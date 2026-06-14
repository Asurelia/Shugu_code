// Shugu Forge — MCP servers section (Settings → Connections → Serveurs MCP).
//
// Lists the MCP servers declared in `.mcp.json` (project + global, merged by the
// Rust backend), and lets the user enable/disable each one, probe its tools
// ("Tester"), remove it, or add a new one (stdio command or http url). All of
// this drives the TanStack hooks in `./queries`, which wrap the Tauri commands
// behind the `mcp::` Rust module.
//
// Styling reuses the existing Connections charte ("glass Celestial Veil"):
// `.conn-card`, `.conn-field`, `.input`, `.conn-actions`, `.lgb`/`.lgb-sm`/
// `.lgb-primary`, plus the same inline-style pill idiom used by the llama-server
// controls for the transport badge. No new design system is introduced.

import { useState } from "react";
import { Icon } from "@/components/components";
import {
  useMcpServers,
  useMcpToggle,
  useMcpTest,
  useMcpAdd,
  useMcpRemove,
  type McpServerStatus,
  type McpToolInfo,
  type McpServerConfig,
} from "./queries";

// Per-row outcome of a "Tester" probe: either the discovered tools or an error
// string. Kept in local state keyed by server name because a single
// `useMcpTest()` mutation instance can only hold ONE result at a time — so we
// stash each row's outcome here as the user tests servers independently.
type TestResult = { tools: McpToolInfo[] } | { error: string };

// Pré-remplissage du formulaire « Ajouter un serveur ». Tous les presets du
// catalogue sont en `npx` (Node, présent sur la machine — pas de dépendance
// Python/uv), pour qu'un clic « just works ».
type Preset = {
  id: string;
  name: string;
  label: string;
  desc: string;
  command: string;
  args: string;
  env?: string; // lignes KEY=VALUE à compléter par l'utilisateur
  envNote?: string;
};

// Catalogue restreint de serveurs MCP utiles et fiables. L'objectif est qu'un
// utilisateur non-technique branche un outil externe sans connaître la commande.
const RECOMMENDED: Preset[] = [
  {
    id: "filesystem",
    name: "filesystem",
    label: "Fichiers",
    desc: "Lire et parcourir des fichiers d'un dossier (au-delà du workspace).",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem .",
  },
  {
    id: "memory",
    name: "memory",
    label: "Mémoire",
    desc: "Mémoire persistante (graphe de connaissances) entre les sessions.",
    command: "npx",
    args: "-y @modelcontextprotocol/server-memory",
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    label: "Raisonnement",
    desc: "Outil de réflexion structurée étape par étape pour les tâches complexes.",
    command: "npx",
    args: "-y @modelcontextprotocol/server-sequential-thinking",
  },
  {
    id: "context7",
    name: "context7",
    label: "Docs de libs",
    desc: "Documentation à jour de n'importe quelle librairie/framework (Context7).",
    command: "npx",
    args: "-y @upstash/context7-mcp",
  },
  {
    id: "playwright",
    name: "playwright",
    label: "Navigateur",
    desc: "Pilote un vrai navigateur : naviguer, cliquer, remplir, capturer (Playwright).",
    command: "npx",
    args: "-y @playwright/mcp@latest",
  },
  {
    id: "github",
    name: "github",
    label: "GitHub",
    desc: "Repos, pull requests, issues. Nécessite un jeton GitHub.",
    command: "npx",
    args: "-y @modelcontextprotocol/server-github",
    env: "GITHUB_PERSONAL_ACCESS_TOKEN=",
    envNote: "Colle ton jeton GitHub (Settings → Developer settings → Personal access tokens) après le =.",
  },
];

export function McpServersSection() {
  const { data: servers, isLoading, error } = useMcpServers();
  const toggle = useMcpToggle();
  const test = useMcpTest();
  const remove = useMcpRemove();

  const [adding, setAdding] = useState(false);
  // Pré-remplissage du formulaire depuis le catalogue 1-clic (null = vierge).
  const [preset, setPreset] = useState<Preset | null>(null);
  // Which server is currently being probed (drives the "Test…" button label).
  const [testingName, setTestingName] = useState<string | null>(null);
  // Per-server probe results (tools or error).
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const onTest = async (name: string) => {
    setTestingName(name);
    try {
      const tools = await test.mutateAsync(name);
      setTestResults((r) => ({ ...r, [name]: { tools } }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [name]: { error: String(err) } }));
    } finally {
      setTestingName(null);
    }
  };

  const onToggle = async (s: McpServerStatus, enabled: boolean) => {
    try {
      await toggle.mutateAsync({ name: s.name, enabled });
    } catch (err) {
      // Re-fetch will snap the switch back to truth; surface the failure too.
      console.warn("[mcp] toggle failed", err);
    }
  };

  const onRemove = async (name: string) => {
    // Simple confirmation (no modal) — matches the rest of the destructive
    // actions in Settings and the task spec ("confirmation simple").
    if (!window.confirm(`Supprimer le serveur MCP « ${name} » de .mcp.json ?`)) return;
    try {
      await remove.mutateAsync(name);
      setTestResults((r) => {
        const next = { ...r };
        delete next[name];
        return next;
      });
    } catch (err) {
      console.warn("[mcp] remove failed", err);
    }
  };

  return (
    <div className="setting-section" style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
      <h3 style={{ marginBottom: 4 }}>Serveurs MCP</h3>
      <p className="sub">
        Les serveurs MCP donnent à l'IA de nouveaux outils — chercher dans
        Notion, lire Figma, interroger une base, parcourir des fichiers, etc.
        Chaque serveur est défini dans un fichier <code>.mcp.json</code> (à la
        racine du projet, ou dans ton dossier personnel pour le global). Active
        un serveur pour que ses outils soient proposés au chat et aux agents.
      </p>

      <div className="conn-actions" style={{ marginTop: 12 }}>
        <button
          className="lgb lgb-sm lgb-primary"
          onClick={() => { setPreset(null); setAdding((v) => !v); }}
        >
          <Icon name={adding ? "x" : "plus"} size={12} />
          {adding ? " Annuler" : " Ajouter un serveur"}
        </button>
      </div>

      {/* Catalogue 1-clic — pré-remplit le formulaire avec un serveur connu, pour
          que l'utilisateur n'ait pas à connaître la commande exacte. Masqué
          pendant l'édition pour ne pas encombrer. */}
      {!adding && (
        <div style={{ marginTop: 14 }}>
          <div className="sub" style={{ marginBottom: 8 }}>
            Ajout rapide — clique un outil pour pré-remplir le formulaire :
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {RECOMMENDED.map((p) => (
              <button
                key={p.id}
                className="lgb lgb-sm"
                title={p.desc}
                onClick={() => { setPreset(p); setAdding(true); }}
              >
                <Icon name="plus" size={11} /> {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <AddServerForm
          key={preset?.id ?? "blank"}
          preset={preset}
          onClose={() => { setAdding(false); setPreset(null); }}
          onAdded={() => { setAdding(false); setPreset(null); }}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
        {isLoading && (
          <div style={{ fontSize: 12, color: "var(--on-surface-muted)" }}>Chargement des serveurs MCP…</div>
        )}

        {error && (
          <div style={{
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(255, 107, 107, 0.08)",
            border: "1px solid rgba(255, 107, 107, 0.25)",
            fontSize: 11,
            color: "var(--error, #ff6b6b)",
            lineHeight: 1.4,
          }}>
            ⚠ Impossible de lister les serveurs MCP&nbsp;: <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 4px", borderRadius: 3 }}>{String(error)}</code>
          </div>
        )}

        {!isLoading && !error && servers && servers.length === 0 && (
          // Pedagogical empty state ("UI auto-explicative"): explain what MCP is
          // and where the config lives, instead of an empty void.
          <div style={{
            padding: "16px 18px",
            borderRadius: 8,
            background: "rgba(124, 58, 237, 0.06)",
            border: "1px dashed rgba(124, 58, 237, 0.28)",
            fontSize: 12,
            color: "var(--on-surface-muted)",
            lineHeight: 1.6,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--on-surface)", marginBottom: 6 }}>
              Aucun serveur MCP pour l'instant
            </div>
            Un <b>serveur MCP</b> (Model Context Protocol) branche une source
            d'outils externe sur l'IA — par exemple chercher dans Notion, lire un
            fichier Figma, ou parcourir un dossier. Une fois ajouté et activé,
            ses outils apparaissent automatiquement dans le chat et chez les
            agents.
            <br />
            Clique <b>« Ajouter un serveur »</b> ci-dessus, ou édite le fichier{" "}
            <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 5px", borderRadius: 3 }}>.mcp.json</code>{" "}
            à la racine de ton projet.
          </div>
        )}

        {!isLoading && servers && servers.map((s) => (
          <McpServerCard
            key={s.name}
            server={s}
            busy={toggle.isPending || remove.isPending}
            testing={testingName === s.name}
            result={testResults[s.name]}
            onToggle={(enabled) => void onToggle(s, enabled)}
            onTest={() => void onTest(s.name)}
            onRemove={() => void onRemove(s.name)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── A single MCP server card ────────────────────────────────────────────────

function McpServerCard({
  server,
  busy,
  testing,
  result,
  onToggle,
  onTest,
  onRemove,
}: {
  server: McpServerStatus;
  busy: boolean;
  testing: boolean;
  result: TestResult | undefined;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={"conn-card " + (server.connected ? "connected" : "")}>
      <div className="conn-head">
        <div className="conn-info">
          <div className="conn-name" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {server.name}
            <TransportBadge transport={server.transport} />
          </div>
          <div className="conn-meta">
            {server.connected
              ? `${server.toolCount} outil${server.toolCount > 1 ? "s" : ""} découvert${server.toolCount > 1 ? "s" : ""}`
              : server.enabled
                ? "activé — pas encore connecté"
                : "désactivé"}
          </div>
        </div>
        {/* Enable toggle — same native checkbox idiom as the Codex card. */}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--on-surface)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          Activé
        </label>
      </div>

      {server.error && (
        <div style={{
          margin: "6px 0",
          padding: "8px 10px",
          borderRadius: 6,
          background: "rgba(255, 107, 107, 0.08)",
          border: "1px solid rgba(255, 107, 107, 0.25)",
          fontSize: 11,
          color: "var(--error, #ff6b6b)",
          lineHeight: 1.4,
        }}>
          ⚠ {server.error}
        </div>
      )}

      {/* Probe result: discovered tools, or an error. */}
      {result && "tools" in result && (
        <div style={{
          margin: "6px 0",
          padding: "8px 10px",
          borderRadius: 6,
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(255,255,255,0.06)",
          fontSize: 11,
          color: "var(--on-surface-muted)",
          lineHeight: 1.5,
        }}>
          {result.tools.length === 0 ? (
            "Connecté — ce serveur n'expose aucun outil."
          ) : (
            <>
              <div style={{ fontWeight: 600, color: "var(--on-surface)", marginBottom: 4 }}>
                {result.tools.length} outil{result.tools.length > 1 ? "s" : ""} découvert{result.tools.length > 1 ? "s" : ""}&nbsp;:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {result.tools.map((t) => (
                  <div key={t.name}>
                    <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 5px", borderRadius: 3, color: "var(--on-surface)" }}>{t.name}</code>
                    {t.description && (
                      <span style={{ marginLeft: 6, opacity: 0.8 }}>{t.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {result && "error" in result && (
        <div style={{
          margin: "6px 0",
          padding: "8px 10px",
          borderRadius: 6,
          background: "rgba(255, 107, 107, 0.08)",
          border: "1px solid rgba(255, 107, 107, 0.25)",
          fontSize: 11,
          color: "var(--error, #ff6b6b)",
          lineHeight: 1.4,
        }}>
          ⚠ Échec du test&nbsp;: <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 4px", borderRadius: 3 }}>{result.error}</code>
        </div>
      )}

      <div className="conn-actions">
        <button className="lgb lgb-sm" onClick={onTest} disabled={testing}>
          <Icon name="thumbs" size={11} /> {testing ? "Test…" : "Tester"}
        </button>
        <span style={{ flex: 1 }} />
        <button className="lgb lgb-sm" onClick={onRemove} disabled={busy} title="Supprimer ce serveur de .mcp.json">
          <Icon name="trash" size={11} /> Supprimer
        </button>
      </div>
    </div>
  );
}

// ─── Transport badge (stdio / http) — llama-pill idiom ───────────────────────

function TransportBadge({ transport }: { transport: string }) {
  const isHttp = transport === "http";
  const isStdio = transport === "stdio";
  const ok = isHttp || isStdio;
  return (
    <span
      title={
        isStdio
          ? "Serveur local lancé en sous-process (stdio)"
          : isHttp
            ? "Serveur distant via HTTP/SSE"
            : "Configuration invalide (ni command ni url)"
      }
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 99,
        background: ok ? "rgba(124, 58, 237, 0.18)" : "rgba(255, 107, 107, 0.18)",
        color: ok ? "var(--primary, #7c3aed)" : "var(--error, #ff6b6b)",
      }}
    >
      {transport}
    </span>
  );
}

// ─── Add-server inline form ──────────────────────────────────────────────────

function AddServerForm({ preset, onClose, onAdded }: { preset?: Preset | null; onClose: () => void; onAdded: () => void }) {
  const add = useMcpAdd();
  // Initialise depuis le preset du catalogue (tous en stdio). Le composant est
  // `key`-é par preset.id côté parent → remonté à chaque choix, donc ces valeurs
  // initiales reflètent bien le prest sélectionné.
  const [name, setName] = useState(preset?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  // stdio fields
  const [command, setCommand] = useState(preset?.command ?? "");
  const [argsLine, setArgsLine] = useState(preset?.args ?? "");
  // env entered as "KEY=VALUE" lines (one per line). Written in clear text into
  // .mcp.json in v1 — surfaced with a visible warning below (keychain later).
  const [envLines, setEnvLines] = useState(preset?.env ?? "");
  // http fields
  const [url, setUrl] = useState("");
  // scope
  const [scope, setScope] = useState<"project" | "global">("project");
  const [error, setError] = useState<string | null>(null);

  const hasEnv = envLines.trim().length > 0;

  const ok = kind === "stdio" ? name.trim() !== "" && command.trim() !== "" : name.trim() !== "" && url.trim() !== "";

  const buildConfig = (): McpServerConfig => {
    if (kind === "stdio") {
      const args = argsLine.trim() ? argsLine.trim().split(/\s+/).filter(Boolean) : [];
      const env: Record<string, string> = {};
      for (const line of envLines.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue; // skip malformed lines (no key)
        env[t.slice(0, eq).trim()] = t.slice(eq + 1);
      }
      return { command: command.trim(), args, env };
    }
    return { url: url.trim() };
  };

  const submit = async () => {
    if (!ok) return;
    setError(null);
    try {
      await add.mutateAsync({ name: name.trim(), config: buildConfig(), global: scope === "global" });
      onAdded();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div style={{
      margin: "12px 0",
      padding: 14,
      borderRadius: 8,
      background: "rgba(124, 58, 237, 0.06)",
      border: "1px solid rgba(124, 58, 237, 0.22)",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      <div className="conn-field">
        <label>Nom du serveur</label>
        <div className="input">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. notion, filesystem, figma…" spellCheck={false} autoFocus />
        </div>
      </div>

      <div className="conn-field">
        <label>Type de transport</label>
        <div style={{ display: "flex", gap: 6 }}>
          {([
            { v: "stdio", l: "stdio (local)" },
            { v: "http", l: "http (distant)" },
          ] as const).map((k) => (
            <button
              key={k.v}
              className={"conn-tab-btn" + (kind === k.v ? " on" : "")}
              onClick={() => setKind(k.v)}
            >
              {k.l}
            </button>
          ))}
        </div>
      </div>

      {kind === "stdio" ? (
        <>
          <div className="conn-field">
            <label>Commande</label>
            <div className="input">
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="ex. npx, uvx, node" spellCheck={false} />
            </div>
          </div>
          <div className="conn-field">
            <label>Arguments (séparés par des espaces)</label>
            <div className="input">
              <input value={argsLine} onChange={(e) => setArgsLine(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." spellCheck={false} />
            </div>
          </div>
          <div className="conn-field">
            <label>Variables d'environnement (optionnel — une par ligne, KEY=VALUE)</label>
            <div className="input" style={{ alignItems: "stretch" }}>
              <textarea
                value={envLines}
                onChange={(e) => setEnvLines(e.target.value)}
                placeholder={"NOTION_TOKEN=secret_xxx\nAPI_BASE=https://…"}
                spellCheck={false}
                rows={3}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: "inherit",
                  resize: "vertical",
                }}
              />
            </div>
          </div>
          {preset?.envNote && (
            <div style={{
              padding: "6px 10px",
              borderRadius: 6,
              background: "rgba(124, 58, 237, 0.10)",
              border: "1px solid rgba(124, 58, 237, 0.30)",
              fontSize: 11,
              color: "var(--on-surface)",
              lineHeight: 1.4,
            }}>
              💡 {preset.envNote}
            </div>
          )}
          {hasEnv && (
            <div style={{
              padding: "6px 10px",
              borderRadius: 6,
              background: "rgba(255, 180, 60, 0.10)",
              border: "1px solid rgba(255, 180, 60, 0.30)",
              fontSize: 11,
              color: "var(--on-surface)",
              lineHeight: 1.4,
            }}>
              ⚠ Les valeurs sont écrites <b>en clair</b> dans <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 4px", borderRadius: 3 }}>.mcp.json</code>. Le stockage chiffré (keychain) viendra plus tard.
            </div>
          )}
        </>
      ) : (
        <div className="conn-field">
          <label>URL du serveur</label>
          <div className="input">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} />
          </div>
        </div>
      )}

      <div className="conn-field">
        <label>Portée</label>
        <div style={{ display: "flex", gap: 6 }}>
          {([
            { v: "project", l: "Projet (.mcp.json à la racine)" },
            { v: "global", l: "Global (~/.mcp.json)" },
          ] as const).map((sc) => (
            <button
              key={sc.v}
              className={"conn-tab-btn" + (scope === sc.v ? " on" : "")}
              onClick={() => setScope(sc.v)}
            >
              {sc.l}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{
          padding: "6px 10px",
          borderRadius: 6,
          background: "rgba(255, 107, 107, 0.08)",
          border: "1px solid rgba(255, 107, 107, 0.25)",
          fontSize: 11,
          color: "var(--error, #ff6b6b)",
        }}>
          ⚠ {error}
        </div>
      )}

      <div className="conn-actions">
        <button className="lgb lgb-sm" onClick={onClose}>Annuler</button>
        <span style={{ flex: 1 }} />
        <button
          className="lgb lgb-sm lgb-primary"
          onClick={() => void submit()}
          disabled={!ok || add.isPending}
          title={ok ? "Enregistrer le serveur dans .mcp.json" : "Renseigne au moins le nom et la commande (ou l'URL)"}
        >
          <Icon name="sparkle" size={11} /> {add.isPending ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}
