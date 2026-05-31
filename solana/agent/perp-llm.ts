/**
 * AI mode for the perp engine. The user states a goal in natural language; the
 * model is given a LIVE market snapshot (real Pyth price + momentum, the trader's
 * balance, limits) and either asks one concise clarifying question (size?
 * leverage? stop-loss / take-profit?) or — when it has enough, or the user says
 * "you decide" — proposes a concrete position with a rationale.
 *
 * As everywhere in this system, the model ONLY proposes. Deterministic policy
 * clamps the proposal and the isolated PORST signer authorizes execution; the
 * model never builds a transaction, never signs, never moves funds.
 */
import { llmProvider } from "./llm";

export interface MarketSnapshot {
  priceUsd: number; // live mark (real, Pyth)
  emaUsd: number; // Pyth EMA (short-term reference)
  momentumPct: number; // (price - ema) / ema * 100
  borrowBpsPerHour: number;
  maxLeverage: number;
  traderBalanceUsd: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type PerpInterpretation =
  | { kind: "ask"; reply: string }
  | {
      kind: "propose";
      side: "long" | "short";
      collateralUsd: number;
      leverage: number;
      slPct: number | null; // % from entry (null = none)
      tpPct: number | null;
      rationale: string;
    };

function systemPrompt(s: MarketSnapshot): string {
  return [
    "You are the trading co-pilot for a non-custodial, post-quantum-secured perpetual-futures app on Solana.",
    "The market is SOL-PERP, margined and settled in USDT. You help the user open a leveraged position.",
    "",
    "LIVE MARKET (real, from the Pyth oracle — use this to reason about direction and risk):",
    `  SOL price: $${s.priceUsd.toFixed(4)}`,
    `  Pyth EMA:  $${s.emaUsd.toFixed(4)}  (short-term momentum: ${s.momentumPct >= 0 ? "+" : ""}${s.momentumPct.toFixed(3)}%)`,
    `  borrow/funding fee: ${s.borrowBpsPerHour} bps/hour on notional`,
    `  trader USDT balance: $${s.traderBalanceUsd.toFixed(2)}`,
    `  max leverage allowed: ${s.maxLeverage}x`,
    "",
    "You CANNOT execute, build transactions, or sign — you only produce a structured proposal.",
    "A deterministic policy engine clamps it and a hardware-isolated post-quantum signer authorizes it.",
    "",
    "Decide between two responses, replying with ONLY a JSON object (no prose, no code fences):",
    "  • If the user has NOT given enough to size a trade AND has not asked you to decide,",
    "    ask ONE short, friendly question for the missing piece (size in USDT, leverage, or stop-loss/take-profit).",
    "    Always offer the shortcut: they can say \"you decide\".",
    '    Format: {"kind":"ask","reply":"<one short question>"}',
    "  • Otherwise propose a concrete position. If the user said \"you decide\" (or similar), choose everything:",
    "    pick side from momentum, size CONSERVATIVELY (a small fraction of balance), choose sensible leverage,",
    "    and ALWAYS include a stop-loss and take-profit.",
    '    Format: {"kind":"propose","side":"long"|"short","collateralUsd":<number>,"leverage":<integer>,',
    '             "slPct":<number|null>,"tpPct":<number|null>,"rationale":"<one or two sentences>"}',
    "Rules: leverage is an integer between 1 and the max above. collateralUsd must be ≤ the balance.",
    "slPct/tpPct are POSITIVE percentage distances from the current price (e.g. 5 means a 5% move).",
    "Require a stop-loss whenever leverage > 10. Keep rationales grounded in the live data shown above.",
  ].join("\n");
}

function extractJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model output");
  return JSON.parse(m[0]);
}

function normalize(obj: any, s: MarketSnapshot): PerpInterpretation {
  if (obj && obj.kind === "propose") {
    const side = String(obj.side).toLowerCase() === "short" ? "short" : "long";
    let leverage = Math.max(1, Math.min(s.maxLeverage, Math.round(Number(obj.leverage) || 1)));
    const collateralUsd = Math.max(0, Number(obj.collateralUsd) || 0);
    const slPct = obj.slPct === null || obj.slPct === undefined ? null : Math.abs(Number(obj.slPct));
    const tpPct = obj.tpPct === null || obj.tpPct === undefined ? null : Math.abs(Number(obj.tpPct));
    return {
      kind: "propose",
      side,
      collateralUsd,
      leverage,
      slPct: Number.isFinite(slPct as number) ? slPct : null,
      tpPct: Number.isFinite(tpPct as number) ? tpPct : null,
      rationale: String(obj.rationale ?? ""),
    };
  }
  return { kind: "ask", reply: String(obj?.reply ?? "How much USDT do you want to commit, and at what leverage? (or say “you decide”)") };
}

async function callOpenAI(messages: any[]): Promise<string> {
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, messages }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data.choices[0].message.content;
}

async function callAnthropic(system: string, msgs: ChatTurn[]): Promise<string> {
  const model = process.env.LLM_MODEL || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system,
      messages: msgs.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return (data.content || []).map((c: any) => c.text || "").join("");
}

/** Deterministic fallback: parse simple commands or "you decide". */
function fallback(message: string, history: ChatTurn[], s: MarketSnapshot): PerpInterpretation {
  const text = message.toLowerCase();
  const decide = /(you decide|decide for me|your call|whatever you think|best trade|pick for me|surprise me)/.test(text);

  const sideMatch = /\b(long|buy|bull)\b/.test(text) ? "long" : /\b(short|sell|bear)\b/.test(text) ? "short" : null;
  const levMatch = text.match(/(\d+(?:\.\d+)?)\s*x/);
  const amtMatch = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:usdt|usd|dollars)?/);
  const leverage = levMatch ? Math.round(parseFloat(levMatch[1])) : null;
  const amount = amtMatch ? parseFloat(amtMatch[1]) : null;

  if (decide) {
    const side: "long" | "short" = s.momentumPct >= 0 ? "long" : "short";
    const collateralUsd = Math.max(1, Math.min(s.traderBalanceUsd * 0.1, 250));
    return {
      kind: "propose",
      side,
      collateralUsd: Math.round(collateralUsd),
      leverage: 3,
      slPct: 5,
      tpPct: 10,
      rationale: `Momentum is ${s.momentumPct >= 0 ? "positive" : "negative"} (${s.momentumPct.toFixed(2)}% vs EMA), so I'm going ${side} with a conservative 3x, risking ~10% of your balance, 5% stop / 10% target.`,
    };
  }

  if (sideMatch && amount && leverage) {
    return {
      kind: "propose",
      side: sideMatch as "long" | "short",
      collateralUsd: amount,
      leverage,
      slPct: leverage > 10 ? 4 : null,
      tpPct: null,
      rationale: `Opening your requested ${sideMatch} ${amount} USDT at ${leverage}x.`,
    };
  }

  // Ask for whatever's missing.
  if (!sideMatch) return { kind: "ask", reply: "Are you feeling bullish (long) or bearish (short) on SOL? Or say “you decide” and I’ll read the market." };
  if (!amount) return { kind: "ask", reply: "How much USDT do you want to commit as collateral?" };
  return { kind: "ask", reply: `And what leverage (1–${s.maxLeverage}x)?` };
}

/** Interpret a perp-trading conversation turn into an ask or a concrete proposal. */
export async function interpretPerp(
  history: ChatTurn[],
  message: string,
  snapshot: MarketSnapshot
): Promise<PerpInterpretation> {
  const provider = llmProvider();
  try {
    if (provider === "openai") {
      const messages = [
        { role: "system", content: systemPrompt(snapshot) },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ];
      return normalize(extractJson(await callOpenAI(messages)), snapshot);
    }
    if (provider === "anthropic") {
      const out = await callAnthropic(systemPrompt(snapshot), [...history, { role: "user", content: message }]);
      return normalize(extractJson(out), snapshot);
    }
  } catch {
    // fall through to deterministic parsing
  }
  return fallback(message, history, snapshot);
}
