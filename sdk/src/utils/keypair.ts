import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

/** Deterministic keypair from seed + index via SHA-512. */
export function deriveKeypair(seed: Uint8Array, index: number = 0): Keypair {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(index, 0);
  const combined = Buffer.concat([Buffer.from(seed), indexBuf]);
  const hash = nacl.hash(combined);
  const secretKey = hash.slice(0, 32);
  return Keypair.fromSeed(secretKey);
}

/** Derives the stealth-address VIEW keypair (Curve25519) from a Solana keypair via domain-separated SHA-512. */
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

/** Derives the stealth-address SPEND keypair (Curve25519) from a Solana keypair via domain-separated SHA-512. */
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

export function generateKeypair(): Keypair {
  return Keypair.generate();
}

export function loadKeypairFromJson(secretKeyJson: string): Keypair {
  const parsed = JSON.parse(secretKeyJson);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("Invalid keypair JSON: expected an array of 64 numbers");
  }
  const secretKey = Uint8Array.from(parsed);
  return Keypair.fromSecretKey(secretKey);
}

export function keypairToJson(keypair: Keypair): string {
  return JSON.stringify(Array.from(keypair.secretKey));
}

/** X25519 ECDH shared secret. */
export function computeSharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = nacl.box.before(publicKey, secretKey);
  return shared;
}

export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length);
}

/** SHA-512 truncated to 32 bytes. */
export function hash256(input: Uint8Array): Uint8Array {
  return nacl.hash(input).slice(0, 32);
}
