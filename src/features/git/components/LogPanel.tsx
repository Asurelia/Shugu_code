// Shugu Forge — LogPanel (LOT 3 git-ui).
//
// Virtualized commit list — pulls `useGitLog(maxCount)` and renders rows
// with `@tanstack/react-virtual` so a 5k-commit log scrolls cheaply.
// Click → opens the detail panel (full message, author, parents).

import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useGitLog } from "@/features/git/queries";
import type { GitLogEntry } from "@/lib/types";

const ROW_PX = 44;

function formatRelative(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const d = now - ts;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 30 * 86400) return `${Math.floor(d / 86400)}d ago`;
  if (d < 365 * 86400) return `${Math.floor(d / (30 * 86400))}mo ago`;
  return `${Math.floor(d / (365 * 86400))}y ago`;
}

function DetailPanel({
  entry,
  onClose,
}: {
  entry: GitLogEntry;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "linear-gradient(180deg, rgba(20,16,38,0.96), rgba(12,10,24,0.98))",
        zIndex: 10,
        padding: 12,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={onClose}
          className="lgb lgb-sm"
          style={{ padding: "2px 8px" }}
        >
          ← back
        </button>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--primary)",
          }}
        >
          {entry.shortOid}
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{entry.summary}</div>
      <div style={{ fontSize: 11, color: "var(--on-surface-variant)" }}>
        {entry.authorName} &lt;{entry.authorEmail}&gt;
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {new Date(entry.timestamp * 1000).toLocaleString()} ·{" "}
        {entry.parents.length === 0
          ? "root"
          : entry.parents.length === 1
            ? `parent ${entry.parents[0].slice(0, 7)}`
            : `merge of ${entry.parents.map((p) => p.slice(0, 7)).join(", ")}`}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 10,
          background: "rgba(0,0,0,0.18)",
          border: "1px solid rgba(255,255,255,0.04)",
          borderRadius: 8,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--on-surface-variant)",
        }}
      >
        {entry.message || entry.summary}
      </pre>
    </div>
  );
}

export function LogPanel({
  maxCount = 500,
}: {
  maxCount?: number;
}): JSX.Element {
  const { data, isLoading, error } = useGitLog(maxCount);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<GitLogEntry | null>(null);

  const rows = data ?? [];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 8,
  });

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scrollRef}
        className="scroll"
        style={{ flex: 1, overflow: "auto", position: "relative" }}
      >
        {isLoading && (
          <div
            style={{
              padding: 16,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            Loading log…
          </div>
        )}
        {error && (
          <div
            style={{
              padding: 16,
              color: "var(--danger)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            {String(error)}
          </div>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <div
            style={{
              padding: 16,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            No commits yet.
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const r = rows[vi.index];
            return (
              <div
                key={r.oid}
                onClick={() => setSelected(r)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                  height: ROW_PX,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "6px 12px",
                  cursor: "pointer",
                  borderBottom: "1px solid rgba(255,255,255,0.03)",
                }}
                className="side-item"
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--primary)",
                      width: 56,
                    }}
                  >
                    {r.shortOid}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.summary}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    fontSize: 10,
                    color: "var(--on-surface-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.authorName}
                  </span>
                  <span>{formatRelative(r.timestamp)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selected && <DetailPanel entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
