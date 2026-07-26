import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/components";
import { db, type ConversationRow } from "@/lib/db";
import { fsListFiles } from "@/lib/fs";
import {
  COMMANDS,
  fmtKbd,
  type Command,
  type CommandContext,
} from "@/lib/commands";
import { useModalFocusTrap } from "@/lib/modalFocus";
import {
  paletteMatchScore,
  parsePaletteQuery,
  type UnifiedPaletteScope,
} from "./unifiedPaletteModel";
import "./unified-palette.css";

const MAX_FILES = 20_000;
const MAX_FILE_RESULTS = 30;
const MAX_CONVERSATION_RESULTS = 12;

type PaletteKind = "command" | "file" | "conversation";

interface PaletteResult {
  id: string;
  kind: PaletteKind;
  title: string;
  hint: string;
  icon: string;
  kbd?: string;
  score: number;
  run: () => void | Promise<void>;
}

interface PaletteGroup {
  id: string;
  label: string;
  results: PaletteResult[];
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

function formatActivity(updatedAt: number): string {
  const elapsed = Math.max(0, Date.now() - updatedAt);
  if (elapsed < 60_000) return "à l’instant";
  if (elapsed < 3_600_000) return `il y a ${Math.floor(elapsed / 60_000)} min`;
  if (elapsed < 86_400_000)
    return `il y a ${Math.floor(elapsed / 3_600_000)} h`;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
  }).format(updatedAt);
}

function allows(scope: UnifiedPaletteScope, kind: PaletteKind): boolean {
  if (scope === "all") return true;
  if (scope === "commands") return kind === "command";
  if (scope === "files") return kind === "file";
  return kind === "conversation";
}

function sortByScore<T extends { score: number }>(items: T[]): T[] {
  return items.sort((a, b) => b.score - a.score);
}

export function UnifiedPalette({
  open,
  onClose,
  ctx,
  activeConversationId,
  onOpenFile,
  onOpenConversation,
}: {
  open: boolean;
  onClose: () => void;
  ctx: CommandContext;
  activeConversationId: string;
  onOpenFile: (path: string) => void | Promise<void>;
  onOpenConversation: (id: string) => void | Promise<void>;
}) {
  const [rawQuery, setRawQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [paths, setPaths] = useState<string[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useModalFocusTrap({
    open,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    onEscape: onClose,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRawQuery("");
    setIndex(0);
    setFilesLoading(true);

    void fsListFiles([], MAX_FILES)
      .then((result) => {
        if (!cancelled) setPaths(result.paths);
      })
      .catch(() => {
        if (!cancelled) setPaths([]);
      })
      .finally(() => {
        if (!cancelled) setFilesLoading(false);
      });

    void db.conversations
      .list()
      .then((rows) => {
        if (!cancelled) setConversations(rows);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const parsed = useMemo(() => parsePaletteQuery(rawQuery), [rawQuery]);

  const activeCommands = useMemo(
    () =>
      COMMANDS.filter((command) => {
        if (command.scope === "input") return false;
        if (command.id === "open-palette" || command.id === "open-palette-alt")
          return false;
        return !command.when || command.when(ctx);
      }),
    [ctx],
  );

  const commandResults = useMemo(() => {
    if (!allows(parsed.scope, "command")) return [];
    return sortByScore(
      activeCommands
        .map((command: Command): PaletteResult | null => {
          const hint = [command.category, command.description]
            .filter(Boolean)
            .join(" · ");
          const score = paletteMatchScore(command.title, hint, parsed.query);
          if (score < 0) return null;
          return {
            id: `command:${command.id}`,
            kind: "command",
            title: command.title,
            hint,
            icon: command.icon ?? "search",
            kbd: fmtKbd(command.keybinding),
            score,
            run: () => command.run(ctx),
          };
        })
        .filter((result): result is PaletteResult => result !== null),
    );
  }, [activeCommands, ctx, parsed]);

  const fileResults = useMemo(() => {
    if (!allows(parsed.scope, "file")) return [];
    if (!parsed.query && parsed.scope === "all") return [];

    const results: PaletteResult[] = [];
    for (const path of paths) {
      const title = basename(path);
      const hint = dirname(path);
      const score = paletteMatchScore(title, hint, parsed.query);
      if (score < 0) continue;
      results.push({
        id: `file:${path}`,
        kind: "file",
        title,
        hint,
        icon: "file",
        score,
        run: () => onOpenFile(path),
      });
    }
    return sortByScore(results).slice(0, MAX_FILE_RESULTS);
  }, [onOpenFile, parsed, paths]);

  const conversationResults = useMemo(() => {
    if (!allows(parsed.scope, "conversation")) return [];

    const results = conversations
      .map((conversation): PaletteResult | null => {
        const state =
          conversation.id === activeConversationId
            ? "ouverte"
            : conversation.archived
              ? "archivée"
              : conversation.unread
                ? "non lue"
                : "conversation";
        const hint = `${state} · ${formatActivity(conversation.updated_at)}`;
        const score = parsed.query
          ? paletteMatchScore(conversation.title, hint, parsed.query)
          : conversation.updated_at + (conversation.pinned ? 10 ** 15 : 0);
        if (score < 0) return null;
        return {
          id: `conversation:${conversation.id}`,
          kind: "conversation",
          title: conversation.title,
          hint,
          icon: "chat",
          score,
          run: () => onOpenConversation(conversation.id),
        };
      })
      .filter((result): result is PaletteResult => result !== null);

    return sortByScore(results).slice(
      0,
      parsed.scope === "conversations" && !parsed.query
        ? 30
        : MAX_CONVERSATION_RESULTS,
    );
  }, [activeConversationId, conversations, onOpenConversation, parsed]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const searching = parsed.query.length > 0 || parsed.scope !== "all";
    const candidates = searching
      ? [
          { id: "commands", label: "Commandes", results: commandResults },
          { id: "files", label: "Fichiers", results: fileResults },
          {
            id: "conversations",
            label: "Conversations",
            results: conversationResults,
          },
        ]
      : [
          {
            id: "conversations",
            label: "Reprendre",
            results: conversationResults.slice(0, 6),
          },
          { id: "commands", label: "Commandes", results: commandResults },
        ];
    return candidates.filter((group) => group.results.length > 0);
  }, [commandResults, conversationResults, fileResults, parsed]);

  const flatResults = useMemo(
    () => groups.flatMap((group) => group.results),
    [groups],
  );

  useEffect(() => {
    setIndex(0);
  }, [rawQuery]);

  useEffect(() => {
    if (flatResults.length === 0) {
      setIndex(0);
      return;
    }
    setIndex((current) => Math.min(current, flatResults.length - 1));
  }, [flatResults.length]);

  useEffect(() => {
    document
      .getElementById(`unified-palette-result-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (result: PaletteResult | undefined) => {
    if (!result) return;
    void result.run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) =>
        Math.min(current + 1, Math.max(0, flatResults.length - 1)),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setIndex(Math.max(0, flatResults.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(flatResults[index]);
    }
  };

  if (!open) return null;

  let cursor = 0;
  return (
    <div
      className="palette-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="palette palette-unified"
        role="dialog"
        aria-modal="true"
        aria-label="Recherche rapide"
        tabIndex={-1}
      >
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            name="unified-palette-query"
            autoComplete="off"
            aria-label="Rechercher commandes, fichiers et conversations"
            aria-controls="unified-palette-results"
            aria-activedescendant={
              flatResults.length > 0
                ? `unified-palette-result-${index}`
                : undefined
            }
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Commandes, fichiers et conversations…"
          />
          <span className="kbd">esc</span>
        </div>
        <div
          id="unified-palette-results"
          className="palette-list scroll"
          role="listbox"
          aria-label="Résultats"
        >
          {groups.map((group) => (
            <div key={group.id} role="group" aria-label={group.label}>
              <div className="palette-section-label">
                {group.label}
                <span className="count">{group.results.length}</span>
              </div>
              {group.results.map((result) => {
                const resultIndex = cursor++;
                return (
                  <button
                    id={`unified-palette-result-${resultIndex}`}
                    type="button"
                    role="option"
                    aria-selected={resultIndex === index}
                    key={result.id}
                    className={
                      "palette-item" + (resultIndex === index ? " active" : "")
                    }
                    style={{
                      width: "100%",
                      border: 0,
                      font: "inherit",
                      textAlign: "left",
                    }}
                    onMouseEnter={() => setIndex(resultIndex)}
                    onClick={() => pick(result)}
                  >
                    <div className="ico">
                      <Icon name={result.icon} size={13} />
                    </div>
                    <div className="body">
                      <div className="name">{result.title}</div>
                      {result.hint && <div className="hint">{result.hint}</div>}
                    </div>
                    {result.kbd && <span className="kbd">{result.kbd}</span>}
                    <span className="kind">
                      {result.kind === "command"
                        ? "action"
                        : result.kind === "file"
                          ? "fichier"
                          : "chat"}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {flatResults.length === 0 && (
            <div className="palette-empty">
              <strong>Aucun résultat</strong>
              {filesLoading && allows(parsed.scope, "file")
                ? "Lecture du workspace…"
                : `Essaie un autre terme pour « ${parsed.query || rawQuery} ».`}
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd" style={{ marginLeft: 2 }}>
              ↓
            </span>{" "}
            naviguer
          </span>
          <span>
            <span className="kbd">↵</span> ouvrir
          </span>
          <span className="spacer" />
          <span className="palette-scope-hint">
            <span>
              <b>&gt;</b> commandes
            </span>
            <span>
              <b>#</b> fichiers
            </span>
            <span>
              <b>@</b> conversations
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
