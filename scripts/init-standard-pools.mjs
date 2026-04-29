/**
 * Initialize the 5 standard denomination pools (0.01, 0.05, 0.1, 1, 10
 * SOL) for the WSOL mint on whichever cluster the RPC points at. Idempotent
 * — skips pools that already exist.
 *
 * Per the HIGH-002 / HIGH-003 fixes, the operator must be the protocol
 * authority and the vault must be a TokenAccount owned by the pool's
 * vault_authority PDA. This script handles both setups.
 *
 * Usage:
 *   KEYPAIR=/path/to/protocol_authority.json node scripts/init-standard-pools.mjs
 *   RPC_URL=... KEYPAIR=...                node scripts/init-standard-pools.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";

import {
  KIRITE_PROGRAM_ID,
  deriveShieldPool,
  deriveVaultAuthority,
  buildInitializeShieldPoolIx,
} from "../sdk/src/kirite-zk.mjs";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const TIMELOCK_SECONDS = 600n; // minimum allowed by validate_timelock_duration

const POOLS = [
  { label: "0.01 SOL", denom: 10_000_000n },
  { label: "0.05 SOL", denom: 50_000_000n },
  { label: "0.1 SOL",  denom: 100_000_000n },
  { label: "1 SOL",    denom: 1_000_000_000n },
  { label: "10 SOL",   denom: 10_000_000_000n },
];

function loadKp() {
  const p = process.env.KEYPAIR || `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}

async function ensurePool(conn, payer, denom, label) {
  const [pool] = deriveShieldPool(NATIVE_MINT, denom);
  const existing = await conn.getAccountInfo(pool);
  if (existing) {
    console.log(`  ${label}: already exists at ${pool.toBase58()}`);
    return false;
  }

  const [vaultAuthority] = deriveVaultAuthority(pool);
  const vault = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vaultAuthority,
    true, // allow owner-off-curve (PDA)
  );

  console.log(`  ${label}: pool ${pool.toBase58().slice(0, 16)}... vault ${vault.toBase58().slice(0, 16)}...`);

  // Step 1: create the vault as an ATA owned by vault_authority PDA.
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    vault,
    vaultAuthority,
    NATIVE_MINT,
  );
  const ataSig = await conn.sendTransaction(new Transaction().add(ataIx), [payer]);
  await conn.confirmTransaction(ataSig, "confirmed");

  // Step 2: init_shield_pool — operator must be protocol authority.
  const initIx = buildInitializeShieldPoolIx({
    operator: payer.publicKey,
    mint: NATIVE_MINT,
    vault,
    denomination: denom,
    timelockSeconds: TIMELOCK_SECONDS,
  });
  const sig = await conn.sendTransaction(new Transaction().add(initIx), [payer]);
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  ${label}: created (sig ${sig.slice(0, 32)}...)`);
  return true;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const operator = loadKp();
  console.log(`operator (must be protocol authority): ${operator.publicKey.toBase58()}`);
  console.log(`program: ${KIRITE_PROGRAM_ID.toBase58()}`);

  let created = 0;
  for (const { label, denom } of POOLS) {
    try {
      const did = await ensurePool(conn, operator, denom, label);
      if (did) created++;
    } catch (err) {
      console.log(`  ${label}: FAILED — ${err.message?.slice(0, 200) ?? err}`);
    }
  }
  console.log(`\n✓ done. ${created} pool(s) newly created.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
