declare module "tweetnacl" {
  type ByteArray = Uint8Array;

  interface BoxKeyPair {
    publicKey: ByteArray;
    secretKey: ByteArray;
  }

  interface SignKeyPair {
    publicKey: ByteArray;
    secretKey: ByteArray;
  }

  interface Nacl {
    box: {
      (msg: ByteArray, nonce: ByteArray, theirPubKey: ByteArray, mySecretKey: ByteArray): ByteArray;
      open: (
        box: ByteArray,
        nonce: ByteArray,
        theirPubKey: ByteArray,
        mySecretKey: ByteArray
      ) => ByteArray | null;
      before: (theirPubKey: ByteArray, mySecretKey: ByteArray) => ByteArray;
      keyPair: {
        (): BoxKeyPair;
        fromSecretKey: (secretKey: ByteArray) => BoxKeyPair;
      };
      publicKeyLength: number;
      secretKeyLength: number;
      sharedKeyLength: number;
      nonceLength: number;
    };
    sign: {
      keyPair: {
        (): SignKeyPair;
        fromSecretKey: (secretKey: ByteArray) => SignKeyPair;
        fromSeed: (seed: ByteArray) => SignKeyPair;
      };
      detached: (msg: ByteArray, secretKey: ByteArray) => ByteArray;
      publicKeyLength: number;
      secretKeyLength: number;
      seedLength: number;
      signatureLength: number;
    };
    randomBytes: (length: number) => ByteArray;
    hash: (msg: ByteArray) => ByteArray;
  }

  const nacl: Nacl;
  export default nacl;
}
