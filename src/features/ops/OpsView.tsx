// src/features/ops/OpsView.tsx — Lane OPÉRABILITÉ : Storage + Backup + Diagnostics.
//
// Une seule section Settings (« ops ») qui regroupe trois centres opérables,
// chacun adossé à des commandes Rust nouvelles (module backup/storage/
// diagnostics). Le style réutilise la charte existante (« glass Celestial
// Veil ») : `settings-shell`, `setting-section`, `lgb`/`lgb-sm`/`lgb-primary`,
// `chip` + variantes. Aucun design system nouveau, aucun style global ajouté.

import { useState } from "react";
import { Icon } from "@/components/components";
import { formatBytes } from "@/lib/modelBundle";
import { useConfirm } from "@/components/trust/useConfirm";
import {
  useStorageBreakdown,
  useIntegrityCheck,
  useExportData,
  useImportData,
  useBackupNow,
  useDiagBundle,
  invalidateStorage,
  type StorageItem,
  type ExportResult,
  type ImportResult,
  type DiagBundle,
} from "./queries";

// ─── Barre proportionnelle pour un poste de stockage ─────────────────────────

function StorageBar({ item, total }: { item: StorageItem; total: number }) {
  const pct = total > 0 && item.present ? Math.max(2, Math.round((item.bytes / total) * 100)) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{item.label}</span>
        <span className="sub" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {item.present ? formatBytes(item.bytes) : "absent"}
          {item.present && total > 0 ? ` · ${pct}%` : ""}
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
        D'où vient l'espace consommé par Shugu. Mesure best-effort ; les postes
        régénérables (build Rust, node_modules) sont sûrs à supprimer.
      </p>

      {isLoading && <p className="sub" style={{ marginTop: 12 }}>Calcul des tailles…</p>}
      {error && (
        <p className="sub" style={{ marginTop: 12, color: "var(--danger)" }}>
          Erreur : {String((error as Error)?.message ?? error)}
        </p>
      )}

      {data && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <span className="chip primary">Total mesuré · {formatBytes(data.totalBytes)}</span>
            {!data.hasWorkspace && (
              <span className="chip warn">Aucun workspace ouvert — postes workspace masqués</span>
            )}
          </div>
          {data.items.map((it) => (
            <StorageBar key={it.key} item={it} total={data.totalBytes} />
          ))}
        </div>
      )}
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
  const { confirm, dialog: confirmDialog } = useConfirm();

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

  const onImport = async () => {
    setMsg(null);
    const ok = await confirm({
      title: "Restaurer une sauvegarde",
      body: (
        <>
          La base actuelle sera <strong>remplacée</strong> par la sauvegarde
          choisie. Une copie de sécurité est prise automatiquement au préalable,
          et un redémarrage de l'application sera nécessaire.
        </>
      ),
      tone: "danger",
      confirmLabel: "Restaurer",
    });
    if (!ok) return;
    try {
      const res = await importData.mutateAsync();
      if (res) {
        setLastImport(res);
        setMsg({
          kind: "ok",
          text: `Restauré depuis ${res.bundleDir}. Copie de sécurité : ${res.safetyBackup}. Redémarre Shugu pour finaliser.`,
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
          onClick={() => void onImport()}
        >
          <Icon name="revert" size={12} /> {importData.isPending ? " Restauration…" : " Restaurer une sauvegarde…"}
        </button>
      </div>

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
          Redémarrage requis pour appliquer la restauration
        </div>
      )}
      {confirmDialog}
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
