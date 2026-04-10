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

export function createConnection(
  endpoint: string,
  commitment: Commitment = "confirmed"
): Connection {
  return new Connection(endpoint, {
    commitment,
    confirmTransactionInitialTimeout: DEFAULT_CONFIRM_TIMEOUT,
  });
}

/** @throws ConnectionError if the endpoint is unreachable or returns invalid data */
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

/** @throws AccountNotFoundError */
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

/** Batched getMultipleAccountsInfo (100 per RPC call). */
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

export async function getTokenBalance(
  connection: Connection,
  tokenAccount: PublicKey
): Promise<bigint> {
  const info = await connection.getTokenAccountBalance(tokenAccount);
  return BigInt(info.value.amount);
}

export async function getSolBalance(
  connection: Connection,
  address: PublicKey
): Promise<number> {
  return connection.getBalance(address);
}

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

export async function getCurrentSlot(
  connection: Connection,
  commitment: Commitment = "confirmed"
): Promise<number> {
  return connection.getSlot(commitment);
}

export async function getBlockTime(
  connection: Connection,
  slot: number
): Promise<number | null> {
  return connection.getBlockTime(slot);
}

/** Maps "mainnet"/"devnet"/etc. to RPC URL, or passes through a URL. */
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

export async function getRecentSignatures(
  connection: Connection,
  address: PublicKey,
  limit: number = 100
) {
  return connection.getSignaturesForAddress(address, { limit });
}
// conn rev #18
