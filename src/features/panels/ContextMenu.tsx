// Shugu Forge — custom right-click context menu.
//
// Wraps any clickable target with annotate / pin / "ask Shugu" actions.
// Receives target metadata, position, and a callback that the host (today
// RootLayout) uses to add the resulting Annotation to its state.
//
// The submenu state (flag color picker / tag picker) is owned here — the
// host shouldn't need to know about it.

import { useState } from "react";
import { Icon } from "@/components/components";

export function ContextMenu({ open, x, y, target, onClose, onAnnotate }: any) {
  const [submenu, setSubmenu] = useState<string | null>(null);
  if (!open) return null;

  const W = 260, H = 480;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  const tagColors = [
    { name: "Bug",      hex: "#ff6a8a" },
    { name: "Note",     hex: "#e08efe" },
    { name: "Idea",     hex: "#ffcf6b" },
    { name: "Question", hex: "#81ecff" },
    { name: "Done",     hex: "#8aefc7" },
  ];

  const onItem = (kind: string, payload?: any) => {
    if (kind === "close") { onClose(); return; }
    onAnnotate({ kind, payload, target });
    onClose();
  };

  return (
    <>
      <div style={{position:"fixed", inset:0, zIndex:9998}} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}/>
      <div className="ctx-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
        {target?.label && (
          <div className="ctx-target-info">
            <span className="badge">{target.kind || "selection"}</span>
            <span className="target-text">{target.label}</span>
          </div>
        )}

        <div className="ctx-section">Annotate</div>
        <button className="ctx-item" onClick={() => onItem("comment")}>
          <span className="ico"><Icon name="chat" size={13}/></span>
          <span className="label">Add comment…</span>
          <span className="kbd">⌘⇧M</span>
        </button>
        <div
          className="ctx-submenu-wrap"
          onMouseEnter={() => setSubmenu("flag")}
          onMouseLeave={() => setSubmenu(null)}
        >
          <button className="ctx-item">
            <span className="ico"><Icon name="thumbs" size={13}/></span>
            <span className="label">Add flag</span>
            <span className="submark">›</span>
          </button>
          {submenu === "flag" && (
            <div className="ctx-menu ctx-submenu">
              <div className="ctx-section">Flag color</div>
              <div className="ctx-color-row">
                {tagColors.map(c => (
                  <div key={c.hex} className="ctx-color" style={{background:c.hex}} title={c.name} onClick={() => onItem("flag", c)}/>
                ))}
              </div>
            </div>
          )}
        </div>
        <div
          className="ctx-submenu-wrap"
          onMouseEnter={() => setSubmenu("tag")}
          onMouseLeave={() => setSubmenu(null)}
        >
          <button className="ctx-item">
            <span className="ico"><Icon name="copy" size={13}/></span>
            <span className="label">Add tag</span>
            <span className="submark">›</span>
          </button>
          {submenu === "tag" && (
            <div className="ctx-menu ctx-submenu">
              <div className="ctx-section">Tag</div>
              {tagColors.map(c => (
                <button key={c.name} className="ctx-item" onClick={() => onItem("tag", c)}>
                  <span className="ico" style={{background:c.hex, width:10, height:10, borderRadius:3}}></span>
                  <span className="label">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="ctx-item" onClick={() => onItem("pin")}>
          <span className="ico"><Icon name="up" size={13}/></span>
          <span className="label">Pin to floating chat</span>
          <span className="kbd">⌘P</span>
        </button>

        <div className="ctx-divider"></div>
        <div className="ctx-section">Shugu</div>
        <button className="ctx-item" onClick={() => onItem("ask")}>
          <span className="ico"><Icon name="sparkle" size={13}/></span>
          <span className="label">Ask Shugu about this</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("rewrite")}>
          <span className="ico"><Icon name="sparkle" size={13}/></span>
          <span className="label">Refactor with Shugu</span>
          <span className="kbd">⌘E</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("fix")}>
          <span className="ico"><Icon name="sparkle" size={13}/></span>
          <span className="label">Fix with Shugu</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("explain")}>
          <span className="ico"><Icon name="chat" size={13}/></span>
          <span className="label">Explain this</span>
        </button>

        <div className="ctx-divider"></div>
        <button className="ctx-item" onClick={() => onItem("copy")}>
          <span className="ico"><Icon name="copy" size={13}/></span>
          <span className="label">Copy</span>
          <span className="kbd">⌘C</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("paste")}>
          <span className="ico"><Icon name="copy" size={13}/></span>
          <span className="label">Paste</span>
          <span className="kbd">⌘V</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("inspect")}>
          <span className="ico"><Icon name="search" size={13}/></span>
          <span className="label">Inspect element</span>
        </button>
      </div>
    </>
  );
}
