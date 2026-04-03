/**
 * Example: Stealth Address Generation and Scan
 *
 * Generates a one-time stealth address for a recipient, then scans the
 * on-chain registry as the recipient to detect the incoming payment.
 *
 * Run: npx tsx examples/03-stealth-address.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KiriteClient, StealthAddress } from "@kirite/sdk";
import { readFileSync } from "fs";
import { homedir } from "os";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const secret = JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

  const kirite = new KiriteClient(connection, wallet);
  const stealth = new StealthAddress(kirite);

  // Recipient's published meta-address (spend pubkey + view pubkey)
  const recipientSpendKey = new PublicKey(
    "7xK93fQ2RvBQVjNrW8FpqLg3KfZsdH4kXvT2YAbRcEnp",
  );
  const recipientViewKey = new PublicKey(
    "9mR2xK7PDvBQVjNrW8FpqLg3KfZsdH4kXvT2YAbRcEnp",
  );

  // Sender derives a one-time address for the recipient
  const { address, ephemeralPubkey } = stealth.generate(
    recipientSpendKey,
    recipientViewKey,
  );

  console.log("Generated stealth address");
  console.log("Address:", address.toBase58());
  console.log("Ephemeral pubkey:", ephemeralPubkey.toBase58());

  // Recipient scans the registry with their view key
  const myViewKey = wallet; // recipient's view key (in practice, separate)
  const found = await stealth.scan(recipientSpendKey, myViewKey.publicKey);

  console.log(`Scanned ${found.length} stealth payments addressed to me`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
