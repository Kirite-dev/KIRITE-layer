/**
 * Example: Confidential Transfer
 *
 * Sends an encrypted token transfer where the amount is invisible on-chain.
 * Run: npx tsx examples/01-confidential-transfer.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KiriteClient } from "@kirite/sdk";
import { readFileSync } from "fs";
import { homedir } from "os";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const secret = JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

  const kirite = new KiriteClient(connection, wallet);

  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const recipient = new PublicKey("9mR2xK7PDvBQVjNrW8FpqLg3KfZsdH4kXvT2YAbRcEnp");

  const result = await kirite.confidentialTransfer({
    mint: USDC_MINT,
    recipient,
    amount: 1_000_000, // 1 USDC
  });

  console.log("Confidential transfer submitted");
  console.log("Signature:", result.signature);
  console.log("Encrypted on-chain. No amount visible.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
