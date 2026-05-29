// Shugu Forge — Codex usage panel.
//
// Shows REAL per-run token consumption (OpenAI's own `turn.completed.usage`)
// aggregated over rolling windows. This is an HONEST LOCAL ESTIMATE of quota
// consumption — OpenAI does not expose the subscription's authoritative
// remaining quota (5h/weekly %) in headless `codex exec` mode (verified:
// rate_limits:null, no `codex status` subcommand — openai/codex #14728, #10233).
// So we never show a fake "% remaining"; we show what was actually used, plus a
// banner when a real "limit reached" error was detected.

import {
  useCodexWindow,
  useCodexRecent,
  useCodexLimit,
  useCodexRateLimits,
} from "./codexQueries";
import { CODEX_WINDOW_5H, CODEX_WINDOW_WEEK, type CodexRateWindow } from "@/lib/codex";

/** Format an absolute epoch-seconds reset time as a human "dans …" hint. */
function fmtResetIn(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const s = Math.max(0, resetsAt - Math.floor(Date.now() / 1000));
  if (s < 60) return `reset dans ${s}s`;
  if (s < 3600) return `reset dans ${Math.floor(s / 60)}min`;
  if (s < 86400) return `reset dans ${Math.floor(s / 3600)}h`;
  return `reset dans ${Math.floor(s / 86400)}j`;
}

/** REAL quota window bar (OpenAI's authoritative usedPercent + reset). */
function RealWindowBar({ label, w }: { label: string; w: CodexRateWindow }) {
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const danger = pct >= 90;
  return (
    <div style={{ flex: 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--on-surface-muted)", marginBottom: 3 }}>
        <span>{label}</span>
        <span>{fmtResetIn(w.resetsAt)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 99, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: danger ? "var(--error, #ff6b6b)" : "#10a37f",
            transition: "width .3s",
          }}
        />
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: danger ? "var(--error, #ff6b6b)" : "var(--on-surface)", marginTop: 3 }}>
        {pct}% <span style={{ fontSize: 10, fontWeight: 400, color: "var(--on-surface-muted)" }}>utilisé</span>
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `il y a ${s}s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)}min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)}h`;
  return `il y a ${Math.floor(s / 86400)}j`;
}

function WindowStat({ label, windowSecs }: { label: string; windowSecs: number }) {
  const { data } = useCodexWindow(windowSecs);
  const total = data?.totalTokens ?? 0;
  const runs = data?.runs ?? 0;
  return (
    <div
      style={{
        flex: 1,
        padding: "10px 12px",
        borderRadius: 8,
        background: "rgba(16, 163, 127, 0.06)",
        border: "1px solid rgba(16, 163, 127, 0.22)",
      }}
    >
      <div style={{ fontSize: 10.5, color: "var(--on-surface-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--on-surface)" }}>
        {fmtTokens(total)} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--on-surface-muted)" }}>tokens</span>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--on-surface-muted)", marginTop: 2 }}>
        {runs} run{runs > 1 ? "s" : ""}
      </div>
    </div>
  );
}

export function CodexUsage() {
  const { data: recent } = useCodexRecent(12);
  const { data: limit } = useCodexLimit();
  const { data: real } = useCodexRateLimits();
  const hasReal = !!real && (real.primary != null || real.secondary != null);

  // Show the limit banner only if the most recent limit event is recent enough
  // to plausibly still be in effect (Codex windows reset on ~5h).
  const limitActive =
    limit != null && Date.now() - limit.ts < CODEX_WINDOW_5H * 1000;

  return (
    <div style={{ marginTop: 10 }}>
      {limitActive && (
        <div
          style={{
            marginBottom: 10,
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(255, 159, 67, 0.10)",
            border: "1px solid rgba(255, 159, 67, 0.35)",
            fontSize: 11,
            color: "var(--warning, #ff9f43)",
            lineHeight: 1.4,
          }}
        >
          ⚠ Limite Codex atteinte {fmtAgo(limit!.ts)} — la fenêtre se réinitialise ~5h après le
          premier usage. <span style={{ opacity: 0.8 }}>{limit!.message}</span>
        </div>
      )}

      {/* REAL quota (OpenAI authoritative) — primary 5h + secondary weekly. */}
      {hasReal && (
        <div
          style={{
            display: "flex",
            gap: 14,
            padding: "10px 12px",
            borderRadius: 8,
            background: "rgba(16, 163, 127, 0.06)",
            border: "1px solid rgba(16, 163, 127, 0.22)",
            marginBottom: 8,
          }}
        >
          {real!.primary && <RealWindowBar label="Quota 5h" w={real!.primary} />}
          {real!.secondary && <RealWindowBar label="Quota hebdo" w={real!.secondary} />}
        </div>
      )}

      <div style={{ fontSize: 10.5, color: "var(--on-surface-muted)", marginBottom: 4 }}>
        {hasReal ? "Consommation locale (détail tokens)" : "Estimation locale (tokens exacts par run)"}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <WindowStat label="5 dernières heures" windowSecs={CODEX_WINDOW_5H} />
        <WindowStat label="7 derniers jours" windowSecs={CODEX_WINDOW_WEEK} />
      </div>

      {recent && recent.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10.5, color: "var(--on-surface-muted)", marginBottom: 4 }}>
            Runs récents (tokens exacts)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((r) => (
              <div
                key={r.runId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 10.5,
                  padding: "3px 6px",
                  borderRadius: 4,
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background:
                      r.surface === "worker"
                        ? "rgba(124, 58, 237, 0.18)"
                        : "rgba(16, 163, 127, 0.18)",
                    color: r.surface === "worker" ? "var(--primary, #7c3aed)" : "#10a37f",
                  }}
                >
                  {r.surface}
                </span>
                <span style={{ color: "var(--on-surface-muted)", minWidth: 64 }}>{fmtAgo(r.ts)}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--on-surface-muted)" }}>
                  ↓{fmtTokens(r.inputTokens)} · ↑{fmtTokens(r.outputTokens)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          color: "var(--on-surface-muted)",
          lineHeight: 1.5,
          opacity: 0.85,
        }}
      >
        {hasReal ? (
          <>
            Le <b>quota réel</b> (% utilisé + reset) vient directement d'OpenAI via l'app-server. Les{" "}
            <b>tokens par run</b> ci-dessous sont exacts (rapportés par Codex) ; le total par fenêtre
            reste une estimation locale, indicative.
          </>
        ) : (
          <>
            Les <b>tokens par run sont exacts</b> (rapportés par Codex). Le total par fenêtre est une{" "}
            <b>estimation locale</b> — le quota réel d'OpenAI s'affichera dès que l'app-server est
            joignable (connecté à Codex).
          </>
        )}
      </div>
    </div>
  );
}
