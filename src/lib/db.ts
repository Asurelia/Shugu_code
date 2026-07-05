/**
 * Local SQLite persistence layer — source of truth (not a cache).
 *
 * Lazy-loads the `@tauri-apps/plugin-sql` Database against `sqlite:shugu.db`;
 * migrations run at startup via the Rust side. Shugu Forge is Tauri-only,
 * so this module assumes the plugin is always present — no null-fallback,
 * no degraded-mode branch. Dynamic import is kept so Vite can defer the
 * plugin module load until the first DB call.
 */

import type { Generation } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

let _dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (!_dbPromise) {
    _dbPromise = import("@tauri-apps/plugin-sql").then((mod) =>
      mod.default.load("sqlite:shugu.db")
    );
    // Un échec de load() (ex. « database is locked » pendant qu'une tâche de
    // fond tient brièvement le verrou d'écriture) ne doit PAS être mis en
    // cache : sinon toute la couche données reste morte pour la session alors
    // que l'appel suivant aurait réussi. On purge le cache sur rejet — le
    // rejet lui-même est propagé à l'appelant, qui gère déjà ses erreurs.
    _dbPromise.catch(() => {
      _dbPromise = null;
    });
  }
  return _dbPromise;
}

// ---------------------------------------------------------------------------
// Row interfaces — mirror the DDL exactly
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  title: string;
  project_id: string | null;
  pinned: number;       // 0 | 1
  archived: number;     // 0 | 1
  unread: number;       // 0 | 1
  env: string | null;
  parent_id: string | null;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  text: string | null;
  body: string | null;
  code_lang: string | null;
  code_text: string | null;
  /** `<think>` trace captured from thinking-enabled models (V3 schema). */
  reasoning: string | null;
  image: number;        // 0 | 1
  ts: number;
  /** UUID of the agent whose output this message relays (V5 schema).
   *  NULL for regular chat messages. Matches `agents.id`. */
  agent_id: string | null;
  /** 1 when this message is a verbatim orchestrator relay (V5 schema);
   *  0 for user + direct-chat AI messages. */
  via_agent: number;    // 0 | 1
  /** Unix ms timestamp of last edit. NULL if never edited (V6 schema). */
  edited_at: number | null;
  /** Unix ms timestamp of soft-delete. NULL = live; non-null = deleted (V6 schema). */
  deleted_at: number | null;
  /** UUID of the message this is a re-generation of (V6 schema). */
  parent_id: string | null;
}

/**
 * A project = an opened folder. Ex-vestigial `projects` table (V1), resurrected
 * in V18 into the real registry. `root_path` is the canonical key (display form:
 * no `\\?\` prefix, forward slashes), matching what `fsGetWorkspaceRoot()` returns.
 * `color`/`sort_order` (unused V1 columns) finally drive the project switcher.
 */
export interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
  color: string | null;
  sort_order: number;
  last_opened_at: number | null;
  created_at: number | null;
}

export interface GenerationRow {
  id: string;
  prompt: string;
  negative: string | null;
  ratio: string | null;
  model: string | null;
  seed: number | null;
  steps: number | null;
  guidance: number | null;
  style: string | null;
  hue: number | null;
  status: string | null;
  result_url: string | null;
  ts: number;
}

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  payload: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export interface LogRow {
  id: number;
  level: string;
  source: string | null;
  message: string;
  ts: number;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export interface ReviewRow {
  id: string;
  agent_id: string;
  reviewer_id: string;
  kind: "deliverable" | "plan" | "plan-review";
  verdict: "APPROUVÉ" | "BLOQUÉ" | "À CORRIGER" | "unknown";
  validated: number; // 0|1
  body: string;
  ts: number;
}

/** Une source réellement injectée dans le contexte d'une conversation
 *  (V15 schema). `kind` : 'editor' | 'mention' | 'rag'. */
export interface MessageSourceRow {
  conversation_id: string;
  message_id: string;
  path: string;
  kind: string;
  ts: number;
}

/** Source agrégée par chemin pour l'onglet "Sources" (kinds joints, dernier usage). */
export interface ConversationSource {
  path: string;
  /** Comma-joined kinds, ex. "editor,rag". */
  kind: string;
  ts: number;
}

/** Un fait que la mascotte retient sur l'utilisateur (V16 migration). */
export interface MascotMemoryRow {
  id: string;
  category: string;
  key: string;
  value: string;
  source: string;        // 'user' | 'extracted'
  confidence: number;
  validated: number;     // 0 | 1
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Shape mappers: UI <-> Row
// The UI shape used by ChatSidebar/SEED_CONVOS differs from the DDL row.
// ---------------------------------------------------------------------------

export interface ConvoUI {
  id: string;
  title: string;
  /** Real project the conversation belongs to (V18 FK → projects.id), or null
   *  for global/unassigned. This is the persisted scope. */
  project_id: string | null;
  /** Purely in-session sidebar organizer (pinned/custom buckets). NOT persisted
   *  — decoupled from project_id in V18; resets to "ungrouped" on reload. */
  group: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  status: "active" | "archived";
  env?: string;
  parent_id?: string | null;
  updated: number;
  children?: ConvoUI[];
}

/** Convert a DB row back to the UI shape ChatSidebar works with. */
export function rowToConvo(r: ConversationRow): ConvoUI {
  return {
    id: r.id,
    title: r.title,
    project_id: r.project_id,
    group: "ungrouped",
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    unread: r.unread === 1,
    status: r.archived === 1 ? "archived" : "active",
    env: r.env ?? undefined,
    parent_id: r.parent_id,
    updated: r.updated_at,
  };
}

/** Convert a UI convo to a DB row. Children are NOT stored here (flattened). */
export function convoToRow(c: ConvoUI): ConversationRow {
  return {
    id: c.id,
    title: c.title,
    project_id: c.project_id ?? null,
    pinned: c.pinned ? 1 : 0,
    archived: c.status === "archived" || c.archived ? 1 : 0,
    unread: c.unread ? 1 : 0,
    env: c.env ?? null,
    parent_id: c.parent_id ?? null,
    updated_at: c.updated,
  };
}

/**
 * Convert a Generation UI shape to a GenerationRow for SQLite persistence.
 * id: string coercion; ts: numeric guard; nullable fields default to null.
 */
export function toGenerationRow(g: Generation): GenerationRow {
  return {
    id: String(g.id),
    prompt: g.prompt,
    negative: g.negative ?? null,
    ratio: g.ratio ?? null,
    model: g.model ?? null,
    seed: g.seed ?? null,
    steps: g.steps ?? null,
    guidance: g.guidance ?? null,
    style: g.style ?? null,
    hue: g.hue ?? null,
    status: g.status ?? null,
    result_url: g.resultUrl ?? null,
    ts: Number(g.ts) || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

const conversations = {
  /**
   * List conversations, scoped by project.
   *   - `scope` omitted (undefined) → all conversations (backward-compatible).
   *   - `scope === null`            → only unassigned/global conversations.
   *   - `scope` a project id string → only that project's conversations.
   */
  async list(scope?: string | null): Promise<ConversationRow[]> {
    const db = await getDb();
    if (scope === undefined) {
      return db.select("SELECT * FROM conversations ORDER BY updated_at DESC") as Promise<ConversationRow[]>;
    }
    if (scope === null) {
      return db.select(
        "SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC"
      ) as Promise<ConversationRow[]>;
    }
    return db.select(
      "SELECT * FROM conversations WHERE project_id = $1 ORDER BY updated_at DESC", [scope]
    ) as Promise<ConversationRow[]>;
  },

  async get(id: string): Promise<ConversationRow | null> {
    const db = await getDb();
    const rows: ConversationRow[] = await db.select(
      "SELECT * FROM conversations WHERE id = $1 LIMIT 1", [id]
    );
    return rows[0] ?? null;
  },

  async create(row: ConversationRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR IGNORE INTO conversations
         (id, title, project_id, pinned, archived, unread, env, parent_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id, row.title, row.project_id, row.pinned, row.archived,
       row.unread, row.env, row.parent_id, row.updated_at]
    );
  },

  async rename(id: string, title: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3",
      [title, Date.now(), id]
    );
  },

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET pinned = $1, updated_at = $2 WHERE id = $3",
      [pinned ? 1 : 0, Date.now(), id]
    );
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET archived = $1, updated_at = $2 WHERE id = $3",
      [archived ? 1 : 0, Date.now(), id]
    );
  },

  /** Move a conversation to a project (or `null` to unassign / make global). */
  async setProject(id: string, projectId: string | null): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET project_id = $1, updated_at = $2 WHERE id = $3",
      [projectId, Date.now(), id]
    );
  },

  async setUnread(id: string, unread: boolean): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET unread = $1 WHERE id = $2",
      [unread ? 1 : 0, id]
    );
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
  },

  async upsertMany(rows: ConversationRow[]): Promise<void> {
    const db = await getDb();
    for (const r of rows) {
      await db.execute(
        `INSERT OR REPLACE INTO conversations
           (id, title, project_id, pinned, archived, unread, env, parent_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, r.title, r.project_id, r.pinned, r.archived,
         r.unread, r.env, r.parent_id, r.updated_at]
      );
    }
  },

  /**
   * Load all conversations and reconstruct the parent→children tree from
   * the flat parent_id foreign key. Rows with parent_id == null are top-level;
   * rows with a parent_id are attached to their parent's children[] array.
   * Orphaned rows (parent_id set but parent not found) are kept as top-level
   * rather than silently dropped. Top-level order matches list() (updated DESC).
   *
   * The existing flat list() is left untouched for callers that want flat rows.
   */
  async listNested(scope?: string | null): Promise<ConvoUI[]> {
    const rows = await conversations.list(scope);
    const byId = new Map<string, ConvoUI>();
    const ui = rows.map(rowToConvo);
    for (const c of ui) {
      byId.set(c.id, { ...c, children: [] });
    }
    const top: ConvoUI[] = [];
    for (const c of ui) {
      const node = byId.get(c.id)!;
      if (c.parent_id && byId.has(c.parent_id)) {
        byId.get(c.parent_id)!.children!.push(node);
      } else {
        top.push(node);
      }
    }
    return top;
  },
};

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

const messages = {
  async listByConversation(convId: string): Promise<MessageRow[]> {
    const db = await getDb();
    // deleted_at IS NULL → soft-delete filter applied here so that BOTH the
    // UI reader AND sendChatMessage (which calls this to build LLM history)
    // automatically exclude deleted messages without any extra guard.
    return db.select(
      "SELECT * FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY ts ASC",
      [convId]
    ) as Promise<MessageRow[]>;
  },

  async append(row: MessageRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO messages
         (id, conversation_id, role, text, body, code_lang, code_text,
          reasoning, image, ts, agent_id, via_agent,
          edited_at, deleted_at, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [row.id, row.conversation_id, row.role, row.text, row.body,
       row.code_lang, row.code_text, row.reasoning, row.image, row.ts,
       row.agent_id, row.via_agent,
       row.edited_at ?? null, row.deleted_at ?? null, row.parent_id ?? null]
    );
  },

  /** Fetch a single message row by id, or null if not found. */
  async get(id: string): Promise<MessageRow | null> {
    const db = await getDb();
    const rows: MessageRow[] = await db.select(
      "SELECT * FROM messages WHERE id = $1 LIMIT 1", [id]
    );
    return rows[0] ?? null;
  },

  /** Soft-delete a single message: sets deleted_at to now. */
  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE messages SET deleted_at = $1 WHERE id = $2",
      [Date.now(), id]
    );
  },

  /**
   * Soft-delete a message and every message in the same conversation whose ts
   * is >= the target message's ts. Used by "Regenerate from here" to prune
   * the tail of the conversation before re-sending.
   *
   * Also soft-deletes the last user message BEFORE the cut point (the prompt
   * that will be re-sent), so that `sendChatMessage` can re-append it fresh.
   * Without this, sendChatMessage would duplicate the user prompt in history.
   *
   * Returns the text of the last user message before the cut point (the prompt
   * to re-send), or null if none exists.
   */
  async softDeleteFrom(messageId: string, convId: string): Promise<MessageRow | null> {
    const db = await getDb();

    // 1. Find the target message's ts.
    const rows: MessageRow[] = await db.select(
      "SELECT * FROM messages WHERE id = $1 LIMIT 1",
      [messageId]
    );
    if (rows.length === 0) return null;
    const cutTs = rows[0].ts;

    // 2. Find the last user message before the cut point BEFORE deleting it,
    //    so we can return it to the caller for re-submission.
    const prior: MessageRow[] = await db.select(
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND role = 'user' AND ts < $2 AND deleted_at IS NULL
       ORDER BY ts DESC LIMIT 1`,
      [convId, cutTs]
    );
    const priorUserMsg = prior[0] ?? null;

    // 3. Soft-delete the tail (target + everything at or after cut point).
    const now = Date.now();
    await db.execute(
      `UPDATE messages
       SET deleted_at = $1
       WHERE conversation_id = $2 AND ts >= $3 AND deleted_at IS NULL`,
      [now, convId, cutTs]
    );

    // 4. Also soft-delete the prior user message so sendChatMessage re-appends
    //    it fresh — prevents a duplicate user turn in the conversation history.
    if (priorUserMsg) {
      await db.execute(
        "UPDATE messages SET deleted_at = $1 WHERE id = $2",
        [now, priorUserMsg.id]
      );
    }

    return priorUserMsg;
  },

  /**
   * Update the editable content of a message and stamp edited_at.
   *
   * Both `text` and `body` are updated to the new value. This covers all
   * message shapes:
   *   - User messages: text is set, body is null → text gets the edit,
   *     body stays null (null overwrite is no-op).
   *   - AI messages: body is set, text is null → both get the new value;
   *     displayBody in useMessageDisplay reads `text ?? body`, so the
   *     first non-null wins. After edit both fields hold the same string,
   *     which is consistent and never shows stale original content.
   */
  async editText(id: string, newText: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE messages SET text = $1, body = $1, edited_at = $2 WHERE id = $3",
      [newText, Date.now(), id]
    );
  },

  async removeByConversation(convId: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "DELETE FROM messages WHERE conversation_id = $1", [convId]
    );
  },
};

// ---------------------------------------------------------------------------
// projects  (V18 — the project registry, keyed by opened folder)
// ---------------------------------------------------------------------------

/** Key used by conversationCounts() for the "no project" (NULL) bucket. */
export const GLOBAL_BUCKET = "__global__";

/** Auto-assigned project dot colors (mid-ramp hexes, readable in both modes). */
const PROJECT_COLORS = [
  "#1D9E75", "#D85A30", "#378ADD", "#7F77DD", "#BA7517", "#D4537E", "#639922",
];

/** Last path segment of a folder path — the default project name. */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Canonical project key: strip the Windows extended-length prefix (`\\?\`,
 * including its `\\?\UNC\` network-share variant), convert backslashes to
 * forward slashes, drop the trailing slash. Mirrors Rust `pathutil::norm_display`
 * (which builds on `strip_extended_prefix`) so a key from `fsGetWorkspaceRoot()`
 * and one from a `studio_projects.workspace_root` (canonical Rust form) match —
 * including UNC shares, where `\\?\UNC\server\share` must collapse to
 * `//server/share` exactly like the Rust side does.
 */
export function normalizeRoot(p: string): string {
  return p
    .replace(/^\\\\\?\\UNC\\/, "\\\\") // \\?\UNC\server\share -> \\server\share
    .replace(/^\\\\\?\\/, "")          // \\?\C:\...            -> C:\...
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

const projects = {
  /** Registered projects (those with a folder), most-recently-opened first. */
  async list(): Promise<ProjectRow[]> {
    const db = await getDb();
    return db.select(
      "SELECT * FROM projects WHERE root_path IS NOT NULL ORDER BY last_opened_at DESC, sort_order ASC"
    ) as Promise<ProjectRow[]>;
  },

  async getByRoot(rootPath: string): Promise<ProjectRow | null> {
    const db = await getDb();
    const key = normalizeRoot(rootPath);
    const rows: ProjectRow[] = await db.select(
      "SELECT * FROM projects WHERE root_path = $1 LIMIT 1", [key]
    );
    return rows[0] ?? null;
  },

  /** Ensure a project exists for this folder and bump last_opened_at. Idempotent. */
  async upsertForRoot(rootPath: string): Promise<ProjectRow> {
    const db = await getDb();
    const key = normalizeRoot(rootPath);
    const now = Date.now();
    const existing = await projects.getByRoot(key);
    if (existing) {
      await db.execute("UPDATE projects SET last_opened_at = $1 WHERE id = $2", [now, existing.id]);
      return { ...existing, last_opened_at: now };
    }
    const countRows: { n: number }[] = await db.select(
      "SELECT COUNT(*) AS n FROM projects WHERE root_path IS NOT NULL"
    );
    const idx = countRows[0]?.n ?? 0;
    const row: ProjectRow = {
      id: `p-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: basename(key),
      root_path: key,
      color: PROJECT_COLORS[idx % PROJECT_COLORS.length],
      sort_order: idx,
      last_opened_at: now,
      created_at: now,
    };
    await db.execute(
      `INSERT OR IGNORE INTO projects
         (id, name, root_path, color, sort_order, last_opened_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.name, row.root_path, row.color, row.sort_order, row.last_opened_at, row.created_at]
    );
    // A concurrent writer may have inserted the same root_path (UNIQUE index):
    // re-read so both callers converge on the same row.
    return (await projects.getByRoot(key)) ?? row;
  },

  /** Active-conversation count per project id (+ GLOBAL_BUCKET for unassigned). */
  async conversationCounts(): Promise<Record<string, number>> {
    const db = await getDb();
    const rows: { project_id: string | null; n: number }[] = await db.select(
      "SELECT project_id, COUNT(*) AS n FROM conversations WHERE archived = 0 GROUP BY project_id"
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.project_id ?? GLOBAL_BUCKET] = r.n;
    return out;
  },

  async rename(id: string, name: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE projects SET name = $1 WHERE id = $2", [name, id]);
  },

  async setColor(id: string, color: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE projects SET color = $1 WHERE id = $2", [color, id]);
  },

  /**
   * One-shot, flag-guarded, best-effort reclamation of EXISTING conversations
   * into their real project. Runs POST-boot (never in the migration — avoids the
   * boot write-lock). Two steps:
   *   1. NULL out legacy `project_id` values that were ephemeral group ids (they
   *      don't map to a real project row) — otherwise those conversations would
   *      be orphaned (invisible outside "All").
   *   2. Reassign via `studio_projects` links: a studio project ties a
   *      conversation to a `workspace_root`, so we know its real folder.
   * Conversations with no studio link stay NULL → "Global" (honest limit).
   */
  async backfillFromStudio(): Promise<void> {
    const db = await getDb();
    if ((await settings.get("projects_backfill_done")) === "1") return;
    try {
      await db.execute(
        `UPDATE conversations SET project_id = NULL
           WHERE project_id IS NOT NULL
             AND project_id NOT IN (SELECT id FROM projects WHERE root_path IS NOT NULL)`
      );
      const links: { conversation_id: string; workspace_root: string }[] = await db.select(
        `SELECT DISTINCT conversation_id, workspace_root FROM studio_projects
           WHERE conversation_id IS NOT NULL AND workspace_root IS NOT NULL AND deleted_at IS NULL`
      );
      for (const l of links) {
        const proj = await projects.upsertForRoot(l.workspace_root);
        await db.execute(
          "UPDATE conversations SET project_id = $1 WHERE id = $2 AND project_id IS NULL",
          [proj.id, l.conversation_id]
        );
      }
      await settings.set("projects_backfill_done", "1");
    } catch (e) {
      console.error("[projects] backfill failed (will retry next boot):", e);
    }
  },
};

// ---------------------------------------------------------------------------
// generations
// ---------------------------------------------------------------------------

const generations = {
  async list(): Promise<GenerationRow[]> {
    const db = await getDb();
    return db.select("SELECT * FROM generations ORDER BY ts DESC") as Promise<GenerationRow[]>;
  },

  async create(row: GenerationRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR IGNORE INTO generations
         (id, prompt, negative, ratio, model, seed, steps, guidance, style, hue, status, result_url, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [row.id, row.prompt, row.negative, row.ratio, row.model,
       row.seed, row.steps, row.guidance, row.style, row.hue,
       row.status, row.result_url, row.ts]
    );
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM generations WHERE id = $1", [id]);
  },

  async upsertMany(rows: GenerationRow[]): Promise<void> {
    const db = await getDb();
    for (const r of rows) {
      await db.execute(
        `INSERT OR REPLACE INTO generations
           (id, prompt, negative, ratio, model, seed, steps, guidance, style, hue, status, result_url, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [r.id, r.prompt, r.negative, r.ratio, r.model,
         r.seed, r.steps, r.guidance, r.style, r.hue,
         r.status, r.result_url, r.ts]
      );
    }
  },
};

// ---------------------------------------------------------------------------
// jobs  (V2 migration)
// ---------------------------------------------------------------------------

const jobs = {
  async list(filter?: { status?: string; kind?: string }): Promise<JobRow[]> {
    const db = await getDb();
    if (filter?.status && filter?.kind) {
      return db.select(
        "SELECT * FROM jobs WHERE status = $1 AND kind = $2 ORDER BY created_at DESC",
        [filter.status, filter.kind]
      ) as Promise<JobRow[]>;
    }
    if (filter?.status) {
      return db.select(
        "SELECT * FROM jobs WHERE status = $1 ORDER BY created_at DESC",
        [filter.status]
      ) as Promise<JobRow[]>;
    }
    if (filter?.kind) {
      return db.select(
        "SELECT * FROM jobs WHERE kind = $1 ORDER BY created_at DESC",
        [filter.kind]
      ) as Promise<JobRow[]>;
    }
    return db.select("SELECT * FROM jobs ORDER BY created_at DESC") as Promise<JobRow[]>;
  },

  async get(id: string): Promise<JobRow | null> {
    const db = await getDb();
    const rows: JobRow[] = await db.select(
      "SELECT * FROM jobs WHERE id = $1 LIMIT 1", [id]
    );
    return rows[0] ?? null;
  },

  async create(row: JobRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR IGNORE INTO jobs
         (id, kind, status, payload, result, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.kind, row.status, row.payload, row.result,
       row.created_at, row.updated_at]
    );
  },

  async setStatus(id: string, status: string, result?: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE jobs SET status = $1, result = $2, updated_at = $3 WHERE id = $4",
      [status, result ?? null, Date.now(), id]
    );
  },
};

// ---------------------------------------------------------------------------
// logs  (V2 migration)
// ---------------------------------------------------------------------------

const logs = {
  async recent(limit = 200): Promise<LogRow[]> {
    const db = await getDb();
    return db.select(
      "SELECT * FROM logs ORDER BY ts DESC LIMIT $1", [limit]
    ) as Promise<LogRow[]>;
  },

  async append(level: string, source: string | null, message: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "INSERT INTO logs (level, source, message, ts) VALUES ($1, $2, $3, $4)",
      [level, source, message, Date.now()]
    );
  },
};

// ---------------------------------------------------------------------------
// settings  (V2 migration)
// ---------------------------------------------------------------------------

const settings = {
  async get(key: string): Promise<string | null> {
    const db = await getDb();
    const rows: SettingRow[] = await db.select(
      "SELECT value FROM settings WHERE key = $1 LIMIT 1", [key]
    );
    return rows[0]?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
       VALUES ($1, $2, $3)`,
      [key, value, Date.now()]
    );
  },

  async all(): Promise<SettingRow[]> {
    const db = await getDb();
    return db.select("SELECT * FROM settings") as Promise<SettingRow[]>;
  },
};

// ---------------------------------------------------------------------------
// stats — real, live counts for the account/profile card
//
// Local-first: these are honest numbers read straight from SQLite (the source
// of truth), NOT a fabricated subscription quota. Used by the profile card's
// "Activité locale" panel. Kept here so the account card stays free of raw SQL.
// ---------------------------------------------------------------------------

export interface LocalCounts {
  conversations: number;
  messages: number;
  images: number;
}

const stats = {
  async counts(): Promise<LocalCounts> {
    const database = await getDb();
    const scalar = async (sql: string): Promise<number> => {
      const rows = (await database.select(sql)) as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    };
    // Sequential to match the plugin's single-connection usage elsewhere in
    // this module; the three counts are cheap COUNT(*) index scans.
    const conversations = await scalar("SELECT COUNT(*) AS n FROM conversations");
    const messages = await scalar("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL");
    const images = await scalar("SELECT COUNT(*) AS n FROM generations");
    return { conversations, messages, images };
  },
};

// ---------------------------------------------------------------------------
// reviews  (V13 migration — agent_reviews)
// ---------------------------------------------------------------------------

const reviews = {
  async save(row: ReviewRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO agent_reviews
         (id, agent_id, reviewer_id, kind, verdict, validated, body, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.id, row.agent_id, row.reviewer_id, row.kind, row.verdict,
       row.validated, row.body, row.ts]
    );
  },

  async getByAgent(agentId: string): Promise<ReviewRow[]> {
    const db = await getDb();
    return db.select(
      "SELECT * FROM agent_reviews WHERE agent_id = $1 ORDER BY ts DESC",
      [agentId]
    ) as Promise<ReviewRow[]>;
  },

  async recent(limit: number): Promise<ReviewRow[]> {
    const db = await getDb();
    return db.select(
      "SELECT * FROM agent_reviews ORDER BY ts DESC LIMIT $1",
      [limit]
    ) as Promise<ReviewRow[]>;
  },

  async setValidatedByReviewer(reviewerId: string, validated: number): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE agent_reviews SET validated = $1 WHERE reviewer_id = $2",
      [validated, reviewerId]
    );
  },

  /** Current `validated` flag (0|1) of a deliverable review, or null if absent.
   *  Lets the UI reflect the auto (R3) state before a manual 👍/👎. */
  async getValidatedByReviewer(reviewerId: string): Promise<number | null> {
    const db = await getDb();
    const rows = (await db.select(
      "SELECT validated FROM agent_reviews WHERE reviewer_id = $1 AND kind = 'deliverable' LIMIT 1",
      [reviewerId]
    )) as Array<{ validated: number }>;
    return rows.length > 0 ? rows[0].validated : null;
  },
};

// ---------------------------------------------------------------------------
// message_sources — vraies sources injectées par conversation (onglet "Sources")
// ---------------------------------------------------------------------------

const sources = {
  /**
   * Enregistre les sources réellement injectées pour un message user.
   * Idempotent par (message_id, path, kind) via INSERT OR IGNORE — renvoyer le
   * même message deux fois (régénération) ne duplique pas.
   */
  async record(
    convId: string,
    messageId: string,
    entries: { path: string; kind: string }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const database = await getDb();
    const ts = Date.now();
    for (const e of entries) {
      await database.execute(
        `INSERT OR IGNORE INTO message_sources
           (conversation_id, message_id, path, kind, ts)
         VALUES ($1, $2, $3, $4, $5)`,
        [convId, messageId, e.path, e.kind, ts],
      );
    }
  },

  /** Sources distinctes d'une conversation, plus récemment utilisées d'abord. */
  async listByConversation(convId: string): Promise<ConversationSource[]> {
    const database = await getDb();
    return database.select(
      `SELECT path, GROUP_CONCAT(DISTINCT kind) AS kind, MAX(ts) AS ts
         FROM message_sources
        WHERE conversation_id = $1
        GROUP BY path
        ORDER BY ts DESC`,
      [convId],
    ) as Promise<ConversationSource[]>;
  },
};

// ---------------------------------------------------------------------------
// mascotMemory  (V16 migration — faits appris sur l'utilisateur)
// ---------------------------------------------------------------------------

const mascotMemory = {
  async list(category?: string, validatedOnly = false): Promise<MascotMemoryRow[]> {
    const dbh = await getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (category) { args.push(category); where.push(`category = $${args.length}`); }
    if (validatedOnly) where.push("validated = 1");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return dbh.select(
      `SELECT * FROM mascot_memory ${clause} ORDER BY category, updated_at DESC`,
      args
    ) as Promise<MascotMemoryRow[]>;
  },

  /**
   * Insère un fait, ou met à jour celui de même `id` SANS toucher `created_at`
   * (préservé par le SQL via ON CONFLICT — pas de read-modify-write en JS).
   */
  async upsert(row: MascotMemoryRow): Promise<void> {
    const dbh = await getDb();
    await dbh.execute(
      `INSERT INTO mascot_memory
         (id, category, key, value, source, confidence, validated, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(id) DO UPDATE SET
         category   = excluded.category,
         key        = excluded.key,
         value      = excluded.value,
         source     = excluded.source,
         confidence = excluded.confidence,
         validated  = excluded.validated,
         updated_at = excluded.updated_at`,
      [row.id, row.category, row.key, row.value, row.source,
       row.confidence, row.validated, row.created_at, row.updated_at]
    );
  },

  async remove(id: string): Promise<void> {
    const dbh = await getDb();
    await dbh.execute("DELETE FROM mascot_memory WHERE id = $1", [id]);
  },

  /** Promeut un fait à « validé ». Préserve la `confidence` enregistrée
   *  (la validation utilisateur est déjà portée par `validated = 1`). */
  async setValidated(id: string, updatedAt: number): Promise<void> {
    const dbh = await getDb();
    await dbh.execute(
      "UPDATE mascot_memory SET validated = 1, updated_at = $1 WHERE id = $2",
      [updatedAt, id]
    );
  },
};

// ---------------------------------------------------------------------------
// Public repository facade
// ---------------------------------------------------------------------------

export const db = {
  conversations,
  messages,
  projects,
  generations,
  jobs,
  logs,
  settings,
  stats,
  reviews,
  sources,
  mascotMemory,

  /**
   * Wipe all user-generated data from the local SQLite database.
   * Clears: messages, conversations, projects, generations, jobs, logs,
   *         agents, agent_events, message_sources, mascot_memory.
   * `mascot_memory` (ce que la mascotte a appris sur l'utilisateur) est inclus :
   * c'est la donnée la plus personnelle de la feature, « effacer mes données »
   * doit l'effacer aussi.
   * Settings are intentionally preserved (provider keys, preferences, etc.)
   * so the user's configuration survives a data reset.
   *
   * After this call, callers must invalidate all relevant TanStack queries so
   * the UI reflects the empty state — see the "Effacer" button in views-code.tsx.
   */
  async clearAll(): Promise<void> {
    const database = await getDb();
    // Delete in FK-safe order: children before parents.
    await database.execute("DELETE FROM agent_events");
    await database.execute("DELETE FROM agents");
    await database.execute("DELETE FROM message_sources");
    await database.execute("DELETE FROM messages");
    await database.execute("DELETE FROM conversations");
    await database.execute("DELETE FROM projects");
    await database.execute("DELETE FROM generations");
    await database.execute("DELETE FROM jobs");
    await database.execute("DELETE FROM logs");
    await database.execute("DELETE FROM mascot_memory");
  },
};

// ---------------------------------------------------------------------------
// seedIfEmpty — bootstrap a fresh Tauri DB with prototype data
//
// NOTE: import SEED_CONVOS / SEED_GROUPS from chat-sidebar at call sites
// (circular-import safe because they are plain data, no hooks).
// This function is called from ChatSidebar and RootLayout on mount.
//
// Children in SEED_CONVOS (e.g. c6.children) are flattened into top-level
// rows with parent_id set. Re-nesting on read-back is not implemented yet —
// the sidebar renders them as top-level items when loaded from SQLite.
// TODO: reconstruct children array from parent_id on read.
// ---------------------------------------------------------------------------

export async function seedIfEmpty(): Promise<void> {
  const database = await getDb();

  const existing: ConversationRow[] = await database.select(
    "SELECT id FROM conversations LIMIT 1"
  );
  const conversationsAlreadySeeded = existing.length > 0;

  if (!conversationsAlreadySeeded) {
    // Lazy-import seed data to avoid circular dependency at module level
    const { SEED_CONVOS } = await import("@/features/chat/chat-sidebar");

    // Flatten conversations (including children with parent_id)
    const allConvos: ConvoUI[] = [];
    for (const c of SEED_CONVOS) {
      allConvos.push(c);
      if (c.children) {
        for (const child of c.children) {
          allConvos.push({ ...child, parent_id: c.id });
        }
      }
    }

    await conversations.upsertMany(allConvos.map(convoToRow));
    // (Le seed des 18 fausses générations dans `generations` a été retiré —
    //  la galerie part désormais honnêtement vide.)
  }

  // ─── Seed messages for the c1 conversation if it has none yet ──────────
  //
  // This is conditional on c1's per-conversation emptiness, NOT on the
  // global messages table being empty (per M4 advisor note #4). Rationale:
  // a user who has chatted in other conversations might still have an
  // untouched c1; we want to seed it so the prototype demo content renders
  // on first open. We do NOT overwrite an existing c1 conversation — if
  // the user has already written messages there, leave them alone.
  const c1Exists = await database.select(
    "SELECT id FROM conversations WHERE id = $1 LIMIT 1",
    ["c1"]
  );
  if (c1Exists.length > 0) {
    const c1Messages = await database.select(
      "SELECT id FROM messages WHERE conversation_id = $1 LIMIT 1",
      ["c1"]
    );
    if (c1Messages.length === 0) {
      const { seedMessages } = await import("@/mocks/seedMessages");
      // Spread the seed messages over a 60-second window ending now, so
      // the read-back ORDER BY ts ASC preserves the prototype's narrative
      // sequence. Original seed used "14:30"/"14:31" string timestamps —
      // we lose the absolute clock value but keep the relative order.
      const base = Date.now() - 60_000;
      const messageRows: MessageRow[] = seedMessages.map((m, i) => ({
        id: String(m.id),
        conversation_id: "c1",
        role: m.role,
        reasoning: null,
        agent_id: null,
        via_agent: 0,
        text: m.text ?? null,
        body: m.body ?? null,
        code_lang: m.code?.lang ?? null,
        code_text: m.code?.text ?? null,
        image: m.image ? 1 : 0,
        ts: base + i * 1000,
        // V6 columns — all null for seed data (messages start unedited, undeleted)
        edited_at: null,
        deleted_at: null,
        parent_id: null,
      }));
      for (const row of messageRows) {
        await messages.append(row);
      }
    }
  }
}
