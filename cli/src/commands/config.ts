import { Command } from "commander";
import {
  loadConfig,
  setConfigValue,
  resetConfig,
  getConfigPath,
  getAllConfigEntries,
} from "../utils/config";
import {
  printBanner,
  printHeader,
  printField,
  printSuccess,
  printError,
  printTable,
} from "../utils/display";
import { getWalletInfo } from "../utils/wallet";

/**
 * Registers the `kirite config` command group.
 */
export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage CLI configuration");

  // kirite config get [key]
  configCmd
    .command("get [key]")
    .description("Get a configuration value (or all values)")
    .action((key?: string) => {
      try {
        if (key) {
          const config = loadConfig();
          const value = (config as Record<string, unknown>)[key];
          if (value === undefined) {
            printError(`Unknown config key: ${key}`);
            process.exit(1);
          }
          printField(key, String(value));
        } else {
          // Show all config
          printBanner();
          printHeader("Configuration");
          printField("Config File", getConfigPath());
          console.log();

          const entries = getAllConfigEntries();
          for (const [k, v] of entries) {
            printField(k, v);
          }

          // Show wallet info
          console.log();
          printHeader("Wallet");
          const walletInfo = getWalletInfo();
          printField("Path", walletInfo.path);
          printField("Exists", walletInfo.exists ? "Yes" : "No");
          if (walletInfo.exists) {
            printField("Public Key", walletInfo.publicKey);
          }
          console.log();
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite config set <key> <value>
  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key: string, value: string) => {
      try {
        setConfigValue(key, value);
        printSuccess(`Set ${key} = ${value}`);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite config reset
  configCmd
    .command("reset")
    .description("Reset configuration to defaults")
    .action(() => {
      try {
        resetConfig();
        printSuccess("Configuration reset to defaults");
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite config path
  configCmd
    .command("path")
    .description("Show the config file path")
    .action(() => {
      console.log(getConfigPath());
    });
}
