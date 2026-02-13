import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  derivePoolAddress,
  derivePoolTokenAddress,
  derivePoolAuthorityAddress,
  deriveNullifierAddress,
  computeMerkleRoot,
  computeMerklePath,
  verifyMerklePath,
  hashPair,
  computeLeafHash,
  getZeroHashes,
} from "../src/shield-pool/pool-state";
import {
  generateDepositSecrets,
  computeFinalNullifier,
  generateDepositProof,
  serializeDepositNote,
  deserializeDepositNote,
} from "../src/shield-pool/deposit";
import {
  generateWithdrawProof,
  verifyWithdrawProof,
} from "../src/shield-pool/withdraw";
import { hash256, randomBytes } from "../src/utils/keypair";
import { KIRITE_PROGRAM_ID, ZERO_VALUE, PROOF_SIZES } from "../src/constants";

describe("Shield Pool - PDA Derivation", () => {
  const mint = Keypair.generate().publicKey;

  it("derives deterministic pool address", () => {
    const [addr1, bump1] = derivePoolAddress(mint, 0);
    const [addr2, bump2] = derivePoolAddress(mint, 0);

    expect(addr1.equals(addr2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it("derives different addresses for different pool indices", () => {
    const [addr1] = derivePoolAddress(mint, 0);
    const [addr2] = derivePoolAddress(mint, 1);

    expect(addr1.equals(addr2)).toBe(false);
  });

  it("derives pool token address from pool", () => {
    const [poolAddr] = derivePoolAddress(mint, 0);
    const [tokenAddr1] = derivePoolTokenAddress(poolAddr);
    const [tokenAddr2] = derivePoolTokenAddress(poolAddr);

    expect(tokenAddr1.equals(tokenAddr2)).toBe(true);
  });

  it("derives pool authority address", () => {
    const [poolAddr] = derivePoolAddress(mint, 0);
    const [authAddr] = derivePoolAuthorityAddress(poolAddr);

    expect(authAddr).toBeInstanceOf(PublicKey);
  });

  it("derives nullifier address", () => {
    const nullifier = randomBytes(32);
    const [addr1] = deriveNullifierAddress(nullifier);
    const [addr2] = deriveNullifierAddress(nullifier);

    expect(addr1.equals(addr2)).toBe(true);
  });

  it("different nullifiers have different addresses", () => {
    const [addr1] = deriveNullifierAddress(randomBytes(32));
    const [addr2] = deriveNullifierAddress(randomBytes(32));

    expect(addr1.equals(addr2)).toBe(false);
  });
});

describe("Shield Pool - Merkle Tree", () => {
  describe("hashPair", () => {
    it("produces deterministic output", () => {
      const left = randomBytes(32);
      const right = randomBytes(32);

      const hash1 = hashPair(left, right);
      const hash2 = hashPair(left, right);

      expect(Buffer.from(hash1).toString("hex")).toBe(
        Buffer.from(hash2).toString("hex")
      );
    });

    it("is order-dependent", () => {
      const a = randomBytes(32);
      const b = randomBytes(32);

      const hash1 = hashPair(a, b);
      const hash2 = hashPair(b, a);

      expect(Buffer.from(hash1).toString("hex")).not.toBe(
        Buffer.from(hash2).toString("hex")
      );
    });
  });

  describe("computeLeafHash", () => {
    it("produces 32-byte hash", () => {
      const commitment = randomBytes(32);
      const leaf = computeLeafHash(commitment);
      expect(leaf.length).toBe(32);
    });

    it("is deterministic", () => {
      const commitment = randomBytes(32);
      const leaf1 = computeLeafHash(commitment);
      const leaf2 = computeLeafHash(commitment);
      expect(Buffer.from(leaf1).toString("hex")).toBe(
        Buffer.from(leaf2).toString("hex")
      );
    });
  });

  describe("computeMerkleRoot", () => {
    it("computes root for single leaf", () => {
      const leaf = randomBytes(32);
      const root = computeMerkleRoot([leaf], 2); // depth 2 = 4 leaves
      expect(root.length).toBe(32);
    });

    it("computes root for multiple leaves", () => {
      const leaves = [randomBytes(32), randomBytes(32), randomBytes(32)];
      const root = computeMerkleRoot(leaves, 2);
      expect(root.length).toBe(32);
    });

    it("different leaves produce different roots", () => {
      const root1 = computeMerkleRoot([randomBytes(32)], 2);
      const root2 = computeMerkleRoot([randomBytes(32)], 2);
      expect(Buffer.from(root1).toString("hex")).not.toBe(
        Buffer.from(root2).toString("hex")
      );
    });

    it("empty tree has deterministic root", () => {
      const root1 = computeMerkleRoot([], 3);
      const root2 = computeMerkleRoot([], 3);
      expect(Buffer.from(root1).toString("hex")).toBe(
        Buffer.from(root2).toString("hex")
      );
    });
  });

  describe("computeMerklePath and verifyMerklePath", () => {
    it("generates and verifies valid path for first leaf", () => {
      const leaves = [randomBytes(32), randomBytes(32), randomBytes(32)];
      const depth = 2;

      const root = computeMerkleRoot(leaves, depth);
      const path = computeMerklePath(leaves, 0, depth);

      expect(path.siblings.length).toBe(depth);
      expect(path.pathIndices.length).toBe(depth);

      const isValid = verifyMerklePath(root, leaves[0], path);
      expect(isValid).toBe(true);
    });

    it("generates and verifies valid path for last leaf", () => {
      const leaves = [
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
      ];
      const depth = 2;

      const root = computeMerkleRoot(leaves, depth);
      const path = computeMerklePath(leaves, 3, depth);

      const isValid = verifyMerklePath(root, leaves[3], path);
      expect(isValid).toBe(true);
    });

    it("rejects path for wrong leaf", () => {
      const leaves = [randomBytes(32), randomBytes(32)];
      const depth = 2;

      const root = computeMerkleRoot(leaves, depth);
      const path = computeMerklePath(leaves, 0, depth);

      // Use a different leaf
      const wrongLeaf = randomBytes(32);
      const isValid = verifyMerklePath(root, wrongLeaf, path);
      expect(isValid).toBe(false);
    });

    it("rejects path against wrong root", () => {
      const leaves = [randomBytes(32), randomBytes(32)];
      const depth = 2;

      const path = computeMerklePath(leaves, 0, depth);
      const wrongRoot = randomBytes(32);

      const isValid = verifyMerklePath(wrongRoot, leaves[0], path);
      expect(isValid).toBe(false);
    });
  });

  describe("getZeroHashes", () => {
    it("generates correct number of zero hashes", () => {
      const hashes = getZeroHashes(5);
      expect(hashes.length).toBe(6); // depth + 1 (includes level 0)
    });

    it("first zero hash is the zero value", () => {
      const hashes = getZeroHashes(3);
      expect(Buffer.from(hashes[0]).toString("hex")).toBe(
        ZERO_VALUE.toString("hex")
      );
    });

    it("each level is hash of previous level pair", () => {
      const hashes = getZeroHashes(3);
      for (let i = 1; i <= 3; i++) {
        const expected = hashPair(hashes[i - 1], hashes[i - 1]);
        expect(Buffer.from(hashes[i]).toString("hex")).toBe(
          Buffer.from(expected).toString("hex")
        );
      }
    });
  });
});

describe("Shield Pool - Deposit", () => {
  const poolId = Keypair.generate().publicKey;
  const amount = new BN(1_000_000_000);

  describe("generateDepositSecrets", () => {
    it("generates commitment and nullifier", () => {
      const secrets = generateDepositSecrets(amount, poolId);

      expect(secrets.commitment.length).toBe(32);
      expect(secrets.nullifier.length).toBe(32);
      expect(secrets.secret.length).toBe(32);
      expect(secrets.nullifierSecret.length).toBe(32);
    });

    it("generates unique secrets each time", () => {
      const s1 = generateDepositSecrets(amount, poolId);
      const s2 = generateDepositSecrets(amount, poolId);

      expect(Buffer.from(s1.commitment).toString("hex")).not.toBe(
        Buffer.from(s2.commitment).toString("hex")
      );
    });
  });

  describe("computeFinalNullifier", () => {
    it("computes deterministic final nullifier", () => {
      const nullifierSecret = randomBytes(32);
      const leafIndex = 5;

      const n1 = computeFinalNullifier(nullifierSecret, leafIndex, poolId);
      const n2 = computeFinalNullifier(nullifierSecret, leafIndex, poolId);

      expect(Buffer.from(n1).toString("hex")).toBe(
        Buffer.from(n2).toString("hex")
      );
    });

    it("different leaf indices produce different nullifiers", () => {
      const nullifierSecret = randomBytes(32);
      const n1 = computeFinalNullifier(nullifierSecret, 0, poolId);
      const n2 = computeFinalNullifier(nullifierSecret, 1, poolId);

      expect(Buffer.from(n1).toString("hex")).not.toBe(
        Buffer.from(n2).toString("hex")
      );
    });
  });

  describe("generateDepositProof", () => {
    it("generates a valid deposit proof", () => {
      const secrets = generateDepositSecrets(amount, poolId);
      const proof = generateDepositProof(
        secrets.commitment,
        amount,
        secrets.secret
      );

      expect(proof.commitment.length).toBe(32);
      expect(proof.nullifier.length).toBe(32);
      expect(proof.proof.length).toBe(PROOF_SIZES.DEPOSIT_PROOF);
    });
  });

  describe("deposit note serialization", () => {
    it("round-trips correctly", () => {
      const note = {
        commitment: randomBytes(32),
        nullifier: randomBytes(32),
        secret: Buffer.concat([randomBytes(32), randomBytes(32)]),
        amount: new BN("5000000000"),
        leafIndex: 123,
        timestamp: 1700000000,
        poolId: poolId.toBase58(),
      };

      const serialized = serializeDepositNote(note);
      expect(typeof serialized).toBe("string");
      expect(serialized.length).toBeGreaterThan(0);

      const deserialized = deserializeDepositNote(serialized);
      expect(deserialized.amount.toString()).toBe("5000000000");
      expect(deserialized.leafIndex).toBe(123);
      expect(deserialized.timestamp).toBe(1700000000);
      expect(deserialized.poolId).toBe(poolId.toBase58());
      expect(
        Buffer.from(deserialized.commitment).toString("hex")
      ).toBe(Buffer.from(note.commitment).toString("hex"));
    });
  });
});

describe("Shield Pool - Withdraw", () => {
  describe("verifyWithdrawProof", () => {
    it("verifies a valid withdrawal proof", () => {
      const poolId = Keypair.generate().publicKey;
      const amount = new BN(1_000_000_000);
      const recipient = Keypair.generate().publicKey;

      // Create a deposit note
      const secrets = generateDepositSecrets(amount, poolId);
      const leafIndex = 0;
      const finalNullifier = computeFinalNullifier(
        secrets.nullifierSecret,
        leafIndex,
        poolId
      );

      const note = {
        commitment: secrets.commitment,
        nullifier: finalNullifier,
        secret: Buffer.concat([
          Buffer.from(secrets.secret),
          Buffer.from(secrets.nullifierSecret),
        ]),
        amount,
        leafIndex,
        timestamp: Date.now(),
        poolId: poolId.toBase58(),
      };

      // Build a small tree
      const leafHash = computeLeafHash(note.commitment);
      const leaves = [leafHash, randomBytes(32), randomBytes(32)];
      const depth = 2;
      const root = computeMerkleRoot(leaves, depth);
      const path = computeMerklePath(leaves, 0, depth);

      const withdrawProof = generateWithdrawProof(
        note,
        path,
        root,
        recipient
      );

      expect(verifyWithdrawProof(withdrawProof)).toBe(true);
      expect(withdrawProof.nullifier.length).toBe(32);
      expect(withdrawProof.root.length).toBe(32);
      expect(withdrawProof.proof.length).toBe(PROOF_SIZES.WITHDRAW_PROOF);
    });

    it("rejects proof with zero nullifier", () => {
      const proof = {
        nullifier: new Uint8Array(32), // all zeros
        root: randomBytes(32),
        proof: randomBytes(PROOF_SIZES.WITHDRAW_PROOF),
        recipientHash: randomBytes(32),
      };

      expect(verifyWithdrawProof(proof)).toBe(false);
    });

    it("rejects proof with wrong size", () => {
      const proof = {
        nullifier: randomBytes(32),
        root: randomBytes(32),
        proof: randomBytes(100), // wrong size
        recipientHash: randomBytes(32),
      };

      expect(verifyWithdrawProof(proof)).toBe(false);
    });
  });
});
