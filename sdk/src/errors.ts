/** Base error class for all KIRITE errors */
export class KiriteError extends Error {
  public readonly code: number;
  public readonly context: Record<string, unknown>;

  constructor(message: string, code: number, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "KiriteError";
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, KiriteError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
    };
  }
}

/** Error thrown when wallet is not configured */
export class WalletNotConnectedError extends KiriteError {
  constructor() {
    super("Wallet not connected. Provide a keypair in client config.", 1000);
    this.name = "WalletNotConnectedError";
    Object.setPrototypeOf(this, WalletNotConnectedError.prototype);
  }
}

/** Error thrown when RPC connection fails */
export class ConnectionError extends KiriteError {
  constructor(endpoint: string, cause?: string) {
    super(
      `Failed to connect to RPC endpoint: ${endpoint}${cause ? ` (${cause})` : ""}`,
      1001,
      { endpoint }
    );
    this.name = "ConnectionError";
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/** Error thrown when a transaction fails */
export class TransactionError extends KiriteError {
  public readonly signature?: string;
  public readonly logs?: string[];

  constructor(message: string, signature?: string, logs?: string[]) {
    super(message, 2000, { signature, logs });
    this.name = "TransactionError";
    this.signature = signature;
    this.logs = logs;
    Object.setPrototypeOf(this, TransactionError.prototype);
  }
}

/** Error thrown when transaction confirmation times out */
export class ConfirmationTimeoutError extends TransactionError {
  constructor(signature: string, timeoutMs: number) {
    super(
      `Transaction confirmation timed out after ${timeoutMs}ms`,
      signature
    );
    this.name = "ConfirmationTimeoutError";
    Object.setPrototypeOf(this, ConfirmationTimeoutError.prototype);
  }
}

/** Error thrown when transaction simulation fails */
export class SimulationError extends TransactionError {
  constructor(logs: string[]) {
    super("Transaction simulation failed", undefined, logs);
    this.name = "SimulationError";
    Object.setPrototypeOf(this, SimulationError.prototype);
  }
}

/** Error thrown when encryption/decryption fails */
export class EncryptionError extends KiriteError {
  constructor(operation: "encrypt" | "decrypt", reason: string) {
    super(`${operation} failed: ${reason}`, 3000, { operation });
    this.name = "EncryptionError";
    Object.setPrototypeOf(this, EncryptionError.prototype);
  }
}

/** Error thrown when proof generation fails */
export class ProofError extends KiriteError {
  constructor(proofType: string, reason: string) {
    super(`Failed to generate ${proofType} proof: ${reason}`, 3001, { proofType });
    this.name = "ProofError";
    Object.setPrototypeOf(this, ProofError.prototype);
  }
}

/** Error thrown when proof verification fails */
export class ProofVerificationError extends KiriteError {
  constructor(proofType: string) {
    super(`${proofType} proof verification failed`, 3002, { proofType });
    this.name = "ProofVerificationError";
    Object.setPrototypeOf(this, ProofVerificationError.prototype);
  }
}

/** Error thrown for invalid amounts */
export class InvalidAmountError extends KiriteError {
  constructor(amount: string, reason: string) {
    super(`Invalid amount ${amount}: ${reason}`, 4000, { amount });
    this.name = "InvalidAmountError";
    Object.setPrototypeOf(this, InvalidAmountError.prototype);
  }
}

/** Error thrown when pool is not found */
export class PoolNotFoundError extends KiriteError {
  constructor(poolId: string) {
    super(`Shield pool not found: ${poolId}`, 4001, { poolId });
    this.name = "PoolNotFoundError";
    Object.setPrototypeOf(this, PoolNotFoundError.prototype);
  }
}

/** Error thrown when pool is paused */
export class PoolPausedError extends KiriteError {
  constructor(poolId: string) {
    super(`Shield pool is paused: ${poolId}`, 4002, { poolId });
    this.name = "PoolPausedError";
    Object.setPrototypeOf(this, PoolPausedError.prototype);
  }
}

/** Error thrown when denomination is not supported */
export class InvalidDenominationError extends KiriteError {
  constructor(amount: string, supported: string[]) {
    super(
      `Amount ${amount} is not a supported denomination. Supported: ${supported.join(", ")}`,
      4003,
      { amount, supported }
    );
    this.name = "InvalidDenominationError";
    Object.setPrototypeOf(this, InvalidDenominationError.prototype);
  }
}

/** Error thrown when a nullifier has been spent */
export class NullifierSpentError extends KiriteError {
  constructor(nullifier: string) {
    super(`Nullifier already spent: ${nullifier}`, 4004, { nullifier });
    this.name = "NullifierSpentError";
    Object.setPrototypeOf(this, NullifierSpentError.prototype);
  }
}

/** Error thrown when the Merkle tree is full */
export class TreeFullError extends KiriteError {
  constructor(poolId: string, capacity: number) {
    super(`Merkle tree full for pool ${poolId} (capacity: ${capacity})`, 4005, {
      poolId,
      capacity,
    });
    this.name = "TreeFullError";
    Object.setPrototypeOf(this, TreeFullError.prototype);
  }
}

/** Error thrown for stealth address issues */
export class StealthAddressError extends KiriteError {
  constructor(reason: string) {
    super(`Stealth address error: ${reason}`, 5000);
    this.name = "StealthAddressError";
    Object.setPrototypeOf(this, StealthAddressError.prototype);
  }
}

/** Error thrown when registry entry is not found */
export class RegistryNotFoundError extends KiriteError {
  constructor(owner: string) {
    super(`Stealth registry entry not found for: ${owner}`, 5001, { owner });
    this.name = "RegistryNotFoundError";
    Object.setPrototypeOf(this, RegistryNotFoundError.prototype);
  }
}

/** Error thrown when an account is not found on-chain */
export class AccountNotFoundError extends KiriteError {
  constructor(address: string, accountType: string) {
    super(`${accountType} account not found at ${address}`, 6000, {
      address,
      accountType,
    });
    this.name = "AccountNotFoundError";
    Object.setPrototypeOf(this, AccountNotFoundError.prototype);
  }
}

/** Error thrown for insufficient balance */
export class InsufficientBalanceError extends KiriteError {
  constructor(required: string, available: string) {
    super(`Insufficient balance: need ${required}, have ${available}`, 6001, {
      required,
      available,
    });
    this.name = "InsufficientBalanceError";
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}

/** Error code mapping from on-chain program errors */
const PROGRAM_ERROR_MAP: Record<number, string> = {
  6000: "Invalid proof",
  6001: "Amount overflow",
  6002: "Insufficient balance",
  6003: "Invalid nullifier",
  6004: "Nullifier already spent",
  6005: "Invalid Merkle root",
  6006: "Tree is full",
  6007: "Pool is paused",
  6008: "Invalid denomination",
  6009: "Unauthorized",
  6010: "Invalid stealth address",
  6011: "Registry entry exists",
  6012: "Invalid commitment",
  6013: "Invalid encryption key",
  6014: "Decryption failed",
  6015: "Invalid range proof",
  6016: "Invalid equality proof",
};

/**
 * Parses an on-chain error from transaction logs into a typed KiriteError.
 * @param logs - Transaction log messages
 * @returns Parsed KiriteError or generic TransactionError
 */
export function parseTransactionError(logs: string[]): KiriteError {
  for (const log of logs) {
    const anchorMatch = log.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+)/);
    if (anchorMatch) {
      const errorNumber = parseInt(anchorMatch[2], 10);
      const errorMessage = anchorMatch[3];
      const mappedMessage = PROGRAM_ERROR_MAP[errorNumber] || errorMessage;
      return new KiriteError(mappedMessage, errorNumber, {
        errorCode: anchorMatch[1],
        logs,
      });
    }

    const customMatch = log.match(/Program log: Error: (.+)/);
    if (customMatch) {
      return new KiriteError(customMatch[1], 2000, { logs });
    }

    if (log.includes("insufficient lamports")) {
      return new InsufficientBalanceError("unknown", "unknown");
    }

    if (log.includes("custom program error: 0x")) {
      const hexMatch = log.match(/custom program error: (0x[0-9a-fA-F]+)/);
      if (hexMatch) {
        const code = parseInt(hexMatch[1], 16);
        const message = PROGRAM_ERROR_MAP[code] || `Unknown program error: ${hexMatch[1]}`;
        return new KiriteError(message, code, { logs });
      }
    }
  }

  return new TransactionError("Transaction failed with unknown error", undefined, logs);
}

/**
 * Checks if an error is a specific KIRITE error type.
 * @param error - Error to check
 * @param errorClass - Error class to check against
 */
export function isKiriteError<T extends KiriteError>(
  error: unknown,
  errorClass: new (...args: any[]) => T
): error is T {
  return error instanceof errorClass;
}
// err rev #8
