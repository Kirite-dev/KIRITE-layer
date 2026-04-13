import {
  PublicKey,
  Keypair,
  Connection,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  ConfidentialTransferParams,
  ConfidentialTransferResult,
  EncryptedAmount,
  ElGamalKeypair,
  TransferProof,
  TransactionOptions,
  DecryptedTransfer,
} from "../types";
import {
  WalletNotConnectedError,
  InvalidAmountError,
  InsufficientBalanceError,
  TransactionError,
} from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  COMPUTE_BUDGET,
  MAX_MEMO_LENGTH,
} from "../constants";
import { encryptAmount, decryptAmount, serializeEncryptedAmount } from "./encryption";
import { generateTransferProof, serializeTransferProof } from "./proof";
import {
  buildTransaction,
  sendAndConfirmTransaction,
  createMemoInstruction,
  getMedianPriorityFee,
} from "../utils/transaction";
import { deriveElGamalKeypair } from "../utils/keypair";
import { fetchAccountOrThrow } from "../utils/connection";

export function deriveConfidentialAccountAddress(
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.CONFIDENTIAL_ACCOUNT, owner.toBuffer(), mint.toBuffer()],
    programId
  );
}

export function deriveEncryptedBalanceAddress(
  confidentialAccount: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ENCRYPTED_BALANCE, confidentialAccount.toBuffer()],
    programId
  );
}

export function buildInitConfidentialAccountInstruction(
  owner: PublicKey,
  mint: PublicKey,
  elGamalPubkey: Uint8Array,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [confidentialAccount] = deriveConfidentialAccountAddress(
    owner,
    mint,
    programId
  );
  const [encryptedBalance] = deriveEncryptedBalanceAddress(
    confidentialAccount,
    programId
  );

  const discriminator = Buffer.from([0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x7a, 0x8b]);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(elGamalPubkey),
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: confidentialAccount, isSigner: false, isWritable: true },
      { pubkey: encryptedBalance, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

export function buildConfidentialTransferInstruction(
  sender: PublicKey,
  params: ConfidentialTransferParams,
  encryptedAmount: EncryptedAmount,
  proof: TransferProof,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [senderConfAccount] = deriveConfidentialAccountAddress(
    sender,
    params.mint,
    programId
  );
  const [recipientConfAccount] = deriveConfidentialAccountAddress(
    params.recipient,
    params.mint,
    programId
  );
  const [senderBalance] = deriveEncryptedBalanceAddress(
    senderConfAccount,
    programId
  );
  const [recipientBalance] = deriveEncryptedBalanceAddress(
    recipientConfAccount,
    programId
  );

  const discriminator = Buffer.from([0x2c, 0x3d, 0x4e, 0x5f, 0x6a, 0x7b, 0x8c, 0x9d]);

  const serializedAmount = serializeEncryptedAmount(encryptedAmount);
  const serializedProof = serializeTransferProof(proof);

  const amountLenBuf = Buffer.alloc(4);
  amountLenBuf.writeUInt32LE(serializedAmount.length, 0);
  const proofLenBuf = Buffer.alloc(4);
  proofLenBuf.writeUInt32LE(serializedProof.length, 0);

  const data = Buffer.concat([
    discriminator,
    amountLenBuf,
    Buffer.from(serializedAmount),
    proofLenBuf,
    Buffer.from(serializedProof),
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: senderConfAccount, isSigner: false, isWritable: true },
      { pubkey: senderBalance, isSigner: false, isWritable: true },
      { pubkey: recipientConfAccount, isSigner: false, isWritable: true },
      { pubkey: recipientBalance, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * End-to-end confidential transfer: decrypt balance, encrypt amount,
 * generate ZK proofs, build + send tx.
 */
export async function executeConfidentialTransfer(
  connection: Connection,
  wallet: Keypair,
  params: ConfidentialTransferParams,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ConfidentialTransferResult> {
  if (params.amount.isNeg() || params.amount.isZero()) {
    throw new InvalidAmountError(
      params.amount.toString(),
      "Amount must be positive"
    );
  }

  const elGamalKeypair = deriveElGamalKeypair(wallet);
  const [senderConfAccount] = deriveConfidentialAccountAddress(
    wallet.publicKey,
    params.mint,
    programId
  );
  const [senderBalanceAddr] = deriveEncryptedBalanceAddress(
    senderConfAccount,
    programId
  );

  let senderBalance: BN;
  try {
    const balanceAccount = await fetchAccountOrThrow(
      connection,
      senderBalanceAddr,
      "EncryptedBalance"
    );

    const encBalanceData = balanceAccount.data.slice(8); // skip discriminator
    const encBalance: EncryptedAmount = {
      ephemeralKey: encBalanceData.slice(0, 32),
      ciphertext: encBalanceData.slice(32, 64),
      randomness: encBalanceData.slice(64, 96),
    };

    senderBalance = decryptAmount(encBalance, elGamalKeypair.secretKey);
  } catch (err) {
    senderBalance = new BN(0);
  }

  if (senderBalance.lt(params.amount)) {
    throw new InsufficientBalanceError(
      params.amount.toString(),
      senderBalance.toString()
    );
  }

  const encryptedAmount = encryptAmount(
    params.amount,
    params.recipientElGamalPubkey
  );

  const proof = generateTransferProof(
    params.amount,
    senderBalance,
    elGamalKeypair.secretKey,
    params.recipientElGamalPubkey,
    encryptedAmount
  );

  const transferIx = buildConfidentialTransferInstruction(
    wallet.publicKey,
    params,
    encryptedAmount,
    proof,
    programId
  );

  const instructions: TransactionInstruction[] = [transferIx];
  if (params.memo) {
    const memoText =
      params.memo.length > MAX_MEMO_LENGTH
        ? params.memo.slice(0, MAX_MEMO_LENGTH)
        : params.memo;
    instructions.push(createMemoInstruction(memoText, wallet.publicKey));
  }

  const priorityFee = await getMedianPriorityFee(connection);

  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    instructions,
    COMPUTE_BUDGET.CONFIDENTIAL_TRANSFER,
    priorityFee
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
    encryptedAmount,
    proof,
    slot,
  };
}

/** Scans and decrypts incoming confidential transfers for the given wallet. */
export async function decryptIncomingTransfers(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  fromSlot?: number,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<DecryptedTransfer[]> {
  const elGamalKeypair = deriveElGamalKeypair(wallet);
  const [confAccount] = deriveConfidentialAccountAddress(
    wallet.publicKey,
    mint,
    programId
  );

  const signatures = await connection.getSignaturesForAddress(confAccount, {
    limit: 100,
  });

  const transfers: DecryptedTransfer[] = [];

  for (const sigInfo of signatures) {
    if (fromSlot && sigInfo.slot < fromSlot) continue;

    try {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
      });

      if (!tx || !tx.meta) continue;

      for (const innerIx of tx.transaction.message.instructions) {
        const programIdIndex = innerIx.programIdIndex;
        const programKey =
          tx.transaction.message.accountKeys[programIdIndex];

        if (!programKey.equals(programId)) continue;

        const ixData = Buffer.from(
          (innerIx as any).data || [],
          "base64"
        );
        if (ixData.length < 108) continue;

        const discriminator = ixData.slice(0, 8);
        const expectedDisc = Buffer.from([
          0x2c, 0x3d, 0x4e, 0x5f, 0x6a, 0x7b, 0x8c, 0x9d,
        ]);
        if (!discriminator.equals(expectedDisc)) continue;

        const amountLen = ixData.readUInt32LE(8);
        if (amountLen !== 96) continue;

        const encryptedData = ixData.slice(12, 108);
        const encAmount: EncryptedAmount = {
          ephemeralKey: encryptedData.slice(0, 32),
          ciphertext: encryptedData.slice(32, 64),
          randomness: encryptedData.slice(64, 96),
        };

        try {
          const amount = decryptAmount(encAmount, elGamalKeypair.secretKey);

          const senderKey = tx.transaction.message.accountKeys[0];

          transfers.push({
            amount,
            sender: senderKey,
            receiver: wallet.publicKey,
            mint,
            timestamp: tx.blockTime || 0,
            slot: sigInfo.slot,
          });
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return transfers;
}

export async function getConfidentialBalance(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<BN> {
  const elGamalKeypair = deriveElGamalKeypair(wallet);
  const [confAccount] = deriveConfidentialAccountAddress(
    wallet.publicKey,
    mint,
    programId
  );
  const [balanceAddr] = deriveEncryptedBalanceAddress(confAccount, programId);

  try {
    const balanceAccount = await fetchAccountOrThrow(
      connection,
      balanceAddr,
      "EncryptedBalance"
    );

    const encData = balanceAccount.data.slice(8);
    const encBalance: EncryptedAmount = {
      ephemeralKey: encData.slice(0, 32),
      ciphertext: encData.slice(32, 64),
      randomness: encData.slice(64, 96),
    };

    return decryptAmount(encBalance, elGamalKeypair.secretKey);
  } catch {
    return new BN(0);
  }
}
// transfer rev #12
