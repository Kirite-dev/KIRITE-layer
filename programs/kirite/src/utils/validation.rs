use anchor_lang::prelude::*;

use crate::errors::KiriteError;
use crate::state::protocol::ProtocolConfig;

pub const MAX_FEE_BPS: u16 = 10_000;
pub const MAX_DENOMINATION: u64 = 1_000_000_000_000_000;
pub const MIN_DENOMINATION: u64 = 1_000;
pub const MAX_SUPPORTED_MINTS: usize = 32;
pub const MIN_TIMELOCK_SECONDS: i64 = 600;
pub const MAX_TIMELOCK_SECONDS: i64 = 604_800;
pub const GOVERNANCE_TIMELOCK_SECONDS: i64 = 172_800;
pub const MAX_FREEZE_REASON_LEN: usize = 128;

pub fn require_not_paused(config: &ProtocolConfig) -> Result<()> {
    require!(!config.is_paused, KiriteError::ProtocolPaused);
    Ok(())
}

pub fn require_authority(config: &ProtocolConfig, signer: &Pubkey) -> Result<()> {
    require!(
        config.authority == *signer,
        KiriteError::UnauthorizedAuthority
    );
    Ok(())
}

pub fn require_supported_mint(config: &ProtocolConfig, mint: &Pubkey) -> Result<()> {
    let found = config.supported_mints.iter().any(|m| m == mint);
    require!(found, KiriteError::UnsupportedMint);
    Ok(())
}

pub fn validate_fee_bps(bps: u16) -> Result<()> {
    require!(bps <= MAX_FEE_BPS, KiriteError::FeeBasisPointsExceedMax);
    Ok(())
}

pub fn validate_denomination(denomination: u64) -> Result<()> {
    require!(
        denomination >= MIN_DENOMINATION,
        KiriteError::DepositBelowMinimum
    );
    require!(
        denomination <= MAX_DENOMINATION,
        KiriteError::DepositAboveMaximum
    );
    Ok(())
}

pub fn validate_timelock_duration(seconds: i64) -> Result<()> {
    require!(
        seconds >= MIN_TIMELOCK_SECONDS,
        KiriteError::InvalidTimestamp
    );
    require!(
        seconds <= MAX_TIMELOCK_SECONDS,
        KiriteError::InvalidTimestamp
    );
    Ok(())
}

pub fn is_timelock_expired(deposit_timestamp: i64, timelock_seconds: i64, now: i64) -> bool {
    now >= deposit_timestamp.saturating_add(timelock_seconds)
}

pub fn validate_freeze_reason(reason: &str) -> Result<()> {
    require!(
        reason.len() <= MAX_FREEZE_REASON_LEN,
        KiriteError::InputTooLong
    );
    require!(!reason.is_empty(), KiriteError::InputTooLong);
    Ok(())
}

pub fn require_nonzero_bytes(data: &[u8; 32], err: KiriteError) -> Result<()> {
    let all_zero = data.iter().all(|&b| b == 0);
    if all_zero {
        return Err(err.into());
    }
    Ok(())
}

pub fn validate_merkle_proof_len(proof: &[[u8; 32]], expected_height: usize) -> Result<()> {
    require!(
        proof.len() == expected_height,
        KiriteError::InvalidMerkleProof
    );
    Ok(())
}

pub fn validate_nullifier(nullifier: &[u8; 32]) -> Result<()> {
    require_nonzero_bytes(nullifier, KiriteError::NullifierAlreadyUsed)
}

pub fn validate_ciphertext_bytes(ct: &[u8; 64]) -> Result<()> {
    let all_zero = ct.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::MalformedCiphertext);
    Ok(())
}

/// 30s tolerance for clock drift.
pub fn validate_timestamp_not_future(ts: i64, current: i64) -> Result<()> {
    require!(ts <= current + 30, KiriteError::InvalidTimestamp);
    Ok(())
}

pub fn require_governance_timelock_elapsed(
    proposal_timestamp: i64,
    current_timestamp: i64,
) -> Result<()> {
    let elapsed = current_timestamp.saturating_sub(proposal_timestamp);
    require!(
        elapsed >= GOVERNANCE_TIMELOCK_SECONDS,
        KiriteError::GovernanceTimelockActive
    );
    Ok(())
}

pub fn account_space(data_len: usize) -> usize {
    8 + data_len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timelock_not_expired() {
        assert!(!is_timelock_expired(1000, 600, 1500));
    }

    #[test]
    fn test_timelock_expired() {
        assert!(is_timelock_expired(1000, 600, 1700));
    }

    #[test]
    fn test_timelock_exact_boundary() {
        assert!(is_timelock_expired(1000, 600, 1600));
    }

    #[test]
    fn test_validate_denomination_too_small() {
        assert!(validate_denomination(100).is_err());
    }

    #[test]
    fn test_validate_denomination_ok() {
        assert!(validate_denomination(1_000_000).is_ok());
    }
}
// rev10
