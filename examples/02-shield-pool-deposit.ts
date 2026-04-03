/**
 * Example: Shield Pool Deposit
 *
 * Deposits tokens into the shield pool and prints the withdrawal note.
 * Save the nullifier offline. It is the only way to withdraw later.
 *
 * Run: npx tsx examples/02-shield-pool-deposit.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KiriteClient, ShieldPool } from "@kirite/sdk";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const secret = JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

  const kirite = new KiriteClient(connection, wallet);
  const pool = new ShieldPool(kirite);

  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

  const note = await pool.deposit({
    mint: SOL_MINT,
    amount: 1_000_000_000, // 1 SOL
  });

  console.log("Deposit complete");
  console.log("Commitment:", note.commitment);
  console.log("Nullifier (KEEP SECRET):", note.nullifier);

  // Persist the note locally for later withdrawal
  writeFileSync(
    `./deposit-${Date.now()}.json`,
    JSON.stringify(note, null, 2),
  );
  console.log("Note saved to disk.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
