use anchor_lang::prelude::*;

pub const MAX_STEALTH_ENTRIES: usize = 256;

#[account]
pub struct StealthRegistry {
    pub owner: Pubkey,
    /// Compressed Curve25519 spend key.
    pub spend_pubkey: [u8; 32],
    /// Compressed Curve25519 view key (used for shared secret derivation).
    pub view_pubkey: [u8; 32],
    pub address_count: u64,
    pub is_active: bool,
    pub created_at: i64,
    pub last_used_at: i64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl StealthRegistry {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 8 + 8 + 1 + 64;
}

#[account]
pub struct StealthAddress {
    pub registry: Pubkey,
    pub address: Pubkey,
    pub ephemeral_pubkey: [u8; 32],
    pub mint: Pubkey,
    /// ElGamal ciphertext under recipient's view key.
    pub encrypted_amount: [u8; 64],
    pub is_claimed: bool,
    pub created_at: i64,
    pub claimed_at: i64,
    pub bump: u8,
}

impl StealthAddress {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 64 + 1 + 8 + 8 + 1;
}

/// On-chain announcement for recipient scanning (ERC-5564 pattern).
#[account]
pub struct EphemeralKeyRecord {
    pub stealth_address: Pubkey,
    pub registry: Pubkey,
    pub ephemeral_pubkey: [u8; 32],
    /// H(view_key * R)[0] -- recipients skip non-matching tags cheaply.
    pub view_tag: u8,
    pub created_at: i64,
    pub bump: u8,
}

impl EphemeralKeyRecord {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateStealthParams {
    pub spend_pubkey: [u8; 32],
    pub view_pubkey: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResolveStealthParams {
    pub ephemeral_pubkey: [u8; 32],
    pub ephemeral_secret: [u8; 32],
    pub encrypted_amount: [u8; 64],
    pub mint: Pubkey,
}
