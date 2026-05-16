// Safe Tauri invoke wrapper.
// In a Tauri webview, delegates to @tauri-apps/api/core::invoke.
// In a plain browser (`pnpm dev` web mode), returns a mock that the UI can still consume.

import { seedFileTree } from "@/mocks/seedFileTree";
import { seedFileContents } from "@/mocks/seedFileContents";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mocks: Record<string, (args?: any) => any> = {
  models_list: () => ([
    { id: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5", protocol: "anthropic" },
    { id: "anthropic/claude-sonnet-5",  label: "claude-sonnet-5",  protocol: "anthropic" },
    { id: "openai/gpt-4o-mini",         label: "gpt-4o-mini",      protocol: "openai" },
    { id: "ollama/qwen2.5:32b",         label: "qwen2.5:32b",      protocol: "ollama" },
  ]),
  fs_read_dir: () => seedFileTree,
  fs_read_file: ({ path }: { path: string }) => (seedFileContents as any)[path]?.text ?? "",
  fs_write_file: () => ({ ok: true }),
  term_spawn: () => undefined,
  term_write: () => undefined,
  term_resize: () => undefined,
  term_kill: () => undefined,
  term_snapshot: () => "",
  // Credentials backend — in Tauri these hit the OS keychain; in web mode we
  // mirror to a sessionStorage map so the in-app config flow still works for
  // demos. NEVER use this storage for anything that matters; it is plainly
  // visible in DevTools and survives only as long as the tab.
  cred_set: ({ account, secret }: { account: string; secret: string }) => {
    try { sessionStorage.setItem("shugu.cred.web::" + account, secret); } catch { /* quota */ }
    return null;
  },
  cred_get: ({ account }: { account: string }) => {
    try { return sessionStorage.getItem("shugu.cred.web::" + account); } catch { return null; }
  },
  cred_delete: ({ account }: { account: string }) => {
    try { sessionStorage.removeItem("shugu.cred.web::" + account); } catch { /* noop */ }
    return null;
  },
  chat_send: ({ messages, model, protocol, baseUrl }: { messages: Array<{role: string; content: string}>; model: string; protocol: string; baseUrl: string }) => {
    void baseUrl;
    const keyHint = protocol === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : protocol === "openai"
        ? "OPENAI_API_KEY"
        : protocol === "ollama"
          ? "a running Ollama daemon"
          : "the provider key";
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";
    return `(${protocol} · ${model}, ${messages.length} msgs in history) mock reply — set ${keyHint} and run in Tauri for a real response. You said: "${prompt.slice(0, 80)}"`;
  },
  image_generate: ({ prompt, ratio, model, protocol, baseUrl, seed, steps, guidance, style }: { prompt: string; ratio: string; model: string; protocol: string; baseUrl: string; seed: number; steps: number; guidance: number; style: string }) => {
    void baseUrl;
    const hhmm = (() => { const d = new Date(); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; })();
    const hue = [...prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return { id: "img-" + Date.now(), prompt, ratio, model, seed, steps, guidance, style, hue, ts: hhmm, status: `done (mock · ${protocol})`, resultUrl: null };
  },
};

export async function invoke<T = unknown>(cmd: string, args?: any): Promise<T> {
  if (inTauri) {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke<T>(cmd, args);
  }
  const fn = mocks[cmd];
  if (!fn) throw new Error(`[mock invoke] unknown command "${cmd}"`);
  return fn(args) as T;
}

export async function listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (inTauri) {
    const mod = await import("@tauri-apps/api/event");
    const unlisten = await mod.listen<T>(event, (e) => handler(e.payload));
    return unlisten;
  }
  // No-op in web mode (would need an in-memory event bus to simulate streaming).
  void event; void handler;
  return () => {};
}
