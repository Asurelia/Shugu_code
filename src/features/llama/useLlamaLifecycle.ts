// Auto-stop / auto-start llama-server based on the active chat model.
//
// User decision (2026-05-17): "Auto-stop si chat est API". The rationale
// is that keeping llama-server alive while the chat actually talks to a
// remote API just squats ~1 GB of VRAM for nothing. We start it when the
// user picks a `llamacpp/*` model and stop it as soon as they pick
// anything else (anthropic, openai, groq, custom, …).
//
// Mount this hook ONCE per app instance — in the main IDE root only.
// The mascot window shares `useActiveModel` via localStorage + storage
// events, so it will see the same model id; but it MUST NOT mount this
// hook too or both windows would race on start/stop calls.
//
// Edge cases handled:
//   - Initial mount before model has loaded → skip (model is empty).
//   - Boot race with `llama_autostart` triggered from lib.rs::setup —
//     idempotent on both sides (Rust early-returns if already running;
//     stopping a non-running server is a no-op).
//   - Rapid switching between two API models → consecutive stop calls
//     hit a server already dead, both succeed cleanly.
//   - Network errors talking to the Rust side → logged, not rethrown
//     (we don't want to crash the chat surface over a llama failure).

import { useEffect } from "react";
import { useActiveModel } from "@/features/chat/chat-sync";
import { startLlama, stopLlama, getLlamaStatus } from "@/lib/llamaLifecycle";

export function useLlamaLifecycle(): void {
  const [model] = useActiveModel();

  useEffect(() => {
    if (!model) return;
    // The `llamacpp/` prefix is the registry key in `PROVIDER_REGISTRY`;
    // anything else (anthropic, openai, ollama, mistral, groq, custom-XXX)
    // means the chat talks over the network, not to a local server.
    const isLocalModel = model.startsWith("llamacpp/");

    let cancelled = false;
    void (async () => {
      try {
        const status = await getLlamaStatus();
        if (cancelled) return;
        if (isLocalModel && !status.running) {
          await startLlama();
        } else if (!isLocalModel && status.running) {
          await stopLlama();
        }
      } catch (err) {
        // Llama lifecycle is best-effort. Failing to stop just means the
        // VRAM stays squatted; failing to start means the next chat send
        // will get an HTTP connect error and surface a clean message.
        console.warn("[useLlamaLifecycle] sync failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [model]);
}
