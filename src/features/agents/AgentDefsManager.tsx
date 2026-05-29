// Shugu Forge — Page gestionnaire d'agents personnalisés.
//
// Source de vérité = fichiers `.md` au format Claude Code (frontmatter YAML
// + body = system prompt), via les wrappers `@/lib/agentDefs` et les queries
// TanStack de `./agentDefsQueries`. Un agent défini ici marche aussi dans
// Claude Code / Codex / Pi (cf. `~/.claude/agents/` ↔ `~/.shugu/agents/`).
//
// Composition : un seul fichier, sous-composants internes (AgentCard,
// EmptyState, AgentFormDrawer) pour rester sous le plafond CLAUDE.md.

import { useState } from "react";
import { ModelPicker } from "@/features/panels/panels";
import {
  useAgentDefs,
  useWriteAgentDef,
  useDeleteAgentDef,
} from "./agentDefsQueries";
import type {
  AgentDef,
  AgentDefScope,
  AgentDefOrigin,
} from "@/lib/agentDefs";

// ─────────────────────────────────────────────────────────────────────
// Constantes d'affichage
// ─────────────────────────────────────────────────────────────────────

type ScopeTab = "all" | "global" | "workspace";

const SCOPE_LABEL: Record<ScopeTab, string> = {
  all: "Tous",
  global: "Globaux",
  workspace: "Ce projet",
};

const ORIGIN_BADGE: Record<
  AgentDefOrigin,
  { label: string; bg: string; fg: string }
> = {
  builtin: { label: "Pré-défini", bg: "rgba(129,236,255,0.16)", fg: "#81ecff" },
  user: { label: "Toi", bg: "rgba(138,239,199,0.18)", fg: "#8aefc7" },
  model: { label: "Créé par Shugu", bg: "rgba(224,142,254,0.20)", fg: "#e08efe" },
};

const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];
const BASE_ROLES = ["coder", "researcher", "tester", "orchestrator", "mascot"];

// ─────────────────────────────────────────────────────────────────────
// Composant principal
// ─────────────────────────────────────────────────────────────────────

type EditingState = AgentDef & { isNew?: boolean };

export function AgentDefsManager() {
  const [scope, setScope] = useState<ScopeTab>("all");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const { data: defs = [], isLoading, error } = useAgentDefs(scope as AgentDefScope);
  const writeMutation = useWriteAgentDef();
  const deleteMutation = useDeleteAgentDef();

  const onCreate = () => setEditing(blankDef("workspace"));
  const onEdit = (def: AgentDef) => setEditing({ ...def });
  const onClose = () => setEditing(null);

  const onSave = async (def: EditingState) => {
    const { isNew: _isNew, ...payload } = def;
    await writeMutation.mutateAsync(payload);
    setEditing(null);
  };
  const onToggle = async (def: AgentDef) => {
    await writeMutation.mutateAsync({ ...def, enabled: !def.enabled });
  };
  const onDelete = async (def: AgentDef) => {
    if (!window.confirm(`Supprimer l'agent "${def.name}" ?`)) return;
    await deleteMutation.mutateAsync(def.path);
    setEditing(null);
  };

  return (
    <div style={styles.shell}>
      <div style={styles.header}>
        <div style={{ flex: 1 }}>
          <h2 style={styles.title}>Mes agents</h2>
          <p style={styles.subtitle}>
            Chaque agent est un fichier <code style={styles.code}>.md</code>{" "}
            au format Claude Code (portable Claude Code · Codex · Pi · Shugu).
            Pas de format propriétaire, pas de lock-in.
          </p>
        </div>
        <button style={styles.btnPrimary} onClick={onCreate}>
          + Nouvel agent
        </button>
      </div>

      <div style={styles.tabs}>
        {(["all", "global", "workspace"] as ScopeTab[]).map((t) => (
          <button
            key={t}
            style={t === scope ? styles.tabActive : styles.tab}
            onClick={() => setScope(t)}
          >
            {SCOPE_LABEL[t]}
          </button>
        ))}
      </div>

      {isLoading && <div style={styles.empty}>Chargement…</div>}
      {error && (
        <div style={styles.error}>Erreur : {String((error as Error).message)}</div>
      )}
      {!isLoading && !error && defs.length === 0 && <EmptyState onCreate={onCreate} />}
      {defs.length > 0 && (
        <div style={styles.grid}>
          {defs.map((d) => (
            <AgentCard
              key={d.path}
              def={d}
              onEdit={() => onEdit(d)}
              onToggle={() => onToggle(d)}
            />
          ))}
        </div>
      )}

      {editing && (
        <AgentFormDrawer
          initial={editing}
          saving={writeMutation.isPending}
          onClose={onClose}
          onSave={onSave}
          onDelete={editing.isNew ? undefined : () => onDelete(editing)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sous-composants
// ─────────────────────────────────────────────────────────────────────

function AgentCard({
  def,
  onEdit,
  onToggle,
}: {
  def: AgentDef;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const origin = ORIGIN_BADGE[def.origin] ?? ORIGIN_BADGE.user;
  const initial = (def.name || "?").charAt(0).toUpperCase();
  return (
    <div
      style={{ ...styles.card, opacity: def.enabled ? 1 : 0.55 }}
      onClick={onEdit}
      role="button"
    >
      <div style={styles.cardHead}>
        <div
          style={{
            ...styles.avatar,
            background: def.color || "linear-gradient(135deg,#e08efe,#7c3aed)",
          }}
        >
          {initial}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.cardName}>{def.name}</div>
          <div style={styles.cardScope}>
            {def.scope === "global" ? "🌐 global" : "📁 ce projet"}
          </div>
        </div>
        <span style={{ ...styles.badge, background: origin.bg, color: origin.fg }}>
          {origin.label}
        </span>
      </div>
      <div style={styles.cardDesc}>{def.description || "—"}</div>
      <div style={styles.cardFooter}>
        <span style={styles.cardMeta}>{def.model || "(modèle hérité)"}</span>
        <label
          style={styles.toggle}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={def.enabled}
            onChange={onToggle}
            style={{ marginRight: 6 }}
          />
          {def.enabled ? "Actif" : "Brouillon"}
        </label>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={styles.emptyState}>
      <div style={styles.emptyEmoji}>📋</div>
      <h3 style={styles.emptyTitle}>Aucun agent ici pour l'instant</h3>
      <p style={styles.emptyDesc}>
        Un agent est un assistant spécialisé : tu lui donnes un nom, une
        spécialité (« quand m'utiliser »), et ses instructions. Tu pourras
        l'invoquer manuellement dans le chat, et plus tard Shugu pourra le
        choisir tout seul selon ta demande.
      </p>
      <button style={styles.btnPrimary} onClick={onCreate}>
        + Créer mon premier agent
      </button>
    </div>
  );
}

function AgentFormDrawer({
  initial,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  initial: EditingState;
  saving: boolean;
  onClose: () => void;
  onSave: (def: EditingState) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [def, setDef] = useState<EditingState>(initial);
  const set = <K extends keyof EditingState>(k: K, v: EditingState[K]) =>
    setDef((d) => ({ ...d, [k]: v }));
  const canSave = def.name.trim().length > 0 && def.body.trim().length > 0;

  return (
    <>
      <div style={styles.scrim} onClick={onClose} />
      <div style={styles.drawer}>
        <div style={styles.drawerHead}>
          <h3 style={styles.drawerTitle}>
            {initial.isNew ? "Nouvel agent" : `Éditer · ${initial.name}`}
          </h3>
          <button style={styles.btnGhost} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={styles.drawerBody}>
          <Field label="Nom (alphanumérique, '-' ou '_')">
            <input
              style={styles.input}
              value={def.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="code-reviewer"
            />
          </Field>
          <Field label="Quand m'utiliser (sert au routing auto plus tard)">
            <input
              style={styles.input}
              value={def.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Quand je dois faire relire mon code Rust"
            />
          </Field>
          <Field label="Instructions (system prompt)">
            <textarea
              style={{ ...styles.input, height: 180, fontFamily: "var(--font-mono)" }}
              value={def.body}
              onChange={(e) => set("body", e.target.value)}
              placeholder="Tu es un reviewer Rust expert. Analyse le code…"
            />
          </Field>
          <Field label="Modèle (vide = hérite du modèle actif du chat)">
            <ModelPicker
              model={def.model ?? ""}
              onChange={(m) => set("model", m || undefined)}
              className=""
            />
          </Field>
          <Field label="Rôle moteur (skills + outils internes hérités)">
            <select
              style={styles.input}
              value={def.baseRole}
              onChange={(e) => set("baseRole", e.target.value)}
            >
              {BASE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          {initial.isNew && (
            <Field label="Emplacement">
              <div style={{ display: "flex", gap: 8 }}>
                <ScopeRadio
                  selected={def.scope}
                  value="workspace"
                  label="📁 Ce projet (.claude/agents/)"
                  onChange={(v) => set("scope", v)}
                />
                <ScopeRadio
                  selected={def.scope}
                  value="global"
                  label="🌐 Global (~/.claude/agents/)"
                  onChange={(v) => set("scope", v)}
                />
              </div>
            </Field>
          )}
          <Field label="État">
            <label style={{ display: "inline-flex", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={def.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
                style={{ marginRight: 6 }}
              />
              {def.enabled ? "Actif" : "Brouillon"}
            </label>
          </Field>
        </div>
        <div style={styles.drawerFooter}>
          {onDelete && (
            <button style={styles.btnDanger} onClick={() => void onDelete()}>
              Supprimer
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.btnGhost} onClick={onClose}>
            Annuler
          </button>
          <button
            style={{
              ...styles.btnPrimary,
              opacity: canSave && !saving ? 1 : 0.5,
              cursor: canSave && !saving ? "pointer" : "not-allowed",
            }}
            disabled={!canSave || saving}
            onClick={() => void onSave(def)}
          >
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function ScopeRadio({
  selected,
  value,
  label,
  onChange,
}: {
  selected: string;
  value: "workspace" | "global";
  label: string;
  onChange: (v: "workspace" | "global") => void;
}) {
  const active = selected === value;
  return (
    <button
      type="button"
      style={active ? styles.scopeBtnActive : styles.scopeBtn}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Factory : objet vierge pour création
// ─────────────────────────────────────────────────────────────────────

function blankDef(scope: "workspace" | "global"): EditingState {
  return {
    name: "",
    description: "",
    model: undefined,
    tools: [...DEFAULT_TOOLS],
    icon: undefined,
    color: undefined,
    origin: "user",
    enabled: true,
    baseRole: "coder",
    path: "",
    scope,
    body: "",
    isNew: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Styles (inline pour V1 — alignés sur les variables CSS Shugu)
// ─────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  shell: { padding: 24, height: "100%", overflowY: "auto" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 18,
  },
  title: {
    margin: 0,
    fontFamily: "var(--font-display)",
    fontSize: 22,
    fontWeight: 600,
    color: "var(--on-surface)",
  },
  subtitle: {
    margin: "6px 0 0",
    fontSize: 13,
    color: "var(--on-surface-muted)",
    maxWidth: 720,
    lineHeight: 1.5,
  },
  code: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(224,142,254,0.10)",
    color: "var(--primary)",
  },
  tabs: {
    display: "flex",
    gap: 6,
    marginBottom: 16,
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    paddingBottom: 8,
  },
  tab: {
    background: "transparent",
    border: 0,
    padding: "6px 12px",
    borderRadius: 6,
    color: "var(--on-surface-muted)",
    cursor: "pointer",
    fontSize: 12.5,
    fontFamily: "inherit",
  },
  tabActive: {
    background: "rgba(224,142,254,0.14)",
    border: 0,
    padding: "6px 12px",
    borderRadius: 6,
    color: "var(--primary)",
    cursor: "pointer",
    fontSize: 12.5,
    fontFamily: "inherit",
    fontWeight: 600,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 14,
  },
  card: {
    background: "linear-gradient(180deg, rgba(20,16,38,0.65), rgba(14,12,28,0.65))",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 12,
    padding: 14,
    cursor: "pointer",
    transition: "border-color 140ms ease, transform 140ms ease",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  cardHead: { display: "flex", alignItems: "center", gap: 10 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
  },
  cardName: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 14,
    color: "var(--on-surface)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardScope: {
    fontSize: 11,
    color: "var(--on-surface-muted)",
    marginTop: 2,
  },
  badge: {
    padding: "2px 7px",
    borderRadius: 99,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  cardDesc: {
    fontSize: 12.5,
    color: "var(--on-surface-variant)",
    lineHeight: 1.5,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  cardFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 11,
    color: "var(--on-surface-muted)",
    marginTop: "auto",
  },
  cardMeta: { fontFamily: "var(--font-mono)", fontSize: 11 },
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 11,
    color: "var(--on-surface-muted)",
    cursor: "pointer",
  },
  empty: { padding: 40, textAlign: "center", color: "var(--on-surface-muted)" },
  error: {
    padding: 14,
    borderRadius: 8,
    background: "rgba(255,107,107,0.12)",
    border: "1px solid rgba(255,107,107,0.25)",
    color: "#ff6b6b",
    fontSize: 12.5,
  },
  emptyState: {
    padding: "48px 24px",
    textAlign: "center",
    border: "1px dashed rgba(255,255,255,0.10)",
    borderRadius: 12,
    background: "rgba(20,16,38,0.30)",
  },
  emptyEmoji: { fontSize: 40, marginBottom: 12 },
  emptyTitle: {
    margin: 0,
    fontFamily: "var(--font-display)",
    fontSize: 18,
    color: "var(--on-surface)",
  },
  emptyDesc: {
    margin: "10px auto 20px",
    maxWidth: 480,
    fontSize: 13,
    lineHeight: 1.55,
    color: "var(--on-surface-muted)",
  },
  btnPrimary: {
    padding: "8px 14px",
    borderRadius: 8,
    border: 0,
    background: "linear-gradient(135deg, #e08efe, #7c3aed)",
    color: "#fff",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
    flexShrink: 0,
  },
  btnGhost: {
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "transparent",
    color: "var(--on-surface-muted)",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  btnDanger: {
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,107,107,0.30)",
    background: "rgba(255,107,107,0.10)",
    color: "#ff6b6b",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  scrim: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.40)",
    zIndex: 200,
  },
  drawer: {
    position: "fixed",
    right: 0,
    top: 0,
    bottom: 0,
    width: 480,
    maxWidth: "100vw",
    background: "linear-gradient(180deg, rgba(20,16,38,0.98), rgba(14,12,28,0.99))",
    borderLeft: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "-24px 0 60px rgba(0,0,0,0.5)",
    display: "flex",
    flexDirection: "column",
    zIndex: 201,
  },
  drawerHead: {
    display: "flex",
    alignItems: "center",
    padding: "14px 18px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  drawerTitle: {
    flex: 1,
    margin: 0,
    fontFamily: "var(--font-display)",
    fontSize: 15,
    color: "var(--on-surface)",
  },
  drawerBody: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  drawerFooter: {
    display: "flex",
    gap: 8,
    padding: "12px 18px",
    borderTop: "1px solid rgba(255,255,255,0.06)",
  },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--on-surface-muted)",
    fontFamily: "var(--font-mono)",
  },
  input: {
    background: "rgba(0,0,0,0.30)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 8,
    padding: "8px 10px",
    color: "var(--on-surface)",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
    resize: "vertical",
  },
  scopeBtn: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "transparent",
    color: "var(--on-surface-muted)",
    cursor: "pointer",
    fontSize: 12.5,
    fontFamily: "inherit",
  },
  scopeBtnActive: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(224,142,254,0.35)",
    background: "rgba(224,142,254,0.14)",
    color: "var(--primary)",
    cursor: "pointer",
    fontSize: 12.5,
    fontFamily: "inherit",
    fontWeight: 600,
  },
};
