import {
  Connection,
  Commitment,
  PublicKey,
  AccountInfo,
  GetProgramAccountsFilter,
  ParsedAccountData,
  RpcResponseAndContext,
  SignatureResult,
  TransactionSignature,
} from "@solana/web3.js";
import { ConnectionError, AccountNotFoundError } from "../errors";
import { RPC_ENDPOINTS, DEFAULT_CONFIRM_TIMEOUT } from "../constants";

/**
 * Creates a Solana connection with health validation.
 * @param endpoint - RPC endpoint URL
 * @param commitment - Commitment level
 * @returns Configured Connection instance
 */
export function createConnection(
  endpoint: string,
  commitment: Commitment = "confirmed"
): Connection {
  return new Connection(endpoint, {
    commitment,
    confirmTransactionInitialTimeout: DEFAULT_CONFIRM_TIMEOUT,
  });
}

/**
 * Validates that an RPC connection is healthy by fetching the latest slot.
 * @param connection - Solana connection to validate
 * @throws ConnectionError if the connection is unhealthy
 */
export async function validateConnection(connection: Connection): Promise<void> {
  try {
    const slot = await connection.getSlot();
    if (slot <= 0) {
      throw new Error("Invalid slot returned");
    }
  } catch (err) {
    const endpoint = (connection as any)._rpcEndpoint || "unknown";
    throw new ConnectionError(endpoint, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetches an account and throws if it doesn't exist.
 * @param connection - Solana connection
 * @param address - Account address
 * @param accountType - Human-readable account type for error messages
 * @returns Account info
 */
export async function fetchAccountOrThrow(
  connection: Connection,
  address: PublicKey,
  accountType: string
): Promise<AccountInfo<Buffer>> {
  const account = await connection.getAccountInfo(address);
  if (!account) {
    throw new AccountNotFoundError(address.toBase58(), accountType);
  }
  return account;
}

/**
 * Fetches multiple accounts in a single RPC call.
 * @param connection - Solana connection
 * @param addresses - List of account addresses
 * @returns Array of account info (null for missing accounts)
 */
export async function fetchMultipleAccounts(
  connection: Connection,
  addresses: PublicKey[]
): Promise<(AccountInfo<Buffer> | null)[]> {
  const batchSize = 100;
  const results: (AccountInfo<Buffer> | null)[] = [];

  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const infos = await connection.getMultipleAccountsInfo(batch);
    results.push(...infos);
  }

  return results;
}

/**
 * Fetches all program accounts matching the given filters.
 * @param connection - Solana connection
 * @param programId - Program ID to query
 * @param filters - Account filters (memcmp, dataSize)
 * @returns Array of account entries
 */
export async function fetchProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  filters: GetProgramAccountsFilter[] = []
): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters,
  });
  return accounts;
}

/**
 * Gets the token balance for an associated token account.
 * @param connection - Solana connection
 * @param tokenAccount - Token account address
 * @returns Token balance as a bigint
 */
export async function getTokenBalance(
  connection: Connection,
  tokenAccount: PublicKey
): Promise<bigint> {
  const info = await connection.getTokenAccountBalance(tokenAccount);
  return BigInt(info.value.amount);
}

/**
 * Gets the SOL balance for an account.
 * @param connection - Solana connection
 * @param address - Account address
 * @returns Balance in lamports
 */
export async function getSolBalance(
  connection: Connection,
  address: PublicKey
): Promise<number> {
  return connection.getBalance(address);
}

/**
 * Confirms a transaction with timeout.
 * @param connection - Solana connection
 * @param signature - Transaction signature to confirm
 * @param commitment - Commitment level
 * @param timeoutMs - Timeout in milliseconds
 * @returns Signature result
 */
export async function confirmTransaction(
  connection: Connection,
  signature: TransactionSignature,
  commitment: Commitment = "confirmed",
  timeoutMs: number = DEFAULT_CONFIRM_TIMEOUT
): Promise<RpcResponseAndContext<SignatureResult>> {
  const latestBlockhash = await connection.getLatestBlockhash(commitment);

  const result = await Promise.race([
    connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      commitment
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Confirmation timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);

  return result;
}

/**
 * Gets the current slot number.
 * @param connection - Solana connection
 * @param commitment - Commitment level
 * @returns Current slot
 */
export async function getCurrentSlot(
  connection: Connection,
  commitment: Commitment = "confirmed"
): Promise<number> {
  return connection.getSlot(commitment);
}

/**
 * Gets the current block time for a slot.
 * @param connection - Solana connection
 * @param slot - Slot number
 * @returns Unix timestamp or null
 */
export async function getBlockTime(
  connection: Connection,
  slot: number
): Promise<number | null> {
  return connection.getBlockTime(slot);
}

/**
 * Resolves a network name to an RPC endpoint URL.
 * @param network - Network name or custom URL
 * @returns RPC endpoint URL
 */
export function resolveEndpoint(network: string): string {
  switch (network.toLowerCase()) {
    case "mainnet":
    case "mainnet-beta":
      return RPC_ENDPOINTS.MAINNET;
    case "devnet":
      return RPC_ENDPOINTS.DEVNET;
    case "testnet":
      return RPC_ENDPOINTS.TESTNET;
    case "localnet":
    case "localhost":
      return RPC_ENDPOINTS.LOCALNET;
    default:
      if (network.startsWith("http://") || network.startsWith("https://")) {
        return network;
      }
      throw new ConnectionError(network, "Unknown network. Use mainnet, devnet, testnet, localnet, or a URL.");
  }
}

/**
 * Fetches recent transaction signatures for an address.
 * @param connection - Solana connection
 * @param address - Account address
 * @param limit - Maximum number of signatures
 * @returns Array of confirmed signature info
 */
export async function getRecentSignatures(
  connection: Connection,
  address: PublicKey,
  limit: number = 100
) {
  return connection.getSignaturesForAddress(address, { limit });
}
// conn rev #18
