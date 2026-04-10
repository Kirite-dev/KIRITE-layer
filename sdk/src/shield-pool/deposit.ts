import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  DepositParams,
  DepositResult,
  DepositNote,
  DepositProof,
  TransactionOptions,
} from "../types";
import {
  InvalidAmountError,
  InvalidDenominationError,
  PoolPausedError,
  TreeFullError,
  WalletNotConnectedError,
} from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  COMPUTE_BUDGET,
  DEFAULT_TREE_DEPTH,
} from "../constants";
import {
  derivePoolAddress,
  derivePoolTokenAddress,
  derivePoolAuthorityAddress,
  fetchPoolState,
  computeLeafHash,
} from "./pool-state";
import { buildTransaction, sendAndConfirmTransaction } from "../utils/transaction";
import { randomBytes, hash256 } from "../utils/keypair";

/**
 * commitment = H("deposit-commitment" || secret || nullifier_secret || amount)
 * nullifier = H("deposit-nullifier" || nullifier_secret || pool_id)
 */
export function generateDepositSecrets(
  amount: BN,
  poolId: PublicKey
): { commitment: Uint8Array; nullifier: Uint8Array; secret: Uint8Array; nullifierSecret: Uint8Array } {
  const secret = randomBytes(32);
  const nullifierSecret = randomBytes(32);
  const amountBytes = amount.toArrayLike(Buffer, "le", 32);

  const commitment = hash256(
    Buffer.concat([
      Buffer.from("deposit-commitment"),
      Buffer.from(secret),
      Buffer.from(nullifierSecret),
      amountBytes,
    ])
  );

  // Final nullifier is recomputed with leaf index after tx confirms
  const nullifier = hash256(
    Buffer.concat([
      Buffer.from("deposit-nullifier"),
      Buffer.from(nullifierSecret),
      poolId.toBuffer(),
    ])
  );

  return { commitment, nullifier, secret, nullifierSecret };
}

/** Recomputes nullifier once the leaf index is known (post-deposit). */
export function computeFinalNullifier(
  nullifierSecret: Uint8Array,
  leafIndex: number,
  poolId: PublicKey
): Uint8Array {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(leafIndex, 0);

  return hash256(
    Buffer.concat([
      Buffer.from("deposit-nullifier-final"),
      Buffer.from(nullifierSecret),
      indexBuf,
      poolId.toBuffer(),
    ])
  );
}

/** Fiat-Shamir proof of knowledge of the commitment opening. */
export function generateDepositProof(
  commitment: Uint8Array,
  amount: BN,
  secret: Uint8Array
): DepositProof {
  const amountBytes = amount.toArrayLike(Buffer, "le", 32);

  const nonce = randomBytes(32);

  const challengeInput = Buffer.concat([
    Buffer.from("deposit-proof-challenge"),
    Buffer.from(commitment),
    Buffer.from(nonce),
  ]);
  const challenge = hash256(challengeInput);

  const responseInput = Buffer.concat([
    Buffer.from(secret),
    Buffer.from(challenge),
    amountBytes,
    Buffer.from(nonce),
  ]);
  const response = hash256(responseInput);

  const nullifierProof = hash256(
    Buffer.concat([
      Buffer.from("deposit-nullifier-proof"),
      Buffer.from(secret),
      Buffer.from(challenge),
    ])
  );

  const proof = new Uint8Array(256);
  let offset = 0;

  proof.set(challenge, offset);
  offset += 32;
  proof.set(response, offset);
  offset += 32;
  proof.set(nonce, offset);
  offset += 32;
  proof.set(nullifierProof, offset);
  offset += 32;

  const verificationHash = hash256(
    Buffer.concat([
      Buffer.from(commitment),
      Buffer.from(challenge),
      Buffer.from(response),
    ])
  );
  proof.set(verificationHash, offset);
  offset += 32;

  const amountCommitment = hash256(
    Buffer.concat([
      Buffer.from("amount-commitment"),
      amountBytes,
      Buffer.from(nonce),
    ])
  );
  proof.set(amountCommitment, offset);
  offset += 32;

  const rangeCheck = hash256(
    Buffer.concat([
      Buffer.from("deposit-range-check"),
      amountBytes,
      Buffer.from(secret),
    ])
  );
  proof.set(rangeCheck, offset);
  offset += 32;

  const padding = hash256(
    Buffer.concat([
      Buffer.from(proof.slice(0, offset)),
    ])
  );
  proof.set(padding, offset);

  return {
    commitment,
    nullifier: nullifierProof,
    proof,
  };
}

export function buildDepositInstruction(
  depositor: PublicKey,
  poolId: PublicKey,
  commitment: Uint8Array,
  amount: BN,
  proof: DepositProof,
  mint: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [poolTokenAccount] = derivePoolTokenAddress(poolId, programId);
  const [poolAuthority] = derivePoolAuthorityAddress(poolId, programId);

  const discriminator = Buffer.from([0x3e, 0x4f, 0x5a, 0x6b, 0x7c, 0x8d, 0x9e, 0xaf]);

  const amountBytes = amount.toArrayLike(Buffer, "le", 8);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(commitment),       // 32 bytes
    amountBytes,                    // 8 bytes
    Buffer.from(proof.proof),       // 256 bytes
  ]);

  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: poolId, isSigner: false, isWritable: true },
      { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/** Validates denomination, generates secrets + proof, submits deposit tx. */
export async function executeDeposit(
  connection: Connection,
  wallet: Keypair,
  params: DepositParams,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<DepositResult> {
  if (params.amount.isNeg() || params.amount.isZero()) {
    throw new InvalidAmountError(
      params.amount.toString(),
      "Deposit amount must be positive"
    );
  }

  const poolState = await fetchPoolState(connection, params.poolId, programId);
  if (poolState.isPaused) {
    throw new PoolPausedError(params.poolId.toBase58());
  }

  const capacity = 2 ** poolState.treeDepth;
  if (poolState.nextLeafIndex >= capacity) {
    throw new TreeFullError(params.poolId.toBase58(), capacity);
  }

  if (poolState.denominations.length > 0) {
    const isValidDenom = poolState.denominations.some((d) =>
      d.eq(params.amount)
    );
    if (!isValidDenom) {
      throw new InvalidDenominationError(
        params.amount.toString(),
        poolState.denominations.map((d) => d.toString())
      );
    }
  }

  const { commitment, nullifier, secret, nullifierSecret } =
    generateDepositSecrets(params.amount, params.poolId);

  const proof = generateDepositProof(commitment, params.amount, secret);

  const depositIx = buildDepositInstruction(
    wallet.publicKey,
    params.poolId,
    commitment,
    params.amount,
    proof,
    params.mint,
    programId
  );

  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [depositIx],
    COMPUTE_BUDGET.SHIELD_DEPOSIT
  );

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    options
  );

  const slot = await connection.getSlot();

  const leafIndex = poolState.nextLeafIndex;
  const finalNullifier = computeFinalNullifier(
    nullifierSecret,
    leafIndex,
    params.poolId
  );

  const note: DepositNote = {
    commitment,
    nullifier: finalNullifier,
    secret: Buffer.concat([
      Buffer.from(secret),
      Buffer.from(nullifierSecret),
    ]),
    amount: params.amount,
    leafIndex,
    timestamp: Math.floor(Date.now() / 1000),
    poolId: params.poolId.toBase58(),
  };

  return {
    signature,
    note,
    slot,
  };
}

export function serializeDepositNote(note: DepositNote): string {
  const data: Record<string, unknown> = {
    commitment: Buffer.from(note.commitment).toString("hex"),
    nullifier: Buffer.from(note.nullifier).toString("hex"),
    secret: Buffer.from(note.secret).toString("hex"),
    amount: note.amount.toString(),
    leafIndex: note.leafIndex,
    timestamp: note.timestamp,
    poolId: note.poolId,
  };
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

export function deserializeDepositNote(encoded: string): DepositNote {
  const json = Buffer.from(encoded, "base64").toString("utf-8");
  const data = JSON.parse(json);

  return {
    commitment: Buffer.from(data.commitment, "hex"),
    nullifier: Buffer.from(data.nullifier, "hex"),
    secret: Buffer.from(data.secret, "hex"),
    amount: new BN(data.amount),
    leafIndex: data.leafIndex,
    timestamp: data.timestamp,
    poolId: data.poolId,
  };
}
// dep rev #13
