use anchor_lang::prelude::*;

use crate::utils::crypto::MERKLE_TREE_HEIGHT;

pub const MAX_HISTORICAL_ROOTS: usize = 3;

#[account(zero_copy)]
#[repr(C)]
pub struct ShieldPool {
    // 32-byte aligned fields first
    pub mint: Pubkey,                                       // 32
    pub operator: Pubkey,                                   // 32
    pub protocol_config: Pubkey,                            // 32
    pub vault: Pubkey,                                      // 32
    pub current_root: [u8; 32],                             // 32
    pub historical_roots: [[u8; 32]; MAX_HISTORICAL_ROOTS], // 96
    pub filled_subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT],    // 160
    // 8-byte aligned fields
    pub denomination: u64,      // 8
    pub total_deposits: u64,    // 8
    pub total_withdrawals: u64, // 8
    pub fees_collected: u64,    // 8
    pub timelock_seconds: i64,  // 8 (legacy, retained for layout stability)
    pub created_at: i64,        // 8
    pub last_deposit_at: i64,   // 8 — timestamp of the most recent deposit
    // 4-byte aligned
    pub next_leaf_index: u32, // 4
    // 1-byte fields grouped
    pub root_history_index: u8, // 1
    pub is_frozen: u8,          // 1
    pub bump: u8,               // 1
    pub vault_authority_bump: u8, // 1
                                // total should be aligned (no padding needed)
}

impl ShieldPool {
    pub const SPACE: usize = 8 + std::mem::size_of::<ShieldPool>();

    pub fn push_root(&mut self, root: [u8; 32]) {
        let idx = self.root_history_index as usize;
        self.historical_roots[idx] = root;
        self.root_history_index = ((idx + 1) % MAX_HISTORICAL_ROOTS) as u8;
        self.current_root = root;
    }

    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        if self.current_root == *root {
            return true;
        }
        self.historical_roots.iter().any(|r| r == root)
    }

    pub fn frozen(&self) -> bool {
        self.is_frozen != 0
    }
}

/// Per-nullifier record. Existence of the PDA at
/// `[b"nullifier", pool, nullifier_hash]` is the double-spend signal:
/// if it already exists, the second `init` fails and the withdraw
/// reverts. Indexing by the nullifier hash (rather than leaf index)
/// keeps the deposit-to-withdraw mapping unobservable on-chain.
#[account]
pub struct NullifierRecord {
    pub pool: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub consumed_at: i64,
    pub bump: u8,
}

impl NullifierRecord {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PoolConfig {
    pub denomination: u64,
    pub timelock_seconds: i64,
}
// rev5
