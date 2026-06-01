// src/features/cockpit/BrowserSurface.tsx
// Minimal browser surface: URL bar + iframe. Primarily useful for localhost /
// preview:// URLs (many external sites block framing via X-Frame-Options — that
// is expected and acceptable for v1). The Tauri CSP is `null` (permissive) so
// the iframe itself is not blocked at the app level.
import { useState, useRef } from "react";

export function BrowserSurface() {
  const [inputUrl, setInputUrl] = useState("");
  const [loadedUrl, setLoadedUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = () => {
    const raw = inputUrl.trim();
    if (!raw) return;
    // Prepend http:// when the user types a bare hostname or path.
    const url =
      raw.startsWith("http://") ||
      raw.startsWith("https://") ||
      raw.startsWith("preview://") ||
      raw.startsWith("http://preview.localhost")
        ? raw
        : "http://" + raw;
    setLoadedUrl(url);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") navigate();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--surface, rgba(8,6,16,0.9))",
      }}
    >
      {/* URL bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          flexShrink: 0,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Entre une URL ou lance un aperçu local (ex: http://localhost:1420)"
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            color: "var(--on-surface, #ece8f5)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            padding: "4px 8px",
            outline: "none",
          }}
        />
        <button
          className="lgb lgb-sm"
          onClick={navigate}
          disabled={!inputUrl.trim()}
          title="Naviguer"
        >
          Aller
        </button>
      </div>

      {/* iframe / empty state */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {loadedUrl ? (
          <iframe
            src={loadedUrl}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: "block",
              background: "#fff",
            }}
            title="Navigateur cockpit"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            <span style={{ fontSize: 28, opacity: 0.3 }}>⟳</span>
            <span>Entre une URL ou lance un aperçu local.</span>
            <span style={{ opacity: 0.5, fontSize: 11 }}>
              Note : les sites externes bloquent souvent l'iframing (X-Frame-Options).
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
