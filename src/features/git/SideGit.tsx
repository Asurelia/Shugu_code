import { Icon } from "@/components/components";

export function SideGit(): JSX.Element {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Source Control</div>
      </div>
      <div className="side-list scroll" style={{ padding: 16 }}>
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          textAlign: "center",
        }}>
          <Icon name="git" size={28} />
          <div>Source Control panel</div>
          <div style={{ opacity: 0.6 }}>Wiring in progress (LOT 3 git-ui)</div>
        </div>
      </div>
    </aside>
  );
}
