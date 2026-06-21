// Shugu Forge — Trust-UX taxonomy (Lane 5).
//
// One place where the "what can this thing actually do to my machine?" vocabulary
// lives, so every confidence primitive (RiskBadge, PermissionBadge,
// ExecutionProfileCard…) speaks the SAME language and uses the SAME colors. The
// old UI lied by omission: a green "Grounded Run" button read as *safe*, and a
// bare "local" chip was ambiguous (local = private? local = sandboxed? local =
// can-touch-my-files?). The taxonomy below makes the real capability explicit.
//
// Color mapping (design tokens, styles.css):
//   read  → tertiary (cyan)   — only looks, never changes anything
//   write → warn (amber)      — edits files on disk
//   exec  → danger (red)      — runs real commands with your toolchain
//
// These map onto the three chat MODES too (see modeToRisk): Chat/Ask = read,
// Plan = read, Agent/Act = exec. The badge color is therefore a truthful,
// at-a-glance signal of blast radius.

/** Capability tiers, ordered by blast radius (ascending). */
export type RiskLevel = "read" | "write" | "exec";

export interface RiskMeta {
  level: RiskLevel;
  /** Short uppercase label for the badge pill. */
  label: string;
  /** One-line plain-language description of what this tier can do. */
  blurb: string;
  /** Emoji glyph (decorative — always paired with text). */
  glyph: string;
  /** CSS color token (with a hard fallback) for foreground/accent. */
  color: string;
  /** Translucent background tint for the pill/card. */
  tint: string;
  /** Border color for the pill/card. */
  border: string;
}

export const RISK: Record<RiskLevel, RiskMeta> = {
  read: {
    level: "read",
    label: "Lecture",
    blurb: "Lit et cherche uniquement — ne modifie aucun fichier, n'exécute rien.",
    glyph: "👁",
    color: "var(--tertiary, #81ecff)",
    tint: "rgba(129, 236, 255, 0.10)",
    border: "rgba(129, 236, 255, 0.30)",
  },
  write: {
    level: "write",
    label: "Écriture",
    blurb: "Peut modifier des fichiers de ton projet — annulable dans l'onglet Git.",
    glyph: "✍️",
    color: "var(--warn, #ffcf6b)",
    tint: "rgba(255, 207, 107, 0.10)",
    border: "rgba(255, 207, 107, 0.32)",
  },
  exec: {
    level: "exec",
    label: "Exécution",
    blurb: "Lance de vraies commandes avec ta toolchain (pnpm, node, cargo…) et écrit sur le disque.",
    glyph: "⚙️",
    color: "var(--danger, #ff6a8a)",
    tint: "rgba(255, 106, 138, 0.10)",
    border: "rgba(255, 106, 138, 0.32)",
  },
};

/** The three chat modes, kept in sync with chat-sync's ChatMode union. We don't
 *  import the type here to avoid a feature→component dependency cycle; the values
 *  are validated against ChatMode at the call sites in views-chat / ModeSelector. */
export type TrustMode = "chat" | "plan" | "agent";

export interface ModeMeta {
  id: TrustMode;
  /** Claude-Code-style short name shown in the badge. */
  badge: string;
  /** Longer human label. */
  label: string;
  /** The risk tier this mode operates at — drives the badge color. */
  risk: RiskLevel;
}

// "chat" = Ask, "plan" = Plan, "agent" = Act. The badge wording mirrors the
// Ask/Plan/Act convention requested by the trust-ux lane while keeping the
// internal mode ids untouched (chat/plan/agent live in localStorage + Rust).
export const MODE_META: Record<TrustMode, ModeMeta> = {
  chat:  { id: "chat",  badge: "Ask",  label: "Chat", risk: "read" },
  plan:  { id: "plan",  badge: "Plan", label: "Plan", risk: "read" },
  agent: { id: "agent", badge: "Act",  label: "Agent", risk: "exec" },
};

/** Coerce an arbitrary string (e.g. from localStorage or a Rust row) to a known
 *  mode, defaulting to "agent" — the same default chat-sync uses. */
export function toTrustMode(raw: string | null | undefined): TrustMode {
  return raw === "chat" || raw === "plan" || raw === "agent" ? raw : "agent";
}

/** Map a chat mode to its risk tier. */
export function modeToRisk(mode: TrustMode): RiskLevel {
  return MODE_META[mode].risk;
}
