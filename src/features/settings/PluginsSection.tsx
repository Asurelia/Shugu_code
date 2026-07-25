// Shugu Forge — P6.7 — gestionnaire de plugins (Settings « Plugins »).
//
// Liste les plugins découverts (~/.shugu/plugins, <workspace>/.shugu/plugins,
// cache Claude Code en lecture seule) avec badge de source, version, toggle
// enable/disable (persisté en SQLite settings — jamais dans les fichiers) et
// le résumé des contributions (N commandes / N agents / N skills / N hooks /
// N MCP en attente). Un plugin désactivé = zéro contribution. Le détail est
// dépliable (chemins des fichiers de contribution).

import { useCallback, useEffect, useState } from "react";
import { pluginsList, pluginsSetEnabled, type PluginSummary } from "@/lib/plugins";
import { pluginContributionsSummary, pluginSourceLabel } from "./pluginsUtils";
import { pushToast } from "@/components/toast";

function PluginRow({
  plugin,
  onToggle,
  busy,
}: {
  plugin: PluginSummary;
  onToggle: (id: string, enabled: boolean) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
        borderRadius: 8,
        background: "var(--surface-container, #16162a)",
        border: "1px solid rgba(150,150,150,0.16)",
        opacity: plugin.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>{plugin.name}</strong>
        {plugin.version && (
          <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--on-surface-muted)" }}>
            v{plugin.version}
          </span>
        )}
        <span
          style={{
            fontSize: 10.5,
            padding: "1px 7px",
            borderRadius: 999,
            color: "var(--on-surface-muted)",
            border: "1px solid rgba(148,163,184,0.32)",
          }}
        >
          {pluginSourceLabel(plugin.source)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 6,
            cursor: "pointer",
            color: "var(--on-surface-muted)",
            background: "transparent",
            border: "1px solid rgba(150,150,150,0.3)",
          }}
        >
          {open ? "Masquer" : "Détail"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(plugin.id, !plugin.enabled)}
          style={{
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 6,
            cursor: "pointer",
            color: plugin.enabled ? "var(--on-surface-muted)" : "var(--success, #8aefc7)",
            background: "transparent",
            border: "1px solid rgba(150,150,150,0.3)",
          }}
        >
          {plugin.enabled ? "Désactiver" : "Activer"}
        </button>
      </div>
      {plugin.description && (
        <span style={{ fontSize: 11.5, color: "var(--on-surface-muted)" }}>{plugin.description}</span>
      )}
      <span style={{ fontSize: 11, color: "var(--on-surface-muted)" }}>
        {pluginContributionsSummary(plugin)}
      </span>
      {open && (
        <div
          style={{
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--on-surface-muted)",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            paddingTop: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span>id : {plugin.id}</span>
          {plugin.author && <span>auteur : {plugin.author}</span>}
          <span>
            contributions lues depuis le dossier du plugin (commands/*.md · agents/*.md ·
            skills/*/SKILL.md · hooks/hooks.json · .mcp.json)
          </span>
          {plugin.mcpPending > 0 && (
            <span>
              ⚠ {plugin.mcpPending} serveur(s) MCP en attente d'approbation — voir Settings → MCP.
            </span>
          )}
        </div>
      )}
    </li>
  );
}

export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPlugins(await pluginsList());
    } catch (err) {
      console.warn("[Plugins] list failed:", err);
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (id: string, enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await pluginsSetEnabled(id, enabled);
      await refresh();
      pushToast(enabled ? "Plugin activé." : "Plugin désactivé — zéro contribution.", "success", 3000);
    } catch (err) {
      pushToast(`Échec : ${String(err)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Plugins</h3>
          <p className="sub">
            Plugins par convention de répertoires (format compatible Claude Code) :
            <code>~/.shugu/plugins/&lt;nom&gt;/</code>,{" "}
            <code>&lt;workspace&gt;/.shugu/plugins/&lt;nom&gt;/</code>, et le cache Claude Code{" "}
            <code>~/.claude/plugins/cache/</code> (importé en <strong>lecture seule</strong> —
            Shugu n'y écrit jamais). Chaque plugin peut contribuer des slash commands, des
            agents, des skills (SKILL.md), des hooks et des serveurs MCP (ces derniers exigent
            une approbation explicite — voir Settings → MCP). La désactivation est persistée
            ici, sans toucher aux fichiers du plugin.
          </p>

          {loading ? (
            <p className="sub">Chargement…</p>
          ) : plugins.length === 0 ? (
            <p className="sub">
              Aucun plugin découvert. Crée un dossier <code>.shugu/plugins/mon-plugin/</code> avec
              un <code>plugin.json</code> et des contributions conventionnelles
              (<code>commands/</code>, <code>agents/</code>, <code>skills/</code>,{" "}
              <code>hooks/</code>, <code>.mcp.json</code>).
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: "10px 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {plugins.map((p) => (
                <PluginRow key={p.id} plugin={p} onToggle={(id, e) => void toggle(id, e)} busy={busy} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
