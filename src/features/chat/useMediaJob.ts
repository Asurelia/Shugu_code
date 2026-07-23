import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "@/lib/tauri";

export type MediaJobProgress = {
  id: string;
  kind: "media:image" | "media:video" | "media:music" | string;
  status: "running" | "cancel_requested" | "cancelled" | "done" | "error" | "interrupted";
  phase: string;
  progress: number;
  message?: string | null;
  resultUrl?: string | null;
  error?: string | null;
  updatedAt: number;
};

function makeJobId(kind: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `media-${kind}-${uuid}` : `media-${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isMediaCancellation(error: unknown): boolean {
  return String(error).toLowerCase().includes("media job cancelled");
}

/** One live durable media job for a generation panel. */
export function useMediaJob() {
  const activeId = useRef<string | null>(null);
  const [progress, setProgress] = useState<MediaJobProgress | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<MediaJobProgress>("media://progress", (event) => {
      if (!disposed && event.id === activeId.current) setProgress(event);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const begin = useCallback((kind: "image" | "video" | "music") => {
    const id = makeJobId(kind);
    activeId.current = id;
    setProgress({
      id,
      kind: `media:${kind}`,
      status: "running",
      phase: "starting",
      progress: 0,
      message: "Démarrage",
      updatedAt: Date.now(),
    });
    return id;
  }, []);

  const cancel = useCallback(async () => {
    const id = activeId.current;
    if (!id) return false;
    const accepted = await invoke<boolean>("media_job_cancel", { id });
    if (accepted) {
      setProgress((current) => current && current.id === id ? {
        ...current,
        status: "cancel_requested",
        phase: "cancelling",
        message: "Annulation…",
        updatedAt: Date.now(),
      } : current);
    }
    return accepted;
  }, []);

  return { progress, begin, cancel };
}
