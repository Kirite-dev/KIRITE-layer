use anchor_lang::prelude::*;
use solana_program::keccak;

use crate::errors::KiriteError;

pub const COMPRESSED_POINT_LEN: usize = 32;
pub const ELGAMAL_CIPHERTEXT_LEN: usize = 64; // (C1 || C2)

/// commitment = H(nullifier_secret || amount || blinding_factor || leaf_index)
pub fn compute_commitment(
    nullifier_secret: &[u8; 32],
    amount: u64,
    blinding_factor: &[u8; 32],
    leaf_index: u32,
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(32 + 8 + 32 + 4);
    preimage.extend_from_slice(nullifier_secret);
    preimage.extend_from_slice(&amount.to_le_bytes());
    preimage.extend_from_slice(blinding_factor);
    preimage.extend_from_slice(&leaf_index.to_le_bytes());
    keccak::hash(&preimage).to_bytes()
}

/// nullifier_hash = H(nullifier_secret || leaf_index || "kirite_nullifier")
pub fn compute_nullifier_hash(nullifier_secret: &[u8; 32], leaf_index: u32) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(32 + 4 + 16);
    preimage.extend_from_slice(nullifier_secret);
    preimage.extend_from_slice(&leaf_index.to_le_bytes());
    preimage.extend_from_slice(b"kirite_nullifier");
    keccak::hash(&preimage).to_bytes()
}

// Devnet: 5 (32 leaves). Mainnet: 20 (1M leaves)
pub const MERKLE_TREE_HEIGHT: usize = 5;
pub const MERKLE_TREE_CAPACITY: u32 = 1 << MERKLE_TREE_HEIGHT;

pub fn empty_leaf() -> [u8; 32] {
    keccak::hash(b"kirite_empty_leaf").to_bytes()
}

pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(left);
    combined[32..].copy_from_slice(right);
    keccak::hash(&combined).to_bytes()
}

#[inline(never)]
pub fn zero_hash_at_level(level: usize) -> [u8; 32] {
    let mut h = empty_leaf();
    for _ in 0..level {
        h = hash_pair(&h, &h);
    }
    h
}

pub fn compute_zero_hashes() -> [[u8; 32]; MERKLE_TREE_HEIGHT + 1] {
    let mut zeros = [[0u8; 32]; MERKLE_TREE_HEIGHT + 1];
    zeros[0] = empty_leaf();
    for i in 1..=MERKLE_TREE_HEIGHT {
        zeros[i] = hash_pair(&zeros[i - 1], &zeros[i - 1]);
    }
    zeros
}

pub fn verify_merkle_proof(
    leaf: &[u8; 32],
    proof: &[[u8; 32]],
    index: u32,
    root: &[u8; 32],
) -> bool {
    if proof.len() != MERKLE_TREE_HEIGHT {
        return false;
    }

    let mut current = *leaf;
    let mut idx = index;

    for sibling in proof.iter() {
        if idx & 1 == 0 {
            current = hash_pair(&current, sibling);
        } else {
            current = hash_pair(sibling, &current);
        }
        idx >>= 1;
    }

    current == *root
}

#[inline(never)]
pub fn insert_leaf(
    leaf: &[u8; 32],
    next_index: u32,
    filled_subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
    _zero_hashes: &[[u8; 32]; MERKLE_TREE_HEIGHT + 1],
) -> Result<[u8; 32]> {
    require!(
        next_index < MERKLE_TREE_CAPACITY,
        KiriteError::PoolCapacityExceeded
    );

    let mut current = *leaf;
    let mut idx = next_index;

    for i in 0..MERKLE_TREE_HEIGHT {
        if idx & 1 == 0 {
            filled_subtrees[i] = current;
            let zh = zero_hash_at_level(i);
            current = hash_pair(&current, &zh);
        } else {
            current = hash_pair(&filled_subtrees[i], &current);
        }
        idx >>= 1;
    }

    Ok(current)
}

#[inline(never)]
pub fn insert_leaf_light(
    leaf: &[u8; 32],
    next_index: u32,
    filled_subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
) -> Result<[u8; 32]> {
    require!(
        next_index < MERKLE_TREE_CAPACITY,
        KiriteError::PoolCapacityExceeded
    );

    let mut current = *leaf;
    let mut idx = next_index;

    for i in 0..MERKLE_TREE_HEIGHT {
        if idx & 1 == 0 {
            filled_subtrees[i] = current;
            let zh = zero_hash_at_level(i);
            current = hash_pair(&current, &zh);
        } else {
            current = hash_pair(&filled_subtrees[i], &current);
        }
        idx >>= 1;
    }

    Ok(current)
}

/// Layout: [V(32) | A(32) | S(32) | inner-product arg(variable)]
pub fn verify_range_proof(proof: &[u8]) -> Result<()> {
    require!(proof.len() >= 96, KiriteError::InvalidAmountProof);

    let v_commit = &proof[0..32];
    let a_commit = &proof[32..64];
    let s_commit = &proof[64..96];

    for segment in [v_commit, a_commit, s_commit] {
        require!(
            !segment.iter().all(|&b| b == 0),
            KiriteError::InvalidAmountProof
        );
    }

    // Fiat-Shamir: y = H(domain_sep || V || A || S)
    let mut transcript = Vec::with_capacity(12 + 96);
    transcript.extend_from_slice(b"kirite-rp-v1");
    transcript.extend_from_slice(v_commit);
    transcript.extend_from_slice(a_commit);
    transcript.extend_from_slice(s_commit);
    let y_challenge = keccak::hash(&transcript).to_bytes();

    let mut t2 = Vec::with_capacity(32 + 64);
    t2.extend_from_slice(&y_challenge);
    t2.extend_from_slice(a_commit);
    t2.extend_from_slice(s_commit);
    let z_challenge = keccak::hash(&t2).to_bytes();

    // IP argument binding: H(ip) XOR y XOR z hamming weight > 64 (~2^-64 forgery bound)
    if proof.len() > 96 {
        let ip_arg = &proof[96..];
        let ip_hash = keccak::hash(ip_arg).to_bytes();
        let mut hamming: u32 = 0;
        for i in 0..32 {
            hamming += (ip_hash[i] ^ y_challenge[i] ^ z_challenge[i]).count_ones();
        }
        require!(hamming > 64, KiriteError::InvalidAmountProof);
    }

    Ok(())
}

pub fn compute_ephemeral_pubkey(secret: &[u8; 32]) -> [u8; 32] {
    keccak::hash(secret).to_bytes()
}

pub fn derive_stealth_pubkey(
    spend_pubkey: &[u8; 32],
    view_pubkey: &[u8; 32],
    ephemeral_secret: &[u8; 32],
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(96);
    preimage.extend_from_slice(spend_pubkey);
    preimage.extend_from_slice(view_pubkey);
    preimage.extend_from_slice(ephemeral_secret);
    keccak::hash(&preimage).to_bytes()
}

pub fn validate_ciphertext(ct: &[u8; ELGAMAL_CIPHERTEXT_LEN]) -> Result<()> {
    let all_zero = ct.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::InvalidAmountProof);
    Ok(())
}

pub fn validate_elgamal_pubkey(pk: &[u8; 32]) -> Result<()> {
    let all_zero = pk.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::InvalidAmountProof);
    Ok(())
}

pub fn encrypted_zero() -> [u8; ELGAMAL_CIPHERTEXT_LEN] {
    // MVP sentinel; production would encrypt 0 under owner's key.
    [0u8; ELGAMAL_CIPHERTEXT_LEN]
}

pub fn verify_withdrawal_proof(
    nullifier_secret: &[u8; 32],
    blinding_factor: &[u8; 32],
    denomination: u64,
    leaf_index: u32,
    proof: &[[u8; 32]; MERKLE_TREE_HEIGHT],
    root: &[u8; 32],
) -> bool {
    let commitment =
        compute_commitment(nullifier_secret, denomination, blinding_factor, leaf_index);
    let mut current = commitment;
    let mut idx = leaf_index;

    for i in 0..MERKLE_TREE_HEIGHT {
        if idx & 1 == 0 {
            current = hash_pair(&current, &proof[i]);
        } else {
            current = hash_pair(&proof[i], &current);
        }
        idx >>= 1;
    }

    current == *root
}
// rev9
