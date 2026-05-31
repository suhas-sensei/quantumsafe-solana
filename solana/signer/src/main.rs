//! `porst-signer` CLI — the crypto core invoked by the TypeScript SDK.
//!
//! It deals only in raw bytes (hex); Solana address ⇄ bytes conversion is the
//! SDK's job. All hashing matches the on-chain program.
//!
//! Subcommands:
//!   keygen  [--seed <hex32>] [--out <path>]
//!       Generate a keystore (random seed from /dev/urandom if --seed omitted).
//!       Writes the keystore JSON to --out (or stdout) and prints the wallet
//!       public key (xmss_root) hex on stderr.
//!
//!   pubkey  --keystore <path>
//!       Print the wallet public key (xmss_root) hex.
//!
//!   digest  --keystore <path> --epoch N --nonce N --recipient <hex32> --amount N
//!       Print the transfer message digest hex.
//!
//!   sign    --keystore <path> --epoch N --nonce N --recipient <hex32> --amount N
//!       Print a JSON object {"digest","signature"} (both hex) for the transfer.

use porst_signer::{
    hex32, keygen, sign_digest, transfer_digest, Keystore, SIGNING_CAPACITY, XMSS_HEIGHT,
};
use std::collections::HashMap;
use std::io::Read;

fn parse_flags(args: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            let val = args.get(i + 1).cloned().unwrap_or_default();
            map.insert(key.to_string(), val);
            i += 2;
        } else {
            i += 1;
        }
    }
    map
}

fn require<'a>(f: &'a HashMap<String, String>, k: &str) -> &'a String {
    f.get(k).unwrap_or_else(|| {
        eprintln!("missing required --{k}");
        std::process::exit(2);
    })
}

fn read_keystore(path: &str) -> Keystore {
    let data = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("cannot read keystore {path}: {e}");
        std::process::exit(2);
    });
    serde_json::from_str(&data).unwrap_or_else(|e| {
        eprintln!("invalid keystore json: {e}");
        std::process::exit(2);
    })
}

fn random_seed() -> [u8; 32] {
    let mut f = std::fs::File::open("/dev/urandom").expect("open /dev/urandom");
    let mut s = [0u8; 32];
    f.read_exact(&mut s).expect("read random seed");
    s
}

fn parse_u64(f: &HashMap<String, String>, k: &str) -> u64 {
    require(f, k).parse().unwrap_or_else(|_| {
        eprintln!("--{k} must be an integer");
        std::process::exit(2);
    })
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        eprintln!("usage: porst-signer <keygen|pubkey|digest|sign> [flags]");
        std::process::exit(2);
    }
    let cmd = argv[1].as_str();
    let flags = parse_flags(&argv[2..]);

    match cmd {
        "keygen" => {
            let seed = match flags.get("seed") {
                Some(h) => hex32(h).unwrap_or_else(|e| {
                    eprintln!("bad --seed: {e}");
                    std::process::exit(2);
                }),
                None => random_seed(),
            };
            let ks = keygen(&seed);
            let json = serde_json::to_string_pretty(&ks).unwrap();
            match flags.get("out") {
                Some(path) => std::fs::write(path, &json).unwrap_or_else(|e| {
                    eprintln!("cannot write {path}: {e}");
                    std::process::exit(2);
                }),
                None => println!("{json}"),
            }
            eprintln!("wallet pubkey (xmss_root): {}", ks.xmss_root);
            eprintln!(
                "capacity: {} epochs x {} sigs = {} lifetime signatures",
                1u64 << XMSS_HEIGHT,
                SIGNING_CAPACITY,
                (1u64 << XMSS_HEIGHT) * SIGNING_CAPACITY
            );
        }
        "pubkey" => {
            let ks = read_keystore(require(&flags, "keystore"));
            println!("{}", ks.xmss_root);
        }
        "digest" => {
            let ks = read_keystore(require(&flags, "keystore"));
            let root = hex32(&ks.xmss_root).unwrap();
            let epoch = parse_u64(&flags, "epoch");
            let nonce = parse_u64(&flags, "nonce");
            let recipient = hex32(require(&flags, "recipient")).unwrap_or_else(|e| {
                eprintln!("bad --recipient: {e}");
                std::process::exit(2);
            });
            let amount = parse_u64(&flags, "amount");
            let d = transfer_digest(&root, epoch, nonce, &recipient, amount);
            println!("{}", hex::encode(d));
        }
        "sign" => {
            let ks = read_keystore(require(&flags, "keystore"));
            let root = hex32(&ks.xmss_root).unwrap();
            let epoch = parse_u64(&flags, "epoch");
            let nonce = parse_u64(&flags, "nonce");
            let recipient = hex32(require(&flags, "recipient")).unwrap_or_else(|e| {
                eprintln!("bad --recipient: {e}");
                std::process::exit(2);
            });
            let amount = parse_u64(&flags, "amount");
            let digest = transfer_digest(&root, epoch, nonce, &recipient, amount);
            let sig = sign_digest(&ks, epoch, &digest);
            let out = serde_json::json!({
                "digest": hex::encode(digest),
                "signature": hex::encode(sig),
            });
            println!("{out}");
        }
        other => {
            eprintln!("unknown subcommand: {other}");
            std::process::exit(2);
        }
    }
}
