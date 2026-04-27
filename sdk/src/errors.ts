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

export class WalletNotConnectedError extends KiriteError {
  constructor() {
    super("Wallet not connected. Provide a keypair in client config.", 1000);
    this.name = "WalletNotConnectedError";
    Object.setPrototypeOf(this, WalletNotConnectedError.prototype);
  }
}

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

export class ConfirmationTimeoutError extends TransactionError {
  constructor(signature: string, timeoutMs: number) {
    super(`Transaction confirmation timed out after ${timeoutMs}ms`, signature);
    this.name = "ConfirmationTimeoutError";
    Object.setPrototypeOf(this, ConfirmationTimeoutError.prototype);
  }
}

export class SimulationError extends TransactionError {
  constructor(logs: string[]) {
    super("Transaction simulation failed", undefined, logs);
    this.name = "SimulationError";
    Object.setPrototypeOf(this, SimulationError.prototype);
  }
}

export class ProofError extends KiriteError {
  constructor(reason: string, context: Record<string, unknown> = {}) {
    super(`Proof error: ${reason}`, 4000, context);
    this.name = "ProofError";
    Object.setPrototypeOf(this, ProofError.prototype);
  }
}

export class InvalidAmountError extends KiriteError {
  constructor(amount: string, reason: string) {
    super(`Invalid amount ${amount}: ${reason}`, 5000, { amount, reason });
    this.name = "InvalidAmountError";
    Object.setPrototypeOf(this, InvalidAmountError.prototype);
  }
}

export class PoolNotFoundError extends KiriteError {
  constructor(poolId: string) {
    super(`Pool not found: ${poolId}`, 5001, { poolId });
    this.name = "PoolNotFoundError";
    Object.setPrototypeOf(this, PoolNotFoundError.prototype);
  }
}

export class PoolFrozenError extends KiriteError {
  constructor(poolId: string) {
    super(`Pool is frozen by authority: ${poolId}`, 5002, { poolId });
    this.name = "PoolFrozenError";
    Object.setPrototypeOf(this, PoolFrozenError.prototype);
  }
}

export class InvalidDenominationError extends KiriteError {
  constructor(denomination: string, allowed: string[]) {
    super(
      `Invalid denomination ${denomination}. Allowed: ${allowed.join(", ")}`,
      5003,
      { denomination, allowed }
    );
    this.name = "InvalidDenominationError";
    Object.setPrototypeOf(this, InvalidDenominationError.prototype);
  }
}

export class NullifierSpentError extends KiriteError {
  constructor(nullifierHash: string) {
    super(`Nullifier already spent: ${nullifierHash}`, 5004, { nullifierHash });
    this.name = "NullifierSpentError";
    Object.setPrototypeOf(this, NullifierSpentError.prototype);
  }
}

export class TreeFullError extends KiriteError {
  constructor(poolId: string, capacity: number) {
    super(`Merkle tree is full for pool ${poolId} (capacity ${capacity})`, 5005, {
      poolId,
      capacity,
    });
    this.name = "TreeFullError";
    Object.setPrototypeOf(this, TreeFullError.prototype);
  }
}

export class StealthAddressError extends KiriteError {
  constructor(reason: string) {
    super(`Stealth address error: ${reason}`, 6000);
    this.name = "StealthAddressError";
    Object.setPrototypeOf(this, StealthAddressError.prototype);
  }
}

export class RegistryNotFoundError extends KiriteError {
  constructor(owner: string) {
    super(`Stealth registry entry not found for owner: ${owner}`, 6001, { owner });
    this.name = "RegistryNotFoundError";
    Object.setPrototypeOf(this, RegistryNotFoundError.prototype);
  }
}

export class AccountNotFoundError extends KiriteError {
  constructor(account: string) {
    super(`Account not found: ${account}`, 7000, { account });
    this.name = "AccountNotFoundError";
    Object.setPrototypeOf(this, AccountNotFoundError.prototype);
  }
}

export class InsufficientBalanceError extends KiriteError {
  constructor(required: string, available: string) {
    super(`Insufficient balance. Required: ${required}, available: ${available}`, 7001, {
      required,
      available,
    });
    this.name = "InsufficientBalanceError";
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}

export class RelayerError extends KiriteError {
  constructor(reason: string, status?: number) {
    super(`Relayer error: ${reason}`, 8000, { status });
    this.name = "RelayerError";
    Object.setPrototypeOf(this, RelayerError.prototype);
  }
}

export function isKiriteError(error: unknown): error is KiriteError {
  return error instanceof KiriteError;
}

export function parseTransactionError(logs: string[] | undefined): KiriteError | null {
  if (!logs || logs.length === 0) return null;

  const joined = logs.join("\n").toLowerCase();

  if (joined.includes("nullifier") && (joined.includes("already") || joined.includes("spent"))) {
    return new NullifierSpentError("(see logs)");
  }
  if (joined.includes("tree") && joined.includes("full")) {
    return new TreeFullError("(unknown)", 0);
  }
  if (joined.includes("pool") && (joined.includes("frozen") || joined.includes("paused"))) {
    return new PoolFrozenError("(unknown)");
  }
  if (joined.includes("invalid") && joined.includes("proof")) {
    return new ProofError("on-chain verifier rejected proof");
  }

  return null;
}
