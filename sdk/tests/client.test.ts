import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { KiriteClient } from "../src/client";
import { KIRITE_PROGRAM_ID, RPC_ENDPOINTS } from "../src/constants";
import { WalletNotConnectedError } from "../src/errors";

describe("KiriteClient", () => {
  let wallet: Keypair;

  beforeEach(() => {
    wallet = Keypair.generate();
  });

  describe("constructor", () => {
    it("creates client with endpoint string", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
      });

      expect(client.getConnection()).toBeInstanceOf(Connection);
      expect(client.getProgramId().equals(KIRITE_PROGRAM_ID)).toBe(true);
    });

    it("creates client with network name", () => {
      const client = new KiriteClient({
        endpoint: "devnet",
      });

      expect(client.getConnection()).toBeInstanceOf(Connection);
    });

    it("creates client with wallet", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      expect(client.getWalletPublicKey().equals(wallet.publicKey)).toBe(true);
    });

    it("creates client with custom program ID", () => {
      const customProgramId = Keypair.generate().publicKey;
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        programId: customProgramId,
      });

      expect(client.getProgramId().equals(customProgramId)).toBe(true);
    });
  });

  describe("wallet management", () => {
    it("throws WalletNotConnectedError when no wallet is set", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
      });

      expect(() => client.getWalletPublicKey()).toThrow(
        WalletNotConnectedError
      );
    });

    it("sets wallet via setWallet", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
      });

      client.setWallet(wallet);
      expect(client.getWalletPublicKey().equals(wallet.publicKey)).toBe(true);
    });

    it("returns ElGamal public key when wallet is set", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      const elGamalPk = client.getElGamalPublicKey();
      expect(elGamalPk).toBeInstanceOf(Uint8Array);
      expect(elGamalPk.length).toBe(32);
    });

    it("throws when getting ElGamal key without wallet", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
      });

      expect(() => client.getElGamalPublicKey()).toThrow(
        WalletNotConnectedError
      );
    });

    it("isReady returns false without wallet", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
      });

      expect(client.isReady()).toBe(false);
    });
  });

  describe("stealth meta-address generation", () => {
    it("generates a stealth meta-address", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      const metaAddress = client.generateStealthMetaAddress();

      expect(metaAddress.spendingKey).toBeInstanceOf(Uint8Array);
      expect(metaAddress.viewingKey).toBeInstanceOf(Uint8Array);
      expect(metaAddress.spendingKey.length).toBe(32);
      expect(metaAddress.viewingKey.length).toBe(32);
    });

    it("generates deterministic meta-addresses", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      const meta1 = client.generateStealthMetaAddress();
      const meta2 = client.generateStealthMetaAddress();

      expect(Buffer.from(meta1.spendingKey).toString("hex")).toBe(
        Buffer.from(meta2.spendingKey).toString("hex")
      );
      expect(Buffer.from(meta1.viewingKey).toString("hex")).toBe(
        Buffer.from(meta2.viewingKey).toString("hex")
      );
    });

    it("throws when generating meta-address without wallet", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
      });

      expect(() => client.generateStealthMetaAddress()).toThrow(
        WalletNotConnectedError
      );
    });
  });

  describe("stealth address generation", () => {
    it("generates unique stealth addresses for the same recipient", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      const metaAddress = client.generateStealthMetaAddress();
      const addr1 = client.generateStealthAddress(metaAddress);
      const addr2 = client.generateStealthAddress(metaAddress);

      // Each call generates a new ephemeral key, so addresses differ
      expect(addr1.address.toBase58()).not.toBe(addr2.address.toBase58());
      expect(Buffer.from(addr1.ephemeralPubkey).toString("hex")).not.toBe(
        Buffer.from(addr2.ephemeralPubkey).toString("hex")
      );
    });

    it("stealth address has valid view tag", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      const metaAddress = client.generateStealthMetaAddress();
      const stealth = client.generateStealthAddress(metaAddress);

      expect(stealth.viewTag).toBeGreaterThanOrEqual(0);
      expect(stealth.viewTag).toBeLessThanOrEqual(255);
    });
  });

  describe("deposit note serialization", () => {
    it("serializes and deserializes a deposit note", () => {
      const client = new KiriteClient({
        endpoint: RPC_ENDPOINTS.DEVNET,
        wallet,
      });

      const BN = require("bn.js");
      const note = {
        commitment: new Uint8Array(32).fill(1),
        nullifier: new Uint8Array(32).fill(2),
        secret: new Uint8Array(64).fill(3),
        amount: new BN(1_000_000),
        leafIndex: 42,
        timestamp: 1700000000,
        poolId: Keypair.generate().publicKey.toBase58(),
      };

      const serialized = client.serializeNote(note);
      expect(typeof serialized).toBe("string");

      const deserialized = client.deserializeNote(serialized);
      expect(deserialized.leafIndex).toBe(42);
      expect(deserialized.amount.toString()).toBe("1000000");
      expect(deserialized.timestamp).toBe(1700000000);
      expect(deserialized.poolId).toBe(note.poolId);
    });
  });
});
