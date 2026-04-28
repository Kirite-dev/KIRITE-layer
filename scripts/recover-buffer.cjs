const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const { PublicKey } = require("@solana/web3.js");

const mnemonic = process.argv[2];
const outPath = process.argv[3];
if (!mnemonic || !outPath) {
  console.error("usage: node recover-buffer.cjs '<12-word mnemonic>' <output-json>");
  process.exit(1);
}

// solana-keygen default (no derivation path, no passphrase) recipe:
// seed = pbkdf2(mnemonic, "mnemonic", 2048, 64, sha512); kp = ed25519.fromSeed(seed[0..32])
const seed = crypto.pbkdf2Sync(
  mnemonic.normalize("NFKD"),
  Buffer.from("mnemonic", "utf-8"),
  2048,
  64,
  "sha512"
);
const kp = nacl.sign.keyPair.fromSeed(seed.slice(0, 32));
const secretKey = Buffer.concat([Buffer.from(kp.secretKey)]);
fs.writeFileSync(outPath, JSON.stringify(Array.from(secretKey)));
console.log(new PublicKey(Buffer.from(kp.publicKey)).toBase58());
