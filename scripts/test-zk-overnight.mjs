/**
 * Overnight stability sweep on devnet.
 *
 * Runs N independent deposit -> proof -> withdraw cycles, each with
 * a fresh note and a fresh stealth recipient. Verifies that every
 * cycle lands, replays are blocked, and pool state stays consistent.
 *
 * Usage:
 *   SCAN_RPC_URL=https://devnet.helius-rpc.com/?api-key=... \
 *   CYCLES=30 node scripts/test-zk-overnight.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KIRITE_PROGRAM_ID,
  deriveShieldPool,
  deriveVaultAuthority,
  deriveProtocolConfig,
  buildInitializeProtocolIx,
  buildInitializeShieldPoolIx,
  buildDepositIx,
  buildWithdrawIx,
  buildComputeUnitLimitIx,
  decodeShieldPool,
  fetchPoolLeaves,
} from "../sdk/src/kirite-zk.mjs";
import {
  computeCommitment,
  generateMembershipProof,
  randomFieldBytes,
} from "../sdk/src/zk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CYCLES = parseInt(process.env.CYCLES || "30", 10);
const DENOM = 12_345_678n;
const TIMELOCK = 600n;
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const SCAN_RPC_URL = process.env.SCAN_RPC_URL || RPC_URL;

const WASM = path.resolve(__dirname, "../circuits/build/membership_js/membership.wasm");
const ZKEY = path.resolve(__dirname, "../circuits/build/membership_final.zkey");

const RESULTS_PATH = path.resolve(__dirname, "../target/overnight-results.json");

function loadKp() {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")),
    ),
  );
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

async function ensureProtocol(conn, payer) {
  const [config] = deriveProtocolConfig();
  const info = await conn.getAccountInfo(config);
  if (info) return;
  const ix = buildInitializeProtocolIx({
    authority: payer.publicKey,
    treasury: payer.publicKey,
  });
  const sig = await conn.sendTransaction(new Transaction().add(ix), [payer]);
  await conn.confirmTransaction(sig, "confirmed");
}

async function ensurePool(conn, payer) {
  const [pool] = deriveShieldPool(NATIVE_MINT, DENOM);
  const [vAuth] = deriveVaultAuthority(pool);
  const vault = await getAssociatedTokenAddress(NATIVE_MINT, vAuth, true);
  const info = await conn.getAccountInfo(pool);
  if (!info) {
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, vault, vAuth, NATIVE_MINT,
    );
    await conn.confirmTransaction(
      await conn.sendTransaction(new Transaction().add(ataIx), [payer]),
      "confirmed",
    );
    const ix = buildInitializeShieldPoolIx({
      operator: payer.publicKey,
      mint: NATIVE_MINT,
      vault,
      denomination: DENOM,
      timelockSeconds: TIMELOCK,
    });
    await conn.confirmTransaction(
      await conn.sendTransaction(new Transaction().add(ix), [payer]),
      "confirmed",
    );
  }
  return { pool, vault };
}

async function ensureRecipient(conn, payer) {
  const kp = Keypair.generate();
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  await conn.confirmTransaction(
    await conn.sendTransaction(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, ata, kp.publicKey, NATIVE_MINT,
        ),
      ),
      [payer],
    ),
    "confirmed",
  );
  return ata;
}

async function depositOnce(conn, payer, pool, vault, leafIndex) {
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction()
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, ata, payer.publicKey, NATIVE_MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: ata,
        lamports: Number(DENOM),
      }),
      createSyncNativeInstruction(ata),
    );
  await conn.confirmTransaction(
    await conn.sendTransaction(wrapTx, [payer]),
    "confirmed",
  );

  const ns = randomFieldBytes();
  const bf = randomFieldBytes();
  const commitment = await computeCommitment(ns, DENOM, bf, leafIndex);

  const ix = buildDepositIx({
    depositor: payer.publicKey,
    depositorTokenAccount: ata,
    vault,
    shieldPool: pool,
    commitment,
  });
  const sig = await conn.sendTransaction(
    new Transaction().add(buildComputeUnitLimitIx(600_000), ix),
    [payer],
  );
  await conn.confirmTransaction(sig, "confirmed");
  return { ns, bf, leafIndex, sig };
}

async function withdrawOnce(conn, scanConn, payer, pool, vault, note, recipientAta) {
  const treasuryAta = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const allLeaves = await fetchPoolLeaves(scanConn, pool, { limit: 1000 });

  const t0 = Date.now();
  const { proof, publicInputs } = await generateMembershipProof({
    nullifierSecret: note.ns,
    blindingFactor: note.bf,
    amount: DENOM,
    leafIndex: note.leafIndex,
    allLeaves,
    recipient: recipientAta,
    wasmPath: WASM,
    zkeyPath: ZKEY,
  });
  const proofMs = Date.now() - t0;

  const ix = buildWithdrawIx({
    relayer: payer.publicKey,
    recipientTokenAccount: recipientAta,
    treasuryTokenAccount: treasuryAta,
    mint: NATIVE_MINT,
    shieldPool: pool,
    vault,
    proof,
    nullifierHash: publicInputs.nullifierHash,
    proofRoot: publicInputs.root,
  });
  const t1 = Date.now();
  const sig = await conn.sendTransaction(
    new Transaction().add(buildComputeUnitLimitIx(600_000), ix),
    [payer],
  );
  await conn.confirmTransaction(sig, "confirmed");
  const confirmMs = Date.now() - t1;

  return { sig, proofMs, confirmMs, proof, publicInputs };
}

async function expectReplayBlocked(conn, payer, pool, vault, note, recipientAta, proof, publicInputs) {
  const treasuryAta = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const ix = buildWithdrawIx({
    relayer: payer.publicKey,
    recipientTokenAccount: recipientAta,
    treasuryTokenAccount: treasuryAta,
    mint: NATIVE_MINT,
    shieldPool: pool,
    vault,
    proof,
    nullifierHash: publicInputs.nullifierHash,
    proofRoot: publicInputs.root,
  });
  try {
    const sig = await conn.sendTransaction(
      new Transaction().add(buildComputeUnitLimitIx(600_000), ix),
      [payer],
    );
    await conn.confirmTransaction(sig, "confirmed");
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const start = Date.now();
  console.log("KIRITE overnight stability sweep");
  console.log("================================");
  console.log(`cycles: ${CYCLES}`);
  console.log(`denom:  ${DENOM} lamports`);
  console.log(`scan:   ${SCAN_RPC_URL.slice(0, 40)}...`);

  const conn = new Connection(RPC_URL, "confirmed");
  const scanConn = SCAN_RPC_URL === RPC_URL ? conn : new Connection(SCAN_RPC_URL, "confirmed");
  const payer = loadKp();

  await ensureProtocol(conn, payer);
  const { pool, vault } = await ensurePool(conn, payer);

  const startBalance = await conn.getBalance(payer.publicKey);
  console.log(`payer:  ${payer.publicKey.toBase58()}`);
  console.log(`SOL:    ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`pool:   ${pool.toBase58()}\n`);

  const results = {
    startedAt: new Date().toISOString(),
    cycles: CYCLES,
    poolKey: pool.toBase58(),
    perCycle: [],
    errors: [],
  };

  for (let i = 0; i < CYCLES; i++) {
    const cycleStart = Date.now();
    const ts = new Date().toISOString();
    process.stdout.write(`[${i + 1}/${CYCLES}] ${ts} `);
    try {
      const poolBefore = decodeShieldPool((await conn.getAccountInfo(pool)).data);
      const leafIndex = poolBefore.nextLeafIndex;
      const rootBefore = Buffer.from(poolBefore.currentRoot).toString("hex");

      const note = await depositOnce(conn, payer, pool, vault, leafIndex);
      const recipientAta = await ensureRecipient(conn, payer);
      const w = await withdrawOnce(conn, scanConn, payer, pool, vault, note, recipientAta);
      const replayBlocked = await expectReplayBlocked(
        conn, payer, pool, vault, note, recipientAta, w.proof, w.publicInputs,
      );

      const poolAfter = decodeShieldPool((await conn.getAccountInfo(pool)).data);
      const rootAfter = Buffer.from(poolAfter.currentRoot).toString("hex");
      const recipientAcc = await getAccount(conn, recipientAta);

      const cycleMs = Date.now() - cycleStart;
      const cycle = {
        i: i + 1,
        leafIndex,
        rootBefore,
        rootAfter,
        rootChanged: rootBefore !== rootAfter,
        proofMs: w.proofMs,
        withdrawConfirmMs: w.confirmMs,
        cycleMs,
        recipientAmount: recipientAcc.amount.toString(),
        replayBlocked,
        depositSig: note.sig,
        withdrawSig: w.sig,
      };
      results.perCycle.push(cycle);

      console.log(`leaf=${leafIndex} proof=${w.proofMs}ms total=${cycleMs}ms replay=${replayBlocked ? "blocked" : "LEAKED"} recv=${cycle.recipientAmount}`);
    } catch (err) {
      const msg = err?.message?.slice(0, 200) ?? String(err);
      console.log(`ERROR: ${msg}`);
      results.errors.push({ i: i + 1, err: msg, ts });
    }

    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  }

  const endBalance = await conn.getBalance(payer.publicKey);
  const proofMs = results.perCycle.map((c) => c.proofMs);
  const cycleMs = results.perCycle.map((c) => c.cycleMs);
  const replayLeaked = results.perCycle.filter((c) => !c.replayBlocked).length;
  const rootChanges = results.perCycle.filter((c) => c.rootChanged).length;

  results.summary = {
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    successCount: results.perCycle.length,
    errorCount: results.errors.length,
    replayLeakedCount: replayLeaked,
    rootChangeCount: rootChanges,
    proofMs: {
      median: pct(proofMs, 0.5),
      p95: pct(proofMs, 0.95),
      max: Math.max(0, ...proofMs),
    },
    cycleMs: {
      median: pct(cycleMs, 0.5),
      p95: pct(cycleMs, 0.95),
      max: Math.max(0, ...cycleMs),
    },
    solSpent: ((startBalance - endBalance) / LAMPORTS_PER_SOL).toFixed(4),
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  console.log("\n================================");
  console.log("summary:");
  console.log(`  cycles ok:           ${results.summary.successCount} / ${CYCLES}`);
  console.log(`  errors:              ${results.summary.errorCount}`);
  console.log(`  replay leaks:        ${replayLeaked} (must be 0)`);
  console.log(`  root advances:       ${rootChanges} (should = successCount)`);
  console.log(`  proof ms (med/p95):  ${results.summary.proofMs.median} / ${results.summary.proofMs.p95}`);
  console.log(`  cycle ms (med/p95):  ${results.summary.cycleMs.median} / ${results.summary.cycleMs.p95}`);
  console.log(`  SOL spent:           ${results.summary.solSpent}`);
  console.log(`  results saved:       ${RESULTS_PATH}`);

  process.exit(replayLeaked === 0 && results.summary.errorCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
