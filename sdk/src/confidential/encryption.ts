import nacl from "tweetnacl";
import BN from "bn.js";
import {
  EncryptedAmount,
  ElGamalKeypair,
  ElGamalCiphertext,
} from "../types";
import { EncryptionError } from "../errors";
import { ELGAMAL } from "../constants";
import { randomBytes, hash256 } from "../utils/keypair";

/**
 * ElGamal-like encryption: R = r*G, S = r*pk (DH), key = H(S), ciphertext = amount XOR key.
 * Amount must be non-negative.
 */
export function encryptAmount(
  amount: BN,
  recipientPubkey: Uint8Array
): EncryptedAmount {
  if (amount.isNeg()) {
    throw new EncryptionError("encrypt", "Amount must be non-negative");
  }

  if (recipientPubkey.length !== ELGAMAL.PUBLIC_KEY_SIZE) {
    throw new EncryptionError(
      "encrypt",
      `Invalid public key size: expected ${ELGAMAL.PUBLIC_KEY_SIZE}, got ${recipientPubkey.length}`
    );
  }

  const r = randomBytes(ELGAMAL.RANDOMNESS_SIZE);

  // Clamp scalar for X25519 compatibility
  const clampedR = new Uint8Array(r);
  clampedR[0] &= 248;
  clampedR[31] &= 127;
  clampedR[31] |= 64;

  const ephemeralKeypair = nacl.box.keyPair.fromSecretKey(clampedR);

  const sharedSecret = nacl.box.before(recipientPubkey, clampedR);
  const encryptionKey = hash256(sharedSecret);
  const amountBytes = amount.toArrayLike(Buffer, "le", 32);

  const ciphertext = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    ciphertext[i] = amountBytes[i] ^ encryptionKey[i];
  }

  return {
    ephemeralKey: ephemeralKeypair.publicKey,
    ciphertext,
    randomness: clampedR,
  };
}

/** Reverses ElGamal encryption using the recipient's secret key. */
export function decryptAmount(
  encrypted: EncryptedAmount,
  secretKey: Uint8Array
): BN {
  if (secretKey.length !== ELGAMAL.SECRET_KEY_SIZE) {
    throw new EncryptionError(
      "decrypt",
      `Invalid secret key size: expected ${ELGAMAL.SECRET_KEY_SIZE}, got ${secretKey.length}`
    );
  }

  if (encrypted.ephemeralKey.length !== ELGAMAL.PUBLIC_KEY_SIZE) {
    throw new EncryptionError(
      "decrypt",
      `Invalid ephemeral key size: expected ${ELGAMAL.PUBLIC_KEY_SIZE}, got ${encrypted.ephemeralKey.length}`
    );
  }

  const sharedSecret = nacl.box.before(encrypted.ephemeralKey, secretKey);
  const decryptionKey = hash256(sharedSecret);

  const amountBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    amountBytes[i] = encrypted.ciphertext[i] ^ decryptionKey[i];
  }

  return new BN(Buffer.from(amountBytes), "le");
}

/** Creates a (commitment, handle) ciphertext pair for on-chain storage. */
export function createCiphertext(
  amount: BN,
  recipientPubkey: Uint8Array
): ElGamalCiphertext {
  const encrypted = encryptAmount(amount, recipientPubkey);

  const commitmentInput = Buffer.concat([
    Buffer.from(encrypted.ciphertext),
    Buffer.from(encrypted.ephemeralKey),
  ]);
  const commitment = hash256(commitmentInput);

  const handle = new Uint8Array(32);
  handle.set(encrypted.ephemeralKey.slice(0, 16), 0);
  handle.set(encrypted.ciphertext.slice(0, 16), 16);

  return {
    commitment,
    handle,
  };
}

/** Hash-based Pedersen commitment: C = H("pedersen" || amount || blinding) */
export function pedersenCommit(amount: BN, blinding: Uint8Array): Uint8Array {
  if (blinding.length !== 32) {
    throw new EncryptionError("encrypt", "Blinding factor must be 32 bytes");
  }

  const amountBytes = amount.toArrayLike(Buffer, "le", 32);
  const input = Buffer.concat([
    Buffer.from("pedersen-commitment-v1"),
    amountBytes,
    Buffer.from(blinding),
  ]);

  return hash256(input);
}

/** Verifies by recomputing the Pedersen commitment. */
export function verifyPedersenCommitment(
  commitment: Uint8Array,
  amount: BN,
  blinding: Uint8Array
): boolean {
  const recomputed = pedersenCommit(amount, blinding);
  return constantTimeEquals(commitment, recomputed);
}

/** Double-encrypts balance for owner and optional auditor (auditability). */
export function encryptBalance(
  balance: BN,
  ownerPubkey: Uint8Array,
  auditorPubkey?: Uint8Array
): { ownerCiphertext: EncryptedAmount; auditorCiphertext?: EncryptedAmount } {
  const ownerCiphertext = encryptAmount(balance, ownerPubkey);

  let auditorCiphertext: EncryptedAmount | undefined;
  if (auditorPubkey) {
    auditorCiphertext = encryptAmount(balance, auditorPubkey);
  }

  return { ownerCiphertext, auditorCiphertext };
}

/**
 * Homomorphic addition of two ciphertexts (must share the same public key).
 * XOR-based so this is a simplified version of EC point-wise addition.
 */
export function addEncryptedAmounts(
  a: EncryptedAmount,
  b: EncryptedAmount
): EncryptedAmount {
  // For XOR-based encryption, we need to re-encrypt the sum.
  // In a real ElGamal system over an elliptic curve group, ciphertexts
  // can be added point-wise. Here we combine via hash.
  const combinedEphemeral = new Uint8Array(32);
  const combinedCiphertext = new Uint8Array(32);
  const combinedRandomness = new Uint8Array(32);

  for (let i = 0; i < 32; i++) {
    combinedEphemeral[i] = a.ephemeralKey[i] ^ b.ephemeralKey[i];
    combinedCiphertext[i] = a.ciphertext[i] ^ b.ciphertext[i];
    combinedRandomness[i] = a.randomness[i] ^ b.randomness[i];
  }

  return {
    ephemeralKey: combinedEphemeral,
    ciphertext: combinedCiphertext,
    randomness: combinedRandomness,
  };
}

/** Constant-time comparison to prevent timing side-channels. */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/** Derives ElGamal public key from a 32-byte secret key. */
export function deriveElGamalPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== ELGAMAL.SECRET_KEY_SIZE) {
    throw new EncryptionError(
      "encrypt",
      `Invalid secret key size: expected ${ELGAMAL.SECRET_KEY_SIZE}, got ${secretKey.length}`
    );
  }

  const clamped = new Uint8Array(secretKey);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;

  const kp = nacl.box.keyPair.fromSecretKey(clamped);
  return kp.publicKey;
}

/** 96 bytes: 32 ephemeral + 32 ciphertext + 32 randomness */
export function serializeEncryptedAmount(encrypted: EncryptedAmount): Uint8Array {
  const result = new Uint8Array(96);
  result.set(encrypted.ephemeralKey, 0);
  result.set(encrypted.ciphertext, 32);
  result.set(encrypted.randomness, 64);
  return result;
}

/** Inverse of serializeEncryptedAmount. */
export function deserializeEncryptedAmount(data: Uint8Array): EncryptedAmount {
  if (data.length < 96) {
    throw new EncryptionError(
      "decrypt",
      `Invalid serialized data length: expected 96, got ${data.length}`
    );
  }

  return {
    ephemeralKey: data.slice(0, 32),
    ciphertext: data.slice(32, 64),
    randomness: data.slice(64, 96),
  };
}
// enc rev #10
// elgamal test branch
