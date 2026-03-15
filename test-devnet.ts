import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6");

async function main() {
  // Setup
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load wallet from default Solana CLI keypair
  const fs = require("fs");
  const os = require("os");
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  console.log("=== KIRITE DEVNET TEST ===");
  console.log(`wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`program: ${PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  // 1. Initialize Protocol
  console.log("--- step 1: initialize protocol ---");
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    PROGRAM_ID
  );

  const [governanceState] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), protocolConfig.toBuffer()],
    PROGRAM_ID
  );

  // Always try to initialize
  {
    const treasury = Keypair.generate();

    const initIx = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: protocolConfig, isSigner: false, isWritable: true },
        { pubkey: governanceState, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: treasury.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        // Anchor discriminator for "initialize_protocol"
        Buffer.from(anchor.utils.bytes.utf8.encode("global:initialize_protocol")).slice(0, 8),
        // fee_bps: u16 = 10 (0.1%)
        Buffer.from(new Uint8Array([10, 0])),
        // burn_ratio_bps: u16 = 5000 (50%)
        Buffer.from(new Uint8Array([0x88, 0x13])),
      ]),
    };

    try {
      // Use IDL-based approach instead
      const idlPath = "./target/idl/kirite.json";
      if (fs.existsSync(idlPath)) {
        const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
        const provider = new anchor.AnchorProvider(
          connection,
          new anchor.Wallet(wallet),
          { commitment: "confirmed" }
        );
        const program = new Program(idl, provider);

        const tx = await program.methods
          .initializeProtocol(10, 5000)
          .accounts({
            protocolConfig,
            governanceState,
            authority: wallet.publicKey,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wallet])
          .rpc();

        console.log(`✓ protocol initialized | tx: ${tx}`);
        console.log(`  protocol_config: ${protocolConfig.toBase58()}`);
      } else {
        console.log("IDL not found, skipping initialization via program...");
      }
    } catch (e: any) {
      if (e.message?.includes("already in use")) {
        console.log("protocol already initialized");
      } else {
        console.log(`✗ initialization failed: ${e.message?.slice(0, 300)}`);
        if (e.logs) console.log("logs:", e.logs.slice(-5).join("\n"));
      }
    }
  }

  // 2. Verify program is accessible
  console.log("\n--- step 2: verify program ---");
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (programInfo) {
    console.log(`✓ program exists on devnet`);
    console.log(`  owner: ${programInfo.owner.toBase58()}`);
    console.log(`  data size: ${programInfo.data.length} bytes`);
    console.log(`  executable: ${programInfo.executable}`);
  } else {
    console.log("✗ program not found!");
    return;
  }

  // 3. Create test SPL token mint
  console.log("\n--- step 3: create test token ---");
  try {
    const mint = await createMint(
      connection,
      wallet,
      wallet.publicKey,
      null,
      6 // 6 decimals like USDC
    );
    console.log(`✓ test mint created: ${mint.toBase58()}`);

    // Create token account
    const tokenAccount = await createAccount(
      connection,
      wallet,
      mint,
      wallet.publicKey
    );
    console.log(`✓ token account created: ${tokenAccount.toBase58()}`);

    // Mint test tokens
    await mintTo(
      connection,
      wallet,
      mint,
      tokenAccount,
      wallet,
      1_000_000_000 // 1000 tokens (6 decimals)
    );
    const accountInfo = await getAccount(connection, tokenAccount);
    console.log(`✓ minted 1000 test tokens | balance: ${accountInfo.amount}`);
  } catch (e: any) {
    console.log(`✗ token creation failed: ${e.message}`);
  }

  // 4. PDA derivation test
  console.log("\n--- step 4: PDA derivation ---");
  const testMint = Keypair.generate().publicKey;
  const denomination = BigInt(1_000_000); // 1 token
  const denomBytes = Buffer.alloc(8);
  denomBytes.writeBigUInt64LE(denomination);

  const [shieldPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("shield_pool"), testMint.toBuffer(), denomBytes],
    PROGRAM_ID
  );
  console.log(`✓ shield pool PDA: ${shieldPoolPda.toBase58()}`);

  const [stealthRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stealth_registry"), wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );
  console.log(`✓ stealth registry PDA: ${stealthRegistryPda.toBase58()}`);

  const [confAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("confidential_account"), wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );
  console.log(`✓ confidential account PDA: ${confAccountPda.toBase58()}`);

  // 5. Final balance check
  console.log("\n--- step 5: final state ---");
  const finalBalance = await connection.getBalance(wallet.publicKey);
  console.log(`remaining balance: ${finalBalance / LAMPORTS_PER_SOL} SOL`);
  console.log(`program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`explorer: https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`);

  console.log("\n=== DEVNET TEST COMPLETE ===");
}

main().catch(console.error);
