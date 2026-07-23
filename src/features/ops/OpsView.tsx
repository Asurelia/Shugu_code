// src/features/ops/OpsView.tsx — Lane OPÉRABILITÉ : Storage + Backup + Diagnostics.
//
// Une seule section Settings (« ops ») qui regroupe trois centres opérables,
// chacun adossé à des commandes Rust nouvelles (module backup/storage/
// diagnostics). Le style réutilise la charte existante (« glass Celestial
// Veil ») : `settings-shell`, `setting-section`, `lgb`/`lgb-sm`/`lgb-primary`,
// `chip` + variantes. Aucun design system nouveau, aucun style global ajouté.

import { useState } from "react";
import { Icon } from "@/components/components";
import { ConfirmDialog } from "@/components/trust";
import { formatBytes } from "@/lib/modelBundle";
import {
  useStorageBreakdown,
  useIntegrityCheck,
  useExportData,
  useImportData,
  useBackupNow,
  useDiagBundle,
  useStorageCleanup,
  useDbSize,
  invalidateStorage,
  type StorageItem,
  type ExportResult,
  type ImportResult,
  type DiagBundle,
} from "./queries";

// ─── Zones nettoyables ────────────────────────────────────────────────────────
//
// Miroir de l'allowlist Rust (`shugu_storage_cleanup`). `confirm: true` = zone
// « créations utilisateur » : le bouton passe par un ConfirmDialog explicite —
// on ne supprime JAMAIS une création sans confirmation (politique projet).
const CLEANABLE_ZONES: Record<string, { confirm: boolean; what: string }> = {
  captures: { confirm: false, what: "les captures d'écran techniques des agents" },
  browserTests: { confirm: false, what: "les artefacts de tests navigateur" },
  logs: { confirm: false, what: "les journaux de Shugu" },
  backups: {
    confirm: false,
    what: "les anciennes sauvegardes automatiques (la plus récente est conservée)",
  },
  videoAssets: { confirm: true, what: "TOUTES les vidéos que tu as générées" },
  musicAssets: { confirm: true, what: "TOUTES les musiques que tu as générées" },
  imageAssets: { confirm: true, what: "TOUTES les images que tu as générées" },
  snippets: { confirm: true, what: "tous les snippets de code sauvegardés" },
};

// ─── Barre proportionnelle pour un poste de stockage ─────────────────────────

function StorageBar({
  item,
  total,
  cleaning,
  onClean,
  alert,
}: {
  item: StorageItem;
  total: number;
  cleaning: boolean;
  onClean?: (item: StorageItem) => void;
  alert?: boolean;
}) {
  const pct = total > 0 && item.present ? Math.max(2, Math.round((item.bytes / total) * 100)) : 0;
  const cleanable = onClean && item.present && item.bytes > 0 && CLEANABLE_ZONES[item.key];
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {item.label}
          {alert && (
            <span className="chip warn" style={{ marginLeft: 8, fontSize: 10.5 }}>
              inhabituellement grosse
            </span>
          )}
        </span>
        <span className="sub" style={{ fontSize: 12, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {item.present ? formatBytes(item.bytes) : "absent"}
          {item.present && total > 0 ? ` · ${pct}%` : ""}
          {cleanable && (
            <button
              className="lgb lgb-sm"
              disabled={cleaning}
              onClick={() => onClean(item)}
              title={`Supprimer ${CLEANABLE_ZONES[item.key].what}`}
            >
              {cleaning ? "…" : "Nettoyer"}
            </button>
          )}
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "rgba(255,255,255,0.06)",
          marginTop: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${item.present ? pct : 0}%`,
            background: item.present
              ? "linear-gradient(90deg, var(--primary), rgba(150,180,255,0.7))"
              : "transparent",
            transition: "width 200ms ease",
          }}
        />
      </div>
      <div className="sub" style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>
        {item.hint}
      </div>
      {item.present && (
        <div className="sub" style={{ fontSize: 10.5, marginTop: 2, fontFamily: "var(--mono, monospace)", opacity: 0.5, wordBreak: "break-all" }}>
          {item.path}
        </div>
      )}
    </div>
  );
}

// ─── Storage Center ──────────────────────────────────────────────────────────

function StorageCenter() {
  const { data, isLoading, error, refetch, isFetching } = useStorageBreakdown();
  const cleanup = useStorageCleanup();
  const dbSize = useDbSize();

  // Zone en attente de confirmation (créations utilisateur uniquement).
  const [confirmItem, setConfirmItem] = useState<StorageItem | null>(null);
  const [cleanMsg, setCleanMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const doClean = async (item: StorageItem) => {
    setCleanMsg(null);
    try {
      const res = await cleanup.mutateAsync({ zone: item.key });
      setCleanMsg({
        kind: "ok",
        text: `${item.label} : ${formatBytes(res.freedBytes)} libérés (${res.deletedCount} élément(s)).`,
      });
    } catch (e) {
      setCleanMsg({
        kind: "err",
        text: `Nettoyage « ${item.label} » impossible : ${String((e as Error)?.message ?? e)}`,
      });
    }
  };

  const onClean = (item: StorageItem) => {
    if (CLEANABLE_ZONES[item.key]?.confirm) {
      setConfirmItem(item);
    } else {
      void doClean(item);
    }
  };

  // Garde-fou anti-Codex : la base au-delà du seuil Rust (300 Mo) = chip
  // d'alerte sur le poste « Base + index vectoriel ».
  const dbAlert =
    !!dbSize.data && dbSize.data.bytes > dbSize.data.alertThresholdBytes;

  return (
    <div className="setting-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ marginBottom: 4 }}>Stockage</h3>
        <button
          className="lgb lgb-sm"
          disabled={isFetching}
          onClick={() => { invalidateStorage(); void refetch(); }}
        >
          <Icon name="revert" size={12} /> {isFetching ? " Mesure…" : " Recalculer"}
        </button>
      </div>
      <p className="sub">
        D'où vient l'espace consommé par Shugu, avec un bouton « Nettoyer » là où
        c'est sans risque. Tes créations (vidéos, musiques, images, snippets) ne
        sont jamais supprimées sans confirmation.
      </p>

      {isLoading && <p className="sub" style={{ marginTop: 12 }}>Calcul des tailles…</p>}
      {error && (
        <p className="sub" style={{ marginTop: 12, color: "var(--danger)" }}>
          Erreur : {String((error as Error)?.message ?? error)}
        </p>
      )}

      {data && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <span className="chip primary">Total mesuré · {formatBytes(data.totalBytes)}</span>
            {dbAlert && dbSize.data && (
              <span className="chip warn">
                La base devient très grosse ({formatBytes(dbSize.data.bytes)}) — regarde le poste « Base + index vectoriel »
              </span>
            )}
            {!data.hasWorkspace && (
              <span className="chip warn">Aucun workspace ouvert — postes workspace masqués</span>
            )}
          </div>
          {data.items.map((it) => (
            <StorageBar
              key={it.key}
              item={it}
              total={data.totalBytes}
              cleaning={cleanup.isPending}
              onClean={onClean}
              alert={it.key === "vector" && dbAlert}
            />
          ))}
          {cleanMsg && (
            <p
              className="sub"
              style={{
                marginTop: 4,
                color: cleanMsg.kind === "ok" ? "var(--success, #7ee29a)" : "var(--danger)",
              }}
            >
              {cleanMsg.text}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmItem !== null}
        title={confirmItem ? `Supprimer ${confirmItem.label.toLowerCase()} ?` : ""}
        body={
          confirmItem ? (
            <>
              Cette action supprime <b>définitivement</b>{" "}
              {CLEANABLE_ZONES[confirmItem.key]?.what} ({formatBytes(confirmItem.bytes)}).
              Il n'y a pas de corbeille : ce qui est supprimé est perdu.
            </>
          ) : null
        }
        confirmLabel="Supprimer définitivement"
        tone="danger"
        onCancel={() => setConfirmItem(null)}
        onConfirm={() => {
          const item = confirmItem;
          setConfirmItem(null);
          if (item) void doClean(item);
        }}
      />
    </div>
  );
}

// ─── Backup / Restore ────────────────────────────────────────────────────────

function BackupCenter() {
  const integrity = useIntegrityCheck();
  const exportData = useExportData();
  const importData = useImportData();
  const backupNow = useBackupNow();

  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const onExport = async () => {
    setMsg(null);
    try {
      const res = await exportData.mutateAsync();
      if (res) {
        setLastExport(res);
        setMsg({ kind: "ok", text: `Sauvegarde créée : ${res.bundleDir}` });
      }
    } catch (e) {
      setMsg({ kind: "err", text: `Échec de l'export : ${String((e as Error)?.message ?? e)}` });
    }
  };

  const onBackupNow = async () => {
    setMsg(null);
    try {
      const res = await backupNow.mutateAsync();
      setLastExport(res);
      setMsg({ kind: "ok", text: `Sauvegarde interne créée : ${res.bundleDir}` });
    } catch (e) {
      setMsg({ kind: "err", text: `Échec : ${String((e as Error)?.message ?? e)}` });
    }
  };

  // Confirmation via ConfirmDialog (trust) — window.confirm remplacé.
  const [confirmImport, setConfirmImport] = useState(false);
  const onImport = async () => {
    setConfirmImport(false);
    setMsg(null);
    try {
      const res = await importData.mutateAsync();
      if (res) {
        setLastImport(res);
        setMsg({
          kind: "ok",
          text: `Restauration préparée depuis ${res.bundleDir}. Copie de sécurité : ${res.safetyBackup}. La base sera remplacée avant l'ouverture de SQLite au prochain démarrage.`,
        });
      }
    } catch (e) {
      setMsg({ kind: "err", text: `Échec de la restauration : ${String((e as Error)?.message ?? e)}` });
    }
  };

  const integ = integrity.data;

  return (
    <div
      className="setting-section"
      style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid rgba(255,255,255,0.06)" }}
    >
      <h3 style={{ marginBottom: 4 }}>Sauvegarde &amp; restauration</h3>
      <p className="sub">
        Exporte une copie atomique de ta base (conversations, agents, projets,
        préférences) vers un dossier. Les secrets restent dans le keychain OS :
        ils ne sont jamais écrits dans une sauvegarde.
      </p>

      {/* Intégrité */}
      <div className="setting-row" style={{ marginTop: 12 }}>
        <div className="info">
          <div className="label">Intégrité de la base</div>
          <div className="desc">
            {integrity.isLoading
              ? "Vérification…"
              : integ
                ? integ.ok
                  ? `Saine · ${formatBytes(integ.dbBytes)}`
                  : `Problèmes détectés : ${[...integ.messages, ...integ.foreignKeyViolations].slice(0, 3).join("; ")}`
                : integrity.error
                  ? `Erreur : ${String((integrity.error as Error)?.message ?? integrity.error)}`
                  : "—"}
          </div>
        </div>
        {integ && <span className={"chip " + (integ.ok ? "success" : "warn")}>{integ.ok ? "ok" : "à vérifier"}</span>}
        <button className="lgb lgb-sm" disabled={integrity.isFetching} onClick={() => void integrity.refetch()}>
          {integrity.isFetching ? "…" : "Re-vérifier"}
        </button>
      </div>

      {/* Actions */}
      <div className="conn-actions" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="lgb lgb-sm lgb-primary" disabled={exportData.isPending} onClick={() => void onExport()}>
          <Icon name="download" size={12} /> {exportData.isPending ? " Export…" : " Exporter vers un dossier…"}
        </button>
        <button className="lgb lgb-sm" disabled={backupNow.isPending} onClick={() => void onBackupNow()}>
          <Icon name="copy" size={12} /> {backupNow.isPending ? " …" : " Sauvegarde interne"}
        </button>
        <button
          className="lgb lgb-sm"
          style={{ color: "var(--warn, #f5c451)", borderColor: "rgba(245,196,81,0.4)" }}
          disabled={importData.isPending}
          onClick={() => setConfirmImport(true)}
        >
          <Icon name="revert" size={12} /> {importData.isPending ? " Restauration…" : " Restaurer une sauvegarde…"}
        </button>
      </div>

      <ConfirmDialog
        open={confirmImport}
        title="Restaurer une sauvegarde ?"
        body={<>La base actuelle sera <b>remplacée</b> (une copie de sécurité est prise automatiquement). Un redémarrage de l'application sera nécessaire.</>}
        confirmLabel="Restaurer"
        tone="danger"
        onCancel={() => setConfirmImport(false)}
        onConfirm={() => void onImport()}
      />

      {msg && (
        <p
          className="sub"
          style={{ marginTop: 12, color: msg.kind === "ok" ? "var(--success, #7ee29a)" : "var(--danger)", wordBreak: "break-all" }}
        >
          {msg.text}
        </p>
      )}

      {lastExport && (
        <div className="sub" style={{ marginTop: 8, fontSize: 11.5, opacity: 0.8 }}>
          Dernier export : {lastExport.manifest.tableCount} tables · schéma v
          {lastExport.manifest.schemaVersion ?? "?"} · integrity{" "}
          {lastExport.manifest.integrityOk ? "ok" : "ko"} · {formatBytes(lastExport.manifest.dbBytes)}
        </div>
      )}
      {lastImport?.restartRequired && (
        <div className="chip warn" style={{ marginTop: 8 }}>
          Restauration validée et préparée · redémarrage requis pour l'appliquer
        </div>
      )}
    </div>
  );
}

// ─── Diagnostics Center ──────────────────────────────────────────────────────

function DiagnosticsCenter() {
  const diag = useDiagBundle();
  const [bundle, setBundle] = useState<DiagBundle | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onGenerate = async () => {
    setErr(null);
    setCopied(false);
    try {
      const b = await diag.mutateAsync();
      setBundle(b);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  const onCopy = async () => {
    if (!bundle) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(bundle.text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* clipboard refusé — l'utilisateur peut copier depuis la zone de texte */
    }
  };

  return (
    <div
      className="setting-section"
      style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid rgba(255,255,255,0.06)" }}
    >
      <h3 style={{ marginBottom: 4 }}>Diagnostics</h3>
      <p className="sub">
        Agrège l'état des sous-systèmes (providers, MCP, llama, agents…) avec
        l'état de la base, en <strong>masquant les secrets</strong>. Le bundle
        est sûr à coller dans un ticket ou un chat de support.
      </p>

      <div className="conn-actions" style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="lgb lgb-sm lgb-primary" disabled={diag.isPending} onClick={() => void onGenerate()}>
          <Icon name="gear" size={12} /> {diag.isPending ? " Génération…" : " Générer le bundle"}
        </button>
        {bundle && (
          <button className="lgb lgb-sm" onClick={() => void onCopy()}>
            <Icon name="copy" size={12} /> {copied ? " Copié ✓" : " Copier"}
          </button>
        )}
      </div>

      {err && (
        <p className="sub" style={{ marginTop: 12, color: "var(--danger)" }}>
          Erreur : {err}
        </p>
      )}

      {bundle && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {bundle.facts.map((f) => (
              <span key={f.label} className="chip">
                {f.label} · {f.value}
              </span>
            ))}
            <span className="chip success">{bundle.redactedCount} secret(s) masqué(s)</span>
          </div>
          <textarea
            readOnly
            value={bundle.text}
            spellCheck={false}
            style={{
              marginTop: 12,
              width: "100%",
              minHeight: 220,
              resize: "vertical",
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              color: "var(--text, #e8ecf5)",
              fontFamily: "var(--mono, monospace)",
              fontSize: 11.5,
              lineHeight: 1.5,
              padding: 12,
              boxSizing: "border-box",
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      )}
    </div>
  );
}

// ─── Vue racine de la section « ops » ────────────────────────────────────────

export function OpsView() {
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <StorageCenter />
        <BackupCenter />
        <DiagnosticsCenter />
      </div>
    </div>
  );
}

export default OpsView;
