// Tauri invoke / event wrappers — thin re-exports.
//
// Shugu Forge ships as a Tauri desktop app exclusively. The previous "web
// mode" fallback (mocks table + sessionStorage credential map) was dropped
// because we use `pnpm tauri dev` for every iteration and the duality was
// pure cognitive overhead — every new IPC call had to ship a matching mock,
// and a stray `inTauri` check on a hot path could silently bypass the real
// backend.
//
// The functions stay in this module (instead of importing `@tauri-apps/api`
// directly at every call site) so import paths stay short and one file
// owns the dynamic import boundary — Vite tree-shakes the Tauri API into
// the webview bundle the same way either way.

export async function invoke<T = unknown>(cmd: string, args?: any): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

export async function listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const mod = await import("@tauri-apps/api/event");
  const unlisten = await mod.listen<T>(event, (e) => handler(e.payload));
  return unlisten;
}
