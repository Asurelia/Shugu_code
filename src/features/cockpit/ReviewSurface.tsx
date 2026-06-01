// src/features/cockpit/ReviewSurface.tsx
// Lot C1 placeholder. The real diff/review (portées, stage/revert, Cmd+clic
// → éditeur, survol + → commentaire) lands in Lot C2.
export function ReviewSurface() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 24,
        color: "var(--on-surface-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      Révision — le diff complet (portées, stage/revert, Cmd+clic → éditeur,
      survol + → commentaire à l'agent) arrive au Lot Cockpit-2.
    </div>
  );
}
