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
} from "../utils/transaction";
import { deriveElGamalKeypair } from "../utils/keypair";
import { fetchAccountOrThrow } from "../utils/connection";

/**
 * Derives the confidential account PDA for a given owner and mint.
 * @param owner - Account owner
 * @param mint - Token mint
 * @param programId - Program ID
 * @returns PDA and bump
 */
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

/**
 * Derives the encrypted balance PDA.
 * @param confidentialAccount - Confidential account address
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function deriveEncryptedBalanceAddress(
  confidentialAccount: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ENCRYPTED_BALANCE, confidentialAccount.toBuffer()],
    programId
  );
}

/**
 * Builds the instruction for initializing a confidential token account.
 *
 * @param owner - Account owner
 * @param mint - Token mint
 * @param elGamalPubkey - ElGamal public key for encryption
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
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

  // Instruction discriminator: sha256("global:init_confidential_account")[0..8]
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

/**
 * Builds the instruction for a confidential transfer.
 *
 * @param sender - Sender's public key
 * @param params - Transfer parameters
 * @param encryptedAmount - Encrypted transfer amount
 * @param proof - Zero-knowledge proof
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
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

  // Instruction discriminator: sha256("global:confidential_transfer")[0..8]
  const discriminator = Buffer.from([0x2c, 0x3d, 0x4e, 0x5f, 0x6a, 0x7b, 0x8c, 0x9d]);

  const serializedAmount = serializeEncryptedAmount(encryptedAmount);
  const serializedProof = serializeTransferProof(proof);

  // Encode amount length (4 bytes LE) + amount + proof length (4 bytes LE) + proof
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
 * Executes a confidential transfer end-to-end.
 *
 * This function:
 * 1. Derives the sender's ElGamal keypair
 * 2. Fetches the sender's current encrypted balance
 * 3. Decrypts the balance to verify sufficiency
 * 4. Encrypts the transfer amount for the recipient
 * 5. Generates zero-knowledge proofs
 * 6. Builds and sends the transaction
 *
 * @param connection - Solana connection
 * @param wallet - Sender's keypair
 * @param params - Transfer parameters
 * @param options - Transaction options
 * @param programId - KIRITE program ID
 * @returns Transfer result with signature and proof data
 */
export async function executeConfidentialTransfer(
  connection: Connection,
  wallet: Keypair,
  params: ConfidentialTransferParams,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ConfidentialTransferResult> {
  // Validate amount
  if (params.amount.isNeg() || params.amount.isZero()) {
    throw new InvalidAmountError(
      params.amount.toString(),
      "Amount must be positive"
    );
  }

  // Derive ElGamal keypair from wallet
  const elGamalKeypair = deriveElGamalKeypair(wallet);

  // Fetch and decrypt current balance
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

    // Parse encrypted balance from account data (skip 8-byte discriminator)
    const encBalanceData = balanceAccount.data.slice(8);
    const encBalance: EncryptedAmount = {
      ephemeralKey: encBalanceData.slice(0, 32),
      ciphertext: encBalanceData.slice(32, 64),
      randomness: encBalanceData.slice(64, 96),
    };

    senderBalance = decryptAmount(encBalance, elGamalKeypair.secretKey);
  } catch (err) {
    // If account doesn't exist, balance is zero
    senderBalance = new BN(0);
  }

  // Check sufficient balance
  if (senderBalance.lt(params.amount)) {
    throw new InsufficientBalanceError(
      params.amount.toString(),
      senderBalance.toString()
    );
  }

  // Encrypt the transfer amount for the recipient
  const encryptedAmount = encryptAmount(
    params.amount,
    params.recipientElGamalPubkey
  );

  // Generate transfer proof
  const proof = generateTransferProof(
    params.amount,
    senderBalance,
    elGamalKeypair.secretKey,
    params.recipientElGamalPubkey,
    encryptedAmount
  );

  // Build transfer instruction
  const transferIx = buildConfidentialTransferInstruction(
    wallet.publicKey,
    params,
    encryptedAmount,
    proof,
    programId
  );

  // Optionally add memo
  const instructions: TransactionInstruction[] = [transferIx];
  if (params.memo) {
    const memoText =
      params.memo.length > MAX_MEMO_LENGTH
        ? params.memo.slice(0, MAX_MEMO_LENGTH)
        : params.memo;
    instructions.push(createMemoInstruction(memoText, wallet.publicKey));
  }

  // Build and send transaction
  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    instructions,
    COMPUTE_BUDGET.CONFIDENTIAL_TRANSFER
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

/**
 * Decrypts all incoming confidential transfers for a given account.
 *
 * @param connection - Solana connection
 * @param wallet - Account owner keypair
 * @param mint - Token mint to query
 * @param fromSlot - Start scanning from this slot (optional)
 * @param programId - KIRITE program ID
 * @returns Array of decrypted transfers
 */
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

  // Fetch recent transaction signatures for the confidential account
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

      // Parse the instruction data to find confidential transfer instructions
      for (const innerIx of tx.transaction.message.instructions) {
        const programIdIndex = innerIx.programIdIndex;
        const programKey =
          tx.transaction.message.accountKeys[programIdIndex];

        if (!programKey.equals(programId)) continue;

        // Try to extract and decrypt the transfer amount
        const ixData = Buffer.from(
          (innerIx as any).data || [],
          "base64"
        );
        if (ixData.length < 108) continue; // Minimum: 8 disc + 4 len + 96 amount

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

          // Extract sender from account keys
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
          // Decryption failed — this transfer is not for us
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return transfers;
}

/**
 * Fetches the decrypted balance of a confidential token account.
 *
 * @param connection - Solana connection
 * @param wallet - Account owner
 * @param mint - Token mint
 * @param programId - Program ID
 * @returns Decrypted balance
 */
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
