// Shugu Forge — first-run onboarding overlay.
//
// Shows once when the user opens the app and no default bundle model has
// been downloaded yet. Offers a one-click download with live progress, or
// a "later" path that defers (the user can still configure a remote API
// provider in Settings and use Shugu cloud-only).
//
// State persistence: the "Plus tard" choice is stored in db.settings under
// `onboarding.dismissed.v1` so this overlay doesn't keep popping up. The
// flag is cleared when the user manually re-triggers the download from
// Settings (TODO — that Settings entry doesn't exist yet, but the flag is
// trivially clearable by hand if needed).
//
// Web mode: getStatus() / getCatalog() return empty arrays in non-Tauri
// builds. The component then sees `defaultEntry === undefined` and returns
// null — no overlay, no crash, dev work on the rest of the app stays
// unblocked.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBundleCatalog, useInstalledBundles, useOnboardingDismissed, onboardingKeys } from "./queries";

import {
  downloadModel,
  formatBytes,
  formatEta,
  formatRate,
  onProgress,
  type BundleProgress,
} from "@/lib/modelBundle";
import { db } from "@/lib/db";

const DISMISS_KEY = "onboarding.dismissed.v1";

export function Onboarding() {
  const qc = useQueryClient();
  // Data fetching migré vers TanStack (Phase I — mai 2026). Le catalog
  // / installedIds / dismissed sont maintenant des useQuery — fresh par
  // défaut, refetch automatique sur invalidation.
  const { data: catalog = [] } = useBundleCatalog();
  // Set of catalog ids known to exist on disk. We deliberately AVOID
  // getStatus() (the full SHA256 verification path) — it hashes a 1+ GB
  // GGUF every call, which on Qwen-installed machines stalled the webview
  // for 3-5 s at every boot, making Windows label the app "Not Responding".
  // The overlay only needs the boolean "installed?" answer, which a cheap
  // path.exists() probe delivers in microseconds.
  const { data: installedIds = [] } = useInstalledBundles();
  const { data: dismissedData, isLoading: dismissedLoading } = useOnboardingDismissed();
  const dismissed: boolean | null = dismissedLoading ? null : (dismissedData ?? false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<BundleProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sliding-window for rate / ETA calculation. We sample every ~250 ms
  // (a few progress events per second) so the displayed rate doesn't
  // jitter to zero between bursts of chunks.
  const lastSample = useRef({ time: Date.now(), bytes: 0 });
  const rate = useRef(0);

  // ─── Live progress subscription ─────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await onProgress((p) => {
        setProgress(p);

        // Compute rate from a 1s sliding window. We only update the
        // sample when at least 250ms passed; otherwise we'd divide by
        // tiny dt values and get spiky rates.
        const now = Date.now();
        const dtMs = now - lastSample.current.time;
        if (dtMs >= 250) {
          const dBytes = p.bytesDone - lastSample.current.bytes;
          rate.current = dBytes / (dtMs / 1000);
          lastSample.current = { time: now, bytes: p.bytesDone };
        }

        if (p.phase === "done") {
          setDownloading(false);
          // Refresh the cheap on-disk check so the overlay self-dismisses.
          // Migré : on invalide la query au lieu de set local manuel.
          void qc.invalidateQueries({ queryKey: onboardingKeys.installed() });
        } else if (p.phase === "error") {
          setDownloading(false);
          setError(p.error ?? "Téléchargement interrompu.");
        }
      });
    })();
    return () => unlisten?.();
  }, []);

  // Wait until we know the dismissed flag before deciding to render. This
  // prevents a brief flash of the overlay on launch.
  if (dismissed === null) return null;

  const defaultEntry = catalog[0];
  const installed = defaultEntry ? installedIds.includes(defaultEntry.id) : false;

  // Don't show if installed, dismissed, or nothing to offer.
  if (!defaultEntry) return null;
  if (installed) return null;
  if (dismissed && !downloading) return null;

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    setProgress(null);
    lastSample.current = { time: Date.now(), bytes: 0 };
    rate.current = 0;
    try {
      await downloadModel(defaultEntry.id);
    } catch (err) {
      setError(String(err));
      setDownloading(false);
    }
  };

  const handleLater = async () => {
    try {
      await db.settings?.set?.(DISMISS_KEY, "true");
    } catch {
      // Even if persistence fails, dismiss for this session.
    }
    // Migré : on update direct le cache TanStack au lieu d'un setState local.
    qc.setQueryData<boolean>(onboardingKeys.dismissed(), true);
  };

  // ─── Progress derivations ───────────────────────────────────────
  const pct =
    progress && progress.bytesTotal > 0
      ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100)
      : 0;
  const remainingBytes =
    progress && progress.bytesTotal > 0
      ? Math.max(0, progress.bytesTotal - progress.bytesDone)
      : 0;
  const etaSec = rate.current > 0 ? remainingBytes / rate.current : Infinity;

  const expectedSizeMb = (defaultEntry.sizeBytes / 1_048_576).toFixed(0);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8, 6, 18, 0.78)",
        backdropFilter: "blur(8px)",
        zIndex: 5000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          background: "var(--surface, #16121f)",
          border: "1px solid rgba(124, 58, 237, 0.32)",
          borderRadius: 14,
          padding: "24px 22px",
          boxShadow: "0 18px 80px rgba(124, 58, 237, 0.25)",
          color: "var(--on-surface, #ece6f6)",
          fontFamily: "var(--font-ui, system-ui, sans-serif)",
        }}
      >
        <div style={{ marginBottom: 6, fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--on-surface-muted, #aa9fc1)" }}>
          Bienvenue dans Shugu Forge
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
          Activer la mascotte locale
        </h2>
        <p style={{ marginTop: 10, marginBottom: 18, fontSize: 14, lineHeight: 1.55, color: "var(--on-surface-muted, #aa9fc1)" }}>
          Shugu peut fonctionner entièrement en local grâce à un petit modèle
          ouvert ({defaultEntry.displayName}, ~{expectedSizeMb} Mo). Tu pourras
          aussi brancher Claude, GPT ou Mistral à tout moment depuis les
          Réglages — la mascotte locale reste là pour la mémoire et le tri.
        </p>

        <div
          style={{
            background: "rgba(124, 58, 237, 0.08)",
            border: "1px solid rgba(124, 58, 237, 0.18)",
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <strong style={{ fontWeight: 600 }}>{defaultEntry.displayName}</strong>
            <span style={{ fontSize: 11, color: "var(--on-surface-muted, #aa9fc1)" }}>
              {defaultEntry.quant} · {defaultEntry.license}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--on-surface-muted, #aa9fc1)" }}>
            {defaultEntry.tagline}
          </div>
        </div>

        {downloading && progress && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: "var(--on-surface-muted, #aa9fc1)" }}>
                {progress.phase === "verifying"
                  ? "Vérification SHA256…"
                  : progress.phase === "downloading"
                    ? `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`
                    : ""}
              </span>
              <span style={{ color: "var(--on-surface-muted, #aa9fc1)" }}>
                {progress.phase === "downloading"
                  ? `${formatRate(rate.current)} · ${formatEta(etaSec)}`
                  : ""}
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 99,
                background: "rgba(124, 58, 237, 0.14)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background:
                    progress.phase === "verifying"
                      ? "linear-gradient(90deg, #a78bfa, #c4b5fd)"
                      : "linear-gradient(90deg, #7c3aed, #a78bfa)",
                  transition: "width 200ms ease",
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              borderRadius: 8,
              background: "rgba(255, 107, 107, 0.1)",
              border: "1px solid rgba(255, 107, 107, 0.32)",
              color: "#ff8888",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <strong>Erreur :</strong> {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            className="lgb lgb-sm"
            onClick={handleLater}
            disabled={downloading}
            title="Tu pourras toujours télécharger plus tard depuis Réglages."
          >
            Plus tard
          </button>
          <button
            className="lgb lgb-sm lgb-primary"
            onClick={handleDownload}
            disabled={downloading}
            title="Télécharge le modèle dans %LOCALAPPDATA%\\dev.shugu.forge\\models\\"
          >
            {downloading ? "Téléchargement…" : "Télécharger maintenant"}
          </button>
        </div>
      </div>
    </div>
  );
}
