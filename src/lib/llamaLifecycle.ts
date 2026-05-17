// Shugu Forge — thin TS wrappers around the Rust llama-server lifecycle
// commands. The Rust side is in `src-tauri/src/commands/llama.rs`; this
// file only exists so consumers don't have to know the exact `invoke`
// names + payload shapes.
//
// Three operations:
//   - `startLlama()`   : idempotent. Spawns llama-server with the
//                       bundled-model defaults (Vulkan when available,
//                       CPU fallback). No-op if already running.
//   - `stopLlama()`    : kills the spawned llama-server (Drop on the
//                       Child handle). No-op if nothing was running.
//   - `getLlamaStatus()` : probes the HTTP endpoint to see if a server
//                       is alive on the configured port — covers both
//                       Shugu-spawned and external instances.
//
// Used by `useLlamaLifecycle()` to sync the server with whatever chat
// model the user picked: a local llama model needs the server up, any
// remote API model can let it sleep to free VRAM.

import { invoke } from "@/lib/tauri";

export interface LlamaStatus {
  running: boolean;
  port?: number;
  pid?: number;
  binary?: string;
  modelPath?: string;
  backend?: string;
}

export async function startLlama(): Promise<LlamaStatus> {
  return invoke<LlamaStatus>("llama_autostart");
}

export async function stopLlama(): Promise<LlamaStatus> {
  return invoke<LlamaStatus>("llama_stop");
}

export async function getLlamaStatus(): Promise<LlamaStatus> {
  return invoke<LlamaStatus>("llama_status");
}
