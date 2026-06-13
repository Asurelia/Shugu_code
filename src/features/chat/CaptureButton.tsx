// Shugu Forge — CaptureButton : capture d'écran → image jointe au composer.
//
// Partagé entre le composer du cockpit (views-chat, className="cx-tool") et
// celui de la mascotte (ChatPanel, className="float-icon-btn") — politique
// « logique commune, styles divergents ». Un clic capture le moniteur
// principal ; s'il y a plusieurs moniteurs, un mini-menu propose le choix.
// Raccourci : Ctrl+Shift+S dans la fenêtre courante.
//
// L'image revient en data URL JPEG (grand côté ≤ 1568 px, encodée côté Rust
// par capture.rs) et suit ensuite le flux `pendingImage` → `sendChatMessage`
// existant : le modèle vision (MiniMax M3, Claude…) lit l'écran sans autre
// code. La fenêtre mascotte est masquée pendant la prise côté Rust.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { Icon } from "@/components/components";

export interface CaptureResult {
  dataUrl: string;
  width: number;
  height: number;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
}

export function useMonitors() {
  return useQuery({
    queryKey: ["capture", "monitors"],
    queryFn: async (): Promise<MonitorInfo[]> => {
      try {
        return await invoke<MonitorInfo[]>("capture_list_monitors");
      } catch {
        // Hors Tauri (vitest / preview web) : pas de capture possible.
        return [];
      }
    },
    staleTime: 60_000,
  });
}

export interface CaptureButtonProps {
  /** Classe du bouton — "cx-tool" (cockpit) ou "float-icon-btn" (mascotte). */
  className: string;
  iconSize?: number;
  onCaptured: (dataUrl: string) => void;
}

export function CaptureButton({ className, iconSize = 14, onCaptured }: CaptureButtonProps) {
  const { data: monitors = [] } = useMonitors();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const capture = useMutation({
    mutationFn: (monitor: number | undefined) =>
      invoke<CaptureResult>("capture_screen", monitor === undefined ? {} : { monitor }),
    onSuccess: (r) => onCaptured(r.dataUrl),
    onError: (err) => console.warn("[CaptureButton] capture failed:", err),
  });

  const trigger = (monitor: number | undefined) => {
    setMenuOpen(false);
    capture.mutate(monitor);
  };

  // Raccourci fenêtre : Ctrl+Shift+S → capture du moniteur principal.
  // Appelle directement `capture.mutate` (référentiellement stable en
  // TanStack v5) — pas `trigger`, qui est recréé à chaque render et rendrait
  // la closure du listener périmée si on l'étoffait un jour.
  const mutateRef = capture.mutate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        mutateRef(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mutateRef]);

  // Fermer le menu moniteurs au clic extérieur.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={className}
        title="Capturer l'écran (Ctrl+Shift+S)"
        aria-label="Capturer l'écran"
        disabled={capture.isPending}
        onClick={() => (monitors.length > 1 ? setMenuOpen((o) => !o) : trigger(undefined))}
      >
        <Icon name="camera" size={iconSize} />
      </button>
      {menuOpen && (
        <div className="capture-monitor-menu" role="menu" aria-label="Choisir le moniteur">
          {monitors.map((m) => (
            <button key={m.index} type="button" role="menuitem" onClick={() => trigger(m.index)}>
              <span>{(m.isPrimary ? "★ " : "") + (m.name || `Moniteur ${m.index + 1}`)}</span>
              <span className="dim">{m.width}×{m.height}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
