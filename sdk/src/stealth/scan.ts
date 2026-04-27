import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  StealthPayment,
  StealthMetaAddress,
  StealthAnnouncementEvent,
  ScanStealthParams,
} from "../types";
import { KIRITE_PROGRAM_ID, SEEDS, DISCRIMINATOR_SIZE } from "../constants";
import { checkViewTag, deriveStealthSpendingKey } from "./address";
import { fetchProgramAccounts, getRecentSignatures } from "../utils/connection";
import { hash256 } from "../utils/keypair";

/** Fetches announcements, filters by view tag, then full ECDH verify. */
export async function scanStealthPayments(
  connection: Connection,
  params: ScanStealthParams,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthPayment[]> {
  const payments: StealthPayment[] = [];

  const announcements = await fetchStealthAnnouncements(
    connection,
    params.fromSlot,
    params.toSlot,
    programId
  );

  for (const announcement of announcements) {
    const viewTagMatch = checkViewTag(
      announcement.ephemeralPubkey,
      announcement.viewTag,
      params.viewingKey
    );

    if (!viewTagMatch) {
      continue;
    }

    const stealthKeypair = deriveStealthSpendingKey(
      announcement.ephemeralPubkey,
      params.viewingKey,
      params.spendingKey
    );

    if (stealthKeypair.publicKey.equals(announcement.stealthAddress)) {
      const balance = await getStealthAddressBalance(
        connection,
        announcement.stealthAddress
      );

      payments.push({
        address: announcement.stealthAddress,
        ephemeralPubkey: announcement.ephemeralPubkey,
        amount: balance.amount,
        mint: balance.mint,
        timestamp: announcement.timestamp,
        slot: announcement.slot,
        txSignature: announcement.signature,
      });
    }
  }

  return payments;
}

async function fetchStealthAnnouncements(
  connection: Connection,
  fromSlot?: number,
  toSlot?: number,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthAnnouncementEvent[]> {
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: 0,
          bytes: "3Qq",
      },
    },
  ]);

  const announcements: StealthAnnouncementEvent[] = [];

  for (const { pubkey, account } of accounts) {
    try {
      const parsed = parseAnnouncementAccount(account.data, pubkey);

      if (fromSlot && parsed.slot < fromSlot) continue;
      if (toSlot && parsed.slot > toSlot) continue;

      announcements.push(parsed);
    } catch {
      continue;
    }
  }

  announcements.sort((a, b) => a.slot - b.slot);

  return announcements;
}

/**
 * Layout: [0..8] disc, [8..40] ephemeral, [40..72] stealth addr,
 * [72] view tag, [73..81] slot, [81..89] timestamp, [89..153] signature
 */
function parseAnnouncementAccount(
  data: Buffer,
  pubkey: PublicKey
): StealthAnnouncementEvent {
  let offset = DISCRIMINATOR_SIZE;

  const ephemeralPubkey = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const stealthAddress = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const viewTag = data.readUInt8(offset);
  offset += 1;

  const slotLow = data.readUInt32LE(offset);
  const slotHigh = data.readUInt32LE(offset + 4);
  const slot = slotLow + slotHigh * 0x100000000;
  offset += 8;

  const timestampLow = data.readUInt32LE(offset);
  const timestampHigh = data.readInt32LE(offset + 4);
  const timestamp = timestampLow + timestampHigh * 0x100000000;
  offset += 8;

  const signatureBytes = data.slice(offset, offset + 64);
  const signature = Buffer.from(signatureBytes).toString("base64");

  return {
    ephemeralPubkey,
    stealthAddress,
    viewTag,
    slot,
    timestamp,
    signature,
  };
}

/** Checks SOL then SPL token balances at a stealth address. */
async function getStealthAddressBalance(
  connection: Connection,
  address: PublicKey
): Promise<{ amount: BN; mint: PublicKey }> {
  const solBalance = await connection.getBalance(address);

  if (solBalance > 0) {
    return {
      amount: new BN(solBalance),
      mint: PublicKey.default,
    };
  }

  const tokenAccounts = await connection.getTokenAccountsByOwner(address, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  if (tokenAccounts.value.length > 0) {
    for (const { account } of tokenAccounts.value) {
      const data = account.data;
      const mint = new PublicKey(data.slice(0, 32));
      const amountBytes = data.slice(64, 72);
      const amount = new BN(amountBytes, "le");

      if (!amount.isZero()) {
        return { amount, mint };
      }
    }
  }

  return {
    amount: new BN(0),
    mint: PublicKey.default,
  };
}

/** Alternative scan via tx log parsing, for when announcement accounts are pruned. */
export async function scanStealthPaymentsFromLogs(
  connection: Connection,
  viewingKey: Uint8Array,
  spendingKey: Uint8Array,
  referencePubkey: PublicKey,
  limit: number = 500,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthPayment[]> {
  const payments: StealthPayment[] = [];

  const signatures = await getRecentSignatures(
    connection,
    referencePubkey,
    limit
  );

  for (const sigInfo of signatures) {
    try {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
      });

      if (!tx || !tx.meta || !tx.meta.logMessages) continue;

      for (const log of tx.meta.logMessages) {
        const match = log.match(
          /Program log: StealthAnnouncement\{ephemeral:([a-f0-9]+),address:([a-zA-Z0-9]+),tag:(\d+)\}/
        );

        if (!match) continue;

        const ephemeralPubkey = Buffer.from(match[1], "hex");
        const stealthAddress = new PublicKey(match[2]);
        const viewTag = parseInt(match[3], 10);

        if (!checkViewTag(ephemeralPubkey, viewTag, viewingKey)) {
          continue;
        }

        const stealthKeypair = deriveStealthSpendingKey(
          ephemeralPubkey,
          viewingKey,
          spendingKey
        );

        if (stealthKeypair.publicKey.equals(stealthAddress)) {
          const balance = await getStealthAddressBalance(
            connection,
            stealthAddress
          );

          payments.push({
            address: stealthAddress,
            ephemeralPubkey,
            amount: balance.amount,
            mint: balance.mint,
            timestamp: tx.blockTime || 0,
            slot: sigInfo.slot,
            txSignature: sigInfo.signature,
          });
        }
      }
    } catch {
      continue;
    }
  }

  return payments;
}

export function calculateStealthBalances(
  payments: StealthPayment[]
): Map<string, BN> {
  const balances = new Map<string, BN>();

  for (const payment of payments) {
    const mintKey = payment.mint ? payment.mint.toBase58() : "SOL";
    const current = balances.get(mintKey) || new BN(0);
    balances.set(mintKey, current.add(payment.amount));
  }

  return balances;
}
// scan rev #17
// stealth perf branch
