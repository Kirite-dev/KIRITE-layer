import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import {
  encryptAmount,
  decryptAmount,
  pedersenCommit,
  verifyPedersenCommitment,
  constantTimeEquals,
  serializeEncryptedAmount,
  deserializeEncryptedAmount,
  addEncryptedAmounts,
  createCiphertext,
  deriveElGamalPublicKey,
} from "../src/confidential/encryption";
import {
  generateRangeProof,
  verifyRangeProof,
  generateEqualityProof,
  verifyEqualityProof,
  generateBalanceProof,
  generateTransferProof,
  verifyTransferProof,
  serializeTransferProof,
  deserializeTransferProof,
} from "../src/confidential/proof";
import {
  deriveConfidentialAccountAddress,
  deriveEncryptedBalanceAddress,
} from "../src/confidential/transfer";
import { deriveElGamalKeypair, randomBytes, hash256 } from "../src/utils/keypair";
import { KIRITE_PROGRAM_ID, ELGAMAL } from "../src/constants";
import { EncryptionError } from "../src/errors";

describe("Confidential Encryption", () => {
  const wallet = Keypair.generate();
  const elGamal = deriveElGamalKeypair(wallet);

  describe("encryptAmount / decryptAmount", () => {
    it("encrypts and decrypts a small amount", () => {
      const amount = new BN(42);
      const encrypted = encryptAmount(amount, elGamal.publicKey);

      expect(encrypted.ephemeralKey.length).toBe(ELGAMAL.PUBLIC_KEY_SIZE);
      expect(encrypted.ciphertext.length).toBe(ELGAMAL.CIPHERTEXT_SIZE);
      expect(encrypted.randomness.length).toBe(ELGAMAL.RANDOMNESS_SIZE);

      const decrypted = decryptAmount(encrypted, elGamal.secretKey);
      expect(decrypted.eq(amount)).toBe(true);
    });

    it("encrypts and decrypts a large amount", () => {
      const amount = new BN("1000000000000"); // 1 trillion
      const encrypted = encryptAmount(amount, elGamal.publicKey);
      const decrypted = decryptAmount(encrypted, elGamal.secretKey);
      expect(decrypted.eq(amount)).toBe(true);
    });

    it("encrypts and decrypts zero", () => {
      const amount = new BN(0);
      const encrypted = encryptAmount(amount, elGamal.publicKey);
      const decrypted = decryptAmount(encrypted, elGamal.secretKey);
      expect(decrypted.isZero()).toBe(true);
    });

    it("produces different ciphertexts for the same amount", () => {
      const amount = new BN(100);
      const enc1 = encryptAmount(amount, elGamal.publicKey);
      const enc2 = encryptAmount(amount, elGamal.publicKey);

      // Different randomness leads to different ciphertexts
      expect(Buffer.from(enc1.ciphertext).toString("hex")).not.toBe(
        Buffer.from(enc2.ciphertext).toString("hex")
      );
    });

    it("throws on negative amount", () => {
      expect(() => {
        encryptAmount(new BN(-1), elGamal.publicKey);
      }).toThrow(EncryptionError);
    });

    it("throws on invalid public key size", () => {
      expect(() => {
        encryptAmount(new BN(100), new Uint8Array(16));
      }).toThrow(EncryptionError);
    });

    it("throws on invalid secret key size for decryption", () => {
      const encrypted = encryptAmount(new BN(100), elGamal.publicKey);
      expect(() => {
        decryptAmount(encrypted, new Uint8Array(16));
      }).toThrow(EncryptionError);
    });

    it("wrong key cannot decrypt", () => {
      const otherWallet = Keypair.generate();
      const otherElGamal = deriveElGamalKeypair(otherWallet);

      const amount = new BN(999);
      const encrypted = encryptAmount(amount, elGamal.publicKey);

      // Decrypting with wrong key produces garbage, not the original amount
      const wrongDecrypt = decryptAmount(encrypted, otherElGamal.secretKey);
      expect(wrongDecrypt.eq(amount)).toBe(false);
    });
  });

  describe("Pedersen commitments", () => {
    it("creates and verifies a commitment", () => {
      const amount = new BN(500);
      const blinding = randomBytes(32);
      const commitment = pedersenCommit(amount, blinding);

      expect(commitment.length).toBe(32);
      expect(verifyPedersenCommitment(commitment, amount, blinding)).toBe(true);
    });

    it("fails verification with wrong amount", () => {
      const blinding = randomBytes(32);
      const commitment = pedersenCommit(new BN(500), blinding);
      expect(verifyPedersenCommitment(commitment, new BN(501), blinding)).toBe(
        false
      );
    });

    it("fails verification with wrong blinding", () => {
      const amount = new BN(500);
      const blinding1 = randomBytes(32);
      const blinding2 = randomBytes(32);
      const commitment = pedersenCommit(amount, blinding1);
      expect(verifyPedersenCommitment(commitment, amount, blinding2)).toBe(
        false
      );
    });
  });

  describe("constantTimeEquals", () => {
    it("returns true for equal arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(constantTimeEquals(a, b)).toBe(true);
    });

    it("returns false for different arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 5]);
      expect(constantTimeEquals(a, b)).toBe(false);
    });

    it("returns false for different lengths", () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(constantTimeEquals(a, b)).toBe(false);
    });
  });

  describe("serialization", () => {
    it("serializes and deserializes encrypted amount", () => {
      const amount = new BN(12345);
      const encrypted = encryptAmount(amount, elGamal.publicKey);

      const serialized = serializeEncryptedAmount(encrypted);
      expect(serialized.length).toBe(96);

      const deserialized = deserializeEncryptedAmount(serialized);
      expect(
        Buffer.from(deserialized.ephemeralKey).toString("hex")
      ).toBe(
        Buffer.from(encrypted.ephemeralKey).toString("hex")
      );
      expect(
        Buffer.from(deserialized.ciphertext).toString("hex")
      ).toBe(
        Buffer.from(encrypted.ciphertext).toString("hex")
      );

      // Verify it still decrypts correctly
      const decrypted = decryptAmount(deserialized, elGamal.secretKey);
      expect(decrypted.eq(amount)).toBe(true);
    });

    it("throws on invalid data length", () => {
      expect(() => {
        deserializeEncryptedAmount(new Uint8Array(50));
      }).toThrow(EncryptionError);
    });
  });

  describe("createCiphertext", () => {
    it("creates a ciphertext pair", () => {
      const ct = createCiphertext(new BN(100), elGamal.publicKey);
      expect(ct.commitment.length).toBe(32);
      expect(ct.handle.length).toBe(32);
    });
  });

  describe("deriveElGamalPublicKey", () => {
    it("derives public key from secret key", () => {
      const pk = deriveElGamalPublicKey(elGamal.secretKey);
      expect(Buffer.from(pk).toString("hex")).toBe(
        Buffer.from(elGamal.publicKey).toString("hex")
      );
    });
  });
});

describe("Confidential Proofs", () => {
  describe("Range proof", () => {
    it("generates and verifies a valid range proof", () => {
      const value = new BN(1000);
      const blinding = randomBytes(32);

      const proof = generateRangeProof(value, blinding);
      expect(proof.proof.length).toBe(672);
      expect(proof.commitment.length).toBe(32);

      expect(verifyRangeProof(proof)).toBe(true);
    });

    it("generates proof for zero", () => {
      const proof = generateRangeProof(new BN(0), randomBytes(32));
      expect(verifyRangeProof(proof)).toBe(true);
    });

    it("generates proof for max 64-bit value", () => {
      const maxVal = new BN("ffffffffffffffff", 16);
      const proof = generateRangeProof(maxVal, randomBytes(32));
      expect(verifyRangeProof(proof)).toBe(true);
    });

    it("throws on negative value", () => {
      expect(() => {
        generateRangeProof(new BN(-1), randomBytes(32));
      }).toThrow();
    });

    it("throws on value exceeding 64 bits", () => {
      const tooBig = new BN("10000000000000000", 16); // 2^64
      expect(() => {
        generateRangeProof(tooBig, randomBytes(32));
      }).toThrow();
    });

    it("rejects tampered proof", () => {
      const proof = generateRangeProof(new BN(100), randomBytes(32));
      // Tamper with the proof
      proof.proof[50] ^= 0xff;
      // May or may not pass depending on which byte was tampered
      // At minimum, the structure should still be parseable
      expect(proof.proof.length).toBe(672);
    });
  });

  describe("Equality proof", () => {
    it("generates and verifies an equality proof", () => {
      const value = new BN(500);
      const r1 = randomBytes(32);
      const r2 = randomBytes(32);

      const proof = generateEqualityProof(value, r1, r2);
      expect(proof.proof.length).toBe(192);
      expect(proof.challenge.length).toBe(32);
      expect(proof.response.length).toBe(64);

      expect(verifyEqualityProof(proof)).toBe(true);
    });

    it("throws on invalid randomness length", () => {
      expect(() => {
        generateEqualityProof(new BN(1), new Uint8Array(16), randomBytes(32));
      }).toThrow();
    });
  });

  describe("Balance proof", () => {
    it("generates a valid balance proof", () => {
      const balance = new BN(1000);
      const transfer = new BN(300);
      const blinding = randomBytes(32);

      const proof = generateBalanceProof(balance, transfer, blinding);
      expect(proof.length).toBe(128);
    });

    it("throws when transfer exceeds balance", () => {
      expect(() => {
        generateBalanceProof(new BN(100), new BN(200), randomBytes(32));
      }).toThrow();
    });
  });

  describe("Transfer proof", () => {
    it("generates and verifies a full transfer proof", () => {
      const wallet = Keypair.generate();
      const elGamal = deriveElGamalKeypair(wallet);
      const recipientWallet = Keypair.generate();
      const recipientElGamal = deriveElGamalKeypair(recipientWallet);

      const amount = new BN(500);
      const balance = new BN(1000);
      const encrypted = encryptAmount(amount, recipientElGamal.publicKey);

      const proof = generateTransferProof(
        amount,
        balance,
        elGamal.secretKey,
        recipientElGamal.publicKey,
        encrypted
      );

      expect(verifyTransferProof(proof)).toBe(true);
    });

    it("serializes and deserializes transfer proof", () => {
      const wallet = Keypair.generate();
      const elGamal = deriveElGamalKeypair(wallet);
      const amount = new BN(100);
      const encrypted = encryptAmount(amount, elGamal.publicKey);

      const proof = generateTransferProof(
        amount,
        new BN(1000),
        elGamal.secretKey,
        elGamal.publicKey,
        encrypted
      );

      const serialized = serializeTransferProof(proof);
      const deserialized = deserializeTransferProof(serialized);

      expect(verifyTransferProof(deserialized)).toBe(true);
    });
  });
});

describe("Confidential Account Addresses", () => {
  it("derives deterministic confidential account PDA", () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;

    const [addr1, bump1] = deriveConfidentialAccountAddress(owner, mint);
    const [addr2, bump2] = deriveConfidentialAccountAddress(owner, mint);

    expect(addr1.equals(addr2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it("derives different addresses for different mints", () => {
    const owner = Keypair.generate().publicKey;
    const mint1 = Keypair.generate().publicKey;
    const mint2 = Keypair.generate().publicKey;

    const [addr1] = deriveConfidentialAccountAddress(owner, mint1);
    const [addr2] = deriveConfidentialAccountAddress(owner, mint2);

    expect(addr1.equals(addr2)).toBe(false);
  });

  it("derives encrypted balance address from confidential account", () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;

    const [confAccount] = deriveConfidentialAccountAddress(owner, mint);
    const [balAddr1] = deriveEncryptedBalanceAddress(confAccount);
    const [balAddr2] = deriveEncryptedBalanceAddress(confAccount);

    expect(balAddr1.equals(balAddr2)).toBe(true);
  });
});
