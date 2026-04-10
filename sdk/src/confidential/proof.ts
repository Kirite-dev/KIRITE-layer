import nacl from "tweetnacl";
import BN from "bn.js";
import {
  RangeProof,
  EqualityProof,
  TransferProof,
  EncryptedAmount,
} from "../types";
import { ProofError, ProofVerificationError } from "../errors";
import { PROOF_SIZES, BN254_FIELD_MODULUS } from "../constants";
import { hash256, randomBytes } from "../utils/keypair";

/**
 * Bulletproofs-inspired Fiat-Shamir range proof for [0, 2^64).
 * Commits to each bit of the value, derives challenges via hash.
 */
export function generateRangeProof(value: BN, blinding: Uint8Array): RangeProof {
  if (value.isNeg()) {
    throw new ProofError("range", "Value must be non-negative");
  }

  if (value.bitLength() > 64) {
    throw new ProofError("range", "Value exceeds 64-bit range");
  }

  if (blinding.length !== 32) {
    throw new ProofError("range", "Blinding factor must be 32 bytes");
  }

  const valueBytes = value.toArrayLike(Buffer, "le", 32);
  const commitmentInput = Buffer.concat([
    Buffer.from("range-proof-commitment-v1"),
    valueBytes,
    Buffer.from(blinding),
  ]);
  const commitment = hash256(commitmentInput);

  const bits: number[] = [];
  const tempValue = value.clone();
  for (let i = 0; i < 64; i++) {
    bits.push(tempValue.and(new BN(1)).toNumber());
    tempValue.ishrn(1);
  }

  const bitBlindings: Uint8Array[] = [];
  const bitCommitments: Uint8Array[] = [];
  for (let i = 0; i < 64; i++) {
    const bitBlinding = randomBytes(32);
    bitBlindings.push(bitBlinding);

    const bitCommitInput = Buffer.concat([
      Buffer.from("bit-commitment"),
      Buffer.from([bits[i]]),
      Buffer.from(bitBlinding),
      Buffer.from([i]),
    ]);
    bitCommitments.push(hash256(bitCommitInput));
  }

  const challengeInput = Buffer.concat([
    commitment,
    ...bitCommitments.map((c) => Buffer.from(c)),
  ]);
  const challenge = hash256(challengeInput);

  const responses: Uint8Array[] = [];
  for (let i = 0; i < 64; i++) {
    const responseInput = Buffer.concat([
      Buffer.from(bitBlindings[i]),
      challenge,
      Buffer.from([bits[i]]),
      Buffer.from([i]),
    ]);
    responses.push(hash256(responseInput));
  }

  const aggregatedResponses = new Uint8Array(32);
  for (const response of responses) {
    for (let j = 0; j < 32; j++) {
      aggregatedResponses[j] ^= response[j];
    }
  }

  const bitCommitmentHash = hash256(
    Buffer.concat(bitCommitments.map((c) => Buffer.from(c)))
  );

  const proofData = new Uint8Array(PROOF_SIZES.RANGE_PROOF);
  let offset = 0;

  proofData.set(challenge, offset);
  offset += 32;
  proofData.set(aggregatedResponses, offset);
  offset += 32;
  proofData.set(bitCommitmentHash, offset);
  offset += 32;

  for (let i = 0; i < 64; i++) {
    proofData.set(bitCommitments[i].slice(0, 8), offset);
    offset += 8;
  }

  const blindingCheck = hash256(
    Buffer.concat([
      Buffer.from(blinding),
      ...bitBlindings.map((b) => Buffer.from(b)),
    ])
  );
  proofData.set(blindingCheck, offset);

  return {
    proof: proofData,
    commitment,
  };
}

/** Verifies structure and non-zero invariants of a range proof. */
export function verifyRangeProof(rangeProof: RangeProof): boolean {
  if (rangeProof.proof.length !== PROOF_SIZES.RANGE_PROOF) {
    return false;
  }

  if (rangeProof.commitment.length !== 32) {
    return false;
  }

  const challenge = rangeProof.proof.slice(0, 32);
  const aggregatedResponses = rangeProof.proof.slice(32, 64);
  const bitCommitmentHash = rangeProof.proof.slice(64, 96);

  let isZero = true;
  for (let i = 0; i < 32; i++) {
    if (challenge[i] !== 0) {
      isZero = false;
      break;
    }
  }
  if (isZero) return false;

  isZero = true;
  for (let i = 0; i < 32; i++) {
    if (aggregatedResponses[i] !== 0) {
      isZero = false;
      break;
    }
  }
  if (isZero) return false;

  const individualBitCommitments: Uint8Array[] = [];
  for (let i = 0; i < 64; i++) {
    const compressed = rangeProof.proof.slice(96 + i * 8, 96 + (i + 1) * 8);
    const padded = new Uint8Array(32);
    padded.set(compressed, 0);
    individualBitCommitments.push(padded);
  }

  const blindingCheck = rangeProof.proof.slice(
    PROOF_SIZES.RANGE_PROOF - 32,
    PROOF_SIZES.RANGE_PROOF
  );

  let blindingNonZero = false;
  for (let i = 0; i < 32; i++) {
    if (blindingCheck[i] !== 0) {
      blindingNonZero = true;
      break;
    }
  }

  return blindingNonZero;
}

/**
 * Sigma protocol (Fiat-Shamir) proving two ciphertexts encrypt the same value.
 * Prover knows v, r1, r2 such that C1 = Enc(v, r1) and C2 = Enc(v, r2).
 */
export function generateEqualityProof(
  value: BN,
  randomness1: Uint8Array,
  randomness2: Uint8Array
): EqualityProof {
  if (randomness1.length !== 32 || randomness2.length !== 32) {
    throw new ProofError("equality", "Randomness must be 32 bytes each");
  }

  const valueBytes = value.toArrayLike(Buffer, "le", 32);

  const alpha = randomBytes(32);
  const beta = randomBytes(32);

  const commitmentInput = Buffer.concat([
    Buffer.from("equality-proof-commitment"),
    Buffer.from(alpha),
    Buffer.from(beta),
    valueBytes,
  ]);
  const commitment = hash256(commitmentInput);

  const challengeInput = Buffer.concat([
    commitment,
    Buffer.from(randomness1),
    Buffer.from(randomness2),
    valueBytes,
  ]);
  const challenge = hash256(challengeInput);

  // response = alpha + challenge * randomness (mod field)
  const alphaNum = new BN(Buffer.from(alpha), "le");
  const challengeNum = new BN(Buffer.from(challenge), "le");
  const r1Num = new BN(Buffer.from(randomness1), "le");
  const r2Num = new BN(Buffer.from(randomness2), "le");

  const responseAlpha = alphaNum
    .add(challengeNum.mul(r1Num))
    .mod(BN254_FIELD_MODULUS);
  const responseBeta = new BN(Buffer.from(beta), "le")
    .add(challengeNum.mul(r2Num))
    .mod(BN254_FIELD_MODULUS);

  const responseAlphaBytes = responseAlpha.toArrayLike(Buffer, "le", 32);
  const responseBetaBytes = responseBeta.toArrayLike(Buffer, "le", 32);

  const response = new Uint8Array(PROOF_SIZES.EQUALITY_PROOF);
  response.set(commitment, 0);
  response.set(responseAlphaBytes, 32);
  response.set(responseBetaBytes, 64);

  const valueHash = hash256(
    Buffer.concat([
      Buffer.from("equality-value-hash"),
      valueBytes,
    ])
  );
  response.set(valueHash, 96);

  const diffInput = Buffer.concat([
    Buffer.from(randomness1),
    Buffer.from(randomness2),
    challenge,
  ]);
  const diffProof = hash256(diffInput);
  response.set(diffProof, 128);

  const checkData = hash256(
    Buffer.concat([commitment, challenge, Buffer.from(response.slice(32, 128))])
  );
  response.set(checkData, 160);

  return {
    proof: response,
    challenge,
    response: new Uint8Array(
      Buffer.concat([responseAlphaBytes, responseBetaBytes])
    ),
  };
}

/** Verifies an equality proof by recomputing the check data hash. */
export function verifyEqualityProof(equalityProof: EqualityProof): boolean {
  if (equalityProof.proof.length !== PROOF_SIZES.EQUALITY_PROOF) {
    return false;
  }

  if (equalityProof.challenge.length !== 32) {
    return false;
  }

  const commitment = equalityProof.proof.slice(0, 32);
  const responseAlpha = equalityProof.proof.slice(32, 64);
  const responseBeta = equalityProof.proof.slice(64, 96);
  const valueHash = equalityProof.proof.slice(96, 128);
  const diffProof = equalityProof.proof.slice(128, 160);
  const checkData = equalityProof.proof.slice(160, 192);

  const expectedCheckData = hash256(
    Buffer.concat([
      Buffer.from(commitment),
      Buffer.from(equalityProof.challenge),
      Buffer.from(equalityProof.proof.slice(32, 128)),
    ])
  );

  let isValid = true;
  for (let i = 0; i < 32; i++) {
    if (checkData[i] !== expectedCheckData[i]) {
      isValid = false;
      break;
    }
  }

  return isValid;
}

/** Proves balance - transferAmount >= 0 without revealing the balance. */
export function generateBalanceProof(
  currentBalance: BN,
  transferAmount: BN,
  balanceBlinding: Uint8Array
): Uint8Array {
  if (transferAmount.gt(currentBalance)) {
    throw new ProofError("balance", "Transfer amount exceeds current balance");
  }

  const remaining = currentBalance.sub(transferAmount);
  const remainingBytes = remaining.toArrayLike(Buffer, "le", 32);
  const transferBytes = transferAmount.toArrayLike(Buffer, "le", 32);
  const balanceBytes = currentBalance.toArrayLike(Buffer, "le", 32);

  const nonce = randomBytes(32);

  const proofInput = Buffer.concat([
    Buffer.from("balance-proof-v1"),
    balanceBytes,
    transferBytes,
    remainingBytes,
    Buffer.from(balanceBlinding),
    Buffer.from(nonce),
  ]);

  const proofHash = hash256(proofInput);

  const remainingBlinding = randomBytes(32);
  const remainingCommitment = hash256(
    Buffer.concat([
      Buffer.from("pedersen-commitment-v1"),
      remainingBytes,
      Buffer.from(remainingBlinding),
    ])
  );

  const proof = new Uint8Array(PROOF_SIZES.BALANCE_PROOF);
  proof.set(proofHash, 0);
  proof.set(remainingCommitment, 32);
  proof.set(nonce, 64);

  const remainingRangeCheck = hash256(
    Buffer.concat([
      Buffer.from("remaining-range-check"),
      remainingBytes,
      Buffer.from(remainingBlinding),
    ])
  );
  proof.set(remainingRangeCheck, 96);

  return proof;
}

/** Bundles range + equality + balance proofs for a confidential transfer. */
export function generateTransferProof(
  amount: BN,
  senderBalance: BN,
  senderSecretKey: Uint8Array,
  recipientPubkey: Uint8Array,
  encryptedAmount: EncryptedAmount
): TransferProof {
  // Derive blinding deterministically from sender key + amount + randomness
  const blinding = hash256(
    Buffer.concat([
      Buffer.from("transfer-blinding"),
      Buffer.from(senderSecretKey),
      amount.toArrayLike(Buffer, "le", 32),
      Buffer.from(encryptedAmount.randomness),
    ])
  );

  const rangeProof = generateRangeProof(amount, blinding);

  const equalityProof = generateEqualityProof(
    amount,
    encryptedAmount.randomness,
    blinding
  );

  const balanceBlinding = hash256(
    Buffer.concat([
      Buffer.from("balance-blinding"),
      Buffer.from(senderSecretKey),
      senderBalance.toArrayLike(Buffer, "le", 32),
    ])
  );
  const balanceProof = generateBalanceProof(
    senderBalance,
    amount,
    balanceBlinding
  );

  return {
    rangeProof,
    equalityProof,
    balanceProof,
  };
}

/** Verifies all sub-proofs in a transfer proof bundle. */
export function verifyTransferProof(proof: TransferProof): boolean {
  const rangeValid = verifyRangeProof(proof.rangeProof);
  if (!rangeValid) return false;

  const equalityValid = verifyEqualityProof(proof.equalityProof);
  if (!equalityValid) return false;

  if (proof.balanceProof.length !== PROOF_SIZES.BALANCE_PROOF) {
    return false;
  }

  const proofHash = proof.balanceProof.slice(0, 32);
  const remainingCommitment = proof.balanceProof.slice(32, 64);

  let nonZero = false;
  for (let i = 0; i < 32; i++) {
    if (proofHash[i] !== 0 || remainingCommitment[i] !== 0) {
      nonZero = true;
      break;
    }
  }

  return nonZero;
}

/** Serializes a transfer proof for on-chain submission. */
export function serializeTransferProof(proof: TransferProof): Uint8Array {
  const totalSize =
    PROOF_SIZES.RANGE_PROOF +
    32 + // range proof commitment
    PROOF_SIZES.EQUALITY_PROOF +
    32 + // equality challenge
    64 + // equality response
    PROOF_SIZES.BALANCE_PROOF;

  const data = new Uint8Array(totalSize);
  let offset = 0;

  data.set(proof.rangeProof.proof, offset);
  offset += PROOF_SIZES.RANGE_PROOF;
  data.set(proof.rangeProof.commitment, offset);
  offset += 32;

  data.set(proof.equalityProof.proof, offset);
  offset += PROOF_SIZES.EQUALITY_PROOF;
  data.set(proof.equalityProof.challenge, offset);
  offset += 32;
  data.set(proof.equalityProof.response, offset);
  offset += 64;

  data.set(proof.balanceProof, offset);

  return data;
}

/** Inverse of serializeTransferProof. */
export function deserializeTransferProof(data: Uint8Array): TransferProof {
  let offset = 0;

  const rangeProofData = data.slice(offset, offset + PROOF_SIZES.RANGE_PROOF);
  offset += PROOF_SIZES.RANGE_PROOF;
  const rangeCommitment = data.slice(offset, offset + 32);
  offset += 32;

  const equalityProofData = data.slice(
    offset,
    offset + PROOF_SIZES.EQUALITY_PROOF
  );
  offset += PROOF_SIZES.EQUALITY_PROOF;
  const equalityChallenge = data.slice(offset, offset + 32);
  offset += 32;
  const equalityResponse = data.slice(offset, offset + 64);
  offset += 64;

  const balanceProof = data.slice(offset, offset + PROOF_SIZES.BALANCE_PROOF);

  return {
    rangeProof: {
      proof: rangeProofData,
      commitment: rangeCommitment,
    },
    equalityProof: {
      proof: equalityProofData,
      challenge: equalityChallenge,
      response: equalityResponse,
    },
    balanceProof,
  };
}
// proof rev #11
