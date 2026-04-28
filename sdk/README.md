# @kirite/sdk

TypeScript SDK for the [KIRITE](https://kirite.dev) privacy protocol on Solana. Tornado-style ZK shield pool with stealth-address recipients, native to Solana.

## Install

```bash
npm install @kirite/sdk @solana/web3.js
```

## What this package gives you

- **Types** for the KIRITE on-chain program: `DepositNote`, `ShieldPoolState`, `StealthMetaAddress`, `StealthAddress`, `StealthPayment`, `Groth16Proof`, etc.
- **Constants** matching the deployed program: `KIRITE_PROGRAM_ID`, `DEFAULT_DENOMINATIONS` (0.01 / 0.05 / 0.1 / 1 / 10 SOL), `DEFAULT_TREE_DEPTH` (5), Merkle / nullifier seeds.
- **Errors** that the on-chain program returns: `NullifierSpentError`, `TreeFullError`, `PoolFrozenError`, etc.
- **Stealth-address helpers**: DKSAP meta-address generation, ECDH derivation, view-tag scanning, on-chain registry interactions.
- **Solana transport utilities**: connection helpers, transaction builder with priority-fee bumping, retry / backoff config.
- **v3 ZK helpers** (`@kirite/sdk/zk`): the actual Groth16 + Poseidon Merkle deposit/withdraw flow used in production. Browser proof generation via snarkjs WASM.
- **Staking helpers** (`@kirite/sdk/staking`): non-custodial stake/unstake/claim instructions for the Token-2022 $KIRITE mint.

## Quick start

### Resolve a pool and check its anonymity set

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  DEFAULT_DENOMINATIONS,
} from "@kirite/sdk";
import BN from "bn.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");

const denomination = DEFAULT_DENOMINATIONS[3]; // 1 SOL
const [poolPda] = PublicKey.findProgramAddressSync(
  [SEEDS.POOL_STATE, denomination.toArrayLike(Buffer, "le", 8)],
  KIRITE_PROGRAM_ID
);
```

### Generate a stealth meta-address

```ts
import { Keypair } from "@solana/web3.js";
import { generateStealthMetaAddress } from "@kirite/sdk";

const wallet = Keypair.generate();
const meta = generateStealthMetaAddress(wallet);
// meta.spendingKey, meta.viewingKey  → publish to a recipient
```

### Deposit + withdraw via the v3 ZK helpers

```ts
import { deposit, withdraw } from "@kirite/sdk/zk";

const note = await deposit({ connection, payer: wallet, denomination });
// → persist `note` locally on the depositor's device

// later, when ready to withdraw to a stealth address:
const sig = await withdraw({
  connection,
  note,
  recipient: stealthAddress.address,
  relayerUrl: "https://relayer.kirite.dev",
});
```

### Stake $KIRITE

```ts
import { stake, unstake, claim } from "@kirite/sdk/staking";

const sig = await stake({ connection, owner: wallet, amount: new BN(1_000_000_000) });
```

## Status

- **Privacy program**: end-to-end verified on Solana devnet. Mainnet rollout in progress.
- **Staking program**: deployed on Solana mainnet.
- **SDK**: 0.5.x is the v3 surface. 0.4.x and earlier are deprecated.

## Honest scope

KIRITE hides the deposit↔withdraw link and the recipient address. It does **not** hide amounts (each pool is fixed-denomination) and does **not** provide infinite anonymity (pools cap at 32 leaves on v1). Practical privacy scales with the active anonymity set.

For more, see the [KIRITE docs](https://kirite.dev/docs) and the [threat model](https://kirite.dev/docs/threat-model).

## License

MIT
