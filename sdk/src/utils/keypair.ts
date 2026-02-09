import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { ElGamalKeypair } from "../types";

/**
 * Derives a deterministic keypair from a seed phrase and an optional derivation path index.
 * Uses SHA-512 hash of the seed concatenated with the index to generate 32 bytes.
 * @param seed - Seed bytes (e.g., from a mnemonic)
 * @param index - Derivation index (default 0)
 * @returns Solana Keypair
 */
export function deriveKeypair(seed: Uint8Array, index: number = 0): Keypair {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(index, 0);
  const combined = Buffer.concat([Buffer.from(seed), indexBuf]);
  const hash = nacl.hash(combined);
  const secretKey = hash.slice(0, 32);
  return Keypair.fromSeed(secretKey);
}

/**
 * Generates a new ElGamal keypair for confidential transfers.
 * The keypair is derived from a Solana keypair using HMAC-like derivation.
 * @param solanaKeypair - Base Solana keypair to derive from
 * @returns ElGamal keypair
 */
export function deriveElGamalKeypair(solanaKeypair: Keypair): ElGamalKeypair {
  const domain = Buffer.from("kirite-elgamal-v1");
  const input = Buffer.concat([domain, Buffer.from(solanaKeypair.secretKey.slice(0, 32))]);
  const hash = nacl.hash(input);
  const secretKey = hash.slice(0, 32);

  // Clamp the secret key for X25519/Ed25519 compatibility
  const clampedSecret = new Uint8Array(secretKey);
  clampedSecret[0] &= 248;
  clampedSecret[31] &= 127;
  clampedSecret[31] |= 64;

  const keyPair = nacl.box.keyPair.fromSecretKey(clampedSecret);

  return {
    publicKey: keyPair.publicKey,
    secretKey: clampedSecret,
  };
}

/**
 * Derives a viewing keypair for stealth address scanning.
 * @param solanaKeypair - Base Solana keypair
 * @returns Keypair used for viewing stealth payments
 */
export function deriveViewingKeypair(solanaKeypair: Keypair): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const domain = Buffer.from("kirite-viewing-v1");
  const input = Buffer.concat([domain, Buffer.from(solanaKeypair.secretKey.slice(0, 32))]);
  const hash = nacl.hash(input);
  const secretKey = hash.slice(0, 32);

  const clampedSecret = new Uint8Array(secretKey);
  clampedSecret[0] &= 248;
  clampedSecret[31] &= 127;
  clampedSecret[31] |= 64;

  const kp = nacl.box.keyPair.fromSecretKey(clampedSecret);
  return {
    publicKey: kp.publicKey,
    secretKey: clampedSecret,
  };
}

/**
 * Derives a spending keypair for stealth address control.
 * @param solanaKeypair - Base Solana keypair
 * @returns Keypair used for spending from stealth addresses
 */
export function deriveSpendingKeypair(solanaKeypair: Keypair): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const domain = Buffer.from("kirite-spending-v1");
  const input = Buffer.concat([domain, Buffer.from(solanaKeypair.secretKey.slice(0, 32))]);
  const hash = nacl.hash(input);
  const secretKey = hash.slice(0, 32);

  const clampedSecret = new Uint8Array(secretKey);
  clampedSecret[0] &= 248;
  clampedSecret[31] &= 127;
  clampedSecret[31] |= 64;

  const kp = nacl.box.keyPair.fromSecretKey(clampedSecret);
  return {
    publicKey: kp.publicKey,
    secretKey: clampedSecret,
  };
}

/**
 * Generates a new random Solana keypair.
 * @returns Fresh Solana Keypair
 */
export function generateKeypair(): Keypair {
  return Keypair.generate();
}

/**
 * Loads a keypair from a JSON secret key file content.
 * @param secretKeyJson - JSON string containing a number array
 * @returns Solana Keypair
 */
export function loadKeypairFromJson(secretKeyJson: string): Keypair {
  const parsed = JSON.parse(secretKeyJson);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("Invalid keypair JSON: expected an array of 64 numbers");
  }
  const secretKey = Uint8Array.from(parsed);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Serializes a keypair to a JSON number array.
 * @param keypair - Solana Keypair
 * @returns JSON string of secret key bytes
 */
export function keypairToJson(keypair: Keypair): string {
  return JSON.stringify(Array.from(keypair.secretKey));
}

/**
 * Computes a shared secret between two curve25519 keys using X25519.
 * @param secretKey - Own secret key (32 bytes)
 * @param publicKey - Other party's public key (32 bytes)
 * @returns Shared secret (32 bytes)
 */
export function computeSharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = nacl.box.before(publicKey, secretKey);
  return shared;
}

/**
 * Generates cryptographically secure random bytes.
 * @param length - Number of random bytes
 * @returns Random byte array
 */
export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length);
}

/**
 * Hashes input bytes using SHA-512 and returns the first 32 bytes.
 * @param input - Bytes to hash
 * @returns 32-byte hash
 */
export function hash256(input: Uint8Array): Uint8Array {
  return nacl.hash(input).slice(0, 32);
}
