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

export interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
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

// ---------------------------------------------------------------------------
// Shape mappers: UI <-> Row
// The UI shape used by ChatSidebar/SEED_CONVOS differs from the DDL row.
// ---------------------------------------------------------------------------

export interface ConvoUI {
  id: string;
  title: string;
  group: string;          // maps to project_id (null → "ungrouped")
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
    group: r.project_id ?? "ungrouped",
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
    project_id: c.group === "ungrouped" ? null : c.group,
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
    negative: null,
    ratio: g.ratio ?? null,
    model: g.model ?? null,
    seed: g.seed ?? null,
    steps: g.steps ?? null,
    guidance: g.guidance ?? null,
    style: g.style ?? null,
    hue: g.hue ?? null,
    status: null,
    result_url: null,
    ts: Number(g.ts) || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

const conversations = {
  async list(): Promise<ConversationRow[]> {
    const db = await getDb();
    return db.select("SELECT * FROM conversations ORDER BY updated_at DESC") as Promise<ConversationRow[]>;
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

  async setGroup(id: string, groupId: string): Promise<void> {
    const db = await getDb();
    const project_id = groupId === "ungrouped" ? null : groupId;
    await db.execute(
      "UPDATE conversations SET project_id = $1, updated_at = $2 WHERE id = $3",
      [project_id, Date.now(), id]
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
  async listNested(): Promise<ConvoUI[]> {
    const rows = await conversations.list();
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
// projects
// ---------------------------------------------------------------------------

const projects = {
  async list(): Promise<ProjectRow[]> {
    const db = await getDb();
    return db.select("SELECT * FROM projects ORDER BY created_at DESC") as Promise<ProjectRow[]>;
  },

  async create(row: ProjectRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      "INSERT OR IGNORE INTO projects (id, name, created_at) VALUES ($1, $2, $3)",
      [row.id, row.name, row.created_at]
    );
  },

  async rename(id: string, name: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE projects SET name = $1 WHERE id = $2", [name, id]);
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM projects WHERE id = $1", [id]);
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

  /**
   * Wipe all user-generated data from the local SQLite database.
   * Clears: messages, conversations, projects, generations, jobs, logs,
   *         agents, agent_events.
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
    await database.execute("DELETE FROM messages");
    await database.execute("DELETE FROM conversations");
    await database.execute("DELETE FROM projects");
    await database.execute("DELETE FROM generations");
    await database.execute("DELETE FROM jobs");
    await database.execute("DELETE FROM logs");
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
    const [{ SEED_CONVOS }, { seedGenerations }] = await Promise.all([
      import("@/features/chat/chat-sidebar"),
      import("@/mocks/seedGenerations"),
    ]);

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

    // Seed generations — coerce types to match DDL (id: TEXT, ts: INTEGER)
    const genRows: GenerationRow[] = seedGenerations.map((g, i) => ({
      id: String(g.id),
      prompt: g.prompt,
      negative: null,
      ratio: g.ratio ?? null,
      model: g.model ?? null,
      seed: g.seed ?? null,
      steps: g.steps ?? null,
      guidance: g.guidance ?? null,
      style: g.style ?? null,
      hue: g.hue ?? null,
      status: null,
      result_url: null,
      ts: Date.now() - (18 - i) * 60_000,
    }));

    await generations.upsertMany(genRows);
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
