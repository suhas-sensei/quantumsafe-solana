/**
 * IPC client for the isolated PORST signer. The agent core uses ONLY this
 * surface to obtain signatures — it never has the seed. Schema-strict
 * newline-delimited JSON over a Unix domain socket.
 */
import * as net from "net";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

export interface SwapSignRequest {
  epoch: number;
  nonce: number;
  inputMint: string; // hex (32 bytes)
  outputMint: string; // hex
  amountIn: number;
  minOut: number;
  routeHash: string; // hex
  expiry: number;
  summary: string; // human-readable; the signer's approval is over this
  approve?: boolean;
}

export interface SwapSignResult {
  approved: boolean;
  reason?: string;
  digest?: string;
  signature?: string;
}

export interface OpenPerpSignRequest {
  epoch: number;
  nonce: number;
  market: string; // hex (32 bytes)
  side: number; // 0 long, 1 short
  collateral: number;
  leverage: number;
  maxEntryPrice: number;
  slPrice: number;
  tpPrice: number;
  expiry: number;
  summary: string; // human-readable; the signer's approval is over this
  approve?: boolean;
}

export interface ClosePerpSignRequest {
  epoch: number;
  nonce: number;
  position: string; // hex (32 bytes)
  expiry: number;
  summary: string;
  approve?: boolean;
}

export class SignerClient {
  private constructor(private socketPath: string, private proc?: ChildProcess) {}

  /** Spawn the signer daemon as a separate process and connect to it. */
  static async spawn(
    keystorePath: string,
    socketPath: string,
    opts: { autoApprove?: boolean } = {}
  ): Promise<SignerClient> {
    const daemon = path.join(__dirname, "daemon.cjs");
    const argv = ["--keystore", keystorePath, "--socket", socketPath];
    if (opts.autoApprove) argv.push("--auto-approve");
    const proc = spawn("node", [daemon, ...argv], { stdio: ["ignore", "pipe", "inherit"] });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("signer daemon did not start")), 8000);
      proc.stdout!.on("data", (d) => {
        if (d.toString().includes("signer-ready")) {
          clearTimeout(t);
          resolve();
        }
      });
      proc.on("exit", (c) => reject(new Error(`signer daemon exited (${c})`)));
    });
    return new SignerClient(socketPath, proc);
  }

  /** Connect to an already-running daemon. */
  static connect(socketPath: string): SignerClient {
    return new SignerClient(socketPath);
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(this.socketPath);
      const id = Math.random().toString(36).slice(2);
      let buf = "";
      conn.on("connect", () => conn.write(JSON.stringify({ id, method, params }) + "\n"));
      conn.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        conn.end();
        const res = JSON.parse(buf.slice(0, nl));
        if (res.ok) resolve(res.result as T);
        else reject(new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error)));
      });
      conn.on("error", reject);
    });
  }

  ping() {
    return this.request<{ pong: boolean; signer: string }>("ping");
  }
  status() {
    return this.request<{ ready: boolean; pubkey: string; lifetime: number }>("status");
  }
  walletPubkey() {
    return this.request<{ pubkey: string }>("wallet_pubkey").then((r) => r.pubkey);
  }
  signSwap(req: SwapSignRequest) {
    return this.request<SwapSignResult>("sign_swap", req);
  }
  signOpenPerp(req: OpenPerpSignRequest) {
    return this.request<SwapSignResult>("sign_open_perp", req);
  }
  signClosePerp(req: ClosePerpSignRequest) {
    return this.request<SwapSignResult>("sign_close_perp", req);
  }

  /** Stop the spawned daemon (if we own it). */
  kill() {
    this.proc?.kill("SIGTERM");
  }
}
