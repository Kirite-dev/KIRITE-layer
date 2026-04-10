import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ShieldPoolState,
  ShieldPoolConfig,
  MerklePath,
  MerkleNode,
} from "../types";
import {
  PoolNotFoundError,
  AccountNotFoundError,
  NullifierSpentError,
} from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  DEFAULT_TREE_DEPTH,
  ZERO_VALUE,
  DISCRIMINATOR_SIZE,
  DEFAULT_DENOMINATIONS,
} from "../constants";
import { fetchAccountOrThrow, fetchProgramAccounts } from "../utils/connection";
import { hash256 } from "../utils/keypair";

export function derivePoolAddress(
  mint: PublicKey,
  poolIndex: number = 0,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(poolIndex, 0);
  return PublicKey.findProgramAddressSync(
    [SEEDS.POOL_STATE, mint.toBuffer(), indexBuf],
    programId
  );
}

export function derivePoolTokenAddress(
  poolAddress: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.POOL_TOKEN, poolAddress.toBuffer()],
    programId
  );
}

export function derivePoolAuthorityAddress(
  poolAddress: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.POOL_AUTHORITY, poolAddress.toBuffer()],
    programId
  );
}

/** Nullifier PDA -- existence means the deposit has been withdrawn. */
export function deriveNullifierAddress(
  nullifier: Uint8Array,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, Buffer.from(nullifier)],
    programId
  );
}

export function parsePoolState(
  data: Buffer,
  poolId: PublicKey
): ShieldPoolState {
  let offset = DISCRIMINATOR_SIZE;

  const authority = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const mint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const tokenAccount = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const merkleRoot = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const nextLeafIndex = data.readUInt32LE(offset);
  offset += 4;

  const treeDepth = data.readUInt8(offset);
  offset += 1;

  const totalDepositsLow = data.readUInt32LE(offset);
  const totalDepositsHigh = data.readUInt32LE(offset + 4);
  const totalDeposits = new BN(totalDepositsHigh).shln(32).add(new BN(totalDepositsLow));
  offset += 8;

  const totalWithdrawalsLow = data.readUInt32LE(offset);
  const totalWithdrawalsHigh = data.readUInt32LE(offset + 4);
  const totalWithdrawals = new BN(totalWithdrawalsHigh).shln(32).add(new BN(totalWithdrawalsLow));
  offset += 8;

  const denomCount = data.readUInt8(offset);
  offset += 1;

  const denominations: BN[] = [];
  for (let i = 0; i < denomCount; i++) {
    const denomLow = data.readUInt32LE(offset);
    const denomHigh = data.readUInt32LE(offset + 4);
    denominations.push(new BN(denomHigh).shln(32).add(new BN(denomLow)));
    offset += 8;
  }

  const isPaused = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);

  return {
    poolId,
    authority,
    mint,
    tokenAccount,
    merkleRoot,
    nextLeafIndex,
    treeDepth,
    totalDeposits,
    totalWithdrawals,
    denominations,
    isPaused,
    bump,
  };
}

export async function fetchPoolState(
  connection: Connection,
  poolId: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ShieldPoolState> {
  const account = await fetchAccountOrThrow(connection, poolId, "ShieldPool");

  if (!account.owner.equals(programId)) {
    throw new PoolNotFoundError(poolId.toBase58());
  }

  return parsePoolState(account.data, poolId);
}

export async function fetchPoolsByMint(
  connection: Connection,
  mint: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ShieldPoolState[]> {
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: DISCRIMINATOR_SIZE + 32, // Skip discriminator + authority
        bytes: mint.toBase58(),
      },
    },
  ]);

  return accounts.map(({ pubkey, account }) =>
    parsePoolState(account.data, pubkey)
  );
}

export async function fetchAllPools(
  connection: Connection,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ShieldPoolState[]> {
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: 0,
        bytes: "2Q8", // Base58 of the pool state discriminator prefix
      },
    },
  ]);

  const pools: ShieldPoolState[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      pools.push(parsePoolState(account.data, pubkey));
    } catch {
    }
  }

  return pools;
}

/** Returns true if the nullifier PDA account exists (already withdrawn). */
export async function isNullifierSpent(
  connection: Connection,
  nullifier: Uint8Array,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<boolean> {
  const [nullifierAddr] = deriveNullifierAddress(nullifier, programId);

  try {
    const account = await connection.getAccountInfo(nullifierAddr);
    return account !== null;
  } catch {
    return false;
  }
}

export function computeMerkleRoot(
  leaves: Uint8Array[],
  depth: number = DEFAULT_TREE_DEPTH
): Uint8Array {
  const capacity = 2 ** depth;

  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < capacity) {
    paddedLeaves.push(ZERO_VALUE);
  }

  let currentLevel = paddedLeaves;
  for (let level = 0; level < depth; level++) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || ZERO_VALUE;
      const parent = hashPair(left, right);
      nextLevel.push(parent);
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

export function computeMerklePath(
  leaves: Uint8Array[],
  leafIndex: number,
  depth: number = DEFAULT_TREE_DEPTH
): MerklePath {
  const capacity = 2 ** depth;
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < capacity) {
    paddedLeaves.push(ZERO_VALUE);
  }

  const siblings: Uint8Array[] = [];
  const pathIndices: number[] = [];

  let currentLevel = paddedLeaves;
  let currentIndex = leafIndex;

  for (let level = 0; level < depth; level++) {
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    pathIndices.push(currentIndex % 2);
    siblings.push(currentLevel[siblingIndex] || ZERO_VALUE);

    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || ZERO_VALUE;
      nextLevel.push(hashPair(left, right));
    }
    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { siblings, pathIndices };
}

export function verifyMerklePath(
  root: Uint8Array,
  leaf: Uint8Array,
  path: MerklePath
): boolean {
  let currentHash = leaf;

  for (let i = 0; i < path.siblings.length; i++) {
    if (path.pathIndices[i] === 0) {
      currentHash = hashPair(currentHash, path.siblings[i]);
    } else {
      currentHash = hashPair(path.siblings[i], currentHash);
    }
  }

  if (currentHash.length !== root.length) return false;
  let equal = true;
  for (let j = 0; j < currentHash.length; j++) {
    if (currentHash[j] !== root[j]) {
      equal = false;
      break;
    }
  }
  return equal;
}

export function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const input = Buffer.concat([
    Buffer.from("kirite-merkle-v1"),
    Buffer.from(left),
    Buffer.from(right),
  ]);
  return hash256(input);
}

export function computeLeafHash(commitment: Uint8Array): Uint8Array {
  const input = Buffer.concat([
    Buffer.from("kirite-leaf-v1"),
    Buffer.from(commitment),
  ]);
  return hash256(input);
}

/** Precomputed zero hashes per level, for efficient sparse tree construction. */
export function getZeroHashes(depth: number): Uint8Array[] {
  const zeroHashes: Uint8Array[] = [ZERO_VALUE];

  for (let i = 1; i <= depth; i++) {
    zeroHashes.push(hashPair(zeroHashes[i - 1], zeroHashes[i - 1]));
  }

  return zeroHashes;
}
