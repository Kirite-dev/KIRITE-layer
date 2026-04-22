// KIRITE staking program.
//
// Stakers lock $KIRITE for a chosen period (0 / 30 / 90 / 180 / 365 days)
// and earn a share of the SOL fees the relayer generates from privacy
// traffic. Lock length determines weight: longer locks earn more.
//
// Fee distribution is lazy. Anyone (the relayer in practice) deposits
// SOL into the pool's fee_vault PDA. Whenever a staker interacts with
// the pool, the program detects the lamport delta against
// `last_accounted_lamports` and increments `acc_reward_per_weight`.
// Each staker's accrual is then computed from
//   pending = (pool.acc - user.last_acc) * user.weight / 1e12
// and either added to their unclaimed bucket or paid out.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("8LKqyAx7Uuyu4PqwD7RRGhxjLj1GnPgaEzUu4RUitYt3");

pub const MIN_STAKE: u64 = 1_000;          // ~atomic dust filter
pub const SCALE: u128 = 1_000_000_000_000; // 1e12 fixed-point for acc index
pub const ENTRY_FEE_LAMPORTS: u64 = 0;     // no entry fee — matches the
                                            // industry default for staking
                                            // (Lido/Marinade/Curve/Pendle).

// Lock options. Multiplier is in basis points (×100). Longer locks earn
// proportionally more of the fee distribution. Minimum lock is 30 days
// to filter out hot-money positions and align with serious DeFi norms
// (Curve, Pendle, Velodrome all enforce a non-trivial minimum lock).
pub const LOCK_OPTIONS: &[(u32, u32)] = &[
    (30,  150),  // 30 days
    (90,  250),  // 90 days
    (180, 400),  // 180 days
    (365, 800),  // 365 days
];

const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod kirite_staking {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // Seed the fee_vault with the rent-exempt minimum for a 0-byte
        // system account. This locks a small floor amount in the vault
        // forever so claim/unstake outflows can never drop the account
        // below rent. The floor is excluded from the fee accounting via
        // `last_accounted_lamports`, so it never gets distributed.
        let rent_min = Rent::get()?.minimum_balance(0);
        let cpi = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.fee_vault.key(),
            rent_min,
        );
        anchor_lang::solana_program::program::invoke(
            &cpi,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let pool = &mut ctx.accounts.staking_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.kirite_mint = ctx.accounts.kirite_mint.key();
        pool.kirite_vault = ctx.accounts.kirite_vault.key();
        pool.fee_vault = ctx.accounts.fee_vault.key();
        pool.total_stake_weight = 0;
        pool.acc_reward_per_weight = 0;
        pool.last_accounted_lamports = ctx.accounts.fee_vault.lamports();
        pool.fee_vault_floor = rent_min;
        pool.bump = ctx.bumps.staking_pool;
        pool.vault_authority_bump = ctx.bumps.vault_authority;
        pool.fee_vault_bump = ctx.bumps.fee_vault;
        pool.is_draining = false;
        pool.drain_started_at = 0;
        pool.claim_enabled = false;
        Ok(())
    }

    /// Authority-gated switch. Toggle claim availability. Phase 1 is
    /// expected to launch with claim disabled (rewards accrue but can't
    /// yet be withdrawn); Phase 2 (privacy mainnet) flips this to true.
    pub fn set_claim_enabled(ctx: Context<SetClaimEnabled>, enable: bool) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        require!(
            ctx.accounts.authority.key() == pool.authority,
            StakingError::Unauthorized
        );
        pool.claim_enabled = enable;
        emit!(ClaimEnabledChanged {
            enabled: enable,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64, lock_days: u32) -> Result<()> {
        require!(amount >= MIN_STAKE, StakingError::AmountTooSmall);
        let multiplier = lock_multiplier(lock_days)
            .ok_or(StakingError::InvalidLockOption)?;

        let pool = &mut ctx.accounts.staking_pool;
        let stake = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;

        // Optional entry fee in SOL. Zero by default; preserved for
        // potential future bootstrapping mechanics.
        if ENTRY_FEE_LAMPORTS > 0 {
            let entry_fee_ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.staker.key(),
                &ctx.accounts.fee_vault.key(),
                ENTRY_FEE_LAMPORTS,
            );
            anchor_lang::solana_program::program::invoke(
                &entry_fee_ix,
                &[
                    ctx.accounts.staker.to_account_info(),
                    ctx.accounts.fee_vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Sync fees so the staker's pre-existing position (if any)
        // captures any newly-arrived rewards.
        sync_pool(pool, ctx.accounts.fee_vault.lamports())?;
        accrue(pool, stake);

        // Move tokens from staker into the program's vault. Uses
        // transfer_checked so the SPL Token-2022 program is happy
        // (legacy SPL Token also accepts it).
        let decimals = ctx.accounts.kirite_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.staker_kirite.to_account_info(),
                    mint: ctx.accounts.kirite_mint.to_account_info(),
                    to: ctx.accounts.kirite_vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        // Re-stake semantics: existing position's weight is removed,
        // recomputed against the new lock and total amount, then added
        // back. Lock period restarts from now. This keeps the math
        // honest (no double counting) and avoids per-position accounting.
        if stake.amount > 0 {
            pool.total_stake_weight = pool
                .total_stake_weight
                .checked_sub(stake.weight)
                .ok_or(StakingError::Overflow)?;
        } else {
            stake.owner = ctx.accounts.staker.key();
            stake.bump = ctx.bumps.stake_account;
        }
        stake.amount = stake.amount.checked_add(amount).ok_or(StakingError::Overflow)?;
        stake.lock_days = lock_days;
        stake.stake_at = clock.unix_timestamp;
        stake.weight = (stake.amount as u128)
            .checked_mul(multiplier as u128)
            .ok_or(StakingError::Overflow)?
            / 100;
        stake.last_acc = pool.acc_reward_per_weight;
        pool.total_stake_weight = pool
            .total_stake_weight
            .checked_add(stake.weight)
            .ok_or(StakingError::Overflow)?;

        emit!(StakedEvent {
            staker: stake.owner,
            amount,
            lock_days,
            new_total_amount: stake.amount,
            new_weight: stake.weight,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        require!(pool.claim_enabled, StakingError::ClaimNotEnabled);
        let stake = &mut ctx.accounts.stake_account;
        sync_pool(pool, ctx.accounts.fee_vault.lamports())?;
        accrue(pool, stake);

        let payout = stake.unclaimed;
        require!(payout > 0, StakingError::NothingToClaim);

        // Pay out from the fee_vault PDA via signer-seeded SOL transfer.
        let pool_key = pool.key();
        let fv_seeds: &[&[u8]] = &[b"fee_vault", pool_key.as_ref(), &[pool.fee_vault_bump]];
        let signer = &[fv_seeds];
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.fee_vault.key(),
            &ctx.accounts.staker.key(),
            payout,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.staker.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;

        stake.unclaimed = 0;
        // Refresh accounted lamports — claim drained the vault.
        pool.last_accounted_lamports = ctx.accounts.fee_vault.lamports();

        emit!(ClaimedEvent {
            staker: stake.owner,
            amount: payout,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Authority-gated emergency switch. When enabled, `unstake` skips
    /// the lock check so stakers can self-recover their principal during
    /// a graceful shutdown or v2 migration. Authority cannot move staker
    /// funds — only flip this flag.
    pub fn set_drain_mode(ctx: Context<SetDrainMode>, enable: bool) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        require!(
            ctx.accounts.authority.key() == pool.authority,
            StakingError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        pool.is_draining = enable;
        // record drain start time for the grace-period gate on admin_sweep.
        if enable && pool.drain_started_at == 0 {
            pool.drain_started_at = now;
        }
        if !enable {
            pool.drain_started_at = 0;
        }
        emit!(DrainModeChanged {
            enabled: enable,
            timestamp: now,
        });
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        let stake = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;

        // Lock check: stake_at + lock_days * 86400 <= now.
        // Bypassed only when the pool is in graceful drain mode so users
        // can self-recover during a protocol shutdown or migration.
        if !pool.is_draining {
            let unlock_at = stake
                .stake_at
                .checked_add((stake.lock_days as i64).checked_mul(SECONDS_PER_DAY).ok_or(StakingError::Overflow)?)
                .ok_or(StakingError::Overflow)?;
            require!(
                clock.unix_timestamp >= unlock_at,
                StakingError::StillLocked
            );
        }
        require!(stake.amount > 0, StakingError::NothingStaked);

        sync_pool(pool, ctx.accounts.fee_vault.lamports())?;
        accrue(pool, stake);

        // Pay out any pending rewards in the same tx — only when claim
        // is enabled. If claim is gated (Phase 1), unstake returns just
        // the KIRITE principal and the staker's accrued SOL stays parked
        // on their stake_account so they can claim later when enabled.
        let payout = stake.unclaimed;
        if payout > 0 && pool.claim_enabled {
            let pool_key = pool.key();
            let fv_seeds: &[&[u8]] = &[b"fee_vault", pool_key.as_ref(), &[pool.fee_vault_bump]];
            let signer = &[fv_seeds];
            let ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.fee_vault.key(),
                &ctx.accounts.staker.key(),
                payout,
            );
            anchor_lang::solana_program::program::invoke_signed(
                &ix,
                &[
                    ctx.accounts.fee_vault.to_account_info(),
                    ctx.accounts.staker.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                signer,
            )?;
            stake.unclaimed = 0;
        }

        // Return the KIRITE to the staker. transfer_checked is required
        // for Token-2022 mints and accepted by legacy SPL Token.
        let amount = stake.amount;
        let pool_key = pool.key();
        let va_seeds: &[&[u8]] = &[b"vault_authority", pool_key.as_ref(), &[pool.vault_authority_bump]];
        let va_signer = &[va_seeds];
        let decimals = ctx.accounts.kirite_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.kirite_vault.to_account_info(),
                    mint: ctx.accounts.kirite_mint.to_account_info(),
                    to: ctx.accounts.staker_kirite.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                va_signer,
            ),
            amount,
            decimals,
        )?;

        pool.total_stake_weight = pool
            .total_stake_weight
            .checked_sub(stake.weight)
            .ok_or(StakingError::Overflow)?;
        pool.last_accounted_lamports = ctx.accounts.fee_vault.lamports();

        stake.amount = 0;
        stake.weight = 0;
        stake.lock_days = 0;
        stake.stake_at = 0;

        emit!(UnstakedEvent {
            staker: stake.owner,
            amount,
            payout,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/// Detect new fee deposits and update the global per-weight accumulator.
fn sync_pool(pool: &mut Account<StakingPool>, current_lamports: u64) -> Result<()> {
    if current_lamports > pool.last_accounted_lamports && pool.total_stake_weight > 0 {
        let delta = (current_lamports - pool.last_accounted_lamports) as u128;
        let increment = delta
            .checked_mul(SCALE)
            .ok_or(StakingError::Overflow)?
            .checked_div(pool.total_stake_weight)
            .ok_or(StakingError::Overflow)?;
        pool.acc_reward_per_weight = pool
            .acc_reward_per_weight
            .checked_add(increment)
            .ok_or(StakingError::Overflow)?;
    }
    pool.last_accounted_lamports = current_lamports;
    Ok(())
}

/// Move pending rewards from the global index into the staker's
/// unclaimed bucket so further actions see a clean slate.
fn accrue(pool: &Account<StakingPool>, stake: &mut Account<StakeAccount>) {
    if stake.weight == 0 {
        stake.last_acc = pool.acc_reward_per_weight;
        return;
    }
    if pool.acc_reward_per_weight > stake.last_acc {
        let diff = pool.acc_reward_per_weight - stake.last_acc;
        let pending = (diff.saturating_mul(stake.weight) / SCALE) as u64;
        stake.unclaimed = stake.unclaimed.saturating_add(pending);
    }
    stake.last_acc = pool.acc_reward_per_weight;
}

fn lock_multiplier(lock_days: u32) -> Option<u32> {
    LOCK_OPTIONS.iter().find(|(d, _)| *d == lock_days).map(|(_, m)| *m)
}

// ─── Accounts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + StakingPool::SIZE,
        seeds = [b"staking_pool"],
        bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    pub kirite_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: token account whose owner is `vault_authority` PDA. Caller
    /// is expected to create it ahead of time off-chain.
    #[account(
        constraint = kirite_vault.mint == kirite_mint.key() @ StakingError::InvalidVault,
        constraint = kirite_vault.owner == vault_authority.key() @ StakingError::InvalidVault,
    )]
    pub kirite_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: derived PDA used as the kirite_vault's authority.
    #[account(seeds = [b"vault_authority", staking_pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: PDA that simply accumulates lamports. Lazily created on
    /// first transfer; we only validate the derivation here.
    #[account(
        mut,
        seeds = [b"fee_vault", staking_pool.key().as_ref()],
        bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool"],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + StakeAccount::SIZE,
        seeds = [b"stake_account", staker.key().as_ref()],
        bump,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        constraint = staker_kirite.mint == staking_pool.kirite_mint @ StakingError::InvalidMint,
        constraint = staker_kirite.owner == staker.key() @ StakingError::InvalidOwner,
    )]
    pub staker_kirite: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, constraint = kirite_vault.key() == staking_pool.kirite_vault @ StakingError::InvalidVault)]
    pub kirite_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = kirite_mint.key() == staking_pool.kirite_mint @ StakingError::InvalidMint)]
    pub kirite_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA that holds SOL fees. System-owned, validated via seeds.
    #[account(
        mut,
        seeds = [b"fee_vault", staking_pool.key().as_ref()],
        bump = staking_pool.fee_vault_bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub staker: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool"],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [b"stake_account", staker.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ StakingError::InvalidOwner,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    /// CHECK: PDA that holds SOL fees. System-owned, validated via seeds.
    #[account(
        mut,
        seeds = [b"fee_vault", staking_pool.key().as_ref()],
        bump = staking_pool.fee_vault_bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub staker: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDrainMode<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool"],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetClaimEnabled<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool"],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool"],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [b"stake_account", staker.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ StakingError::InvalidOwner,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        constraint = staker_kirite.mint == staking_pool.kirite_mint @ StakingError::InvalidMint,
        constraint = staker_kirite.owner == staker.key() @ StakingError::InvalidOwner,
    )]
    pub staker_kirite: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, constraint = kirite_vault.key() == staking_pool.kirite_vault @ StakingError::InvalidVault)]
    pub kirite_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = kirite_mint.key() == staking_pool.kirite_mint @ StakingError::InvalidMint)]
    pub kirite_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer for `kirite_vault`. PDA derived from staking_pool.
    #[account(seeds = [b"vault_authority", staking_pool.key().as_ref()], bump = staking_pool.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: PDA that holds SOL fees. System-owned, validated via seeds.
    #[account(
        mut,
        seeds = [b"fee_vault", staking_pool.key().as_ref()],
        bump = staking_pool.fee_vault_bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub staker: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// ─── State ────────────────────────────────────────────────────────────

#[account]
pub struct StakingPool {
    pub authority: Pubkey,
    pub kirite_mint: Pubkey,
    pub kirite_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub total_stake_weight: u128,
    pub acc_reward_per_weight: u128,
    pub last_accounted_lamports: u64,
    pub fee_vault_floor: u64,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub fee_vault_bump: u8,
    // when true, unstake bypasses the lock check so users can self-recover
    // their principal during a graceful protocol shutdown or v2 migration.
    // authority can never move staker funds, only enable this flag.
    pub is_draining: bool,
    /// unix timestamp when drain mode was first enabled. used to gate
    /// admin_sweep behind a 90-day grace window so stakers can exit
    /// before any residual funds are swept.
    pub drain_started_at: i64,
    /// claim is gated until the authority enables it. lets us launch
    /// staking before the privacy product is live without paying out
    /// near-zero rewards from a thin pool.
    pub claim_enabled: bool,
}

impl StakingPool {
    pub const SIZE: usize = 32 * 4 + 16 + 16 + 8 + 8 + 1 + 1 + 1 + 1 + 8 + 1;
}

#[account]
pub struct StakeAccount {
    pub owner: Pubkey,
    pub amount: u64,
    pub lock_days: u32,
    pub weight: u128,
    pub stake_at: i64,
    pub last_acc: u128,
    pub unclaimed: u64,
    pub bump: u8,
}

impl StakeAccount {
    pub const SIZE: usize = 32 + 8 + 4 + 16 + 8 + 16 + 8 + 1;
}

// ─── Events ───────────────────────────────────────────────────────────

#[event]
pub struct StakedEvent {
    pub staker: Pubkey,
    pub amount: u64,
    pub lock_days: u32,
    pub new_total_amount: u64,
    pub new_weight: u128,
    pub timestamp: i64,
}

#[event]
pub struct ClaimedEvent {
    pub staker: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnstakedEvent {
    pub staker: Pubkey,
    pub amount: u64,
    pub payout: u64,
    pub timestamp: i64,
}

#[event]
pub struct DrainModeChanged {
    pub enabled: bool,
    pub timestamp: i64,
}

#[event]
pub struct ClaimEnabledChanged {
    pub enabled: bool,
    pub timestamp: i64,
}

// ─── Errors ───────────────────────────────────────────────────────────

#[error_code]
pub enum StakingError {
    #[msg("amount below minimum stake")]
    AmountTooSmall,
    #[msg("lock period must be one of 0, 30, 90, 180, 365 days")]
    InvalidLockOption,
    #[msg("nothing staked")]
    NothingStaked,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("position is still locked")]
    StillLocked,
    #[msg("staker_kirite has wrong mint")]
    InvalidMint,
    #[msg("staker_kirite owner mismatch")]
    InvalidOwner,
    #[msg("vault account mismatch")]
    InvalidVault,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("only the pool authority can perform this action")]
    Unauthorized,
    #[msg("claim is not yet enabled by the pool authority")]
    ClaimNotEnabled,
}
