import {
  Connection,
  Keypair,
  PublicKey,
  TransactionSignature,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  KiriteClientConfig,
  ConfidentialTransferParams,
  ConfidentialTransferResult,
  DepositParams,
  DepositResult,
  WithdrawParams,
  WithdrawResult,
  DepositNote,
  StealthMetaAddress,
  StealthAddress,
  StealthPayment,
  ShieldPoolState,
  StealthRegistryEntry,
  DecryptedTransfer,
  ElGamalKeypair,
  TransactionOptions,
  ScanStealthParams,
} from "./types";
import {
  WalletNotConnectedError,
  ConnectionError,
} from "./errors";
import {
  KIRITE_PROGRAM_ID,
  DEFAULT_CONFIRM_TIMEOUT,
  DEFAULT_RETRY_CONFIG,
} from "./constants";
import {
  createConnection,
  validateConnection,
  resolveEndpoint,
} from "./utils/connection";
import {
  deriveElGamalKeypair,
  deriveViewingKeypair,
  deriveSpendingKeypair,
} from "./utils/keypair";
import {
  executeConfidentialTransfer,
  decryptIncomingTransfers,
  getConfidentialBalance,
  buildInitConfidentialAccountInstruction,
} from "./confidential/transfer";
import { encryptAmount, decryptAmount } from "./confidential/encryption";
import {
  executeDeposit,
  serializeDepositNote,
  deserializeDepositNote,
} from "./shield-pool/deposit";
import { executeWithdraw, estimateRelayerFee } from "./shield-pool/withdraw";
import {
  fetchPoolState,
  fetchPoolsByMint,
  fetchAllPools,
  isNullifierSpent,
} from "./shield-pool/pool-state";
import {
  generateStealthMetaAddress,
  generateStealthAddress,
  deriveStealthSpendingKey,
} from "./stealth/address";
import {
  scanStealthPayments,
  scanStealthPaymentsFromLogs,
} from "./stealth/scan";
import {
  registerStealthMetaAddress,
  publishStealthAnnouncement,
  lookupStealthMetaAddress,
  fetchRegistryEntry,
  fetchAllRegistryEntries,
} from "./stealth/registry";
import {
  buildTransaction,
  sendAndConfirmTransaction,
} from "./utils/transaction";

/**
 * Main entry point for the KIRITE privacy protocol SDK.
 *
 * Provides a unified interface for:
 * - Confidential transfers (encrypted amounts)
 * - Shield pool operations (deposit/withdraw for unlinkability)
 * - Stealth addresses (one-time recipient addresses)
 *
 * @example
 * ```typescript
 * const client = new KiriteClient({
 *   endpoint: "https://api.devnet.solana.com",
 *   wallet: myKeypair,
 * });
 *
 * await client.connect();
 *
 * // Confidential transfer
 * const result = await client.confidentialTransfer({
 *   recipient: recipientPubkey,
 *   amount: new BN(1_000_000),
 *   mint: usdcMint,
 *   recipientElGamalPubkey: recipientElGamal,
 * });
 * ```
 */
export class KiriteClient {
  private connection: Connection;
  private wallet: Keypair | null;
  private programId: PublicKey;
  private confirmTimeout: number;
  private defaultOptions: TransactionOptions;
  private elGamalKeypair: ElGamalKeypair | null = null;
  private isConnected: boolean = false;

  constructor(config: KiriteClientConfig) {
    const endpoint = config.endpoint.startsWith("http")
      ? config.endpoint
      : resolveEndpoint(config.endpoint);

    this.connection = createConnection(
      endpoint,
      config.commitment || "confirmed"
    );
    this.wallet = config.wallet || null;
    this.programId = config.programId || KIRITE_PROGRAM_ID;
    this.confirmTimeout = config.confirmTimeout || DEFAULT_CONFIRM_TIMEOUT;
    this.defaultOptions = {
      skipPreflight: config.skipPreflight || false,
      maxRetries: config.maxRetries || DEFAULT_RETRY_CONFIG.maxRetries,
      commitment: config.commitment || "confirmed",
    };

    if (this.wallet) {
      this.elGamalKeypair = deriveElGamalKeypair(this.wallet);
    }
  }

  /** @throws ConnectionError if the connection is unhealthy */
  async connect(): Promise<void> {
    await validateConnection(this.connection);
    this.isConnected = true;
  }

  getConnection(): Connection {
    return this.connection;
  }

  /** @throws WalletNotConnectedError if no wallet is set */
  getWalletPublicKey(): PublicKey {
    if (!this.wallet) {
      throw new WalletNotConnectedError();
    }
    return this.wallet.publicKey;
  }

  setWallet(wallet: Keypair): void {
    this.wallet = wallet;
    this.elGamalKeypair = deriveElGamalKeypair(wallet);
  }

  /** @throws WalletNotConnectedError if no wallet is set */
  getElGamalPublicKey(): Uint8Array {
    if (!this.elGamalKeypair) {
      throw new WalletNotConnectedError();
    }
    return this.elGamalKeypair.publicKey;
  }

  getProgramId(): PublicKey {
    return this.programId;
  }

  isReady(): boolean {
    return this.isConnected && this.wallet !== null;
  }

  async initConfidentialAccount(
    mint: PublicKey,
    options?: TransactionOptions
  ): Promise<TransactionSignature> {
    this.requireWallet();

    const ix = buildInitConfidentialAccountInstruction(
      this.wallet!.publicKey,
      mint,
      this.elGamalKeypair!.publicKey,
      this.programId
    );

    const tx = await buildTransaction(
      this.connection,
      this.wallet!.publicKey,
      [ix]
    );

    return sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet!],
      options || this.defaultOptions
    );
  }

  async confidentialTransfer(
    params: ConfidentialTransferParams,
    options?: TransactionOptions
  ): Promise<ConfidentialTransferResult> {
    this.requireWallet();

    return executeConfidentialTransfer(
      this.connection,
      this.wallet!,
      params,
      options || this.defaultOptions,
      this.programId
    );
  }

  async getConfidentialBalance(mint: PublicKey): Promise<BN> {
    this.requireWallet();

    return getConfidentialBalance(
      this.connection,
      this.wallet!,
      mint,
      this.programId
    );
  }

  async decryptTransfers(
    mint: PublicKey,
    fromSlot?: number
  ): Promise<DecryptedTransfer[]> {
    this.requireWallet();

    return decryptIncomingTransfers(
      this.connection,
      this.wallet!,
      mint,
      fromSlot,
      this.programId
    );
  }

  encryptAmount(amount: BN, recipientElGamalPubkey: Uint8Array) {
    return encryptAmount(amount, recipientElGamalPubkey);
  }

  decryptAmount(encrypted: { ephemeralKey: Uint8Array; ciphertext: Uint8Array; randomness: Uint8Array }): BN {
    this.requireWallet();
    return decryptAmount(encrypted, this.elGamalKeypair!.secretKey);
  }

  /** @returns Deposit result with note needed for later withdrawal */
  async deposit(
    params: DepositParams,
    options?: TransactionOptions
  ): Promise<DepositResult> {
    this.requireWallet();

    return executeDeposit(
      this.connection,
      this.wallet!,
      params,
      options || this.defaultOptions,
      this.programId
    );
  }

  async withdraw(
    params: WithdrawParams,
    options?: TransactionOptions
  ): Promise<WithdrawResult> {
    this.requireWallet();

    return executeWithdraw(
      this.connection,
      this.wallet!,
      params,
      options || this.defaultOptions,
      this.programId
    );
  }

  async getPoolState(poolId: PublicKey): Promise<ShieldPoolState> {
    return fetchPoolState(this.connection, poolId, this.programId);
  }

  async getPoolsByMint(mint: PublicKey): Promise<ShieldPoolState[]> {
    return fetchPoolsByMint(this.connection, mint, this.programId);
  }

  async getAllPools(): Promise<ShieldPoolState[]> {
    return fetchAllPools(this.connection, this.programId);
  }

  async isNoteSpent(note: DepositNote | Uint8Array): Promise<boolean> {
    const nullifier = note instanceof Uint8Array ? note : note.nullifier;
    return isNullifierSpent(this.connection, nullifier, this.programId);
  }

  serializeNote(note: DepositNote): string {
    return serializeDepositNote(note);
  }

  deserializeNote(encoded: string): DepositNote {
    return deserializeDepositNote(encoded);
  }

  async estimateRelayerFee(): Promise<BN> {
    return estimateRelayerFee(this.connection);
  }

  generateStealthMetaAddress(): StealthMetaAddress {
    this.requireWallet();
    return generateStealthMetaAddress(this.wallet!);
  }

  generateStealthAddress(
    recipientMetaAddress: StealthMetaAddress
  ): StealthAddress {
    return generateStealthAddress(recipientMetaAddress);
  }

  async registerStealth(
    label: string = "",
    options?: TransactionOptions
  ): Promise<TransactionSignature> {
    this.requireWallet();

    const metaAddress = generateStealthMetaAddress(this.wallet!);
    return registerStealthMetaAddress(
      this.connection,
      this.wallet!,
      metaAddress,
      label,
      options || this.defaultOptions,
      this.programId
    );
  }

  async lookupStealthAddress(
    recipient: PublicKey
  ): Promise<StealthMetaAddress> {
    return lookupStealthMetaAddress(
      this.connection,
      recipient,
      this.programId
    );
  }

  async announceStealthPayment(
    ephemeralPubkey: Uint8Array,
    stealthAddress: PublicKey,
    viewTag: number,
    options?: TransactionOptions
  ): Promise<TransactionSignature> {
    this.requireWallet();

    return publishStealthAnnouncement(
      this.connection,
      this.wallet!,
      ephemeralPubkey,
      stealthAddress,
      viewTag,
      options || this.defaultOptions,
      this.programId
    );
  }

  async scanStealthPayments(
    fromSlot?: number,
    toSlot?: number
  ): Promise<StealthPayment[]> {
    this.requireWallet();

    const viewingKeypair = deriveViewingKeypair(this.wallet!);
    const spendingKeypair = deriveSpendingKeypair(this.wallet!);

    return scanStealthPayments(
      this.connection,
      {
        viewingKey: viewingKeypair.secretKey,
        spendingKey: spendingKeypair.secretKey,
        fromSlot,
        toSlot,
      },
      this.programId
    );
  }

  deriveStealthSpendingKey(ephemeralPubkey: Uint8Array): Keypair {
    this.requireWallet();

    const viewingKeypair = deriveViewingKeypair(this.wallet!);
    const spendingKeypair = deriveSpendingKeypair(this.wallet!);

    return deriveStealthSpendingKey(
      ephemeralPubkey,
      viewingKeypair.secretKey,
      spendingKeypair.secretKey
    );
  }

  async getRegistryEntry(
    owner: PublicKey
  ): Promise<StealthRegistryEntry> {
    return fetchRegistryEntry(this.connection, owner, this.programId);
  }

  async getAllRegistryEntries(): Promise<StealthRegistryEntry[]> {
    return fetchAllRegistryEntries(this.connection, this.programId);
  }

  private requireWallet(): void {
    if (!this.wallet) {
      throw new WalletNotConnectedError();
    }
  }
}
// rev11
// client rev #9
