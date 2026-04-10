import { PublicKey, Keypair, Connection, TransactionSignature, Commitment } from "@solana/web3.js";
import BN from "bn.js";

export interface EncryptedAmount {
  /** r * G */
  ephemeralKey: Uint8Array;
  /** m * G + r * pk */
  ciphertext: Uint8Array;
  randomness: Uint8Array;
}

export interface DecryptedTransfer {
  amount: BN;
  sender: PublicKey;
  receiver: PublicKey;
  mint: PublicKey;
  timestamp: number;
  slot: number;
}

export interface CurvePoint {
  x: Uint8Array;
  y: Uint8Array;
}

export type Scalar = Uint8Array;

export interface ElGamalKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface ElGamalCiphertext {
  commitment: Uint8Array;
  handle: Uint8Array;
}

/** Range proof: value in [0, 2^64) */
export interface RangeProof {
  proof: Uint8Array;
  commitment: Uint8Array;
}

/** Proves two ciphertexts encrypt the same value */
export interface EqualityProof {
  proof: Uint8Array;
  challenge: Uint8Array;
  response: Uint8Array;
}

export interface TransferProof {
  rangeProof: RangeProof;
  equalityProof: EqualityProof;
  /** Proof that the sender has sufficient balance */
  balanceProof: Uint8Array;
}

export interface DepositProof {
  commitment: Uint8Array;
  nullifier: Uint8Array;
  proof: Uint8Array;
}

export interface WithdrawProof {
  nullifier: Uint8Array;
  root: Uint8Array;
  proof: Uint8Array;
  recipientHash: Uint8Array;
}

export interface ShieldPoolConfig {
  denominations: BN[];
  treeDepth: number;
  authority: PublicKey;
  mint: PublicKey;
}

export interface ShieldPoolState {
  poolId: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  merkleRoot: Uint8Array;
  nextLeafIndex: number;
  treeDepth: number;
  totalDeposits: BN;
  totalWithdrawals: BN;
  denominations: BN[];
  isPaused: boolean;
  bump: number;
}

/** Must be saved by the user -- required for withdrawal */
export interface DepositNote {
  commitment: Uint8Array;
  nullifier: Uint8Array;
  secret: Uint8Array;
  amount: BN;
  leafIndex: number;
  timestamp: number;
  poolId: string;
}

export interface MerklePath {
  siblings: Uint8Array[];
  pathIndices: number[];
}

export interface MerkleNode {
  hash: Uint8Array;
  index: number;
  level: number;
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
  mint: PublicKey;
  timestamp: number;
  slot: number;
  txSignature: string;
}

export interface StealthRegistryEntry {
  owner: PublicKey;
  metaAddress: StealthMetaAddress;
  label: string;
  createdAt: number;
}

export interface KiriteClientConfig {
  endpoint: string;
  commitment?: Commitment;
  wallet?: Keypair;
  programId?: PublicKey;
  confirmTimeout?: number;
  maxRetries?: number;
  skipPreflight?: boolean;
}

export interface TransactionOptions {
  skipPreflight?: boolean;
  maxRetries?: number;
  commitment?: Commitment;
  preflightCommitment?: Commitment;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export interface ConfidentialTransferParams {
  recipient: PublicKey;
  amount: BN;
  mint: PublicKey;
  recipientElGamalPubkey: Uint8Array;
  memo?: string;
}

export interface ConfidentialTransferResult {
  signature: TransactionSignature;
  encryptedAmount: EncryptedAmount;
  proof: TransferProof;
  slot: number;
}

export interface DepositParams {
  poolId: PublicKey;
  amount: BN;
  mint: PublicKey;
}

export interface DepositResult {
  signature: TransactionSignature;
  note: DepositNote;
  slot: number;
}

export interface WithdrawParams {
  poolId: PublicKey;
  note: DepositNote;
  recipient: PublicKey;
  relayerFee?: BN;
}

export interface WithdrawResult {
  signature: TransactionSignature;
  amount: BN;
  recipient: PublicKey;
  slot: number;
}

export interface GenerateStealthParams {
  metaAddress: StealthMetaAddress;
}

export interface ScanStealthParams {
  viewingKey: Uint8Array;
  spendingKey: Uint8Array;
  fromSlot?: number;
  toSlot?: number;
}

export interface ConfidentialTransferEvent {
  sender: PublicKey;
  recipient: PublicKey;
  encryptedAmount: EncryptedAmount;
  mint: PublicKey;
  slot: number;
  timestamp: number;
  signature: string;
}

export interface ShieldDepositEvent {
  depositor: PublicKey;
  poolId: PublicKey;
  commitment: Uint8Array;
  leafIndex: number;
  amount: BN;
  slot: number;
  timestamp: number;
  signature: string;
}

export interface ShieldWithdrawEvent {
  recipient: PublicKey;
  poolId: PublicKey;
  nullifier: Uint8Array;
  amount: BN;
  slot: number;
  timestamp: number;
  signature: string;
}

export interface StealthAnnouncementEvent {
  ephemeralPubkey: Uint8Array;
  stealthAddress: PublicKey;
  viewTag: number;
  slot: number;
  timestamp: number;
  signature: string;
}
// type rev #6
