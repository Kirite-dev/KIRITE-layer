import { PublicKey, Connection, TransactionSignature, Commitment } from "@solana/web3.js";
import BN from "bn.js";

export interface ShieldPoolState {
  poolId: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  merkleRoot: Uint8Array;
  historicalRoots: Uint8Array[];
  nextLeafIndex: number;
  treeDepth: number;
  denomination: BN;
  totalDeposits: BN;
  totalWithdrawals: BN;
  isPaused: boolean;
  bump: number;
}

/** Local note saved by the depositor; required to withdraw later. Never leaves the device. */
export interface DepositNote {
  ns: Uint8Array;
  bf: Uint8Array;
  leafIndex: number;
  denomination: BN;
  pool: PublicKey;
  commitment: Uint8Array;
  timestamp: number;
}

export interface MerklePath {
  siblings: Uint8Array[];
  pathBits: number[];
}

export interface MerkleNode {
  hash: Uint8Array;
  level: number;
  index: number;
}

export interface Groth16Proof {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
}

export interface WithdrawPublicInputs {
  root: Uint8Array;
  nullifierHash: Uint8Array;
  denomination: BN;
  recipientHash: Uint8Array;
}

export interface StealthMetaAddress {
  spendingKey: Uint8Array;
  viewingKey: Uint8Array;
}

export interface StealthAddress {
  address: PublicKey;
  ephemeralPubkey: Uint8Array;
  viewTag: number;
}

export interface StealthPayment {
  address: PublicKey;
  ephemeralPubkey: Uint8Array;
  amount: BN;
  mint?: PublicKey;
  timestamp: number;
  txSignature: TransactionSignature;
  slot: number;
}

export interface StealthRegistryEntry {
  owner: PublicKey;
  metaAddress: StealthMetaAddress;
  registeredAt?: number;
  createdAt?: number;
  label?: string;
}

export interface KiriteClientConfig {
  connection: Connection;
  endpoint?: string;
  commitment?: Commitment;
  retryConfig?: RetryConfig;
  confirmTimeout?: number;
}

export interface TransactionOptions {
  priorityFee?: number | "dynamic";
  computeUnitLimit?: number;
  skipPreflight?: boolean;
  commitment?: Commitment;
  preflightCommitment?: Commitment;
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  /** Alias for initialDelayMs (legacy compat). */
  baseDelay?: number;
  /** Alias for maxDelayMs (legacy compat). */
  maxDelay?: number;
}

export interface DepositParams {
  denomination: BN;
  payer: PublicKey;
  options?: TransactionOptions;
}

export interface DepositResult {
  signature: TransactionSignature;
  note: DepositNote;
  leafIndex: number;
}

export interface WithdrawParams {
  note: DepositNote;
  recipient: PublicKey | StealthAddress;
  options?: TransactionOptions;
}

export interface WithdrawResult {
  signature: TransactionSignature;
  nullifierHash: Uint8Array;
}

export interface ScanStealthParams {
  viewingKey: Uint8Array;
  spendingKey: Uint8Array;
  fromSlot?: number;
  toSlot?: number;
}

export interface DepositCommittedEvent {
  pool: PublicKey;
  commitment: Uint8Array;
  leafIndex: number;
  slot: number;
}

export interface WithdrawEvent {
  pool: PublicKey;
  nullifierHash: Uint8Array;
  recipient: PublicKey;
  slot: number;
}

export interface StealthAnnouncementEvent {
  ephemeralPubkey: Uint8Array;
  viewTag: number;
  stealthAddress: PublicKey;
  amount?: BN;
  mint?: PublicKey;
  timestamp: number;
  signature: TransactionSignature;
  slot: number;
}
