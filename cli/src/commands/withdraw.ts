import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { KiriteClient, WithdrawParams } from "@kirite/sdk";
import { loadConfig, readNoteFile } from "../utils/config";
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
 * Registers the `kirite withdraw` command.
 */
export function registerWithdrawCommand(program: Command): void {
  program
    .command("withdraw")
    .description("Withdraw tokens from a shield pool using a deposit note")
    .requiredOption(
      "--note <note>",
      "Deposit note (base64 string or path to file)"
    )
    .requiredOption("--to <address>", "Recipient address (base58)")
    .requiredOption("--pool <address>", "Shield pool address (base58)")
    .option("--relayer-fee <amount>", "Relayer fee in base units (default: 0)")
    .option("--wallet <path>", "Path to wallet keypair file (can be a relayer)")
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

        // Load the deposit note (from string or file)
        let noteString: string;
        try {
          // Try as file path first
          noteString = readNoteFile(opts.note);
        } catch {
          // Treat as inline base64
          noteString = opts.note;
        }

        const note = client.deserializeNote(noteString);
        const poolId = new PublicKey(opts.pool);
        const recipient = new PublicKey(opts.to);
        const relayerFee = opts.relayerFee
          ? new BN(opts.relayerFee)
          : undefined;

        printHeader("Shield Pool Withdrawal");
        printField("Pool", shortenPubkey(poolId));
        printField("Recipient", shortenPubkey(recipient));
        printField("Amount", formatAmount(note.amount));
        printField("Leaf Index", note.leafIndex.toString());
        printField("Commitment", formatHex(note.commitment));
        if (relayerFee) {
          printField("Relayer Fee", formatAmount(relayerFee));
          printField("Net Amount", formatAmount(note.amount.sub(relayerFee)));
        }
        console.log();

        // Check if nullifier is already spent
        const spinner1 = spinnerMessage("Checking nullifier status...");
        spinner1.start();

        const isSpent = await client.isNoteSpent(note);
        spinner1.stop(true);

        if (isSpent) {
          printError("This deposit note has already been used for a withdrawal.");
          printInfo("Each deposit note can only be used once.");
          process.exit(1);
        }

        printSuccess("Nullifier not spent - proceeding with withdrawal");

        // Estimate relayer fee if not specified and using a relayer
        if (!relayerFee && !wallet.publicKey.equals(recipient)) {
          const spinner2 = spinnerMessage("Estimating relayer fee...");
          spinner2.start();

          const estimatedFee = await client.estimateRelayerFee();
          spinner2.stop(true);

          printInfo(`Estimated relayer fee: ${formatAmount(estimatedFee)}`);
        }

        const params: WithdrawParams = {
          poolId,
          note,
          recipient,
          relayerFee,
        };

        const spinner3 = spinnerMessage(
          "Generating withdrawal proof and submitting..."
        );
        spinner3.start();

        const result = await client.withdraw(params);

        spinner3.stop(true);

        printTransactionResult(result.signature, "Shield Pool Withdrawal", {
          "Recipient": result.recipient.toBase58(),
          "Net Amount": formatAmount(result.amount),
          "Slot": result.slot.toString(),
        });

        printSuccess(
          `Withdrawn ${formatAmount(result.amount)} to ${shortenPubkey(
            result.recipient
          )}`
        );
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
