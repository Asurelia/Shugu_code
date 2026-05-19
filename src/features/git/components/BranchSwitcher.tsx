// Shugu Forge — BranchSwitcher (LOT 3 git-ui).
//
// Two exports :
//   - `BranchSwitcher`     : full dropdown for the SideGit panel — shows
//                            current branch, list of local/remote branches,
//                            "Create new branch" inline input, checkout/
//                            delete actions.
//   - `BranchSwitcherCompact` : statusbar-friendly inline trigger that
//                            opens the same dropdown anchored to the
//                            trigger button. Used by the IDE statusbar.
//
// State is owned by the dropdown (open/closed) but ALL branch data flows
// through useGitBranches / useCheckout — no local copy of the branch list.
// Delete uses `git branch -d` semantics : we call useCheckout… not yet —
// there's no `git_branch_delete` command in LOT 1. So the delete entry is
// disabled with a tooltip pointing to the contract gap.

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { useGitBranches } from "@/features/git/queries";
import { useCheckout } from "@/features/git/mutations";

interface DropdownPosition {
  x: number;
  y: number;
  width: number;
}

function BranchDropdown({
  pos,
  onClose,
}: {
  pos: DropdownPosition;
  onClose: () => void;
}): JSX.Element {
  const { data } = useGitBranches();
  const checkout = useCheckout();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside-click + Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const current = data?.current ?? null;
  const local = (data?.local ?? []).filter((b) =>
    filter ? b.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  const remote = (data?.remote ?? []).filter((b) =>
    filter ? b.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  const doCheckout = (branch: string, create = false) => {
    checkout.mutate(
      { branch, create },
      {
        onSuccess: () => {
          setCreating(false);
          setNewName("");
          onClose();
        },
      },
    );
  };

  const commitNew = () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    doCheckout(name, true);
  };

  // VSCode-style minWidth so the dropdown is comfortable even from a
  // narrow trigger (compact statusbar).
  return createPortal(
    <div
      ref={ref}
      className="file-ctx-menu"
      style={{
        left: pos.x,
        top: pos.y,
        minWidth: Math.max(pos.width, 260),
        maxHeight: 360,
        overflowY: "auto",
      }}
      role="menu"
    >
      <div
        style={{
          padding: "6px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          marginBottom: 4,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder="Filter branches…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6,
            padding: "4px 8px",
            color: "var(--on-surface)",
            font: "inherit",
            fontSize: 12,
          }}
        />
      </div>

      {creating ? (
        <div style={{ padding: "4px 6px" }}>
          <input
            type="text"
            placeholder="new-branch-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitNew();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setCreating(false);
                setNewName("");
              }
            }}
            autoFocus
            style={{
              width: "100%",
              background: "rgba(224,142,254,0.06)",
              border: "1px solid rgba(224,142,254,0.28)",
              borderRadius: 6,
              padding: "4px 8px",
              color: "var(--on-surface)",
              font: "inherit",
              fontSize: 12,
            }}
          />
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="plus" size={11} />
          Create new branch…
        </button>
      )}

      {local.length > 0 && (
        <>
          <div className="file-ctx-target" style={{ marginTop: 6 }}>
            Local
          </div>
          {local.map((b) => {
            const isCurrent = b.name === current;
            return (
              <button
                key={`local-${b.name}`}
                onClick={() => {
                  if (!isCurrent) doCheckout(b.name, false);
                  else onClose();
                }}
                disabled={checkout.isPending}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontWeight: isCurrent ? 600 : 400,
                  color: isCurrent ? "var(--primary)" : "var(--on-surface)",
                }}
              >
                <span style={{ width: 12, display: "inline-block", textAlign: "center" }}>
                  {isCurrent ? "●" : ""}
                </span>
                <Icon name="branch" size={11} />
                <span style={{ flex: 1, textAlign: "left" }}>{b.name}</span>
                {(b.ahead > 0 || b.behind > 0) && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--on-surface-muted)",
                    }}
                  >
                    {b.ahead > 0 && `↑${b.ahead}`}
                    {b.behind > 0 && ` ↓${b.behind}`}
                  </span>
                )}
              </button>
            );
          })}
        </>
      )}

      {remote.length > 0 && (
        <>
          <div className="file-ctx-target" style={{ marginTop: 6 }}>
            Remote
          </div>
          {remote.map((b) => (
            <button
              key={`remote-${b.name}`}
              onClick={() => doCheckout(b.name, true)}
              disabled={checkout.isPending}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ width: 12, display: "inline-block" }} />
              <Icon name="branch" size={11} />
              <span
                style={{
                  flex: 1,
                  textAlign: "left",
                  color: "var(--on-surface-variant)",
                }}
              >
                {b.name}
              </span>
              <Icon name="download" size={10} />
            </button>
          ))}
        </>
      )}

      {checkout.isError && (
        <div
          className="file-ctx-target"
          style={{ color: "var(--danger)", fontFamily: "var(--font-mono)" }}
        >
          {String(checkout.error)}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * Full-width dropdown trigger used at the top of SideGit. Shows the
 * current branch name + a chevron, opens the same shared dropdown.
 */
export function BranchSwitcher(): JSX.Element {
  const { data } = useGitBranches();
  const [pos, setPos] = useState<DropdownPosition | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const open = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 4, width: r.width });
  };

  const current = data?.current ?? "(detached HEAD)";
  const head = data?.local.find((b) => b.name === data?.current);
  const ahead = head?.ahead ?? 0;
  const behind = head?.behind ?? 0;

  return (
    <>
      <button
        ref={btnRef}
        onClick={open}
        className="lgb lgb-sm"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          justifyContent: "flex-start",
        }}
        title="Switch branch"
      >
        <Icon name="branch" size={12} />
        <span style={{ flex: 1, textAlign: "left" }}>{current}</span>
        {(ahead > 0 || behind > 0) && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--on-surface-muted)",
            }}
          >
            {ahead > 0 && `↑${ahead}`}
            {behind > 0 && ` ↓${behind}`}
          </span>
        )}
        <Icon name="down" size={10} />
      </button>
      {pos && <BranchDropdown pos={pos} onClose={() => setPos(null)} />}
    </>
  );
}

/**
 * Inline-text variant for the IDE statusbar. Same dropdown but rendered
 * as a `<span class="item branch">` so the existing statusbar styling
 * (font-mono, muted color) stays consistent. Anchors the dropdown below
 * the trigger.
 */
export function BranchSwitcherCompact(): JSX.Element {
  const { data } = useGitBranches();
  const [pos, setPos] = useState<DropdownPosition | null>(null);
  const spanRef = useRef<HTMLSpanElement | null>(null);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = spanRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Open ABOVE the statusbar (which sits at the bottom of the IDE).
    setPos({ x: r.left, y: r.top - 4 - 360, width: r.width });
  };

  const current = data?.current ?? "—";

  return (
    <>
      <span
        ref={spanRef}
        className="item branch"
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") open(e as unknown as React.MouseEvent);
        }}
        style={{ cursor: "pointer" }}
        title="Switch branch"
      >
        {current}
      </span>
      {pos && <BranchDropdown pos={pos} onClose={() => setPos(null)} />}
    </>
  );
}
