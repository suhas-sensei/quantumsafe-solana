export interface Balance {
  amount: string;
  decimals: number;
}
export interface State {
  walletPubkey: string;
  agent: string;
  epoch: number;
  used: number;
  nonce: number;
  lifetime: number;
  remaining: number;
  llm: "anthropic" | "openai" | "fallback";
  explorer: string;
  price: number;
  balances: { SOL: Balance; USDC: Balance };
  tokens: { symbol: string; mint: string; decimals: number }[];
}

export interface Intent {
  inputMint: string;
  outputMint: string;
  amountIn: string;
  minOut: string;
  expiry: number;
  inSym: string;
  outSym: string;
}

export type InterpretResult =
  | { kind: "chat"; reply: string }
  | {
      kind: "intent";
      summary: string;
      policy: { allowed: boolean; reason?: string; approvalMode?: string };
      plan: {
        inSym: string;
        outSym: string;
        amountInHuman: number;
        expectedOutHuman: number;
        minOutHuman: number;
        slippageBps: number;
      };
      intent: Intent;
    };

export interface ExecuteResult {
  stages: { name: string; detail: string }[];
  txSig: string;
  receivedHuman: string;
  state: State;
}

const j = async (r: Response) => {
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

// ---------------- perps ----------------
export interface PerpPosition {
  seq: number;
  side: "long" | "short";
  collateralUsd: number;
  notionalUsd: number;
  entryUsd: number;
  leverage: number;
  slUsd: number | null;
  tpUsd: number | null;
  liqUsd: number;
  pnlUsd: number;
  equityUsd: number;
}
export interface PerpState {
  priceUsd: number;
  oracleAgeSec: number;
  market: {
    address: string;
    maxLeverage: number;
    maintenanceBps: number;
    openFeeBps: number;
    borrowFeeBpsPerHour: number;
    longOiUsd: number;
    shortOiUsd: number;
  };
  wallet: { pubkey: string; epoch: number; nonce: number; used: number; lifetime: number; remaining: number };
  balanceUsd: number;
  vaultUsd: number;
  positions: PerpPosition[];
  keeperLog: { kind: string; detail: string; at: number }[];
  llm: "anthropic" | "openai" | "fallback";
  explorer: string;
}

export interface PerpProposalView {
  side: "long" | "short";
  collateralUsd: number;
  leverage: number;
  notionalUsd: number;
  entryUsd: number;
  slUsd: number | null;
  tpUsd: number | null;
  liqUsd: number;
}
export interface PerpPlan {
  side: number;
  collateralUsd: number;
  leverage: number;
  slPct: number | null;
  tpPct: number | null;
}
export type PerpChatResult =
  | { kind: "chat"; reply: string }
  | { kind: "proposal"; rationale: string; proposal: PerpProposalView; policy: { allowed: boolean; reason?: string }; plan: PerpPlan };

export interface PerpExecResult {
  stages: { name: string; detail: string }[];
  txSig: string;
  seq?: number;
  receivedUsd?: number;
  state: PerpState;
}

export const api = {
  state: (): Promise<State> => fetch("/api/state").then(j),
  perp: {
    state: (): Promise<PerpState> => fetch("/api/perp/state").then(j),
    chat: (message: string, history: { role: "user" | "assistant"; content: string }[]): Promise<PerpChatResult> =>
      fetch("/api/perp/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history }),
      }).then(j),
    open: (plan: PerpPlan): Promise<PerpExecResult> =>
      fetch("/api/perp/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      }).then(j),
    close: (seq: number): Promise<PerpExecResult> =>
      fetch("/api/perp/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq }),
      }).then(j),
  },
  interpret: (message: string): Promise<InterpretResult> =>
    fetch("/api/interpret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then(j),
  execute: (intent: Intent): Promise<ExecuteResult> =>
    fetch("/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    }).then(j),
};
