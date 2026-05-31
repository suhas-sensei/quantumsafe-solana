import { useEffect, useRef, useState } from "react";
import { api, State, InterpretResult, Intent, ExecuteResult } from "./api";
import { Perp } from "./Perp";

export function App() {
  const [tab, setTab] = useState<"perps" | "swap">("perps");
  return (
    <>
      <div className="tabs">
        <button className={tab === "perps" ? "on" : ""} onClick={() => setTab("perps")}>
          Perps
        </button>
        <button className={tab === "swap" ? "on" : ""} onClick={() => setTab("swap")}>
          Swap
        </button>
      </div>
      {tab === "perps" ? <Perp /> : <SwapView />}
    </>
  );
}

type Msg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string }
  | { role: "proposal"; data: Extract<InterpretResult, { kind: "intent" }> }
  | { role: "execution"; stages: { name: string; detail: string }[]; tx: string; received: string; outSym: string };

const short = (s: string, n = 4) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

function SwapView() {
  const [state, setState] = useState<State | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Intent | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = () => api.state().then(setState).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const r = await api.interpret(text);
      if (r.kind === "chat") {
        setMsgs((m) => [...m, { role: "agent", text: r.reply }]);
      } else {
        setMsgs((m) => [...m, { role: "proposal", data: r }]);
        if (r.policy.allowed) setPending(r.intent);
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", text: `error: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function approve(intent: Intent, outSym: string) {
    setBusy(true);
    setPending(null);
    try {
      const r: ExecuteResult = await api.execute(intent);
      setMsgs((m) => [...m, { role: "execution", stages: r.stages, tx: r.txSig, received: r.receivedHuman, outSym }]);
      setState(r.state);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", text: `execution rejected: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <aside className="panel">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <div className="title">QuantumSafe</div>
            <div className="subtitle">post-quantum DeFi agent</div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">Portfolio</div>
          {state ? (
            <>
              <Row label="SOL" value={state.balances.SOL.amount} />
              <Row label="USDC" value={state.balances.USDC.amount} />
              <div className="price">1 SOL ≈ {state.price.toFixed(2)} USDC</div>
            </>
          ) : (
            <div className="muted">connecting…</div>
          )}
        </div>

        <div className="card">
          <div className="card-h">Quantum wallet</div>
          <Row label="pubkey" value={state ? short(state.walletPubkey, 5) : "—"} mono />
          <Row label="signatures left" value={state ? `${state.remaining} / ${state.lifetime}` : "—"} />
          <Row label="epoch · nonce" value={state ? `${state.epoch} · ${state.nonce}` : "—"} />
        </div>

        <div className="card">
          <div className="card-h">Security</div>
          <Badge ok text="signer isolated (PORST)" />
          <Badge ok text="policy engine active" />
          <Badge ok text={`intent model: ${state?.llm ?? "—"}`} dim={state?.llm === "fallback"} />
        </div>
        <div className="foot">model proposes · it never signs · keys are post-quantum</div>
      </aside>

      <main className="chat">
        <div className="messages" ref={scroller}>
          {msgs.length === 0 && (
            <div className="empty">
              <h2>Trade by talking.</h2>
              <p>Try: <code>swap 1 SOL to USDC</code> — the agent proposes, you approve, a post-quantum signature authorizes it on-chain.</p>
            </div>
          )}
          {msgs.map((m, i) => (
            <Message key={i} m={m} onApprove={approve} explorer={state?.explorer ?? ""} />
          ))}
          {busy && <div className="bubble agent thinking">working…</div>}
        </div>

        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask the agent to trade…  e.g. swap 1 SOL to USDC"
            disabled={busy}
          />
          <button onClick={send} disabled={busy || !input.trim()}>
            Send
          </button>
        </div>
      </main>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row">
      <span className="row-l">{label}</span>
      <span className={"row-v" + (mono ? " mono" : "")}>{value}</span>
    </div>
  );
}

function Badge({ ok, text, dim }: { ok?: boolean; text: string; dim?: boolean }) {
  return (
    <div className={"badge" + (dim ? " dim" : "")}>
      <span className={"dot" + (ok ? " ok" : "")} />
      {text}
    </div>
  );
}

function Message({ m, onApprove, explorer }: { m: Msg; onApprove: (i: Intent, outSym: string) => void; explorer: string }) {
  if (m.role === "user") return <div className="bubble user">{m.text}</div>;
  if (m.role === "agent") return <div className="bubble agent">{m.text}</div>;
  if (m.role === "proposal") {
    const { plan, policy, intent } = m.data;
    return (
      <div className="bubble agent proposal">
        <div className="prop-h">Proposed swap</div>
        <div className="prop-main">
          <span className="big">{plan.amountInHuman} {plan.inSym}</span>
          <span className="arrow">→</span>
          <span className="big">≈ {plan.expectedOutHuman} {plan.outSym}</span>
        </div>
        <div className="prop-meta">
          min received {plan.minOutHuman} {plan.outSym} · slippage {plan.slippageBps}bps
        </div>
        {policy.allowed ? (
          <>
            <div className="policy ok">✓ passes policy</div>
            <button className="approve" onClick={() => onApprove(intent, plan.outSym)}>
              Approve & sign (post-quantum)
            </button>
          </>
        ) : (
          <div className="policy bad">✗ blocked by policy: {policy.reason}</div>
        )}
      </div>
    );
  }
  // execution
  return (
    <div className="bubble agent execution">
      <div className="prop-h">Authorized & executed</div>
      <ol className="stages">
        {m.stages.map((s, i) => (
          <li key={i}>
            <span className="stage-n">{s.name}</span>
            <span className="stage-d">{s.detail}</span>
          </li>
        ))}
      </ol>
      <div className="result">
        +{m.received} {m.outSym} ·{" "}
        <a className="mono txlink" href={`https://explorer.solana.com/tx/${m.tx}${explorer}`} target="_blank" rel="noreferrer">
          {short(m.tx, 6)} ↗
        </a>
      </div>
    </div>
  );
}
