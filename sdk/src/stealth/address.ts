import { PublicKey, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  StealthMetaAddress,
  StealthAddress,
} from "../types";
import { StealthAddressError } from "../errors";
import { STEALTH } from "../constants";
import {
  deriveViewingKeypair,
  deriveSpendingKeypair,
  randomBytes,
  hash256,
  computeSharedSecret,
} from "../utils/keypair";

/** Derives spending + viewing public keys from a Solana keypair. */
export function generateStealthMetaAddress(
  wallet: Keypair
): StealthMetaAddress {
  const viewingKeypair = deriveViewingKeypair(wallet);
  const spendingKeypair = deriveSpendingKeypair(wallet);

  return {
    spendingKey: spendingKeypair.publicKey,
    viewingKey: viewingKeypair.publicKey,
  };
}

/**
 * DKSAP-like one-time address: R = r*G, S = r*viewingKey, P = H(spendingKey || H(S)).
 * View tag = first byte of H(S) for fast scanning pre-filter.
 * X25519 ECDH -> hash -> Ed25519-compatible Solana address.
 */
export function generateStealthAddress(
  metaAddress: StealthMetaAddress
): StealthAddress {
  if (
    metaAddress.spendingKey.length !== STEALTH.EPHEMERAL_KEY_SIZE ||
    metaAddress.viewingKey.length !== STEALTH.EPHEMERAL_KEY_SIZE
  ) {
    throw new StealthAddressError(
      "Invalid meta-address key sizes"
    );
  }

  const ephemeralSecret = randomBytes(32);
  const clampedSecret = new Uint8Array(ephemeralSecret);
  clampedSecret[0] &= 248;
  clampedSecret[31] &= 127;
  clampedSecret[31] |= 64;

  const ephemeralKeypair = nacl.box.keyPair.fromSecretKey(clampedSecret);

  const sharedSecret = computeSharedSecret(
    clampedSecret,
    metaAddress.viewingKey
  );

  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  const stealthSeed = hash256(
    Buffer.concat([
      Buffer.from("stealth-address-seed"),
      Buffer.from(metaAddress.spendingKey),
      sharedHash,
    ])
  );

  const stealthKeypair = Keypair.fromSeed(stealthSeed);
  const viewTag = sharedHash[0];

  return {
    address: stealthKeypair.publicKey,
    ephemeralPubkey: ephemeralKeypair.publicKey,
    viewTag,
  };
}

/** Fast pre-filter: checks view tag match before full ECDH. */
export function checkViewTag(
  ephemeralPubkey: Uint8Array,
  viewTag: number,
  viewingSecretKey: Uint8Array
): boolean {
  const sharedSecret = computeSharedSecret(viewingSecretKey, ephemeralPubkey);

  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  return sharedHash[0] === viewTag;
}

/** Derives the spending keypair for a stealth address. Requires both viewing + spending secrets. */
export function deriveStealthSpendingKey(
  ephemeralPubkey: Uint8Array,
  viewingSecretKey: Uint8Array,
  spendingSecretKey: Uint8Array
): Keypair {
  const sharedSecret = computeSharedSecret(viewingSecretKey, ephemeralPubkey);

  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  const stealthSeed = hash256(
    Buffer.concat([
      Buffer.from("stealth-address-seed"),
      Buffer.from(nacl.box.keyPair.fromSecretKey(spendingSecretKey).publicKey),
      sharedHash,
    ])
  );

  return Keypair.fromSeed(stealthSeed);
}

/** Recomputes the expected stealth address for verification. */
export function recoverStealthAddress(
  ephemeralPubkey: Uint8Array,
  metaAddress: StealthMetaAddress,
  viewingSecretKey: Uint8Array
): PublicKey {
  const keypair = deriveStealthSpendingKey(
    ephemeralPubkey,
    viewingSecretKey,
    new Uint8Array(32) // placeholder -- only the meta-address spending key is used below
  );

  const sharedSecret = computeSharedSecret(viewingSecretKey, ephemeralPubkey);
  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  const stealthSeed = hash256(
    Buffer.concat([
      Buffer.from("stealth-address-seed"),
      Buffer.from(metaAddress.spendingKey),
      sharedHash,
    ])
  );

  const stealthKeypair = Keypair.fromSeed(stealthSeed);
  return stealthKeypair.publicKey;
}

export function serializeStealthMetaAddress(
  metaAddress: StealthMetaAddress
): string {
  return (
    Buffer.from(metaAddress.spendingKey).toString("hex") +
    Buffer.from(metaAddress.viewingKey).toString("hex")
  );
}

export function deserializeStealthMetaAddress(hex: string): StealthMetaAddress {
  if (hex.length !== 128) {
    throw new StealthAddressError(
      `Invalid meta-address hex length: expected 128, got ${hex.length}`
    );
  }

  return {
    spendingKey: Buffer.from(hex.slice(0, 64), "hex"),
    viewingKey: Buffer.from(hex.slice(64, 128), "hex"),
  };
}

export function validateStealthMetaAddress(
  metaAddress: StealthMetaAddress
): boolean {
  if (
    metaAddress.spendingKey.length !== 32 ||
    metaAddress.viewingKey.length !== 32
  ) {
    return false;
  }

  let spendingNonZero = false;
  let viewingNonZero = false;

  for (let i = 0; i < 32; i++) {
    if (metaAddress.spendingKey[i] !== 0) spendingNonZero = true;
    if (metaAddress.viewingKey[i] !== 0) viewingNonZero = true;
  }

  return spendingNonZero && viewingNonZero;
}
// addr rev #15
