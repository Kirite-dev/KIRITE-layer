import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { KiriteClient, DepositParams } from "@kirite/sdk";
import { loadConfig, saveNoteFile } from "../utils/config";
import { loadWallet } from "../utils/wallet";
import {
  printBanner,
  printHeader,
  printField,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printTransactionResult,
  formatAmount,
  shortenPubkey,
  formatHex,
  spinnerMessage,
} from "../utils/display";

/**
 * Registers the `kirite deposit` command.
 */
export function registerDepositCommand(program: Command): void {
  program
    .command("deposit")
    .description("Deposit tokens into a shield pool")
    .requiredOption("--amount <amount>", "Deposit amount (in base units)")
    .requiredOption("--pool <address>", "Shield pool address (base58)")
    .option("--mint <address>", "Token mint address (if different from pool default)")
    .option("--save-note <path>", "Save deposit note to file (IMPORTANT: needed for withdrawal)")
    .option("--wallet <path>", "Path to wallet keypair file")
    .option("--skip-preflight", "Skip transaction preflight simulation")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
          skipPreflight: opts.skipPreflight || config.skipPreflight,
          maxRetries: config.maxRetries,
          confirmTimeout: config.confirmTimeout * 1000,
        });

        await client.connect();

        const poolId = new PublicKey(opts.pool);
        const amount = new BN(opts.amount);

        // Fetch pool state to get mint and validate
        const spinner1 = spinnerMessage("Fetching pool state...");
        spinner1.start();

        const poolState = await client.getPoolState(poolId);
        spinner1.stop(true);

        const mint = opts.mint ? new PublicKey(opts.mint) : poolState.mint;

        printHeader("Shield Pool Deposit");
        printField("Depositor", shortenPubkey(wallet.publicKey));
        printField("Pool", shortenPubkey(poolId));
        printField("Amount", formatAmount(amount));
        printField("Mint", shortenPubkey(mint));
        printField("Tree Usage", `${poolState.nextLeafIndex} / ${2 ** poolState.treeDepth}`);
        console.log();

        // Validate denomination
        if (poolState.denominations.length > 0) {
          const validDenom = poolState.denominations.some((d) => d.eq(amount));
          if (!validDenom) {
            printError(
              `Amount ${formatAmount(amount)} is not a supported denomination.`
            );
            printInfo(
              `Supported: ${poolState.denominations
                .map((d) => formatAmount(d))
                .join(", ")}`
            );
            process.exit(1);
          }
        }

        if (poolState.isPaused) {
          printError("Pool is currently paused. Deposits are disabled.");
          process.exit(1);
        }

        const params: DepositParams = {
          poolId,
          amount,
          mint,
        };

        const spinner2 = spinnerMessage(
          "Generating commitment and submitting deposit..."
        );
        spinner2.start();

        const result = await client.deposit(params);

        spinner2.stop(true);

        // Serialize the note
        const serializedNote = client.serializeNote(result.note);

        printTransactionResult(result.signature, "Shield Pool Deposit", {
          "Leaf Index": result.note.leafIndex.toString(),
          "Commitment": formatHex(result.note.commitment),
        });

        // Save note to file if requested
        if (opts.saveNote) {
          saveNoteFile(opts.saveNote, serializedNote);
          printSuccess(`Deposit note saved to: ${opts.saveNote}`);
        } else {
          // Print the note to stdout
          printWarning(
            "SAVE THIS DEPOSIT NOTE! You need it to withdraw your funds."
          );
          console.log();
          console.log("  Note:");
          console.log(`  ${serializedNote}`);
          console.log();
          printInfo(
            "Use --save-note <path> to save the note to a file automatically."
          );
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
