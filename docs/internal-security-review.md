# KIRITE internal security review

> Date: 2026-04-30
> Scope: programs/kirite + circuits/membership.circom + supporting utils
> Reviewer: AI-assisted internal review (NOT a substitute for external audit)
> Methodology: pattern-matching against common Solana / Anchor / ZK pitfalls,
> line-by-line walkthrough of every privileged code path

## Summary

- Severity counts: critical 0, high 4, medium 6, low 5, info 3
- Overall assessment: the program is well structured, leans on Anchor's
  account-validation macros for most relationship checks, uses checked
  arithmetic on every fee path, and gets the ZK plumbing (proof byte
  layout, public-input ordering, y-coordinate negation, field-element
  bounds check) right. The four high-severity findings are all "missing
  guard" issues in the deposit / pool-creation / vault-authority flows
  rather than logic errors in the privacy core. None of them break the
  ZK soundness; they let an attacker either grief (spam pools, lock
  funds, run unauthorized pools) or step around the mint allowlist.
  None permit theft from honest depositors' vaults so long as the
  Merkle root and nullifier checks remain intact.
- Files reviewed:
  - programs/kirite/src/lib.rs
  - programs/kirite/src/errors.rs
  - programs/kirite/src/events.rs
  - programs/kirite/src/instructions/initialize.rs
  - programs/kirite/src/instructions/deposit.rs
  - programs/kirite/src/instructions/withdraw.rs
  - programs/kirite/src/instructions/create_stealth.rs
  - programs/kirite/src/instructions/governance.rs
  - programs/kirite/src/instructions/mod.rs
  - programs/kirite/src/state/protocol.rs
  - programs/kirite/src/state/shield_pool.rs
  - programs/kirite/src/state/stealth.rs
  - programs/kirite/src/state/mod.rs
  - programs/kirite/src/utils/zk.rs
  - programs/kirite/src/utils/crypto.rs
  - programs/kirite/src/utils/math.rs
  - programs/kirite/src/utils/validation.rs
  - programs/kirite/src/utils/membership_vk.rs
  - programs/kirite/src/utils/mod.rs
  - circuits/membership.circom
  - sdk/src/zk.mjs (cross-checked for prover/verifier alignment)

## Findings

### [SEV-HIGH-001] Mint allowlist is never enforced

- File: `programs/kirite/src/instructions/initialize.rs:91-123`,
  `programs/kirite/src/instructions/deposit.rs:23-48`,
  `programs/kirite/src/instructions/withdraw.rs:29-79`
- Severity: high
- Category: account-validation
- Description: `ProtocolConfig::supported_mints` is maintained by
  `add_supported_mint` / `remove_supported_mint` (governance.rs:186,
  220). The validation helper `require_supported_mint`
  (`utils/validation.rs:28-32`) exists but is not called from any
  instruction handler. `handle_initialize_shield_pool`,
  `handle_deposit`, and `handle_withdraw` all accept any mint without
  consulting the allowlist. A grep over the program confirms no caller
  for `require_supported_mint`.
- Impact: any user can spin up a pool for an arbitrary mint and push
  the protocol's UI into showing pools the authority never approved.
  Worse, a malicious mint with non-standard transfer hooks (Token-2022,
  freeze authority that can rug) could be used to deposit and then
  block withdrawals — depositors would lose tokens to a frozen vault
  even though their proofs verify.
- Recommendation: add
  `require_supported_mint(&protocol_config, &mint.key())?;` at the top
  of `handle_initialize_shield_pool`, `handle_deposit`, and
  `handle_withdraw`. Alternatively, keep the deposit/withdraw paths
  permissive but gate `initialize_shield_pool` on the protocol
  authority signing AND the mint being on the allowlist. This is the
  cleanest fix because it shrinks the trust surface to pool creation
  only.
- Status: open

### [SEV-HIGH-002] `vault_authority_bump` is never persisted; bump chosen at withdraw time only

- File: `programs/kirite/src/instructions/initialize.rs:159`,
  `programs/kirite/src/instructions/withdraw.rs:55-60, 146-152`
- Severity: high
- Category: account-validation
- Description: `pool.vault_authority_bump` is initialized to `0` and
  the comment says "set during vault init", but no instruction ever
  writes a non-zero bump back. The withdraw context derives the bump
  fresh via `seeds = [b"vault_authority", shield_pool.key()], bump,`
  (line 56-59) and uses `ctx.bumps.vault_authority` directly. Anchor's
  canonical-bump derivation will pick the canonical bump every time,
  so the immediate effect is fine.
  
  However, `vault.owner` is never constrained against `vault_authority`.
  Initialize accepts `vault: UncheckedAccount` (initialize.rs:113-115)
  and never verifies that the SPL token account was actually created
  with `vault_authority` as its `owner`. The pool only stores
  `pool.vault = ctx.accounts.vault.key()` which is checked in
  deposit/withdraw, but ownership of the underlying token account is
  trusted to the pool creator.
- Impact: the pool creator can supply a vault token account whose
  `owner` field is themselves rather than the canonical
  `vault_authority` PDA. They can then drain the vault directly using
  their wallet at any time, bypassing the Groth16 verification path.
  Depositors who shielded into the pool would lose funds.
- Recommendation: in `InitializeShieldPool`, change
  `pub vault: UncheckedAccount<'info>` to
  `pub vault: Box<Account<'info, TokenAccount>>` and add a constraint
  `vault.owner == vault_authority.key()` plus `vault.mint == mint.key()`
  with a `vault_authority: UncheckedAccount` derived via
  `seeds = [b"vault_authority", shield_pool.key().as_ref()], bump`.
  Persist the bump (`pool.vault_authority_bump = ctx.bumps.vault_authority`)
  and use it in withdraw instead of recomputing. This ties the entire
  vault-authority chain together at pool-creation time.
- Status: open

### [SEV-HIGH-003] Pool creation is permissionless (no operator authority check)

- File: `programs/kirite/src/instructions/initialize.rs:91-123`
- Severity: high
- Category: account-validation
- Description: `InitializeShieldPool` only requires `operator: Signer`
  and that `protocol_config` is not paused. There is no check that the
  operator equals `protocol_config.authority` or any allowlisted
  governance signer. Combined with [SEV-HIGH-001] this means anyone
  can permissionlessly create pools that the front-end and indexer
  treat as canonical.
- Impact: griefing surface; brand confusion; potential phishing where
  an attacker creates a pool with a malicious vault setup and tricks
  users into depositing.
- Recommendation: add a constraint
  `protocol_config.authority == operator.key() @ KiriteError::UnauthorizedAuthority`
  (or, if multi-pool operators are intended, gate via
  `governance_state.is_signer(&operator.key())`). If permissionless
  pools are an intentional product decision, document it explicitly
  and harden the front-end's "is this pool canonical?" check.
- Status: open

### [SEV-HIGH-004] Deposit accepts non-canonical (>= p) commitment bytes; soundness risk vs. SDK

- File: `programs/kirite/src/instructions/deposit.rs:113-116`,
  `programs/kirite/src/utils/crypto.rs:138-156` (hash_pair / insert_leaf_light)
- Severity: high
- Category: state / zk-logic
- Description: the only validation on `params.commitment` is "any byte
  is non-zero" (deposit.rs:113-116). The on-chain Merkle insertion
  feeds the raw 32 bytes into the Solana Poseidon syscall. The
  off-chain prover (sdk/src/zk.mjs:75-79, `be32ToField`) reduces every
  byte buffer modulo `BN254_P` before hashing. If a depositor (or a
  buggy SDK build) submits a commitment whose big-endian value is >=
  p, the on-chain root and the off-chain reconstructed root diverge
  silently. The depositor can never produce a Groth16 proof that the
  on-chain `is_known_root` accepts → funds are permanently locked
  inside the vault.
- Impact: targeted denial-of-service at user level; loss of funds for
  affected depositor (no theft, but unrecoverable lock). Also a
  potential adversarial griefing vector: insert a malformed commitment
  to corrupt one Merkle path slot, forcing every later depositor in
  the same subtree to also end up with a divergent proof root.
- Recommendation: at the top of `handle_deposit`, add the same
  canonical-field check used in `verify_membership_proof`:
  ```
  require!(lt_be32(&params.commitment, &BN254_P), KiriteError::InvalidAmountProof);
  ```
  expose `lt_be32` from `utils/zk.rs` (currently private) or duplicate
  the check inline. Apply the same constraint to any caller-supplied
  field-element-shaped inputs (it is already applied on every public
  input of the Groth16 verifier — extend it to commitment bytes).
- Status: open

### [SEV-MEDIUM-001] `claim_stealth_address` spend-proof check is a no-op

- File: `programs/kirite/src/instructions/create_stealth.rs:253-295`
- Severity: medium
- Category: account-validation / cryptographic
- Description: the function takes a 64-byte `spend_proof`, computes a
  keccak digest of it, takes the first 8 bytes, XORs against the first
  8 bytes of the stealth address, and only emits a `msg!` warning if
  the distance is non-zero (line 276-281). It then unconditionally
  marks `is_claimed = true`. The doc comment says "Mainnet: require
  distance == 0. Testnet: warn only."
- Impact: any signer can mark any unclaimed stealth address as
  claimed without proving knowledge of the spend secret. Today the
  consequence is limited because no funds-flow logic depends on
  `is_claimed`, but if a future instruction (e.g. ATA transfer)
  branches on the claim flag, this becomes a direct theft.
- Recommendation: before mainnet, replace the `msg!` warning with a
  hard `require!(distance == 0, KiriteError::InvalidSpendKey)`, OR
  rewrite the verifier to use a real Schnorr / Ed25519 signature
  check against the derived stealth pubkey via the
  `ed25519_program` instruction sysvar. The current XOR check is a
  structural placeholder and should not ship.
- Status: open

### [SEV-MEDIUM-002] Per-deposit timelock is documented but not enforced

- File: `programs/kirite/src/lib.rs:48-49`,
  `programs/kirite/src/state/shield_pool.rs:23`,
  `programs/kirite/src/instructions/deposit.rs:78-158`,
  `programs/kirite/src/instructions/withdraw.rs:81-234`
- Severity: medium
- Category: state
- Description: `lib.rs:48-49` advertises "Timelocked — cannot withdraw
  until `timelock_seconds` elapsed." `ShieldPool` stores a
  `timelock_seconds` value, validated at init by
  `validate_timelock_duration` (range 600s..604_800s). However neither
  `handle_deposit` nor `handle_withdraw` reads `timelock_seconds` at
  all. The pool tracks `last_deposit_at` (deposit.rs:143) which is
  the only timestamp recorded, and `withdraw` does not consult it.
  Furthermore the design is incompatible with timelock-per-deposit:
  the deposit only stores a commitment hash, not a per-leaf timestamp,
  so individual deposits cannot be timelocked unless the timestamp is
  bound into the commitment / circuit.
- Impact: documented protocol guarantee ("timelocked deposits") is
  silently absent. A withdraw proven against a fresh deposit can be
  consumed in the same slot. The intended anti-MEV / anti-tracing
  property is not delivered.
- Recommendation: either (a) drop the timelock claim and stop
  storing `timelock_seconds` to avoid misleading integrators, or
  (b) bind a per-deposit timestamp into the leaf commitment (extend
  the circuit's leaf hash to include `deposit_slot` and add a public
  input `current_slot >= deposit_slot + timelock_seconds`). Option (b)
  is intrusive; option (a) is a one-line README change.
- Status: open

### [SEV-MEDIUM-003] Empty pool's historical_roots contain `[0;32]` slots before being filled

- File: `programs/kirite/src/state/shield_pool.rs:39-51`,
  `programs/kirite/src/instructions/initialize.rs:142-147`
- Severity: medium
- Category: state
- Description: `historical_roots` is initialized to `[[0u8;32]; 3]` at
  pool creation. `is_known_root(&[0u8;32])` returns true for the first
  three deposits because the loop matches the zeroed slots. The field
  passes the BN254 canonical-field check (0 < p). The mitigating
  factor is that nobody can produce a Groth16 proof whose Merkle root
  is `[0u8;32]` because the empty-tree root is `zero_hashes[15]`, not
  zero, and any populated tree's root is also definitionally non-zero
  with overwhelming probability. So practical exploitability is near
  zero — but defense in depth says the bookkeeping should not have
  this gap.
- Impact: theoretical; an adversary who finds a Poseidon preimage
  collision producing root = 0 (cryptographically infeasible) could
  pass the root check with no real deposit history. No realistic
  attack today.
- Recommendation: change `is_known_root` to skip zero entries, or
  initialize `historical_roots` to the empty-tree zero root instead of
  raw zeros:
  ```
  let zero_root = zero_hashes[MERKLE_TREE_HEIGHT];
  pool.historical_roots = [zero_root; MAX_HISTORICAL_ROOTS];
  ```
  Cheap and removes the asymmetry.
- Status: open

### [SEV-MEDIUM-004] `BurnFees` does not validate the fee_token_account's owner / mint

- File: `programs/kirite/src/instructions/governance.rs:387-455`
- Severity: medium
- Category: account-validation
- Description: `BurnFees` accepts a `fee_token_account` with no
  constraint on its `owner` (must equal `fee_authority` PDA) or `mint`
  (must equal `mint.key()`). The actual SPL `token::burn` CPI will
  fail if the mint mismatches because the token program enforces it,
  but the owner-check is the program's responsibility. Today the
  authority is also the signer so the practical risk is low; the
  authority can only burn from accounts they themselves control. But
  if the authority key ever leaks (or is intentionally compromised by
  governance), the missing owner check means the leaked authority can
  burn arbitrary token accounts that happen to share the same mint
  and have any token-account whose authority is the `fee_authority`
  PDA — well, that is constrained because the CPI will reject burns
  from non-owned accounts, so practical impact is contained.
- Impact: defense-in-depth gap; minor.
- Recommendation: add Anchor constraints
  ```
  constraint = fee_token_account.owner == fee_authority.key(),
  constraint = fee_token_account.mint == mint.key(),
  ```
  to the `fee_token_account` declaration.
- Status: open

### [SEV-MEDIUM-005] Stealth registry "deactivate" allows future re-activation gap

- File: `programs/kirite/src/instructions/create_stealth.rs:81-104`
- Severity: medium
- Category: state
- Description: `handle_deactivate_stealth_registry` flips
  `is_active = false` but `resolve_stealth_address` only checks
  `registry.is_active`. There is no instruction to re-activate, but
  also nothing prevents a later add (the field is never re-checked
  against history). The constraint
  `registry.is_active @ KiriteError::StealthAddressAlreadyRegistered`
  on resolve is correct; however the error code surfaced is
  semantically wrong (says "already registered" when actually the
  registry is inactive). Minor UX/diagnostics issue rather than a
  security one.
- Impact: confusing error message; potential support-burden.
- Recommendation: introduce a `RegistryDeactivated` error variant and
  return that. Optionally add an explicit `reactivate` instruction
  guarded by the registry owner.
- Status: open

### [SEV-MEDIUM-006] Circuit does not range-check `leafIndex`

- File: `circuits/membership.circom:49-125`
- Severity: medium
- Category: circuit
- Description: `leafIndex` is a private input used in
  `Poseidon(ns, amount, bf, leafIndex)` (leaf commitment) and
  `Poseidon(ns, leafIndex)` (nullifier hash). The Merkle path
  `pathIndices[i]` is constrained to be a strict bit
  (line 90: `pathIndices[i] * (pathIndices[i] - 1) === 0`), but
  `leafIndex` itself is not bound to `< 2^15`. A prover could choose
  an arbitrary field element as `leafIndex` so long as the
  reconstructed root matches.
- Impact: limited. The on-chain code creates the nullifier PDA seeded
  by `nullifier_hash` (not by leafIndex), so distinct nullifiers stay
  distinct as long as `(ns, leafIndex)` pairs differ. The honest
  protocol always uses leafIndex < 2^15. An attacker who controls a
  deposit could in principle compute a commitment with a "weird"
  leafIndex outside the tree depth — but they would still need a
  Merkle path reconstructing to the public root, which they cannot
  produce because the on-chain tree only has 2^15 slots and they
  cannot insert at index >= 2^15. So the soundness violation is
  benign: it cannot create a duplicate nullifier or an extra
  withdrawable note. Worth fixing for defense-in-depth.
- Recommendation: add
  ```
  component leafIndexBits = Num2Bits(15);
  leafIndexBits.in <== leafIndex;
  ```
  using circomlib's Num2Bits, which enforces `leafIndex < 2^15`. Then
  also constrain `pathIndices[i] === leafIndexBits.out[i]` to remove
  the redundancy of accepting `pathIndices` as separate input — the
  prover should not be able to disagree on the bit decomposition.
- Status: open

### [SEV-LOW-001] `cancel_fee_proposal` does not bind proposal to its protocol_config

- File: `programs/kirite/src/instructions/governance.rs:147-169`
- Severity: low
- Category: account-validation
- Description: `CancelFeeProposal` validates `fee_proposal.proposer ==
  authority.key()` but does not constrain `fee_proposal` via seeds. A
  caller could pass a fee proposal from a different protocol_config
  if multiple deployments exist under the same program ID (impossible
  on a single canonical mainnet deployment but possible on devnet
  forks). Since cancellation only marks the proposal cancelled and
  nothing else, the worst case is an authority cancelling their own
  proposal in a sibling deployment.
- Impact: very low; only relevant in multi-deployment scenarios.
- Recommendation: add seed binding:
  ```
  seeds = [b"fee_proposal", protocol_config.key().as_ref(), &fee_proposal.proposal_index.to_le_bytes()],
  bump = fee_proposal.bump,
  ```
  This requires storing the proposal_index in `FeeProposal`. Or simply
  add a constraint that the proposer matches and the proposal is for
  this protocol_config (would need a `protocol_config: Pubkey` field
  in FeeProposal).
- Status: open

### [SEV-LOW-002] `execute_fee_update` re-checks elapsed using `proposed_at`, ignores `executable_at`

- File: `programs/kirite/src/instructions/governance.rs:110-144`
- Severity: low
- Category: state
- Description: `propose_fee_update` writes both `proposed_at` and
  `executable_at = proposed_at + GOVERNANCE_TIMELOCK_SECONDS`.
  `execute_fee_update` then calls
  `require_governance_timelock_elapsed(proposal.proposed_at, now)`
  which recomputes the same thing. Functionally identical but the
  `executable_at` field is dead state and could drift if the constant
  changes. Minor code smell.
- Impact: none today.
- Recommendation: remove `executable_at` from `FeeProposal` (and bump
  account size) OR switch the check to
  `require!(now >= proposal.executable_at, ...)`. Picking one source
  of truth is cleaner.
- Status: open

### [SEV-LOW-003] `update_governance_signers` does not deduplicate or zero-check

- File: `programs/kirite/src/instructions/governance.rs:476-502`
- Severity: low
- Category: state
- Description: the loop copies `signers` into `gov.signers` without
  rejecting duplicates or `Pubkey::default()` entries. A signer list
  of `[A, A, A]` with `required = 2` would let A self-approve as if
  multi-sig. Since today `is_signer` is only used in the `BurnFees`
  flow indirectly and the authority itself signs every governance
  call, the practical impact is that the multi-sig threshold can be
  silently subverted by configuration. Once governance starts gating
  privileged actions on `is_signer`, the dedup becomes critical.
- Impact: low today, becomes high if multi-sig gating is added later.
- Recommendation: add
  ```
  let mut seen = [false; 7];
  for s in &signers {
      require!(*s != Pubkey::default(), KiriteError::InvalidVariant);
      require!(!signers.iter().filter(|x| *x == s).count() > 1,
               KiriteError::InvalidVariant);
  }
  ```
  or use a HashSet equivalent.
- Status: open

### [SEV-LOW-004] `validate_timestamp_not_future` allows a 30s skew but is unused

- File: `programs/kirite/src/utils/validation.rs:103-106`
- Severity: low
- Category: other
- Description: the helper exists but no instruction calls it. Nothing
  on-chain accepts user-supplied timestamps today; harmless but dead
  code.
- Impact: none.
- Recommendation: remove or wire up.
- Status: open

### [SEV-LOW-005] `freeze_pool` and `unfreeze_pool` re-derive PDA but don't gate on supported mint

- File: `programs/kirite/src/instructions/governance.rs:303-385`
- Severity: low
- Category: account-validation
- Description: the freeze flow correctly checks
  `protocol_config.authority == authority.key()` (line 311), then
  manually `find_program_address` on the pool seeds. Anchor would do
  this if `shield_pool` were declared with explicit seeds; the manual
  re-derivation works but is verbose. Functionally correct. No mint
  allowlist consultation, so a frozen pool may be one that should not
  exist (see SEV-HIGH-001).
- Impact: minor stylistic / defense-in-depth.
- Recommendation: declare seeds inline on the `shield_pool`
  AccountLoader constraint and let Anchor handle the derivation.
  Optionally also cross-check the mint is on the allowlist before
  freezing.
- Status: open

### [SEV-INFO-001] `pubkey_to_field` uses keccak, comment mentions SHA-256

- File: `programs/kirite/src/utils/zk.rs:145-154`
- Severity: info
- Category: zk-logic
- Description: the doc comment opens with "Hash a Solana account
  pubkey into a single 32-byte field element by taking SHA-256" but
  the implementation uses `keccak::hash`. The SDK side
  (`sdk/src/zk.mjs:207-213`) also uses keccak, so prover and verifier
  match — only the comment is misleading.
- Impact: documentation only.
- Recommendation: fix the comment to say keccak.
- Status: open

### [SEV-INFO-002] `_zero_hashes` parameter in `insert_leaf` is unused (dead branch)

- File: `programs/kirite/src/utils/crypto.rs:182-206`
- Severity: info
- Category: other
- Description: `insert_leaf` accepts a `_zero_hashes` parameter and
  never uses it (computes via `zero_hash_at_level(i)` instead).
  `insert_leaf_light` is identical except for the dropped argument
  and is the function actually called from `do_merkle_insert`. The
  unused function is dead code.
- Impact: code-size / maintenance only.
- Recommendation: delete `insert_leaf` and the unused parameter.
- Status: open

### [SEV-INFO-003] `verify_withdrawal_proof` is dead code

- File: `programs/kirite/src/utils/crypto.rs:305-326`
- Severity: info
- Category: other
- Description: a keccak-based Merkle path verifier remains from the
  pre-ZK pool. No instruction calls it. The fact that the codebase
  ships two different leaf hashing conventions in dead code (keccak
  here vs. Poseidon in production) is a footgun for future
  contributors.
- Impact: confusion only.
- Recommendation: delete.
- Status: open

## What was checked and found correct

A non-trivial portion of the review surfaced no issues. Documenting
the negative findings for the record:

- Groth16 proof byte layout (256 bytes: A 64 || B 128 || C 64) and
  big-endian encoding match `groth16-solana` expectations
  (`utils/zk.rs:108-117`).
- proof_a y-coordinate negation is implemented as a constant-time
  borrow-aware subtraction of the y bytes from `BN254_P`
  (`utils/zk.rs:61-77`). The byte-level borrow logic is correct (I
  traced `i=31..0` against a worst-case y = p-1).
- Public-input ordering on the verifier (`withdraw.rs:130-135`)
  matches the circuit's `main {public [root, nullifierHash, amount,
  recipientHash]}` declaration (`membership.circom:128`). Off-chain
  prover assembles the same tuple (`sdk/src/zk.mjs:286-296`).
- Public-input canonical-field validation: `lt_be32(input, &BN254_P)`
  is enforced for every public input before the syscall
  (`utils/zk.rs:104-106`). Non-canonical inputs are rejected.
- Nullifier double-spend gate is anchored on a PDA `init` whose seeds
  are `[b"nullifier", pool, params.nullifier_hash]`
  (`withdraw.rs:43-50`). A second spend with the same nullifier hash
  reverts because Anchor's `init` requires the account not to exist.
- Recipient binding into the proof: `recipient_hash =
  pubkey_to_field(&recipient_token_account.key())` is computed
  on-chain at withdraw time and fed into the public inputs
  (`withdraw.rs:129-135`). A relayer cannot redirect the proof to a
  different token account because the proof validates against the
  recipient_token_account that was actually passed.
- Merkle root acceptance window: `is_known_root` consults
  `current_root` plus three historical roots
  (`shield_pool.rs:46-51`). This handles the deposit-then-withdraw
  race correctly. The window of 3 is small but acceptable for a
  fixed-denomination pool with low concurrency.
- Pool capacity: `next_leaf_index` is `checked_add(1)` with explicit
  `PoolCapacityExceeded` mapping (`deposit.rs:139-141`), and
  `insert_leaf_light` re-checks `next_index < MERKLE_TREE_CAPACITY`
  (`crypto.rs:215`). Double-guarded.
- Empty-leaf sentinel: `empty_leaf() = Poseidon([0])` matches the
  off-chain `poseidonZeroHashes()` helper
  (`crypto.rs:130-134` vs. `sdk/src/zk.mjs:144-155`).
- Filled-subtree update is atomic per-deposit: the entire Merkle
  insert (`do_merkle_insert`) runs under one `load_mut` borrow and
  panics on capacity overflow before any state mutation
  (`deposit.rs:131-144`). No half-applied state.
- Pool freeze and protocol pause are honored on deposit
  (`deposit.rs:30, 98`) and withdraw
  (`withdraw.rs:36, 101`).
- All fee math uses u128 intermediates (`utils/math.rs:9-62`) with
  `checked_mul`, `checked_add`, `checked_sub`, `checked_div`. The
  rounding direction is ceiling for fee
  (`numerator + denom - 1) / denom`), which means the protocol
  always rounds in its favor — correct anti-rounding-grief direction.
- Authority transfer is two-step (initiate writes
  `pending_authority`; accept signs as the new authority) at
  `governance.rs:240-301`. Standard pattern, correctly implemented.
- PDA bumps come from `ctx.bumps.<name>` everywhere they are persisted
  or used as signer seeds (`initialize.rs:66, 76, 158`,
  `withdraw.rs:150, 215`, `governance.rs:68`,
  `create_stealth.rs:61, 197, 205`). No user-supplied bumps.
- `Pubkey::default()` (all-zero) is reserved as the "no pending
  authority" sentinel and the `accept_authority_transfer` flow
  cannot match it because `new_authority.key()` of an actual signer
  cannot be the all-zero key.
- Zero-byte rejection on user-supplied 32-byte values that flow into
  hashes: nullifier_record creation does not need to reject all-zero
  because the PDA derivation catches collisions; commitment rejects
  all-zero (`deposit.rs:113-116`); ephemeral_pubkey and
  ephemeral_secret reject all-zero
  (`create_stealth.rs:161-162`); ElGamal pubkeys reject all-zero
  (`crypto.rs:278-288`).
- DKSAP key independence: `spend_pubkey != view_pubkey` enforced
  (`create_stealth.rs:46-49`).
- Account size constants match struct layouts. I verified
  `ProtocolConfig::SPACE` (line 26-42),
  `FeeProposal::SPACE` (line 78), `GovernanceState::SPACE` (line 93),
  `ShieldPool::SPACE` (zero-copy, computed from `size_of`),
  `NullifierRecord::SPACE` (line 72-73),
  `StealthRegistry::SPACE` (line 21),
  `StealthAddress::SPACE` (line 39),
  `EphemeralKeyRecord::SPACE` (line 55). All add up correctly.
- WSOL burn redirection is handled (`withdraw.rs:181-204`):
  native-mint pools redirect the burn share to treasury rather than
  attempting `Burn` on a wrapped-SOL account (which the SPL token
  program rejects).
- Circuit constrains `pathIndices[i]` to be a strict bit
  (`membership.circom:90`).
- Circuit forces `amount` and `recipientHash` constraints into the
  R1CS via `amountSquared` and `recipientSquared`
  (`membership.circom:120-124`) so the optimizer cannot drop them and
  the public inputs cannot be ignored by the prover.
- Verifying-key (`utils/membership_vk.rs`) is generated from
  `circuits/build/verification_key.json` and pinned with `N_PUBLIC =
  4` matching the circuit's 4 public inputs and 5 IC entries.

## Out of scope

- External audit (mandatory before mainnet despite this internal pass)
- Trusted-setup ceremony hygiene — handled separately under
  `ceremony/`
- Fuzzing / formal verification (recommended for `utils/zk.rs` and
  the Poseidon path)
- Stress testing beyond the 80-cycle stability sweep already run
- Off-chain prover key-management hygiene
- Front-end / SDK supply-chain review
- Solana RPC / relayer infrastructure threat model
- Economic / MEV analysis at scale

## Methodology limitations

- This review did not run the program (no `cargo build-sbf` /
  `anchor test`). Findings are based on static reading; runtime
  behavior of `groth16-solana`, `solana-poseidon`, and
  `curve25519-dalek` is taken on documented contract.
- No fuzz harness was constructed. Edge cases in `negate_g1_y` for
  exotic inputs (y = 0, y = p - 1) were not exhaustively tested.
- The vault-init flow is not actually shown in the code under review;
  finding [SEV-HIGH-002] assumes the off-chain script creates a
  token account owned by the `vault_authority` PDA but this could
  not be confirmed from the on-chain code. If a separate
  `init_vault` instruction exists outside this scope, the
  vault-ownership concern may be partially addressed there.
- I did not exhaustively read every test in `programs/kirite/tests`
  or `examples/`; some of the findings above may already have
  regression coverage I missed.
- I did not audit the `kirite-staking` companion program — the user
  requested only the privacy-protocol review.
- Constant-time / side-channel review of the verifier was not
  performed. On-chain code does not have realistic side channels
  (Solana validators are not adversarial-execution environments in
  the same way as enclaves) but the off-chain SDK is responsible for
  not leaking nullifier_secret via timing.
- The CI / build-reproducibility of `membership_vk.rs` against
  `circuits/build/verification_key.json` was not verified by
  re-running `node vk-to-rust-v2.js`.
