declare module "bn.js" {
  export default class BN {
    constructor(num?: number | string | number[] | Uint8Array | BN, base?: number | "le" | "be", endian?: "le" | "be");
    add(b: BN): BN;
    sub(b: BN): BN;
    mul(b: BN): BN;
    div(b: BN): BN;
    mod(b: BN): BN;
    pow(b: BN): BN;
    cmp(b: BN): number;
    eq(b: BN): boolean;
    gt(b: BN): boolean;
    gte(b: BN): boolean;
    lt(b: BN): boolean;
    lte(b: BN): boolean;
    isZero(): boolean;
    isNeg(): boolean;
    abs(): BN;
    neg(): BN;
    toString(base?: number | "hex", length?: number): string;
    toNumber(): number;
    toArray(endian?: "le" | "be", length?: number): number[];
    toArrayLike(ArrayType: any, endian?: "le" | "be", length?: number): any;
    toBuffer(endian?: "le" | "be", length?: number): Buffer;
    toJSON(): string;
    bitLength(): number;
    byteLength(): number;
    clone(): BN;
    static isBN(obj: unknown): obj is BN;
  }
}
