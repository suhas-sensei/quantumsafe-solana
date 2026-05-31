# porst-wasm — browser signer

WebAssembly bindings for the PORST/XMSS post-quantum signer. This runs the exact
same cryptography as the native `porst-signer` CLI — and is **proven
byte-for-byte identical** to it (`node parity-test.js`) — so signatures produced
in the browser verify on-chain unchanged. ~156 KB `.wasm`, no server needed.

## Build

```bash
# for a web frontend (Vite/Next/plain ESM)
wasm-pack build wasm --target web --out-dir pkg --release

# for Node (used by parity-test.js)
wasm-pack build wasm --target nodejs --out-dir pkg-node --release
```

## API

| function | returns |
| -------- | ------- |
| `keygen(seedHex)` | keystore JSON `{version, seed, xmss_root, xmss_nodes}` |
| `random_seed_hex()` | 32 random bytes (hex) for a seed |
| `wallet_pubkey(keystoreJson)` | XMSS root (hex) = wallet public key |
| `sign_transfer(keystoreJson, epoch, nonce, recipientHex, amount)` | `{digest, signature}` (hex) |
| `verify_transfer(rootHex, epoch, nonce, recipientHex, amount, sigHex)` | `bool` (instant UI feedback) |
| `signing_capacity() / num_epochs() / xmss_height() / lifetime_capacity()` | wallet params |

`epoch / nonce / amount` are plain JS numbers. `recipientHex` is the recipient's
32-byte pubkey as hex (`Buffer.from(pubkey.toBytes()).toString("hex")`).

## Usage (web)

```js
import init, { keygen, wallet_pubkey, sign_transfer } from "./pkg/porst_wasm.js";

await init();                                  // load the .wasm
const ks   = keygen(crypto.getRandomValues... ); // or random_seed_hex()
const root = wallet_pubkey(ks);                // -> create on-chain wallet with this
// read (epoch, nonce) from the on-chain wallet account, then:
const { signature } = JSON.parse(
  sign_transfer(ks, epoch, nonce, recipientHex, amountLamports)
);
// stage `signature` (~13 KB) into a buffer account and call execute_transfer
```

> Keygen builds 16 PORST trees (~2 s of hashing). Run it inside a **Web Worker**
> so the UI stays responsive, and persist the returned keystore (it contains the
> secret seed — encrypt it at rest).

## Parity check

```bash
cargo build -p porst-signer --release        # native CLI to compare against
wasm-pack build wasm --target nodejs --out-dir pkg-node --release
node wasm/parity-test.js                      # asserts identical keys + signatures
```
