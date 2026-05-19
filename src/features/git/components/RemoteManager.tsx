// Shugu Forge — RemoteManager (LOT 3 git-ui).
//
// Lists configured remotes and lets the user add / remove them. The
// "add" flow uses a small inline form (name + URL). Removal is direct
// with no confirm — re-adding is trivial (no data loss from removing a
// remote pointer).

import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { useGitRemotes } from "@/features/git/queries";
import { useAddRemote, useRemoveRemote } from "@/features/git/mutations";

function AddRemoteModal({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState("origin");
  const [url, setUrl] = useState("");
  const add = useAddRemote();

  const submit = () => {
    if (!name.trim() || !url.trim()) return;
    add.mutate(
      { name: name.trim(), url: url.trim() },
      { onSuccess: () => onClose() },
    );
  };

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !add.isPending) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "min(440px, 92vw)",
          background:
            "linear-gradient(180deg, rgba(20,16,38,0.96), rgba(12,10,24,0.98))",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="push" size={12} />
          Add remote
        </div>
        <label style={{ fontSize: 11, color: "var(--on-surface-variant)" }}>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 6,
              padding: "6px 10px",
              color: "var(--on-surface)",
              font: "inherit",
              fontSize: 12,
            }}
          />
        </label>
        <label style={{ fontSize: 11, color: "var(--on-surface-variant)" }}>
          URL
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="git@github.com:user/repo.git"
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 6,
              padding: "6px 10px",
              color: "var(--on-surface)",
              font: "inherit",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
        </label>
        {add.isError && (
          <div
            style={{
              fontSize: 11,
              color: "var(--danger)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {String(add.error)}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="lgb lgb-sm" onClick={onClose} disabled={add.isPending}>
            Cancel
          </button>
          <button
            className="lgb lgb-sm lgb-primary"
            onClick={submit}
            disabled={add.isPending || !name.trim() || !url.trim()}
          >
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function RemoteManager(): JSX.Element {
  const { data, isLoading, error } = useGitRemotes();
  const remove = useRemoveRemote();
  const [showAdd, setShowAdd] = useState(false);

  const remotes = data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px 4px",
        }}
      >
        <div
          className="side-title"
          style={{
            fontSize: 11,
            color: "var(--on-surface-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            flex: 1,
          }}
        >
          Remotes
        </div>
        <button
          className="lgb lgb-sm"
          onClick={() => setShowAdd(true)}
          style={{ padding: "2px 8px" }}
          title="Add remote"
        >
          <Icon name="plus" size={10} />
        </button>
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
      {!isLoading && !error && remotes.length === 0 && (
        <div
          style={{
            padding: "8px 12px",
            fontSize: 11,
            color: "var(--on-surface-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          No remotes configured.
        </div>
      )}
      {remotes.map((r) => (
        <div
          key={r.name}
          className="side-item"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12 }}>{r.name}</div>
            <div
              style={{
                fontSize: 10,
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.url}
            </div>
          </div>
          <button
            className="lgb lgb-sm"
            onClick={() => remove.mutate(r.name)}
            disabled={remove.isPending}
            title="Remove remote"
          >
            <Icon name="x" size={10} />
          </button>
        </div>
      ))}
      {showAdd && <AddRemoteModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}
