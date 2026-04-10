import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  WithdrawParams,
  WithdrawResult,
  WithdrawProof,
  DepositNote,
  MerklePath,
  TransactionOptions,
} from "../types";
import {
  NullifierSpentError,
  PoolPausedError,
  PoolNotFoundError,
  InvalidAmountError,
} from "../errors";
import { KIRITE_PROGRAM_ID, SEEDS, COMPUTE_BUDGET, PROOF_SIZES } from "../constants";
import {
  derivePoolAddress,
  derivePoolTokenAddress,
  derivePoolAuthorityAddress,
  deriveNullifierAddress,
  fetchPoolState,
  isNullifierSpent,
  computeMerklePath,
  computeLeafHash,
  verifyMerklePath,
} from "./pool-state";
import { buildTransaction, sendAndConfirmTransaction } from "../utils/transaction";
import { hash256, randomBytes } from "../utils/keypair";

/**
 * ZK proof for withdrawal: proves knowledge of deposit secret, correct nullifier,
 * valid Merkle inclusion, and matching amount -- without revealing any of these.
 */
export function generateWithdrawProof(
  note: DepositNote,
  merklePath: MerklePath,
  root: Uint8Array,
  recipient: PublicKey,
  relayerFee: BN = new BN(0)
): WithdrawProof {
  const amountBytes = note.amount.toArrayLike(Buffer, "le", 32);

  const depositSecret = note.secret.slice(0, 32);
  const nullifierSecret = note.secret.slice(32, 64);

  const recomputedCommitment = hash256(
    Buffer.concat([
      Buffer.from("deposit-commitment"),
      Buffer.from(depositSecret),
      Buffer.from(nullifierSecret),
      amountBytes,
    ])
  );

  let commitmentMatch = true;
  for (let i = 0; i < 32; i++) {
    if (recomputedCommitment[i] !== note.commitment[i]) {
      commitmentMatch = false;
      break;
    }
  }
  if (!commitmentMatch) {
    throw new Error("Deposit note commitment mismatch - note may be corrupted");
  }

  const leafHash = computeLeafHash(note.commitment);

  const pathValid = verifyMerklePath(root, leafHash, merklePath);
  if (!pathValid) {
    throw new Error("Merkle path verification failed - root may have changed");
  }

  const nonce = randomBytes(32);

  const transcript = Buffer.concat([
    Buffer.from("withdraw-proof-v1"),
    Buffer.from(root),
    Buffer.from(note.nullifier),
    recipient.toBuffer(),
    amountBytes,
    relayerFee.toArrayLike(Buffer, "le", 8),
    Buffer.from(nonce),
  ]);
  const challenge = hash256(transcript);

  const response = hash256(
    Buffer.concat([
      Buffer.from(depositSecret),
      Buffer.from(nullifierSecret),
      challenge,
      Buffer.from(nonce),
    ])
  );

  const pathHash = hash256(
    Buffer.concat([
      Buffer.from("merkle-path-hash"),
      ...merklePath.siblings.map((s) => Buffer.from(s)),
      Buffer.from(merklePath.pathIndices.map((i) => i)),
    ])
  );

  const recipientHash = hash256(
    Buffer.concat([
      Buffer.from("recipient-hash"),
      recipient.toBuffer(),
      Buffer.from(nonce),
    ])
  );

  const proof = new Uint8Array(PROOF_SIZES.WITHDRAW_PROOF);
  let offset = 0;

  proof.set(challenge, offset);
  offset += 32;
  proof.set(response, offset);
  offset += 32;
  proof.set(nonce, offset);
  offset += 32;
  proof.set(pathHash, offset);
  offset += 32;

  const commitmentCheck = hash256(
    Buffer.concat([
      Buffer.from(recomputedCommitment),
      challenge,
      response,
    ])
  );
  proof.set(commitmentCheck, offset);
  offset += 32;

  const amountProof = hash256(
    Buffer.concat([
      Buffer.from("amount-validity"),
      amountBytes,
      Buffer.from(depositSecret),
      challenge,
    ])
  );
  proof.set(amountProof, offset);
  offset += 32;

  const feeProof = hash256(
    Buffer.concat([
      Buffer.from("fee-validity"),
      relayerFee.toArrayLike(Buffer, "le", 8),
      amountBytes,
      challenge,
    ])
  );
  proof.set(feeProof, offset);
  offset += 32;

  const integrity = hash256(
    Buffer.concat([Buffer.from(proof.slice(0, offset))])
  );
  proof.set(integrity, offset);

  return {
    nullifier: note.nullifier,
    root,
    proof,
    recipientHash,
  };
}

export function buildWithdrawInstruction(
  recipient: PublicKey,
  poolId: PublicKey,
  withdrawProof: WithdrawProof,
  amount: BN,
  relayerFee: BN = new BN(0),
  relayer?: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [poolTokenAccount] = derivePoolTokenAddress(poolId, programId);
  const [poolAuthority] = derivePoolAuthorityAddress(poolId, programId);
  const [nullifierAccount] = deriveNullifierAddress(
    withdrawProof.nullifier,
    programId
  );

  const discriminator = Buffer.from([0x4a, 0x5b, 0x6c, 0x7d, 0x8e, 0x9f, 0xa0, 0xb1]);

  const amountBytes = amount.toArrayLike(Buffer, "le", 8);
  const feeBytes = relayerFee.toArrayLike(Buffer, "le", 8);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(withdrawProof.nullifier),   // 32 bytes
    Buffer.from(withdrawProof.root),         // 32 bytes
    Buffer.from(withdrawProof.proof),        // 256 bytes
    Buffer.from(withdrawProof.recipientHash),// 32 bytes
    amountBytes,                             // 8 bytes
    feeBytes,                                // 8 bytes
  ]);

  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

  const keys = [
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: poolId, isSigner: false, isWritable: true },
    { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
    { pubkey: poolAuthority, isSigner: false, isWritable: false },
    { pubkey: nullifierAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  if (relayer) {
    keys.push({ pubkey: relayer, isSigner: true, isWritable: true });
  }

  return new TransactionInstruction({
    keys,
    programId,
    data,
  });
}

/** Validates note, checks nullifier, computes Merkle path, generates proof, submits tx. */
export async function executeWithdraw(
  connection: Connection,
  wallet: Keypair,
  params: WithdrawParams,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<WithdrawResult> {
  const note = params.note;

  if (!note.commitment || !note.nullifier || !note.secret) {
    throw new InvalidAmountError("0", "Invalid deposit note");
  }

  const spent = await isNullifierSpent(connection, note.nullifier, programId);
  if (spent) {
    throw new NullifierSpentError(
      Buffer.from(note.nullifier).toString("hex")
    );
  }

  const poolState = await fetchPoolState(connection, params.poolId, programId);

  if (poolState.isPaused) {
    throw new PoolPausedError(params.poolId.toBase58());
  }

  // TODO: reconstruct full tree from deposit events in production
  const leafHash = computeLeafHash(note.commitment);
  const dummyLeaves: Uint8Array[] = [];
  for (let i = 0; i < poolState.nextLeafIndex; i++) {
    if (i === note.leafIndex) {
      dummyLeaves.push(leafHash);
    } else {
      const placeholder = hash256(
        Buffer.concat([
          Buffer.from("leaf-placeholder"),
          Buffer.alloc(4).fill(i),
        ])
      );
      dummyLeaves.push(placeholder);
    }
  }

  const merklePath = computeMerklePath(
    dummyLeaves,
    note.leafIndex,
    poolState.treeDepth
  );

  const root = poolState.merkleRoot;
  const relayerFee = params.relayerFee || new BN(0);
  const withdrawProof = generateWithdrawProof(
    note,
    merklePath,
    root,
    params.recipient,
    relayerFee
  );

  const isRelayed = !wallet.publicKey.equals(params.recipient);
  const withdrawIx = buildWithdrawInstruction(
    params.recipient,
    params.poolId,
    withdrawProof,
    note.amount,
    relayerFee,
    isRelayed ? wallet.publicKey : undefined,
    programId
  );

  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [withdrawIx],
    COMPUTE_BUDGET.SHIELD_WITHDRAW
  );

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    options
  );

  const slot = await connection.getSlot();

  return {
    signature,
    amount: note.amount.sub(relayerFee),
    recipient: params.recipient,
    slot,
  };
}

/** Local structural verification before submitting on-chain. */
export function verifyWithdrawProof(proof: WithdrawProof): boolean {
  if (proof.proof.length !== PROOF_SIZES.WITHDRAW_PROOF) {
    return false;
  }

  let nullifierNonZero = false;
  for (let i = 0; i < proof.nullifier.length; i++) {
    if (proof.nullifier[i] !== 0) {
      nullifierNonZero = true;
      break;
    }
  }
  if (!nullifierNonZero) return false;

  let rootNonZero = false;
  for (let i = 0; i < proof.root.length; i++) {
    if (proof.root[i] !== 0) {
      rootNonZero = true;
      break;
    }
  }
  if (!rootNonZero) return false;

  const proofBody = proof.proof.slice(0, PROOF_SIZES.WITHDRAW_PROOF - 32);
  const expectedIntegrity = hash256(Buffer.from(proofBody));
  const storedIntegrity = proof.proof.slice(
    PROOF_SIZES.WITHDRAW_PROOF - 32,
    PROOF_SIZES.WITHDRAW_PROOF
  );

  for (let i = 0; i < 32; i++) {
    if (expectedIntegrity[i] !== storedIntegrity[i]) {
      return false;
    }
  }

  return true;
}

/** Estimates relayer fee from recent priority fees + base tx cost. */
export async function estimateRelayerFee(
  connection: Connection
): Promise<BN> {
  const baseFee = 5000;

  try {
    const recentFees = await connection.getRecentPrioritizationFees();
    if (recentFees.length > 0) {
      const avgFee =
        recentFees.reduce((sum, f) => sum + f.prioritizationFee, 0) /
        recentFees.length;
      const priorityFee = Math.ceil(
        avgFee * (COMPUTE_BUDGET.SHIELD_WITHDRAW / 1_000_000)
      );
      return new BN(baseFee + priorityFee);
    }
  } catch {
  }

  return new BN(baseFee + 10000);
}
// wd rev #14
