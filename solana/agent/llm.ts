/**
 * Natural-language intent interpretation. The LLM ONLY proposes a structured
 * intent — it never builds transactions, signs, or moves funds (that boundary
 * is enforced downstream by the policy engine and the isolated signer).
 *
 * Provider is auto-selected from the environment:
 *   - ANTHROPIC_API_KEY -> Claude Messages API (model: $LLM_MODEL or claude-sonnet-4-6)
 *   - OPENAI_API_KEY     -> OpenAI Chat Completions ($LLM_MODEL or gpt-4o-mini)
 *   - neither            -> deterministic regex fallback ("swap 1 SOL to USDC")
 */
import { parseIntent } from "./pipeline";

export type Interpretation =
  | { kind: "intent"; action: "swap"; amount: number; inSym: string; outSym: string }
  | { kind: "chat"; reply: string };

function systemPrompt(tokens: string[]): string {
  return [
    "You are the intent parser for a non-custodial DeFi trading agent on Solana.",
    `The user holds these tokens: ${tokens.join(", ")}.`,
    "You CANNOT execute trades, build transactions, or sign anything — you only translate",
    "the user's request into a structured intent. A separate deterministic system enforces",
    "policy and a hardware-isolated post-quantum signer authorizes execution.",
    "",
    "Respond with ONLY a JSON object, no prose, no code fences:",
    '  to swap:   {"kind":"intent","action":"swap","amount":<number>,"inSym":"<SYM>","outSym":"<SYM>"}',
    '  otherwise: {"kind":"chat","reply":"<short helpful message>"}',
    "Use only the listed token symbols. If the request is ambiguous, ask via a chat reply.",
  ].join("\n");
}

function extractJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model output");
  return JSON.parse(m[0]);
}

function normalize(obj: any, tokens: string[]): Interpretation {
  if (obj && obj.kind === "intent" && obj.action === "swap") {
    const inSym = String(obj.inSym).toUpperCase();
    const outSym = String(obj.outSym).toUpperCase();
    if (!tokens.includes(inSym) || !tokens.includes(outSym)) {
      return { kind: "chat", reply: `I can only trade: ${tokens.join(", ")}.` };
    }
    return { kind: "intent", action: "swap", amount: Number(obj.amount), inSym, outSym };
  }
  return { kind: "chat", reply: String(obj?.reply ?? "How can I help you trade?") };
}

async function anthropic(message: string, tokens: string[]): Promise<Interpretation> {
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
      max_tokens: 256,
      system: systemPrompt(tokens),
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const text = (data.content || []).map((c: any) => c.text || "").join("");
  return normalize(extractJson(text), tokens);
}

async function openai(message: string, tokens: string[]): Promise<Interpretation> {
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt(tokens) },
        { role: "user", content: message },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return normalize(extractJson(data.choices[0].message.content), tokens);
}

export function llmProvider(): "anthropic" | "openai" | "fallback" {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "fallback";
}

/** Interpret a natural-language message into a structured intent. */
export async function interpret(message: string, tokens: string[]): Promise<Interpretation> {
  const provider = llmProvider();
  try {
    if (provider === "anthropic") return await anthropic(message, tokens);
    if (provider === "openai") return await openai(message, tokens);
  } catch (e) {
    // Fall through to deterministic parsing on any LLM error.
  }
  // Deterministic fallback.
  try {
    const p = parseIntent(message);
    if (tokens.includes(p.inSym) && tokens.includes(p.outSym)) {
      return { kind: "intent", action: "swap", amount: p.amount, inSym: p.inSym, outSym: p.outSym };
    }
    return { kind: "chat", reply: `I can only trade: ${tokens.join(", ")}.` };
  } catch {
    return {
      kind: "chat",
      reply: `Tell me a trade like "swap 1 SOL to USDC". Available: ${tokens.join(", ")}.`,
    };
  }
}
