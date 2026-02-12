import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".kirite");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/** CLI configuration shape */
export interface CliConfig {
  /** RPC endpoint URL or network name */
  endpoint: string;
  /** Path to wallet keypair file */
  walletPath: string;
  /** Default commitment level */
  commitment: "processed" | "confirmed" | "finalized";
  /** Custom program ID (optional) */
  programId?: string;
  /** Explorer URL template */
  explorerUrl: string;
  /** Maximum retries for transactions */
  maxRetries: number;
  /** Confirmation timeout in seconds */
  confirmTimeout: number;
  /** Skip preflight simulation */
  skipPreflight: boolean;
  /** Default priority fee in micro-lamports */
  priorityFee: number;
}

/** Default configuration values */
const DEFAULT_CONFIG: CliConfig = {
  endpoint: "https://api.devnet.solana.com",
  walletPath: path.join(os.homedir(), ".config", "solana", "id.json"),
  commitment: "confirmed",
  explorerUrl: "https://explorer.solana.com",
  maxRetries: 3,
  confirmTimeout: 30,
  skipPreflight: false,
  priorityFee: 0,
};

/**
 * Ensures the config directory exists.
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Loads the CLI configuration from disk.
 * If no config file exists, returns defaults.
 *
 * @returns Current CLI configuration
 */
export function loadConfig(): CliConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Saves the CLI configuration to disk.
 *
 * @param config - Configuration to save
 */
export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Gets a single configuration value.
 *
 * @param key - Configuration key
 * @returns Configuration value as string
 */
export function getConfigValue(key: keyof CliConfig): string {
  const config = loadConfig();
  const value = config[key];
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

/**
 * Sets a single configuration value.
 *
 * @param key - Configuration key
 * @param value - Value to set
 */
export function setConfigValue(key: string, value: string): void {
  const config = loadConfig();

  switch (key) {
    case "endpoint":
      config.endpoint = value;
      break;
    case "walletPath":
    case "wallet":
      config.walletPath = value;
      break;
    case "commitment":
      if (!["processed", "confirmed", "finalized"].includes(value)) {
        throw new Error(
          `Invalid commitment: ${value}. Must be processed, confirmed, or finalized.`
        );
      }
      config.commitment = value as CliConfig["commitment"];
      break;
    case "programId":
      config.programId = value;
      break;
    case "explorerUrl":
      config.explorerUrl = value;
      break;
    case "maxRetries":
      config.maxRetries = parseInt(value, 10);
      if (isNaN(config.maxRetries) || config.maxRetries < 0) {
        throw new Error("maxRetries must be a non-negative integer");
      }
      break;
    case "confirmTimeout":
      config.confirmTimeout = parseInt(value, 10);
      if (isNaN(config.confirmTimeout) || config.confirmTimeout <= 0) {
        throw new Error("confirmTimeout must be a positive integer");
      }
      break;
    case "skipPreflight":
      config.skipPreflight = value === "true" || value === "1";
      break;
    case "priorityFee":
      config.priorityFee = parseInt(value, 10);
      if (isNaN(config.priorityFee) || config.priorityFee < 0) {
        throw new Error("priorityFee must be a non-negative integer");
      }
      break;
    default:
      throw new Error(`Unknown config key: ${key}`);
  }

  saveConfig(config);
}

/**
 * Resets configuration to defaults.
 */
export function resetConfig(): void {
  saveConfig({ ...DEFAULT_CONFIG });
}

/**
 * Returns the config file path.
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Returns all configuration entries as key-value pairs.
 */
export function getAllConfigEntries(): [string, string][] {
  const config = loadConfig();
  return Object.entries(config).map(([key, value]) => [
    key,
    String(value ?? ""),
  ]);
}

/**
 * Reads a deposit note from a file.
 * @param filePath - Path to the note file
 * @returns Base64-encoded note string
 */
export function readNoteFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Note file not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf-8").trim();
}

/**
 * Saves a deposit note to a file.
 * @param filePath - Path to write the note
 * @param note - Base64-encoded note string
 */
export function saveNoteFile(filePath: string, note: string): void {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, note, "utf-8");
}
