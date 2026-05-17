// Local GGUF model bundle — frontend wrapper.
//
// Mirrors the Tauri commands in `src-tauri/src/commands/model_bundle.rs`.

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types — mirror Rust structs (serde camelCase)
// ---------------------------------------------------------------------------

export interface ModelBundleEntry {
  id: string;
  displayName: string;
  tagline: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  license: string;
  quant: string;
}

export interface ModelBundleStatus {
  id: string;
  installed: boolean;
  bytesOnDisk: number;
  sha256Actual: string | null;
  sha256Expected: string;
  /** null when expected hash is empty (first-run discovery) — render as "non vérifié". */
  sha256Matches: boolean | null;
}

/** Phases emitted on `bundle-download://progress`. */
export type BundlePhase = "downloading" | "verifying" | "done" | "error";

export interface BundleProgress {
  id: string;
  phase: BundlePhase;
  bytesDone: number;
  bytesTotal: number;
  sha256Actual: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

/** Returns the hardcoded catalog of downloadable models. */
export async function getCatalog(): Promise<ModelBundleEntry[]> {
  return invoke<ModelBundleEntry[]>("model_bundle_catalog");
}

/**
 * On-disk status of every catalog entry. Recomputes SHA256 for each
 * installed file (~3-5s for a 1 GB file on modern CPU) — call sparingly,
 * cache the result. The onboarding flow calls this exactly once at app
 * mount, then relies on `bundle-download://progress` events for live
 * updates during a download.
 */
export async function getStatus(): Promise<ModelBundleStatus[]> {
  return invoke<ModelBundleStatus[]>("model_bundle_status");
}

/**
 * Cheap "is the bundle on disk?" probe — returns the list of catalog ids
 * whose file exists. No hash, no file read; a stat per entry.
 *
 * Use this from any hot path (discovery, picker hydration, boot probes)
 * that only needs the boolean "installed?" answer. Calling `getStatus()`
 * for the same info forces a 3-5 second SHA256 of a 1+ GB file and was
 * the root cause of the "Not Responding" freeze on app boot and on every
 * connection save/disconnect.
 */
export async function getInstalledIds(): Promise<string[]> {
  return invoke<string[]>("model_bundle_installed_ids");
}

/**
 * Trigger a download. The returned promise resolves with the absolute path
 * of the downloaded file on success, or rejects with the human-readable
 * error reason on failure.
 *
 * The caller should ALSO subscribe to `bundle-download://progress` events
 * via `onProgress()` to render a live progress bar — the promise alone
 * only resolves at the very end.
 */
export async function downloadModel(modelId: string): Promise<string> {
  return invoke<string>("model_bundle_download", { modelId });
}

/** Remove the on-disk file (idempotent). */
export async function deleteModel(modelId: string): Promise<void> {
  return invoke<void>("model_bundle_delete", { modelId });
}

/**
 * Return the absolute on-disk path of the bundle file, regardless of
 * whether it's currently installed. Used by the auto-start hook to feed
 * `llama-server -m <path>`.
 */
export async function getModelPath(modelId: string): Promise<string> {
  return invoke<string>("model_bundle_path", { modelId });
}

// ---------------------------------------------------------------------------
// Event subscription helper
// ---------------------------------------------------------------------------

/**
 * Subscribe to bundle-download progress events. Returns a teardown function;
 * call it on component unmount. The handler is invoked for every emission
 * (multiple per second during active download — throttled server-side to
 * ~10/s already).
 */
export async function onProgress(
  handler: (p: BundleProgress) => void,
): Promise<() => void> {
  // Dynamic import keeps Vite's static graph tidy.
  const mod = await import("@tauri-apps/api/event");
  const unlisten = await mod.listen<BundleProgress>(
    "bundle-download://progress",
    (event) => handler(event.payload),
  );
  return unlisten;
}

// ---------------------------------------------------------------------------
// UI helpers (format byte counts, ETA, etc.)
// ---------------------------------------------------------------------------

/** Format a byte count as "1.23 GB" / "456 MB" / "78 KB". */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  // 1 decimal for >= 1 GB scales, 0 decimals for smaller. Avoids the
  // misleading "1024.0 MB" / "0.0 KB" rendering.
  const digits = exp >= 3 ? 2 : exp >= 2 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[exp]}`;
}

/**
 * Format a transfer rate. We compute it from successive progress events
 * (delta bytes / delta time), so the input is bytes/second.
 */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Format an ETA in seconds as "1m 23s" / "12s". */
export function formatEta(secondsRemaining: number): string {
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0) return "—";
  const mins = Math.floor(secondsRemaining / 60);
  const secs = Math.floor(secondsRemaining % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}
