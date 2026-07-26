import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/trust";
import { pushToast } from "@/components/toast";
import { db } from "@/lib/db";
import { queryClient } from "@/lib/queryClient";
import {
  UPDATE_AUTO_CHECK_KEY,
  UPDATE_DISMISSED_VERSION_KEY,
  UPDATE_OPEN_EVENT,
  UPDATE_QUERY_KEY,
  checkForUpdate,
  downloadUpdate,
  listenUpdateProgress,
  revealDownloadedUpdate,
  updateProgressPercent,
  type UpdateDownloadProgress,
} from "@/lib/updates";

/** Global, non-destructive update prompt.
 *
 * The backend downloads only the installer chosen from Shugu's latest stable
 * GitHub Release. This component never executes it: after download, the user
 * explicitly opens Explorer/Finder and remains in control of installation.
 */
export function AppUpdateGate() {
  const [open, setOpen] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadVerified, setDownloadVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useQuery({
    queryKey: UPDATE_QUERY_KEY,
    queryFn: checkForUpdate,
    enabled: false,
    staleTime: 15 * 60_000,
  });

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    void Promise.all([
      db.settings.get(UPDATE_AUTO_CHECK_KEY),
      db.settings.get(UPDATE_DISMISSED_VERSION_KEY),
    ])
      .then(([autoCheck, dismissed]) => {
        if (!alive) return;
        setDismissedVersion(dismissed);
        setSettingsReady(true);
        if (
          autoCheck !== "false" &&
          import.meta.env.VITE_SHUGU_NATIVE_SMOKE !== "1"
        ) {
          timer = window.setTimeout(() => {
            void queryClient
              .fetchQuery({
                queryKey: UPDATE_QUERY_KEY,
                queryFn: checkForUpdate,
                staleTime: 15 * 60_000,
              })
              .catch((cause) => {
                // A boot-time network failure is intentionally silent: About →
                // "Rechercher" remains the explicit diagnostic surface.
                console.warn("[updates] automatic check failed:", cause);
              });
          }, 8_000);
        }
      })
      .catch((cause) => {
        // If SQLite settings cannot be read, preserve the user's possible
        // opt-out by NOT starting an automatic network request.
        console.warn(
          "[updates] settings unavailable; automatic check skipped:",
          cause,
        );
        if (alive) setSettingsReady(true);
      });
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let cleanup: (() => void) | undefined;
    void listenUpdateProgress((next) => {
      if (alive) setProgress(next);
    })
      .then((unlisten) => {
        if (alive) cleanup = unlisten;
        else unlisten();
      })
      .catch((cause) =>
        console.warn("[updates] progress listener failed:", cause),
      );
    return () => {
      alive = false;
      cleanup?.();
    };
  }, []);

  const latestVersion = status?.latestVersion;
  useEffect(() => {
    // This event is emitted only after About's explicit check resolved to an
    // available update. Do not consult a possibly one-render-stale query
    // closure here: opening is the user's explicit intent.
    const show = () => setOpen(true);
    window.addEventListener(UPDATE_OPEN_EVENT, show);
    return () => window.removeEventListener(UPDATE_OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    if (
      status?.state === "available" &&
      status.asset &&
      latestVersion &&
      latestVersion !== dismissedVersion
    ) {
      setOpen(true);
      setDownloaded(false);
      setDownloadVerified(false);
      setError(null);
      setProgress(null);
    }
  }, [dismissedVersion, latestVersion, settingsReady, status]);

  const percent = updateProgressPercent(progress);
  const notes = useMemo(() => {
    const body = status?.notes?.trim();
    return body
      ? body.slice(0, 1_500)
      : "Cette version apporte les derniers correctifs et améliorations de Shugu.";
  }, [status?.notes]);

  const dismiss = () => {
    if (downloading) return;
    setOpen(false);
    if (latestVersion) {
      setDismissedVersion(latestVersion);
      void db.settings.set(UPDATE_DISMISSED_VERSION_KEY, latestVersion);
    }
  };

  const confirm = async () => {
    if (downloaded) {
      try {
        await revealDownloadedUpdate();
      } catch (cause) {
        setError(String(cause));
      }
      return;
    }
    const asset = status?.asset;
    if (!asset) return;
    setDownloading(true);
    setError(null);
    setProgress({ received: 0, total: asset.bytes });
    try {
      const result = await downloadUpdate(asset.id);
      setDownloadVerified(result.verified);
      setDownloaded(true);
      pushToast(
        result.verified
          ? "Mise à jour téléchargée et SHA-256 vérifié."
          : "Mise à jour téléchargée ; SHA-256 calculé, mais GitHub n’a pas fourni d’empreinte de référence.",
        result.verified ? "success" : "info",
        8_000,
      );
    } catch (cause) {
      setError(String(cause));
      pushToast(`Échec de la mise à jour : ${String(cause)}`, "error", 8_000);
    } finally {
      setDownloading(false);
    }
  };

  const confirmLabel = downloaded
    ? "Afficher l’installeur"
    : downloading
      ? `Téléchargement… ${percent} %`
      : error
        ? "Réessayer"
        : "Télécharger";

  return (
    <ConfirmDialog
      open={open}
      title={`Shugu Forge ${latestVersion ?? ""} est disponible`}
      confirmLabel={confirmLabel}
      cancelLabel={downloaded ? "Fermer" : "Plus tard"}
      busy={downloading}
      onCancel={dismiss}
      onConfirm={() => void confirm()}
      body={
        <div>
          <div
            style={{
              maxHeight: 130,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              paddingRight: 4,
            }}
          >
            {notes}
          </div>
          {downloading && (
            <div
              role="progressbar"
              aria-label="Téléchargement de la mise à jour"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              style={{
                height: 5,
                marginTop: 12,
                overflow: "hidden",
                borderRadius: 99,
                background: "rgba(255,255,255,0.08)",
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  background: "var(--primary, #e08efe)",
                  transition: "width 120ms linear",
                }}
              />
            </div>
          )}
          {downloaded && (
            <p style={{ margin: "12px 0 0", color: "var(--success, #7cffd1)" }}>
              Prêt dans le cache Shugu
              {downloadVerified
                ? " · empreinte GitHub vérifiée"
                : " · empreinte locale calculée"}
              .
            </p>
          )}
          {error && (
            <p
              role="alert"
              style={{ margin: "12px 0 0", color: "var(--error, #ff7a9b)" }}
            >
              {error}
            </p>
          )}
          <p style={{ margin: "12px 0 0", opacity: 0.82 }}>
            Shugu ne lance jamais cet installeur automatiquement. Vérifie
            l’éditeur affiché par ton système avant de confirmer l’installation.
          </p>
        </div>
      }
    />
  );
}
