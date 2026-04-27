import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { RetryConfig } from "./types";

/** KIRITE shield pool program (mainnet — placeholder until mainnet deploy lands). */
export const KIRITE_PROGRAM_ID = new PublicKey(
  "KRTEpRYCuGR4N7EbMqQBNHGueaLqVMR26tV7K5aCSBs"
);

/** KIRITE shield pool program (devnet). */
export const KIRITE_DEVNET_PROGRAM_ID = new PublicKey(
  "KRTEdv1YpRCuGR4N7EbMqQBNHGueaLqVMR26tGH8d3x"
);

/** Account-PDA seeds used by the on-chain program. */
export const SEEDS = {
  POOL_STATE: Buffer.from("pool_state"),
  POOL_TOKEN: Buffer.from("pool_token"),
  POOL_AUTHORITY: Buffer.from("pool_authority"),
  MERKLE_TREE: Buffer.from("merkle_tree"),
  NULLIFIER: Buffer.from("nullifier"),
  STEALTH_REGISTRY: Buffer.from("stealth_registry"),
  STEALTH_ANNOUNCEMENT: Buffer.from("stealth_announcement"),
} as const;

/** v1 pools use a height-5 Merkle tree (32 leaves). */
export const DEFAULT_TREE_DEPTH = 5;
export const MAX_TREE_DEPTH = 10;
export const DEFAULT_TREE_CAPACITY = 1 << DEFAULT_TREE_DEPTH;

/** Fixed-denomination ladder for v1 (lamports). */
export const DEFAULT_DENOMINATIONS = [
  new BN(10_000_000),       // 0.01 SOL
  new BN(50_000_000),       // 0.05 SOL
  new BN(100_000_000),      // 0.1 SOL
  new BN(1_000_000_000),    // 1 SOL
  new BN(10_000_000_000),   // 10 SOL
];

export const STEALTH = {
  VIEW_TAG_SIZE: 1,
  EPHEMERAL_KEY_SIZE: 32,
  META_ADDRESS_SIZE: 64,
} as const;

export const RPC_ENDPOINTS = {
  MAINNET: "https://api.mainnet-beta.solana.com",
  DEVNET: "https://api.devnet.solana.com",
  TESTNET: "https://api.testnet.solana.com",
  LOCALNET: "http://localhost:8899",
} as const;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

export const DEFAULT_CONFIRM_TIMEOUT = 30_000;

/** Per-instruction compute-unit budget bumps. */
export const COMPUTE_BUDGET = {
  SHIELD_DEPOSIT: 200_000,
  SHIELD_WITHDRAW: 400_000,
  STEALTH_SEND: 100_000,
  REGISTRY_UPDATE: 60_000,
} as const;

/** BN254 field modulus for proof arithmetic. */
export const BN254_FIELD_MODULUS = new BN(
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
  16
);

export const ZERO_VALUE = Buffer.alloc(32, 0);

export const DISCRIMINATOR_SIZE = 8;
export const MAX_MEMO_LENGTH = 256;
