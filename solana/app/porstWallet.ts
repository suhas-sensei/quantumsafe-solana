/**
 * Client SDK for the PORST/XMSS post-quantum Solana wallet.
 *
 * Cryptography (keygen + signing) is delegated to the `porst-signer` Rust CLI —
 * the single, hardened source of truth that the on-chain program is verified
 * against. This SDK handles Solana orchestration: PDA derivation, funding,
 * reading on-chain state, staging the (~13 KB) signature into a buffer account,
 * and submitting the transfer.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { execFileSync } from "child_process";
import * as fs from "fs";

const hexToBytes = (h: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
};

export interface WalletState {
  xmssRoot: string; // hex
  epoch: bigint;
  used: bigint;
  nonce: bigint;
}

export class PorstWallet {
  readonly program: Program;
  readonly provider: anchor.AnchorProvider;
  readonly cli: string;
  readonly keystorePath: string;
  readonly walletPda: PublicKey;
  readonly vaultPda: PublicKey;

  private constructor(
    program: Program,
    provider: anchor.AnchorProvider,
    cli: string,
    keystorePath: string,
    walletPda: PublicKey,
    vaultPda: PublicKey
  ) {
    this.program = program;
    this.provider = provider;
    this.cli = cli;
    this.keystorePath = keystorePath;
    this.walletPda = walletPda;
    this.vaultPda = vaultPda;
  }

  /** Generate a keystore (via the CLI) and bind an SDK instance to its PDAs. */
  static keygen(
    program: Program,
    provider: anchor.AnchorProvider,
    cli: string,
    keystorePath: string,
    seedHex?: string
  ): PorstWallet {
    const args = ["keygen", "--out", keystorePath];
    if (seedHex) args.push("--seed", seedHex);
    execFileSync(cli, args, { encoding: "utf8" });

    const authority = provider.wallet.publicKey;
    const [walletPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), authority.toBuffer()],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), walletPda.toBuffer()],
      program.programId
    );
    return new PorstWallet(program, provider, cli, keystorePath, walletPda, vaultPda);
  }

  /** XMSS-root public key (hex) read from the keystore. */
  xmssRoot(): string {
    return JSON.parse(fs.readFileSync(this.keystorePath, "utf8")).xmss_root;
  }

  /** Create the on-chain wallet account pinned to this keystore's pubkey. */
  async createWallet(): Promise<void> {
    await this.program.methods
      .createWallet(hexToBytes(this.xmssRoot()))
      .accounts({
        wallet: this.walletPda,
        authority: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Top up the vault PDA with `lamports` from the provider wallet. */
  async fundVault(lamports: number): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.provider.wallet.publicKey,
        toPubkey: this.vaultPda,
        lamports,
      })
    );
    await this.provider.sendAndConfirm(tx);
  }

  /** Read on-chain wallet state. */
  async getState(): Promise<WalletState> {
    const w: any = await (this.program.account as any).wallet.fetch(this.walletPda);
    return {
      xmssRoot: Buffer.from(w.xmssRoot).toString("hex"),
      epoch: BigInt(w.epoch.toString()),
      used: BigInt(w.used.toString()),
      nonce: BigInt(w.nonce.toString()),
    };
  }

  /** Produce a many-time signature for a transfer at the current chain state. */
  signTransfer(
    state: WalletState,
    recipient: PublicKey,
    amount: number
  ): { digest: string; signature: string } {
    const out = execFileSync(
      this.cli,
      [
        "sign",
        "--keystore", this.keystorePath,
        "--epoch", state.epoch.toString(),
        "--nonce", state.nonce.toString(),
        "--recipient", Buffer.from(recipient.toBytes()).toString("hex"),
        "--amount", String(amount),
      ],
      { encoding: "utf8" }
    );
    return JSON.parse(out);
  }

  /** Create a program-owned buffer account sized to hold `space` bytes. */
  private async createBuffer(space: number): Promise<Keypair> {
    const buf = Keypair.generate();
    const lamports = await this.provider.connection.getMinimumBalanceForRentExemption(space);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: this.provider.wallet.publicKey,
        newAccountPubkey: buf.publicKey,
        lamports,
        space,
        programId: this.program.programId,
      })
    );
    await this.provider.sendAndConfirm(tx, [buf]);
    return buf;
  }

  /** Chunk-upload signature bytes into the buffer (≤960 B/tx for the 1232 cap). */
  private async fillBuffer(buffer: PublicKey, bytes: number[]): Promise<void> {
    const CHUNK = 960;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const chunk = bytes.slice(off, off + CHUNK);
      await this.program.methods
        .writeBuffer(off, Buffer.from(chunk))
        .accounts({ buffer, authority: this.provider.wallet.publicKey })
        .rpc();
    }
  }

  /** Stage a raw signature into a fresh buffer account and return its pubkey. */
  async stageSignature(signatureHex: string): Promise<PublicKey> {
    const bytes = hexToBytes(signatureHex);
    const buffer = await this.createBuffer(bytes.length);
    await this.fillBuffer(buffer.publicKey, bytes);
    return buffer.publicKey;
  }

  /** Submit an `execute_transfer` against a staged signature buffer. */
  async executeTransfer(
    recipient: PublicKey,
    amount: number,
    buffer: PublicKey
  ): Promise<string> {
    return await this.program.methods
      .executeTransfer(new anchor.BN(amount))
      .accounts({
        wallet: this.walletPda,
        vault: this.vaultPda,
        recipient,
        buffer,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
  }

  /** Convenience: sign + stage + execute a transfer at the current state. */
  async transfer(recipient: PublicKey, amount: number): Promise<string> {
    const state = await this.getState();
    const { signature } = this.signTransfer(state, recipient, amount);
    const buffer = await this.stageSignature(signature);
    return this.executeTransfer(recipient, amount, buffer);
  }
}
