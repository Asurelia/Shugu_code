// Shugu Forge — Design Studio live preview (Phase B + G + bridge).
//
// Renders the agent-generated project (served by the `preview://` Rust
// protocol from <workspace>/.shugu-forge/preview/) in a sandboxed iframe, and
// reloads it live (fs://changed, reloadKey, or the Recharger button).
//
// Phase G — device frames: Bureau / Tablette / Mobile width selector.
// Bridge — element selection: the `preview://` handler injects a controller
// script into the served HTML. When the user toggles "Sélectionner", we
// postMessage select-mode INTO the cross-origin iframe; on a click the
// controller postMessages the chosen element's descriptor BACK, which we hand
// to the parent via onSelectElement (the Studio then scopes the next chat turn
// to that element).

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/components";
import type { SelectedElement } from "./studioChat";

// wry serves a custom `foo://` scheme as `http://foo.localhost/` on
// Windows/Android and `foo://localhost/` elsewhere.
function previewOrigin(): string {
  const isWin =
    typeof navigator !== "undefined" && /Windows|Win32|Win64/i.test(navigator.userAgent);
  return isWin ? "http://preview.localhost" : "preview://localhost";
}

type Device = "full" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, number | undefined> = { full: undefined, tablet: 768, mobile: 390 };
const DEVICE_LABEL: Record<Device, string> = { full: "Bureau", tablet: "Tablette", mobile: "Mobile" };

export function ProjectPreview({
  reloadKey = 0,
  onSelectElement,
}: {
  reloadKey?: number;
  onSelectElement?: (el: SelectedElement) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const [device, setDevice] = useState<Device>("full");
  const [selecting, setSelecting] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const origin = previewOrigin();

  // Live reload on any workspace write (the agent writes preview files).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlisten = await mod.listen("fs://changed", () => setNonce((n) => n + 1));
      } catch (err) {
        console.warn("[ProjectPreview] fs://changed listen failed:", err);
      }
    })();
    return () => unlisten?.();
  }, []);

  // Element selections coming back from the injected controller.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // Defense-in-depth: only accept selections from the preview's own origin
      // (on Windows, http://preview.localhost === previewOrigin()). This assumes
      // the platform's preview origin; revisit if Shugu ships beyond Windows.
      if (e.origin !== previewOrigin()) return;
      const d = e.data as { type?: string; el?: SelectedElement } | null;
      if (d && d.type === "shugu:selected" && d.el) {
        onSelectElement?.(d.el);
        setSelecting(false);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onSelectElement]);

  const sendMode = (on: boolean) => {
    // Target the preview's own origin (not "*") so the toggle is only ever
    // delivered to the generated page, never any other embedded content.
    frameRef.current?.contentWindow?.postMessage({ type: "shugu:setSelectMode", on }, origin);
  };
  const toggleSelect = () => {
    const next = !selecting;
    setSelecting(next);
    sendMode(next);
  };

  const src = `${origin}/index.html?_=${reloadKey}_${nonce}`;
  const w = DEVICE_WIDTH[device];

  return (
    <div className="studio-preview">
      <div className="studio-preview-bar">
        <span className="studio-preview-origin"><Icon name="image" size={12} /> Aperçu live</span>
        <span style={{ flex: 1 }} />
        <button
          className={"lgb lgb-sm" + (selecting ? " studio-select-on" : "")}
          onClick={toggleSelect}
          title="Sélectionner un élément à modifier"
        >
          <Icon name="sparkle" size={12} /> {selecting ? "Clique un élément…" : "Sélectionner"}
        </button>
        <div className="studio-device">
          {(["full", "tablet", "mobile"] as Device[]).map((d) => (
            <button
              key={d}
              className={"studio-device-btn" + (device === d ? " is-active" : "")}
              onClick={() => setDevice(d)}
              title={`Aperçu ${DEVICE_LABEL[d]}${DEVICE_WIDTH[d] ? ` (${DEVICE_WIDTH[d]}px)` : ""}`}
            >
              {DEVICE_LABEL[d]}
            </button>
          ))}
        </div>
        <button className="lgb lgb-sm" onClick={() => setNonce((n) => n + 1)} title="Recharger l'aperçu">
          <Icon name="history" size={12} /> Recharger
        </button>
      </div>
      <div className={"studio-preview-stage" + (device !== "full" ? " is-framed" : "")}>
        <iframe
          key={src}
          ref={frameRef}
          className="studio-preview-frame"
          style={w ? { width: w, maxWidth: "100%" } : undefined}
          src={src}
          onLoad={() => { if (selecting) sendMode(true); }}
          title="Aperçu du projet généré"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
        />
      </div>
    </div>
  );
}
