// Shugu Forge — MenuBar: data-driven menu bar generated from the command registry.
// Pass 2. Click-to-open only — hover-to-open is Pass 3 polish.

import { useState, useEffect, useRef } from "react";
import { COMMANDS, fmtKbd, type CommandCategory, type CommandContext } from "@/lib/commands";

// Fixed display order. Help is included so it appears automatically when
// a Help-category command is added later — zero code change needed here.
// Today Help has 0 commands, so it is filtered out and never rendered.
const MENU_ORDER: CommandCategory[] = [
  "File", "Edit", "Selection", "View", "Go", "Terminal", "Help", "Workbench",
];

/** Non-input commands grouped by category, in MENU_ORDER. */
function buildMenus() {
  const nonInput = COMMANDS.filter((c) => c.scope !== "input");
  const byCategory = new Map<CommandCategory, typeof nonInput>();
  nonInput.forEach((c) => {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  });
  // Emit only categories that have ≥1 command, in the fixed order.
  return MENU_ORDER
    .filter((cat) => (byCategory.get(cat)?.length ?? 0) > 0)
    .map((cat) => ({ label: cat, commands: byCategory.get(cat)! }));
}

// Computed once at module load — the COMMANDS array is static.
const MENUS = buildMenus();

// ─── MenuBar ──────────────────────────────────────────────────

export function MenuBar({ ctx }: { ctx: CommandContext }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (openIdx === null) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenIdx(null);
    };
    const onPointer = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenIdx(null);
      }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [openIdx]);

  return (
    <div
      ref={barRef}
      className="menubar"
      // data-tauri-drag-region="false" so that clicks in the frameless-window
      // titlebar region are not consumed by the OS window drag handler.
      // The CSS .titlebar > * already sets -webkit-app-region: no-drag for
      // direct children, but MenuBar is one container wrapping many buttons,
      // so we belt-and-braces with the attribute on the wrapper AND the class
      // rule .menubar, .menubar-btn, .menubar-dropdown in styles.css.
      data-tauri-drag-region="false"
    >
      {MENUS.map((menu, idx) => (
        <MenuEntry
          key={menu.label}
          label={menu.label}
          commands={menu.commands}
          ctx={ctx}
          open={openIdx === idx}
          onToggle={() => setOpenIdx(openIdx === idx ? null : idx)}
          onClose={() => setOpenIdx(null)}
        />
      ))}
    </div>
  );
}

// ─── MenuEntry (one top-level menu + its dropdown) ────────────

interface MenuEntryProps {
  label: string;
  commands: typeof COMMANDS;
  ctx: CommandContext;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

function MenuEntry({ label, commands, ctx, open, onToggle, onClose }: MenuEntryProps) {
  return (
    <div className="menubar-entry" style={{ position: "relative" }}>
      <button
        className={"menubar-btn" + (open ? " open" : "")}
        onClick={onToggle}
        data-tauri-drag-region="false"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        <div
          className="chat-ctx menubar-dropdown"
          role="menu"
          data-tauri-drag-region="false"
        >
          {commands.map((cmd) => {
            const disabled = !!(cmd.when && cmd.when(ctx) === false);
            const kbd = fmtKbd(cmd.keybinding);
            return (
              <button
                key={cmd.id}
                className="chat-ctx-item"
                role="menuitem"
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => {
                  // Belt-and-braces: native disabled blocks the event, but
                  // guard explicitly so a future refactor can't accidentally
                  // fire a disabled command.
                  if (disabled) return;
                  void cmd.run(ctx);
                  onClose();
                }}
                data-tauri-drag-region="false"
              >
                <span className="label">{cmd.title}</span>
                {kbd && <span className="kbd">{kbd}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
