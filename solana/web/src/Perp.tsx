import { useEffect, useRef, useState } from "react";
import { api, PerpState, PerpProposalView, PerpPlan, PerpPosition } from "./api";

type Turn = { role: "user" | "assistant"; content: string };
type Msg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string }
  | { role: "proposal"; rationale: string; proposal: PerpProposalView; policy: { allowed: boolean; reason?: string }; plan: PerpPlan }
  | { role: "execution"; stages: { name: string; detail: string }[]; tx: string; note: string };

const short = (s: string, n = 5) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const usd = (n: number) => `$${n.toFixed(2)}`;
const sign = (n: number) => (n >= 0 ? "+" : "");

export function Perp() {
  const [state, setState] = useState<PerpState | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = () => api.perp.state().then(setState).catch(() => {});
  useEffect(() => {
    refresh();
    const h = setInterval(refresh, 4000);
    return () => clearInterval(h);
  }, []);
  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [msgs]);

  const exLink = (tx: string) => `https://explorer.solana.com/tx/${tx}${state?.explorer ?? ""}`;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    const newHist: Turn[] = [...history, { role: "user", content: text }];
    setHistory(newHist);
    setBusy(true);
    try {
      const r = await api.perp.chat(text, history);
      if (r.kind === "chat") {
        setMsgs((m) => [...m, { role: "agent", text: r.reply }]);
        setHistory([...newHist, { role: "assistant", content: r.reply }]);
      } else {
        setMsgs((m) => [...m, { role: "proposal", rationale: r.rationale, proposal: r.proposal, policy: r.policy, plan: r.plan }]);
        setHistory([...newHist, { role: "assistant", content: `Proposed ${r.proposal.side} ${r.proposal.leverage}x, $${r.proposal.collateralUsd} collateral. ${r.rationale}` }]);
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", text: `error: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function approve(plan: PerpPlan) {
    setBusy(true);
    try {
      const r = await api.perp.open(plan);
      setMsgs((m) => [...m, { role: "execution", stages: r.stages, tx: r.txSig, note: `position #${r.seq} opened` }]);
      setState(r.state);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", text: `open rejected: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function close(seq: number) {
    setBusy(true);
    try {
      const r = await api.perp.close(seq);
      setMsgs((m) => [...m, { role: "execution", stages: r.stages, tx: r.txSig, note: `closed · returned ${usd(r.receivedUsd ?? 0)}` }]);
      setState(r.state);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", text: `close rejected: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  // Live PnL recomputed against the polled mark for smoothness.
  const livePnl = (p: PerpPosition): number => {
    if (!state) return p.pnlUsd;
    const diff = state.priceUsd - p.entryUsd;
    const raw = (p.notionalUsd * diff) / p.entryUsd;
    return p.side === "long" ? raw : -raw;
  };

  return (
    <div className="app">
      <aside className="panel">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <div className="title">QuantumSafe</div>
            <div className="subtitle">post-quantum perps · SOL-PERP</div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">SOL-PERP · mark</div>
          <div className="ticker">{state ? usd(state.priceUsd) : "—"}</div>
          <div className="price">
            {state ? `oracle ${state.oracleAgeSec}s ago · Pyth` : "connecting…"}
          </div>
        </div>

        <div className="card">
          <div className="card-h">Account</div>
          <Row label="USDT balance" value={state ? usd(state.balanceUsd) : "—"} />
          <Row label="max leverage" value={state ? `${state.market.maxLeverage}x` : "—"} />
          <Row label="LP vault" value={state ? usd(state.vaultUsd) : "—"} />
          <Row label="long / short OI" value={state ? `${usd(state.market.longOiUsd)} / ${usd(state.market.shortOiUsd)}` : "—"} />
        </div>

        <div className="card">
          <div className="card-h">Quantum wallet</div>
          <Row label="pq pubkey" value={state ? short(state.wallet.pubkey) : "—"} mono />
          <Row label="signatures left" value={state ? `${state.wallet.remaining} / ${state.wallet.lifetime}` : "—"} />
          <Row label="epoch · nonce" value={state ? `${state.wallet.epoch} · ${state.wallet.nonce}` : "—"} />
        </div>

        <div className="card">
          <div className="card-h">Security</div>
          <Badge ok text="signer isolated (PORST)" />
          <Badge ok text="keeper: liq + SL/TP live" />
          <Badge ok text={`intent model: ${state?.llm ?? "—"}`} dim={state?.llm === "fallback"} />
        </div>
        <div className="foot">AI proposes · you approve · a post-quantum signature authorizes each position on-chain · funds never leave a program vault without it</div>
      </aside>

      <main className="chat">
        {state && state.positions.length > 0 && (
          <div className="positions">
            {state.positions.map((p) => {
              const pnl = livePnl(p);
              return (
                <div key={p.seq} className="pos">
                  <div className="pos-top">
                    <span className={"pos-side " + p.side}>{p.side.toUpperCase()} {p.leverage}x</span>
                    <span className={"pos-pnl " + (pnl >= 0 ? "up" : "down")}>{sign(pnl)}{usd(pnl)}</span>
                  </div>
                  <div className="pos-meta">
                    {usd(p.collateralUsd)} margin · {usd(p.notionalUsd)} size · entry {usd(p.entryUsd)}
                  </div>
                  <div className="pos-meta">
                    liq {usd(p.liqUsd)}
                    {p.slUsd ? ` · SL ${usd(p.slUsd)}` : ""}
                    {p.tpUsd ? ` · TP ${usd(p.tpUsd)}` : ""}
                  </div>
                  <button className="closebtn" disabled={busy} onClick={() => close(p.seq)}>
                    Close & sign (PQ)
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="messages" ref={scroller}>
          {msgs.length === 0 && (
            <div className="empty">
              <h2>Trade SOL perps by talking.</h2>
              <p>
                Tell the AI your view — it reads the live market and proposes a position. Try:{" "}
                <code>I'm bullish, you decide</code> · <code>short 200 USDT at 10x</code> ·{" "}
                <code>go long with a tight stop</code>
              </p>
            </div>
          )}
          {msgs.map((m, i) => (
            <Message key={i} m={m} onApprove={approve} busy={busy} exLink={exLink} />
          ))}
          {busy && <div className="bubble agent thinking">working…</div>}
        </div>

        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Tell the AI your trade idea…  e.g. I'm bullish on SOL, you decide"
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

function Message({
  m,
  onApprove,
  busy,
  exLink,
}: {
  m: Msg;
  onApprove: (p: PerpPlan) => void;
  busy: boolean;
  exLink: (tx: string) => string;
}) {
  if (m.role === "user") return <div className="bubble user">{m.text}</div>;
  if (m.role === "agent") return <div className="bubble agent">{m.text}</div>;
  if (m.role === "proposal") {
    const p = m.proposal;
    return (
      <div className="bubble agent proposal">
        <div className="prop-h">Proposed position</div>
        <div className="prop-main">
          <span className={"big pos-side " + p.side}>{p.side.toUpperCase()}</span>
          <span className="big">{p.leverage}x</span>
          <span className="arrow">·</span>
          <span className="big">{usd(p.collateralUsd)}</span>
        </div>
        <div className="prop-meta">
          {usd(p.notionalUsd)} size · entry ~{usd(p.entryUsd)} · liq {usd(p.liqUsd)}
          {p.slUsd ? ` · SL ${usd(p.slUsd)}` : ""}
          {p.tpUsd ? ` · TP ${usd(p.tpUsd)}` : ""}
        </div>
        {m.rationale && <div className="rationale">“{m.rationale}”</div>}
        {m.policy.allowed ? (
          <>
            <div className="policy ok">✓ passes policy</div>
            <button className="approve" disabled={busy} onClick={() => onApprove(m.plan)}>
              Approve &amp; sign (post-quantum)
            </button>
          </>
        ) : (
          <div className="policy bad">✗ blocked by policy: {m.policy.reason}</div>
        )}
      </div>
    );
  }
  return (
    <div className="bubble agent execution">
      <div className="prop-h">Authorized &amp; executed</div>
      <ol className="stages">
        {m.stages.map((s, i) => (
          <li key={i}>
            <span className="stage-n">{s.name}</span>
            <span className="stage-d">{s.detail}</span>
          </li>
        ))}
      </ol>
      <div className="result">
        {m.note} ·{" "}
        <a className="mono txlink" href={exLink(m.tx)} target="_blank" rel="noreferrer">
          {short(m.tx, 6)} ↗
        </a>
      </div>
    </div>
  );
}
