/**
 * Local SQLite persistence layer via tauri-plugin-sql.
 * In Tauri: lazy-loads Database and runs against sqlite:shugu.db (migrations run at startup).
 * In web mode (plain browser): all functions no-op / return empty arrays.
 *
 * Do NOT import Database statically — dynamic import only so the web bundle
 * never tries to resolve the native Tauri plugin module.
 */

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

let _dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database | null> {
  if (!inTauri) return null;
  if (!_dbPromise) {
    _dbPromise = import("@tauri-apps/plugin-sql").then((mod) =>
      mod.default.load("sqlite:shugu.db")
    );
  }
  return _dbPromise;
}

// ---------------------------------------------------------------------------
// Row types — mirror the DDL in src-tauri/src/lib.rs
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  title: string;
  project_id: string | null;
  pinned: number;      // 0 | 1
  archived: number;    // 0 | 1
  unread: number;      // 0 | 1
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
  image: number;       // 0 | 1
  ts: number;
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

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function cacheConversations(rows: ConversationRow[]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  for (const r of rows) {
    await db.execute(
      `INSERT OR REPLACE INTO conversations
         (id, title, project_id, pinned, archived, unread, env, parent_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.id, r.title, r.project_id, r.pinned, r.archived, r.unread, r.env, r.parent_id, r.updated_at]
    );
  }
}

export async function loadCachedConversations(): Promise<ConversationRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select(
    "SELECT * FROM conversations ORDER BY updated_at DESC"
  ) as Promise<ConversationRow[]>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function cacheMessages(conversationId: string, rows: MessageRow[]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  for (const r of rows) {
    await db.execute(
      `INSERT OR REPLACE INTO messages
         (id, conversation_id, role, text, body, code_lang, code_text, image, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.id, conversationId, r.role, r.text, r.body, r.code_lang, r.code_text, r.image, r.ts]
    );
  }
}

export async function loadCachedMessages(conversationId: string): Promise<MessageRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY ts ASC",
    [conversationId]
  ) as Promise<MessageRow[]>;
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

export async function cacheGenerations(rows: GenerationRow[]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  for (const r of rows) {
    await db.execute(
      `INSERT OR REPLACE INTO generations
         (id, prompt, negative, ratio, model, seed, steps, guidance, style, hue, status, result_url, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [r.id, r.prompt, r.negative, r.ratio, r.model, r.seed, r.steps, r.guidance, r.style, r.hue, r.status, r.result_url, r.ts]
    );
  }
}

export async function loadCachedGenerations(): Promise<GenerationRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select(
    "SELECT * FROM generations ORDER BY ts DESC"
  ) as Promise<GenerationRow[]>;
}
