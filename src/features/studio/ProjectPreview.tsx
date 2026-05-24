// Shugu Forge — Design Studio live preview (Phase B + G + bridge + Tweaks).
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
// Tweaks (#2) — live design-token editing: the SAME controller can enumerate
// the `:root` custom properties of the generated page and apply overrides via
// `style.setProperty` instantly. We render dynamic controls from the real
// tokens (no hard-coded names — the agent chooses them per generation), nudge
// them live, then "Appliquer au projet" bakes the values into the CSS via an
// agent turn (onBakeTokens, handled by the parent).

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/components";
import type { SelectedElement } from "./studioChat";
import {
  TWEAKS_STYLE,
  TweakSection,
  TweakSlider,
  TweakText,
  TweakButton,
} from "@/features/tweaks/tweaks-panel";

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

interface Token {
  name: string;
  value: string;
}

// Heuristic: does a CSS value read as a colour? Covers hex + the modern colour
// functions our curated directions emit (oklch/oklab/lab/lch/hwb) + rgb/hsl.
// Only decides whether to show a swatch — non-matches still get a text input,
// so a token is never made un-editable by a miss here.
function isColorLike(v: string): boolean {
  return /^(#|rgb|hsl|hwb|oklch|oklab|lab|lch|color\()/i.test(v.trim());
}

// Classify a token value so we can render the right control: a slider for
// lengths/numbers, a swatch+field for colours, a plain field otherwise.
type TokenKind = "color" | "length" | "number" | "text";
function tokenKind(v: string): TokenKind {
  const t = v.trim();
  if (isColorLike(t)) return "color";
  if (/^-?[\d.]+(px|rem|em|%|vh|vw|vmin|vmax|pt|ch)$/i.test(t)) return "length";
  if (/^-?[\d.]+$/.test(t)) return "number";
  return "text";
}
function parseLen(v: string): { n: number; unit: string } {
  const m = v.trim().match(/^(-?[\d.]+)([a-z%]*)$/i);
  return m ? { n: parseFloat(m[1]) || 0, unit: m[2] || "" } : { n: 0, unit: "" };
}
// Heuristic slider range per unit; computed from the ORIGINAL value so the range
// stays stable while the user drags (rather than the max creeping upward).
function lenRange(unit: string, n: number): { min: number; max: number; step: number } {
  if (unit === "rem" || unit === "em") return { min: 0, max: Math.max(4, +(n * 2).toFixed(2)), step: 0.05 };
  if (unit === "%") return { min: 0, max: 100, step: 1 };
  if (unit === "") return { min: 0, max: Math.max(2, +(n * 2).toFixed(2) || 2), step: n <= 2 ? 0.05 : 1 };
  return { min: 0, max: Math.max(64, Math.ceil(n * 2)), step: 1 };
}

export function ProjectPreview({
  reloadKey = 0,
  onSelectElement,
  onBakeTokens,
}: {
  reloadKey?: number;
  onSelectElement?: (el: SelectedElement) => void;
  onBakeTokens?: (overrides: Record<string, string>) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const [device, setDevice] = useState<Device>("full");
  const [selecting, setSelecting] = useState(false);
  const [tweaking, setTweaking] = useState(false);
  // `tokens` is the snapshot read from the page (the originals, for Reset);
  // `overrides` holds only what the user changed (name → new value).
  const [tokens, setTokens] = useState<Token[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
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

  // Messages coming back from the injected controller (selections + tokens).
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // Defense-in-depth: only accept messages from the preview's own origin
      // (on Windows, http://preview.localhost === previewOrigin()). This assumes
      // the platform's preview origin; revisit if Shugu ships beyond Windows.
      if (e.origin !== previewOrigin()) return;
      const d = e.data as { type?: string; el?: SelectedElement; tokens?: Token[] } | null;
      if (!d) return;
      if (d.type === "shugu:selected" && d.el) {
        onSelectElement?.(d.el);
        setSelecting(false);
      } else if (d.type === "shugu:tokens" && Array.isArray(d.tokens)) {
        setTokens(d.tokens);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onSelectElement]);

  // Target the preview's own origin (not "*") so messages are only ever
  // delivered to the generated page, never any other embedded content.
  const post = (msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(msg, origin);
  };

  const sendMode = (on: boolean) => post({ type: "shugu:setSelectMode", on });
  const toggleSelect = () => {
    const next = !selecting;
    setSelecting(next);
    sendMode(next);
  };

  const requestTokens = () => post({ type: "shugu:getTokens" });
  const toggleTweaks = () => {
    const next = !tweaking;
    setTweaking(next);
    if (next) requestTokens();
  };
  const setToken = (name: string, value: string) => {
    setOverrides((o) => ({ ...o, [name]: value }));
    post({ type: "shugu:setToken", name, value });
  };
  const resetTweaks = () => {
    // Re-apply each changed token's snapshot value in the iframe, then clear.
    for (const name of Object.keys(overrides)) {
      const orig = tokens.find((t) => t.name === name)?.value ?? "";
      post({ type: "shugu:setToken", name, value: orig });
    }
    setOverrides({});
  };

  const src = `${origin}/index.html?_=${reloadKey}_${nonce}`;
  const w = DEVICE_WIDTH[device];
  // Token groups for the Tweaks panel (classified by value → control type).
  const colorTokens = tokens.filter((t) => tokenKind(t.value) === "color");
  const sizeTokens = tokens.filter((t) => {
    const k = tokenKind(t.value);
    return k === "length" || k === "number";
  });
  const textTokens = tokens.filter((t) => tokenKind(t.value) === "text");

  return (
    <div className="studio-preview">
      <div className="studio-preview-bar">
        <span className="studio-preview-origin"><Icon name="image" size={12} /> Aperçu live</span>
        <span style={{ flex: 1 }} />
        <button
          className={"lgb lgb-sm" + (tweaking ? " studio-select-on" : "")}
          onClick={toggleTweaks}
          title="Ajuster les couleurs et tokens en live"
        >
          <Icon name="palette" size={12} /> Tweaks
        </button>
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

      {tweaking && (
        <div className="studio-tweaks">
          <style>{TWEAKS_STYLE}</style>
          <div className="studio-tweaks-hd">
            <b>Tweaks</b>
            <button className="twk-x" aria-label="Fermer" onClick={() => setTweaking(false)}>✕</button>
          </div>
          <div className="twk-body studio-tweaks-bd">
            {tokens.length === 0 ? (
              <p className="studio-tweaks-empty">
                Aucun token <code>--*</code> dans <code>:root</code>. Génère un projet, ou recharge l'aperçu.
              </p>
            ) : (
              <>
                {colorTokens.length > 0 && (
                  <TweakSection label="Couleurs">
                    {colorTokens.map((t) => {
                      const cur = overrides[t.name] ?? t.value;
                      return (
                        <div className="studio-tweak-crow" key={t.name}>
                          <span className="studio-tweak-cname" title={t.name}>{t.name.replace(/^--/, "")}</span>
                          <span className="studio-tweak-swatch" style={{ background: cur }} />
                          <input
                            className="twk-field studio-tweak-cinput"
                            value={cur}
                            spellCheck={false}
                            onChange={(e) => setToken(t.name, e.target.value)}
                          />
                        </div>
                      );
                    })}
                  </TweakSection>
                )}
                {sizeTokens.length > 0 && (
                  <TweakSection label="Tailles & espacements">
                    {sizeTokens.map((t) => {
                      const orig = parseLen(t.value);
                      const curN = parseLen(overrides[t.name] ?? t.value).n;
                      const r = lenRange(orig.unit, orig.n);
                      return (
                        <TweakSlider
                          key={t.name}
                          label={t.name.replace(/^--/, "")}
                          value={curN}
                          unit={orig.unit}
                          min={r.min}
                          max={r.max}
                          step={r.step}
                          onChange={(nv: number) => setToken(t.name, `${nv}${orig.unit}`)}
                        />
                      );
                    })}
                  </TweakSection>
                )}
                {textTokens.length > 0 && (
                  <TweakSection label="Autres">
                    {textTokens.map((t) => (
                      <TweakText
                        key={t.name}
                        label={t.name.replace(/^--/, "")}
                        value={overrides[t.name] ?? t.value}
                        onChange={(v: string) => setToken(t.name, v)}
                      />
                    ))}
                  </TweakSection>
                )}
                <div className="studio-tweaks-actions">
                  <TweakButton label="Réinitialiser" secondary onClick={resetTweaks} />
                  <TweakButton label="Appliquer au projet" onClick={() => onBakeTokens?.(overrides)} />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className={"studio-preview-stage" + (device !== "full" ? " is-framed" : "")}>
        <iframe
          key={src}
          ref={frameRef}
          className="studio-preview-frame"
          style={w ? { width: w, maxWidth: "100%" } : undefined}
          src={src}
          onLoad={() => {
            if (selecting) sendMode(true);
            // New document → previous inline overrides are gone; re-sync from
            // the freshly loaded page so the panel shows the real current values.
            if (tweaking) {
              setOverrides({});
              requestTokens();
            }
          }}
          title="Aperçu du projet généré"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
        />
      </div>
    </div>
  );
}
