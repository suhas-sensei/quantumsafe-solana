/**
 * On-chain SDK for the PORST perpetual-futures engine (`porst_perp`).
 *
 * Mirrors `sdk.ts` for the swap agent: derives PDAs, sets up the market + USDT
 * vault + price oracle + trader wallet, stages the (~13 KB) PORST signature into
 * a program-owned buffer, and submits `open_position` / `close_position`. The
 * permissionless `liquidate` / `trigger` paths take no signature. All real SPL
 * tokens and real settlement math — nothing mocked.
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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
} from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);
const hexToBytes = (h: string): number[] => {
  const o: number[] = [];
  for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16));
  return o;
};

export const SIDE_LONG = 0;
export const SIDE_SHORT = 1;
/** Prices are fixed-point USDT-per-SOL × 1e6. */
export const PRICE_SCALE = 1_000_000;

export interface MarketParams {
  maintenanceBps: number;
  maxLeverage: number;
  openFeeBps: number;
  borrowFeeBpsPerHour: number;
}

export interface PositionView {
  pubkey: PublicKey;
  seq: number;
  side: number;
  collateral: bigint;
  notional: bigint;
  entryPrice: bigint;
  leverage: number;
  slPrice: bigint;
  tpPrice: bigint;
  openTime: number;
}

export class PerpSDK {
  constructor(
    readonly perp: Program,
    readonly provider: anchor.AnchorProvider,
    public usdtMint?: PublicKey
  ) {}

  get conn() {
    return this.provider.connection;
  }
  get payer(): Keypair {
    return (this.provider.wallet as any).payer as Keypair;
  }
  get authority(): PublicKey {
    return this.provider.wallet.publicKey;
  }

  // ---------- PDAs ----------
  oraclePda(): PublicKey {
    return PublicKey.findProgramAddressSync([enc("oracle")], this.perp.programId)[0];
  }
  marketPda(mint = this.usdtMint!): PublicKey {
    return PublicKey.findProgramAddressSync([enc("market"), mint.toBuffer()], this.perp.programId)[0];
  }
  vaultPda(market = this.marketPda()): PublicKey {
    return PublicKey.findProgramAddressSync([enc("vault"), market.toBuffer()], this.perp.programId)[0];
  }
  traderPda(authority = this.authority): PublicKey {
    return PublicKey.findProgramAddressSync([enc("trader"), authority.toBuffer()], this.perp.programId)[0];
  }
  positionPda(seq: number | bigint, trader = this.traderPda()): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(seq));
    return PublicKey.findProgramAddressSync([enc("position"), trader.toBuffer(), buf], this.perp.programId)[0];
  }
  traderUsdt(trader = this.traderPda()): PublicKey {
    return getAssociatedTokenAddressSync(this.usdtMint!, trader, true);
  }

  // ---------- setup ----------
  async createUsdt(decimals = 6): Promise<PublicKey> {
    this.usdtMint = await createMint(this.conn, this.payer, this.authority, null, decimals);
    return this.usdtMint;
  }

  async initOracle(): Promise<PublicKey> {
    const oracle = this.oraclePda();
    if (!(await this.conn.getAccountInfo(oracle))) {
      await this.perp.methods
        .initOracle()
        .accounts({ oracle, authority: this.authority, systemProgram: SystemProgram.programId })
        .rpc();
    }
    return oracle;
  }

  async updateOracle(price: bigint, publishTime: number): Promise<string> {
    return this.perp.methods
      .updateOracle(new anchor.BN(price.toString()), new anchor.BN(publishTime))
      .accounts({ oracle: this.oraclePda(), authority: this.authority })
      .rpc();
  }

  async initMarket(p: MarketParams): Promise<PublicKey> {
    const market = this.marketPda();
    if (!(await this.conn.getAccountInfo(market))) {
      await this.perp.methods
        .initMarket(p.maintenanceBps, p.maxLeverage, p.openFeeBps, p.borrowFeeBpsPerHour)
        .accounts({
          market,
          collateralMint: this.usdtMint!,
          oracle: this.oraclePda(),
          vault: this.vaultPda(market),
          authority: this.authority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }
    return market;
  }

  async createTrader(xmssRootHex: string): Promise<PublicKey> {
    const trader = this.traderPda();
    if (!(await this.conn.getAccountInfo(trader))) {
      await this.perp.methods
        .createTrader(hexToBytes(xmssRootHex))
        .accounts({
          trader,
          authority: this.authority,
          payer: this.authority,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    return trader;
  }

  /** Ensure the trader PDA's USDT ATA exists. */
  async ensureTraderUsdt(): Promise<PublicKey> {
    const ata = this.traderUsdt();
    if (!(await this.conn.getAccountInfo(ata))) {
      const ix = createAssociatedTokenAccountInstruction(this.authority, ata, this.traderPda(), this.usdtMint!);
      await this.provider.sendAndConfirm(new Transaction().add(ix));
    }
    return ata;
  }

  /** Mint USDT into the trader's ATA (the trader's trading capital). */
  async fundTrader(amount: bigint): Promise<void> {
    const ata = await this.ensureTraderUsdt();
    await mintTo(this.conn, this.payer, this.usdtMint!, ata, this.authority, amount);
  }

  /** Seed the market vault with LP liquidity (the counterparty's float). */
  async fundVault(amount: bigint): Promise<void> {
    await mintTo(this.conn, this.payer, this.usdtMint!, this.vaultPda(), this.authority, amount);
  }

  // ---------- reads ----------
  async oracleState(): Promise<{ price: bigint; publishTime: number }> {
    const o: any = await (this.perp.account as any).oracleState.fetch(this.oraclePda());
    return { price: BigInt(o.price.toString()), publishTime: Number(o.publishTime) };
  }
  async marketState(): Promise<any> {
    return (this.perp.account as any).market.fetch(this.marketPda());
  }
  async traderState(): Promise<{ epoch: number; used: number; nonce: number; positionCount: number; xmssRoot: string }> {
    const t: any = await (this.perp.account as any).trader.fetch(this.traderPda());
    return {
      epoch: Number(t.epoch),
      used: Number(t.used),
      nonce: Number(t.nonce),
      positionCount: Number(t.positionCount),
      xmssRoot: Buffer.from(t.xmssRoot).toString("hex"),
    };
  }
  async balance(ata: PublicKey): Promise<bigint> {
    try {
      return (await getAccount(this.conn, ata)).amount;
    } catch {
      return 0n;
    }
  }
  async vaultBalance(): Promise<bigint> {
    return this.balance(this.vaultPda());
  }
  async traderBalance(): Promise<bigint> {
    return this.balance(this.traderUsdt());
  }

  /** All open positions for the trader (scans seqs 0..positionCount). */
  async openPositions(): Promise<PositionView[]> {
    const { positionCount } = await this.traderState();
    const out: PositionView[] = [];
    for (let seq = 0; seq < positionCount; seq++) {
      const pk = this.positionPda(seq);
      const info = await this.conn.getAccountInfo(pk);
      if (!info) continue; // closed -> account gone
      const p: any = await (this.perp.account as any).position.fetch(pk);
      out.push({
        pubkey: pk,
        seq,
        side: p.side,
        collateral: BigInt(p.collateral.toString()),
        notional: BigInt(p.notional.toString()),
        entryPrice: BigInt(p.entryPrice.toString()),
        leverage: p.leverage,
        slPrice: BigInt(p.slPrice.toString()),
        tpPrice: BigInt(p.tpPrice.toString()),
        openTime: Number(p.openTime),
      });
    }
    return out;
  }

  // ---------- signature staging (program-owned buffer) ----------
  async stageSignature(signatureHex: string): Promise<PublicKey> {
    const bytes = hexToBytes(signatureHex);
    const buf = Keypair.generate();
    const lamports = await this.conn.getMinimumBalanceForRentExemption(bytes.length);
    await this.provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: this.authority,
          newAccountPubkey: buf.publicKey,
          lamports,
          space: bytes.length,
          programId: this.perp.programId,
        })
      ),
      [buf]
    );
    const CHUNK = 960;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      await this.perp.methods
        .writeBuffer(off, Buffer.from(bytes.slice(off, off + CHUNK)))
        .accounts({ buffer: buf.publicKey, authority: this.authority })
        .rpc();
    }
    return buf.publicKey;
  }

  // ---------- mutations ----------
  async openPosition(args: {
    side: number;
    collateral: bigint;
    leverage: number;
    maxEntryPrice: bigint;
    slPrice: bigint;
    tpPrice: bigint;
    expiry: number;
    seq: number;
    buffer: PublicKey;
  }): Promise<string> {
    const trader = this.traderPda();
    const market = this.marketPda();
    return this.perp.methods
      .openPosition(
        args.side,
        new anchor.BN(args.collateral.toString()),
        new anchor.BN(args.leverage),
        new anchor.BN(args.maxEntryPrice.toString()),
        new anchor.BN(args.slPrice.toString()),
        new anchor.BN(args.tpPrice.toString()),
        new anchor.BN(args.expiry)
      )
      .accounts({
        trader,
        authority: this.authority,
        buffer: args.buffer,
        market,
        oracle: this.oraclePda(),
        traderUsdt: this.traderUsdt(),
        vault: this.vaultPda(market),
        position: this.positionPda(args.seq),
        payer: this.authority,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .rpc();
  }

  async closePosition(args: { seq: number; expiry: number; buffer: PublicKey }): Promise<string> {
    const trader = this.traderPda();
    const market = this.marketPda();
    return this.perp.methods
      .closePosition(new anchor.BN(args.expiry))
      .accounts({
        trader,
        authority: this.authority,
        buffer: args.buffer,
        market,
        oracle: this.oraclePda(),
        traderUsdt: this.traderUsdt(),
        vault: this.vaultPda(market),
        position: this.positionPda(args.seq),
        payer: this.authority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .rpc();
  }

  /** Permissionless maintenance call (kind = "liquidate" | "trigger"). */
  async maintain(kind: "liquidate" | "trigger", seq: number): Promise<string> {
    const trader = this.traderPda();
    const market = this.marketPda();
    const accounts = {
      trader,
      market,
      oracle: this.oraclePda(),
      traderUsdt: this.traderUsdt(),
      vault: this.vaultPda(market),
      position: this.positionPda(seq),
      payer: this.authority,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    const m = kind === "liquidate" ? this.perp.methods.liquidate() : this.perp.methods.trigger();
    return m
      .accounts(accounts)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
  }
}
