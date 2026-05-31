/**
 * On-chain SDK for the PORST agent: sets up a real token environment + cpswap
 * pool, creates the agent wallet, stages the (~13 KB) PORST signature into a
 * buffer account, and submits `execute_swap`. All real SPL tokens and real swap
 * math — nothing mocked.
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
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
} from "@solana/spl-token";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pkg-node/porst_wasm.js");

const FEE_BPS = 30n;
const enc = (s: string) => Buffer.from(s);
const hexToBytes = (h: string): number[] => {
  const o: number[] = [];
  for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16));
  return o;
};
const pkHex = (p: PublicKey) => Buffer.from(p.toBytes()).toString("hex");

export interface PoolInfo {
  pool: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
}

export class AgentSDK {
  constructor(
    readonly porstAgent: Program,
    readonly cpswap: Program,
    readonly provider: anchor.AnchorProvider
  ) {}

  get conn() {
    return this.provider.connection;
  }
  get payer(): Keypair {
    // The provider wallet wraps a Keypair in tests (NodeWallet).
    return (this.provider.wallet as any).payer as Keypair;
  }

  // ---------- PDAs ----------
  agentPda(authority = this.provider.wallet.publicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [enc("agent"), authority.toBuffer()],
      this.porstAgent.programId
    )[0];
  }
  poolPda(mintA: PublicKey, mintB: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [enc("pool"), mintA.toBuffer(), mintB.toBuffer()],
      this.cpswap.programId
    )[0];
  }
  vaultPdas(pool: PublicKey): { vaultA: PublicKey; vaultB: PublicKey } {
    const [vaultA] = PublicKey.findProgramAddressSync([enc("vault_a"), pool.toBuffer()], this.cpswap.programId);
    const [vaultB] = PublicKey.findProgramAddressSync([enc("vault_b"), pool.toBuffer()], this.cpswap.programId);
    return { vaultA, vaultB };
  }

  // ---------- token env + pool ----------
  async createToken(decimals = 9): Promise<PublicKey> {
    return createMint(this.conn, this.payer, this.provider.wallet.publicKey, null, decimals);
  }

  /** Create a cpswap pool for (mintA, mintB) and seed it with liquidity. */
  async setupPool(mintA: PublicKey, mintB: PublicKey, liqA: bigint, liqB: bigint): Promise<PoolInfo> {
    const pool = this.poolPda(mintA, mintB);
    const { vaultA, vaultB } = this.vaultPdas(pool);

    await this.cpswap.methods
      .initPool()
      .accounts({
        pool,
        mintA,
        mintB,
        vaultA,
        vaultB,
        payer: this.provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Provider's own ATAs as the liquidity source.
    const depA = await getOrCreateAssociatedTokenAccount(this.conn, this.payer, mintA, this.provider.wallet.publicKey);
    const depB = await getOrCreateAssociatedTokenAccount(this.conn, this.payer, mintB, this.provider.wallet.publicKey);
    await mintTo(this.conn, this.payer, mintA, depA.address, this.provider.wallet.publicKey, liqA);
    await mintTo(this.conn, this.payer, mintB, depB.address, this.provider.wallet.publicKey, liqB);

    await this.cpswap.methods
      .addLiquidity(new anchor.BN(liqA.toString()), new anchor.BN(liqB.toString()))
      .accounts({
        pool,
        vaultA,
        vaultB,
        depositorA: depA.address,
        depositorB: depB.address,
        depositor: this.provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return { pool, vaultA, vaultB, mintA, mintB };
  }

  // ---------- agent ----------
  async createAgent(xmssRootHex: string): Promise<PublicKey> {
    const agent = this.agentPda();
    await this.porstAgent.methods
      .createAgent(hexToBytes(xmssRootHex))
      .accounts({
        agent,
        authority: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return agent;
  }

  /** Create the agent PDA's ATA for `mint` (off-curve owner). */
  async ensureAgentAta(mint: PublicKey): Promise<PublicKey> {
    const agent = this.agentPda();
    const ata = getAssociatedTokenAddressSync(mint, agent, true);
    const info = await this.conn.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(
        this.provider.wallet.publicKey,
        ata,
        agent,
        mint
      );
      await this.provider.sendAndConfirm(new Transaction().add(ix));
    }
    return ata;
  }

  /** Mint `amount` of `mint` into the agent's ATA (funds the agent). */
  async fundAgent(mint: PublicKey, amount: bigint): Promise<void> {
    const ata = await this.ensureAgentAta(mint);
    await mintTo(this.conn, this.payer, mint, ata, this.provider.wallet.publicKey, amount);
  }

  async agentState(): Promise<{ xmssRoot: string; epoch: number; used: number; nonce: number }> {
    const a: any = await (this.porstAgent.account as any).agent.fetch(this.agentPda());
    return {
      xmssRoot: Buffer.from(a.xmssRoot).toString("hex"),
      epoch: Number(a.epoch),
      used: Number(a.used),
      nonce: Number(a.nonce),
    };
  }

  async balance(ata: PublicKey): Promise<bigint> {
    return (await getAccount(this.conn, ata)).amount;
  }

  // ---------- quote (mirrors cpswap math exactly) ----------
  async quote(p: PoolInfo, inputMint: PublicKey, amountIn: bigint): Promise<{ expectedOut: bigint; aToB: boolean }> {
    const aToB = inputMint.equals(p.mintA);
    const va = (await getAccount(this.conn, p.vaultA)).amount;
    const vb = (await getAccount(this.conn, p.vaultB)).amount;
    const [reserveIn, reserveOut] = aToB ? [va, vb] : [vb, va];
    const inAfterFee = (amountIn * (10_000n - FEE_BPS)) / 10_000n;
    const expectedOut = (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
    return { expectedOut, aToB };
  }

  /** Route binding hash — same as the on-chain `route_hash`. */
  routeHash(p: PoolInfo): string {
    return wasm.route_hash(pkHex(this.cpswap.programId), pkHex(p.pool));
  }

  // ---------- signature staging ----------
  async stageSignature(signatureHex: string): Promise<PublicKey> {
    const bytes = hexToBytes(signatureHex);
    const buf = Keypair.generate();
    const lamports = await this.conn.getMinimumBalanceForRentExemption(bytes.length);
    await this.provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: this.provider.wallet.publicKey,
          newAccountPubkey: buf.publicKey,
          lamports,
          space: bytes.length,
          programId: this.porstAgent.programId,
        })
      ),
      [buf]
    );
    const CHUNK = 960;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      await this.porstAgent.methods
        .writeBuffer(off, Buffer.from(bytes.slice(off, off + CHUNK)))
        .accounts({ buffer: buf.publicKey, authority: this.provider.wallet.publicKey })
        .rpc();
    }
    return buf.publicKey;
  }

  // ---------- execute ----------
  async executeSwap(args: {
    p: PoolInfo;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: bigint;
    minOut: bigint;
    expiry: number;
    buffer: PublicKey;
  }): Promise<string> {
    const agent = this.agentPda();
    const agentIn = getAssociatedTokenAddressSync(args.inputMint, agent, true);
    const agentOut = getAssociatedTokenAddressSync(args.outputMint, agent, true);
    return await this.porstAgent.methods
      .executeSwap(
        new anchor.BN(args.amountIn.toString()),
        new anchor.BN(args.minOut.toString()),
        new anchor.BN(args.expiry)
      )
      .accounts({
        agent,
        authority: this.provider.wallet.publicKey,
        buffer: args.buffer,
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        agentIn,
        agentOut,
        pool: args.p.pool,
        vaultA: args.p.vaultA,
        vaultB: args.p.vaultB,
        cpswapProgram: this.cpswap.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .rpc();
  }
}
