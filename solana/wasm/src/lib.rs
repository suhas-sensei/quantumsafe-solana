//! Browser (WebAssembly) bindings for the PORST/XMSS post-quantum signer.
//!
//! This exposes the exact same `porst-signer` cryptography that the on-chain
//! program is verified against — keygen, signing, and verification — so a web
//! frontend can run the whole post-quantum signing flow client-side with no Rust
//! CLI and no server. The signature it produces is byte-for-byte identical to the
//! native CLI for the same inputs (deterministic salts), so it verifies on-chain
//! unchanged.
//!
//! `u64` values (epoch, nonce, amount) are passed as JS numbers (`f64`). That is
//! exact for all realistic values: epochs/nonces are tiny and lamport amounts up
//! to 2^53 (~9 billion SOL) are represented exactly.
//!
//! Build for the web with:
//!   wasm-pack build wasm --target web --out-dir pkg

use porst_signer::{
    close_perp_digest, hex32, keygen as ks_keygen, open_perp_digest, route_hash as core_route_hash,
    sign_digest, swap_digest, transfer_digest, verify_wallet_sig, Keystore, NUM_EPOCHS,
    SIGNING_CAPACITY, XMSS_HEIGHT,
};
use wasm_bindgen::prelude::*;

fn js_err<E: core::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn to32(h: &str) -> Result<[u8; 32], JsValue> {
    hex32(h).map_err(|e| JsValue::from_str(&e))
}

/// Generate a fresh keystore from a 32-byte hex seed. Returns the keystore as a
/// JSON string (`{version, seed, xmss_root, xmss_nodes}`). The `xmss_nodes` array
/// is handy for visualizing the XMSS tree in a UI.
///
/// Building 16 PORST trees is a few seconds of hashing — call it from a Web
/// Worker so the UI stays responsive.
#[wasm_bindgen]
pub fn keygen(seed_hex: &str) -> Result<String, JsValue> {
    let seed = to32(seed_hex)?;
    let ks = ks_keygen(&seed);
    serde_json::to_string(&ks).map_err(js_err)
}

/// Generate 32 random bytes (hex) using the platform CSPRNG, for use as a seed.
#[wasm_bindgen]
pub fn random_seed_hex() -> Result<String, JsValue> {
    let mut s = [0u8; 32];
    getrandom::getrandom(&mut s).map_err(js_err)?;
    Ok(hex::encode(s))
}

/// The wallet public key (XMSS root, hex) from a keystore JSON string.
#[wasm_bindgen]
pub fn wallet_pubkey(keystore_json: &str) -> Result<String, JsValue> {
    let ks: Keystore = serde_json::from_str(keystore_json).map_err(js_err)?;
    Ok(ks.xmss_root)
}

/// Sign a SOL-transfer intent. `recipient_hex` is the recipient's 32-byte pubkey
/// as hex. Returns a JSON string `{digest, signature}` (both hex). The signature
/// is ~13 KB; the frontend stages it into a buffer account and calls
/// `execute_transfer`.
#[wasm_bindgen]
pub fn sign_transfer(
    keystore_json: &str,
    epoch: f64,
    nonce: f64,
    recipient_hex: &str,
    amount: f64,
) -> Result<String, JsValue> {
    let ks: Keystore = serde_json::from_str(keystore_json).map_err(js_err)?;
    let root = to32(&ks.xmss_root)?;
    let recipient = to32(recipient_hex)?;
    let (e, n, a) = (epoch as u64, nonce as u64, amount as u64);
    let digest = transfer_digest(&root, e, n, &recipient, a);
    let sig = sign_digest(&ks, e, &digest);
    serde_json::to_string(&serde_json::json!({
        "digest": hex::encode(digest),
        "signature": hex::encode(sig),
    }))
    .map_err(js_err)
}

/// Verify a transfer signature off-chain (mirrors the on-chain check) — useful
/// for instant UI feedback before submitting.
#[wasm_bindgen]
pub fn verify_transfer(
    xmss_root_hex: &str,
    epoch: f64,
    nonce: f64,
    recipient_hex: &str,
    amount: f64,
    signature_hex: &str,
) -> Result<bool, JsValue> {
    let root = to32(xmss_root_hex)?;
    let recipient = to32(recipient_hex)?;
    let (e, n, a) = (epoch as u64, nonce as u64, amount as u64);
    let digest = transfer_digest(&root, e, n, &recipient, a);
    let sig = hex::decode(signature_hex.trim()).map_err(js_err)?;
    Ok(verify_wallet_sig(&root, &digest, &sig, e))
}

/// Compute the route binding hash `keccak256(DS_ROUTE ‖ amm_program ‖ pool)`
/// (hex) — which DEX program + pool a swap is authorized to touch.
#[wasm_bindgen]
pub fn route_hash(amm_program_hex: &str, pool_hex: &str) -> Result<String, JsValue> {
    let amm = to32(amm_program_hex)?;
    let pool = to32(pool_hex)?;
    Ok(hex::encode(core_route_hash(&amm, &pool)))
}

/// Sign a token-swap intent. Mints and route hash are 32-byte hex; `amount_in`,
/// `min_out`, `epoch`, `nonce` are numbers; `expiry` is a unix timestamp.
/// Returns JSON `{digest, signature}` (hex).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn sign_swap(
    keystore_json: &str,
    epoch: f64,
    nonce: f64,
    input_mint_hex: &str,
    output_mint_hex: &str,
    amount_in: f64,
    min_out: f64,
    route_hash_hex: &str,
    expiry: f64,
) -> Result<String, JsValue> {
    let ks: Keystore = serde_json::from_str(keystore_json).map_err(js_err)?;
    let root = to32(&ks.xmss_root)?;
    let input_mint = to32(input_mint_hex)?;
    let output_mint = to32(output_mint_hex)?;
    let rh = to32(route_hash_hex)?;
    let e = epoch as u64;
    let digest = swap_digest(
        &root, e, nonce as u64, &input_mint, &output_mint, amount_in as u64, min_out as u64, &rh,
        expiry as i64,
    );
    let sig = sign_digest(&ks, e, &digest);
    serde_json::to_string(&serde_json::json!({
        "digest": hex::encode(digest),
        "signature": hex::encode(sig),
    }))
    .map_err(js_err)
}

/// Verify a swap signature off-chain (mirrors the on-chain check).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn verify_swap(
    xmss_root_hex: &str,
    epoch: f64,
    nonce: f64,
    input_mint_hex: &str,
    output_mint_hex: &str,
    amount_in: f64,
    min_out: f64,
    route_hash_hex: &str,
    expiry: f64,
    signature_hex: &str,
) -> Result<bool, JsValue> {
    let root = to32(xmss_root_hex)?;
    let input_mint = to32(input_mint_hex)?;
    let output_mint = to32(output_mint_hex)?;
    let rh = to32(route_hash_hex)?;
    let e = epoch as u64;
    let digest = swap_digest(
        &root, e, nonce as u64, &input_mint, &output_mint, amount_in as u64, min_out as u64, &rh,
        expiry as i64,
    );
    let sig = hex::decode(signature_hex.trim()).map_err(js_err)?;
    Ok(verify_wallet_sig(&root, &digest, &sig, e))
}

/// Sign a perpetual-position OPEN intent. `market_hex` is the 32-byte market
/// account; `side` is 0 (long) or 1 (short); `collateral`, `leverage`,
/// `max_entry_price`, `sl_price`, `tp_price` are numbers (prices fixed-point
/// USDT-per-SOL × 1e6, 0 = unset); `expiry` is a unix timestamp. Returns JSON
/// `{digest, signature}` (hex).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn sign_open_perp(
    keystore_json: &str,
    epoch: f64,
    nonce: f64,
    market_hex: &str,
    side: u8,
    collateral: f64,
    leverage: f64,
    max_entry_price: f64,
    sl_price: f64,
    tp_price: f64,
    expiry: f64,
) -> Result<String, JsValue> {
    let ks: Keystore = serde_json::from_str(keystore_json).map_err(js_err)?;
    let root = to32(&ks.xmss_root)?;
    let market = to32(market_hex)?;
    let e = epoch as u64;
    let digest = open_perp_digest(
        &root, e, nonce as u64, &market, side, collateral as u64, leverage as u64,
        max_entry_price as u64, sl_price as u64, tp_price as u64, expiry as i64,
    );
    let sig = sign_digest(&ks, e, &digest);
    serde_json::to_string(&serde_json::json!({
        "digest": hex::encode(digest),
        "signature": hex::encode(sig),
    }))
    .map_err(js_err)
}

/// Verify a perp-open signature off-chain (mirrors the on-chain check).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn verify_open_perp(
    xmss_root_hex: &str,
    epoch: f64,
    nonce: f64,
    market_hex: &str,
    side: u8,
    collateral: f64,
    leverage: f64,
    max_entry_price: f64,
    sl_price: f64,
    tp_price: f64,
    expiry: f64,
    signature_hex: &str,
) -> Result<bool, JsValue> {
    let root = to32(xmss_root_hex)?;
    let market = to32(market_hex)?;
    let e = epoch as u64;
    let digest = open_perp_digest(
        &root, e, nonce as u64, &market, side, collateral as u64, leverage as u64,
        max_entry_price as u64, sl_price as u64, tp_price as u64, expiry as i64,
    );
    let sig = hex::decode(signature_hex.trim()).map_err(js_err)?;
    Ok(verify_wallet_sig(&root, &digest, &sig, e))
}

/// Sign a perpetual-position CLOSE intent. `position_hex` is the 32-byte
/// position account; `expiry` is a unix timestamp. Returns JSON
/// `{digest, signature}` (hex).
#[wasm_bindgen]
pub fn sign_close_perp(
    keystore_json: &str,
    epoch: f64,
    nonce: f64,
    position_hex: &str,
    expiry: f64,
) -> Result<String, JsValue> {
    let ks: Keystore = serde_json::from_str(keystore_json).map_err(js_err)?;
    let root = to32(&ks.xmss_root)?;
    let position = to32(position_hex)?;
    let e = epoch as u64;
    let digest = close_perp_digest(&root, e, nonce as u64, &position, expiry as i64);
    let sig = sign_digest(&ks, e, &digest);
    serde_json::to_string(&serde_json::json!({
        "digest": hex::encode(digest),
        "signature": hex::encode(sig),
    }))
    .map_err(js_err)
}

/// Verify a perp-close signature off-chain (mirrors the on-chain check).
#[wasm_bindgen]
pub fn verify_close_perp(
    xmss_root_hex: &str,
    epoch: f64,
    nonce: f64,
    position_hex: &str,
    expiry: f64,
    signature_hex: &str,
) -> Result<bool, JsValue> {
    let root = to32(xmss_root_hex)?;
    let position = to32(position_hex)?;
    let e = epoch as u64;
    let digest = close_perp_digest(&root, e, nonce as u64, &position, expiry as i64);
    let sig = hex::decode(signature_hex.trim()).map_err(js_err)?;
    Ok(verify_wallet_sig(&root, &digest, &sig, e))
}

/// Wallet parameters, for display.
#[wasm_bindgen]
pub fn signing_capacity() -> f64 {
    SIGNING_CAPACITY as f64
}

#[wasm_bindgen]
pub fn num_epochs() -> f64 {
    NUM_EPOCHS as f64
}

#[wasm_bindgen]
pub fn xmss_height() -> f64 {
    XMSS_HEIGHT as f64
}

/// Total lifetime signatures: `num_epochs * signing_capacity`.
#[wasm_bindgen]
pub fn lifetime_capacity() -> f64 {
    (NUM_EPOCHS * SIGNING_CAPACITY) as f64
}
