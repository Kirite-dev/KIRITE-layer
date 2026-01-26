use anchor_lang::prelude::*;

use crate::utils::validation::MAX_SUPPORTED_MINTS;

/// Global protocol configuration. Singleton PDA seeded by `["protocol_config"]`.
#[account]
pub struct ProtocolConfig {
    /// The admin / upgrade authority for the protocol.
    pub authority: Pubkey,

    /// Optional pending authority for two-step transfer.
    pub pending_authority: Pubkey,

    /// Protocol fee in basis points (e.g., 10 = 0.1%).
    pub fee_bps: u16,

    /// What fraction of collected fees are burned (in bps, e.g., 5000 = 50%).
    pub burn_ratio_bps: u16,

    /// Treasury wallet that receives the non-burned portion of fees.
    pub treasury: Pubkey,

    /// Whether the entire protocol is paused (emergency kill-switch).
    pub is_paused: bool,

    /// List of token mints the protocol supports for shield pools and
    /// confidential transfers. Up to 32 mints.
    pub supported_mints: Vec<Pubkey>,

    /// Total number of shield pools created.
    pub total_pools: u64,

    /// Total deposits across all pools (denominated in base units, summed).
    pub total_deposits: u64,

    /// Total withdrawals across all pools.
    pub total_withdrawals: u64,

    /// Total fees collected (before burn split).
    pub total_fees_collected: u64,

    /// Total fees burned.
    pub total_fees_burned: u64,

    /// Slot at which the protocol was initialised.
    pub initialized_slot: u64,

    /// Timestamp at which the protocol was initialised.
    pub initialized_at: i64,

    /// Bump seed for PDA derivation.
    pub bump: u8,

    /// Reserved space for future upgrades without realloc.
    pub _reserved: [u8; 8],
}

impl ProtocolConfig {
    /// Account space: 8 (discriminator) + serialized data.
    /// We compute a generous upper bound for the Vec.
    pub const SPACE: usize = 8  // discriminator
        + 32  // authority
        + 32  // pending_authority
        + 2   // fee_bps
        + 2   // burn_ratio_bps
        + 32  // treasury
        + 1   // is_paused
        + 4 + (32 * MAX_SUPPORTED_MINTS) // supported_mints vec (4-byte len prefix + data)
        + 8   // total_pools
        + 8   // total_deposits
        + 8   // total_withdrawals
        + 8   // total_fees_collected
        + 8   // total_fees_burned
        + 8   // initialized_slot
        + 8   // initialized_at
        + 1   // bump
        + 8; // _reserved

    pub fn add_supported_mint(&mut self, mint: Pubkey) -> bool {
        if self.supported_mints.len() >= MAX_SUPPORTED_MINTS {
            return false;
        }
        if self.supported_mints.contains(&mint) {
            return false; // already exists
        }
        self.supported_mints.push(mint);
        true
    }

    pub fn remove_supported_mint(&mut self, mint: &Pubkey) -> bool {
        if let Some(pos) = self.supported_mints.iter().position(|m| m == mint) {
            self.supported_mints.swap_remove(pos);
            true
        } else {
            false
        }
    }
}

/// Fee configuration snapshot, used in governance proposals to stage
/// fee changes before they take effect (timelock).
#[account]
pub struct FeeProposal {
    /// Who proposed this fee change.
    pub proposer: Pubkey,

    /// New fee in basis points.
    pub new_fee_bps: u16,

    /// New burn ratio in basis points.
    pub new_burn_ratio_bps: u16,

    /// Timestamp when the proposal was created.
    pub proposed_at: i64,

    /// Timestamp when the proposal becomes executable.
    pub executable_at: i64,

    /// Whether this proposal has been executed.
    pub executed: bool,

    /// Whether this proposal has been cancelled.
    pub cancelled: bool,

    /// Bump seed.
    pub bump: u8,
}

impl FeeProposal {
    pub const SPACE: usize = 8 + 32 + 2 + 2 + 8 + 8 + 1 + 1 + 1;
}

/// Governance state tracking for multi-sig or DAO-controlled upgrades.
#[account]
pub struct GovernanceState {
    /// Current governance model version.
    pub version: u8,

    /// Number of required signers for governance actions.
    pub required_signers: u8,

    /// List of authorised governance signers (up to 7).
    pub signers: [Pubkey; 7],

    /// Total proposals created.
    pub total_proposals: u64,

    /// Total proposals executed.
    pub total_executed: u64,

    /// Bump seed.
    pub bump: u8,

    pub _reserved: [u8; 8],
}

impl GovernanceState {
    pub const SPACE: usize = 8 + 1 + 1 + (32 * 7) + 8 + 8 + 1 + 8;

    /// Check if a signer is in the governance signer set.
    pub fn is_signer(&self, key: &Pubkey) -> bool {
        self.signers
            .iter()
            .take(self.required_signers as usize)
            .any(|s| s == key)
    }
}
