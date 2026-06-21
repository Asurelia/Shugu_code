// src/features/ops/queries.ts — hooks TanStack pour la lane OPÉRABILITÉ.
//
// Couvre trois centres opérables, tous adossés à des commandes Rust NOUVELLES
// (module `commands::backup`, `commands::storage`, `commands::diagnostics`) :
//   - Backup / Restore + intégrité de la base.
//   - Storage Center (ventilation des tailles sur disque).
//   - Diagnostics Center (bundle redacté agrégeant l'état des sous-systèmes).
//
// Toutes les formes reflètent la sérialisation serde camelCase du backend.

import { useQuery, useMutation } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";

// ─── Backup / Restore ────────────────────────────────────────────────────────

export interface BackupManifest {
  format: string;
  bundleVersion: number;
  appVersion: string;
  createdAt: number;
  dbBytes: number;
  schemaVersion: number | null;
  tableCount: number;
  integrityOk: boolean;
}

export interface ExportResult {
  bundleDir: string;
  manifest: BackupManifest;
}

export interface ImportResult {
  bundleDir: string;
  manifest: BackupManifest;
  safetyBackup: string;
  restartRequired: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  messages: string[];
  foreignKeyViolations: string[];
  dbBytes: number;
  dbPath: string;
}

const INTEGRITY_KEY = ["ops", "integrity"] as const;

/** Vérifie l'intégrité de la base vivante (lecture seule). */
export function useIntegrityCheck() {
  return useQuery<IntegrityReport>({
    queryKey: INTEGRITY_KEY,
    queryFn: () => invoke<IntegrityReport>("shugu_db_integrity_check"),
    staleTime: 30_000,
  });
}

/**
 * Exporte un bundle de backup. `destDir` optionnel : si absent, un sélecteur de
 * dossier natif s'ouvre côté Rust. Renvoie `null` si l'utilisateur annule.
 */
export function useExportData() {
  return useMutation<ExportResult | null, unknown, { destDir?: string } | void>({
    mutationFn: (p) =>
      invoke<ExportResult | null>("shugu_export_data", {
        destDir: p && "destDir" in p ? p.destDir : undefined,
      }),
  });
}

/** Backup interne « maintenant » (sous backups/manual/), sans dialog. */
export function useBackupNow() {
  return useMutation<ExportResult, unknown, void>({
    mutationFn: () => invoke<ExportResult>("shugu_backup_now"),
  });
}

/**
 * Importe (restaure) un bundle. `bundleDir` optionnel : si absent, un sélecteur
 * de dossier s'ouvre. Renvoie `null` si annulé. Un redémarrage est requis.
 */
export function useImportData() {
  return useMutation<ImportResult | null, unknown, { bundleDir?: string } | void>({
    mutationFn: (p) =>
      invoke<ImportResult | null>("shugu_import_data", {
        bundleDir: p && "bundleDir" in p ? p.bundleDir : undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRITY_KEY });
    },
  });
}

// ─── Storage Center ──────────────────────────────────────────────────────────

export interface StorageItem {
  key: string;
  label: string;
  present: boolean;
  bytes: number;
  path: string;
  hint: string;
}

export interface StorageBreakdown {
  hasWorkspace: boolean;
  workspaceRoot: string | null;
  totalBytes: number;
  items: StorageItem[];
}

const STORAGE_KEY = ["ops", "storage"] as const;

export function useStorageBreakdown() {
  return useQuery<StorageBreakdown>({
    queryKey: STORAGE_KEY,
    queryFn: () => invoke<StorageBreakdown>("shugu_storage_breakdown"),
    staleTime: 15_000,
  });
}

export function invalidateStorage() {
  void queryClient.invalidateQueries({ queryKey: STORAGE_KEY });
}

// ─── Diagnostics Center ──────────────────────────────────────────────────────

export interface DiagFact {
  label: string;
  value: string;
}

export interface DiagBundle {
  text: string;
  facts: DiagFact[];
  settings: Record<string, string>;
  redactedCount: number;
  generatedAt: number;
}

/**
 * Agrège l'état des sous-systèmes connus par le front (read-only) en un JSON
 * brut, à passer au backend qui le REDACTE avant de le restituer. On capture
 * chaque appel indépendamment : un sous-système indisponible n'empêche pas le
 * bundle (sa section porte l'erreur au lieu de l'état).
 */
async function collectSubsystems(): Promise<string> {
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<unknown> => {
    try {
      return await fn();
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  };

  const [llama, llamaBackend, mcp, codex, agents] = await Promise.all([
    safe("llama", () => invoke("llama_status")),
    safe("llamaBackend", () => invoke("llama_backend_info")),
    safe("mcp", () => invoke("mcp_list_servers")),
    safe("codex", () => invoke("codex_auth_status")),
    safe("agents", () => invoke("agent_list_active")),
  ]);

  return JSON.stringify({
    llama,
    llamaBackend,
    mcpServers: mcp,
    codexAuth: codex,
    activeAgents: agents,
  });
}

/**
 * Génère le bundle diagnostic REDACTÉ. La collecte des sous-systèmes se fait
 * côté front (réutilise les commandes read-only existantes), mais la REDACTION
 * des secrets est faite côté Rust (`shugu_diag_bundle`) — source unique de
 * vérité pour ne jamais laisser fuir un secret.
 */
export function useDiagBundle() {
  return useMutation<DiagBundle, unknown, void>({
    mutationFn: async () => {
      const subsystemsJson = await collectSubsystems();
      return invoke<DiagBundle>("shugu_diag_bundle", { subsystemsJson });
    },
  });
}
