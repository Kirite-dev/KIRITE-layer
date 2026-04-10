use anchor_lang::prelude::*;

use crate::utils::validation::MAX_SUPPORTED_MINTS;

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub fee_bps: u16,
    pub burn_ratio_bps: u16,
    pub treasury: Pubkey,
    pub is_paused: bool,
    pub supported_mints: Vec<Pubkey>,
    pub total_pools: u64,
    pub total_deposits: u64,
    pub total_withdrawals: u64,
    pub total_fees_collected: u64,
    pub total_fees_burned: u64,
    pub initialized_slot: u64,
    pub initialized_at: i64,
    pub bump: u8,
    pub _reserved: [u8; 8],
}

impl ProtocolConfig {
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

#[account]
pub struct FeeProposal {
    pub proposer: Pubkey,
    pub new_fee_bps: u16,
    pub new_burn_ratio_bps: u16,
    pub proposed_at: i64,
    pub executable_at: i64,
    pub executed: bool,
    pub cancelled: bool,
    pub bump: u8,
}

impl FeeProposal {
    pub const SPACE: usize = 8 + 32 + 2 + 2 + 8 + 8 + 1 + 1 + 1;
}

#[account]
pub struct GovernanceState {
    pub version: u8,
    pub required_signers: u8,
    pub signers: [Pubkey; 7],
    pub total_proposals: u64,
    pub total_executed: u64,
    pub bump: u8,
    pub _reserved: [u8; 8],
}

impl GovernanceState {
    pub const SPACE: usize = 8 + 1 + 1 + (32 * 7) + 8 + 8 + 1 + 8;

    pub fn is_signer(&self, key: &Pubkey) -> bool {
        self.signers
            .iter()
            .take(self.required_signers as usize)
            .any(|s| s == key)
    }
}
// rev4
