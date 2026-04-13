import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  StealthMetaAddress,
  StealthRegistryEntry,
  TransactionOptions,
} from "../types";
import { RegistryNotFoundError, StealthAddressError } from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  DISCRIMINATOR_SIZE,
  COMPUTE_BUDGET,
} from "../constants";
import {
  fetchAccountOrThrow,
  fetchProgramAccounts,
} from "../utils/connection";
import {
  buildTransaction,
  getMedianPriorityFee,
  sendAndConfirmTransaction,
} from "../utils/transaction";

export function deriveRegistryAddress(
  owner: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_REGISTRY, owner.toBuffer()],
    programId
  );
}

export function deriveAnnouncementAddress(
  ephemeralPubkey: Uint8Array,
  stealthAddress: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.STEALTH_ANNOUNCEMENT,
      Buffer.from(ephemeralPubkey),
      stealthAddress.toBuffer(),
    ],
    programId
  );
}

/**
 * Layout: [0..8] disc, [8..40] owner, [40..72] spending, [72..104] viewing,
 * [104..108] label len, [108..] label, then i64 timestamp.
 */
export function parseRegistryEntry(data: Buffer): StealthRegistryEntry {
  let offset = DISCRIMINATOR_SIZE;

  const owner = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const spendingKey = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const viewingKey = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const labelLen = data.readUInt32LE(offset);
  offset += 4;

  const label = data.slice(offset, offset + labelLen).toString("utf-8");
  offset += labelLen;

  const createdAtLow = data.readUInt32LE(offset);
  const createdAtHigh = data.readInt32LE(offset + 4);
  const createdAt = createdAtLow + createdAtHigh * 0x100000000;

  return {
    owner,
    metaAddress: { spendingKey, viewingKey },
    label,
    createdAt,
  };
}

/** @throws RegistryNotFoundError if not registered */
export async function fetchRegistryEntry(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthRegistryEntry> {
  const [registryAddr] = deriveRegistryAddress(owner, programId);

  try {
    const account = await fetchAccountOrThrow(
      connection,
      registryAddr,
      "StealthRegistry"
    );
    return parseRegistryEntry(account.data);
  } catch (err) {
    throw new RegistryNotFoundError(owner.toBase58());
  }
}

export async function fetchAllRegistryEntries(
  connection: Connection,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthRegistryEntry[]> {
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: 0,
        bytes: "4Rr",
      },
    },
  ]);

  const entries: StealthRegistryEntry[] = [];

  for (const { account } of accounts) {
    try {
      entries.push(parseRegistryEntry(account.data));
    } catch {
      continue;
    }
  }

  return entries;
}

/** @throws RegistryNotFoundError if not registered */
export async function lookupStealthMetaAddress(
  connection: Connection,
  recipient: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthMetaAddress> {
  const entry = await fetchRegistryEntry(connection, recipient, programId);
  return entry.metaAddress;
}

export function buildRegisterInstruction(
  owner: PublicKey,
  metaAddress: StealthMetaAddress,
  label: string = "",
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [registryAddr] = deriveRegistryAddress(owner, programId);

  const discriminator = Buffer.from([0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0xab, 0xbc, 0xcd]);

  const labelBytes = Buffer.from(label, "utf-8").slice(0, 64);
  const labelLenBuf = Buffer.alloc(4);
  labelLenBuf.writeUInt32LE(labelBytes.length, 0);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(metaAddress.spendingKey),  // 32 bytes
    Buffer.from(metaAddress.viewingKey),    // 32 bytes
    labelLenBuf,                           // 4 bytes
    labelBytes,                            // variable
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: registryAddr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

export function buildUpdateRegistryInstruction(
  owner: PublicKey,
  newMetaAddress: StealthMetaAddress,
  newLabel?: string,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [registryAddr] = deriveRegistryAddress(owner, programId);

  const discriminator = Buffer.from([0x6e, 0x7f, 0x8a, 0x9b, 0xac, 0xbd, 0xce, 0xdf]);

  const labelBytes = newLabel
    ? Buffer.from(newLabel, "utf-8").slice(0, 64)
    : Buffer.alloc(0);
  const labelLenBuf = Buffer.alloc(4);
  labelLenBuf.writeUInt32LE(labelBytes.length, 0);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(newMetaAddress.spendingKey),
    Buffer.from(newMetaAddress.viewingKey),
    labelLenBuf,
    labelBytes,
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: registryAddr, isSigner: false, isWritable: true },
    ],
    programId,
    data,
  });
}

/** Emits stealth announcement so the recipient can discover the payment. */
export function buildAnnouncementInstruction(
  sender: PublicKey,
  ephemeralPubkey: Uint8Array,
  stealthAddress: PublicKey,
  viewTag: number,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [announcementAddr] = deriveAnnouncementAddress(
    ephemeralPubkey,
    stealthAddress,
    programId
  );

  const discriminator = Buffer.from([0x7a, 0x8b, 0x9c, 0xad, 0xbe, 0xcf, 0xd0, 0xe1]);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(ephemeralPubkey),           // 32 bytes
    stealthAddress.toBuffer(),              // 32 bytes
    Buffer.from([viewTag]),                 // 1 byte
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: announcementAddr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

export async function registerStealthMetaAddress(
  connection: Connection,
  wallet: Keypair,
  metaAddress: StealthMetaAddress,
  label: string = "",
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<string> {
  const registerIx = buildRegisterInstruction(
    wallet.publicKey,
    metaAddress,
    label,
    programId
  );

  const priorityFee1 = await getMedianPriorityFee(connection);
  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [registerIx],
    COMPUTE_BUDGET.REGISTRY_UPDATE,
    priorityFee1
  );

  return sendAndConfirmTransaction(connection, tx, [wallet], options);
}

export async function publishStealthAnnouncement(
  connection: Connection,
  wallet: Keypair,
  ephemeralPubkey: Uint8Array,
  stealthAddress: PublicKey,
  viewTag: number,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<string> {
  const announceIx = buildAnnouncementInstruction(
    wallet.publicKey,
    ephemeralPubkey,
    stealthAddress,
    viewTag,
    programId
  );

  const priorityFee2 = await getMedianPriorityFee(connection);
  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [announceIx],
    COMPUTE_BUDGET.STEALTH_SEND,
    priorityFee2
  );

  return sendAndConfirmTransaction(connection, tx, [wallet], options);
}
// reg rev #16
