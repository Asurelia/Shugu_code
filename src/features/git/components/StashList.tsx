// Shugu Forge — StashList (LOT 3 git-ui).
//
// Read-only list of stash entries with per-row actions :
//   - Apply : `git stash apply` (keeps the stash on the stack)
//   - Pop   : `git stash apply --pop` (removes after applying)
//   - View  : logs the index/oid/message (placeholder until a stash diff
//             viewer is wired — out of scope here).

import { Icon } from "@/components/components";
import { useGitStashes } from "@/features/git/queries";
import { useStashApply } from "@/features/git/mutations";

function relTime(ts: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export function StashList(): JSX.Element {
  const { data, isLoading, error } = useGitStashes();
  const apply = useStashApply();

  const stashes = data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        className="side-title"
        style={{
          padding: "8px 12px 4px",
          fontSize: 11,
          color: "var(--on-surface-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Stashes
      </div>
      {isLoading && (
        <div style={{ padding: 12, fontSize: 11, color: "var(--on-surface-muted)" }}>
          Loading…
        </div>
      )}
      {error && (
        <div
          style={{
            padding: 12,
            fontSize: 11,
            color: "var(--danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {String(error)}
        </div>
      )}
      {!isLoading && !error && stashes.length === 0 && (
        <div
          style={{
            padding: "8px 12px",
            fontSize: 11,
            color: "var(--on-surface-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          No stashes.
        </div>
      )}
      {stashes.map((s) => (
        <div
          key={s.index}
          className="side-item"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
          }}
        >
          <Icon name="stash" size={11} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {s.message}
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              stash@{`{${s.index}}`} · {relTime(s.timestamp)}
            </div>
          </div>
          <button
            className="lgb lgb-sm"
            disabled={apply.isPending}
            onClick={() => apply.mutate({ index: s.index, pop: false })}
            title="git stash apply"
          >
            Apply
          </button>
          <button
            className="lgb lgb-sm"
            disabled={apply.isPending}
            onClick={() => apply.mutate({ index: s.index, pop: true })}
            title="git stash pop"
          >
            Pop
          </button>
          <button
            className="lgb lgb-sm"
            onClick={() =>
              console.info("[StashList] view stash", {
                index: s.index,
                oid: s.oid,
                msg: s.message,
              })
            }
            title="View"
          >
            View
          </button>
        </div>
      ))}
    </div>
  );
}
