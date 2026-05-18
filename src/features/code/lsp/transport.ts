// Shugu Forge — Tauri Transport adapter for @codemirror/lsp-client (LOT 3).
//
// Le LSPClient de @codemirror/lsp-client attend un Transport simple :
//   { send(msg), subscribe(handler), unsubscribe(handler) }
// L'exemple officiel utilise un WebSocket, mais Tauri nous donne mieux :
// un canal IPC bidirectionnel via `invoke('lsp_send')` (JS → Rust → stdin
// du LSP server) + `listen('lsp://msg')` (Rust → JS, déjà framé/unframed
// côté Rust). Pas de port à exposer, pas de handshake WebSocket, pas de
// problème de CSP — tout passe par le canal Tauri.
//
// Architecture :
//   - Au create(langId), on attache UN listener Tauri global qui filtre par
//     langId (utile car plusieurs LSP servers cohabitent : ts + rust + py).
//   - subscribe/unsubscribe gèrent un Set de handlers locaux à ce Transport.
//   - send → invoke('lsp_send', { langId, message }).
//   - dispose() détache le listener Tauri (à appeler quand le client est
//     disconnect()-ed pour éviter de retenir une référence morte).
//
// Sécurité : le `message` est une string JSON-RPC déjà sérialisée par
// LSPClient ; le backend Rust ne parse PAS ce JSON (juste framing
// Content-Length + écriture sur stdin). Aucune surface d'injection.

import type { Transport } from "@codemirror/lsp-client";
import { invoke, listen } from "@/lib/tauri";
import { diag } from "@/lib/diag";

/** Transport étendu avec dispose() pour cleanup du listener Tauri. */
export interface TauriLspTransport extends Transport {
  /** Détache le listener Tauri. Appeler après LSPClient.disconnect(). */
  dispose(): void;
}

export async function createTauriTransport(langId: string): Promise<TauriLspTransport> {
  const handlers = new Set<(msg: string) => void>();

  const unlisten = await listen<{ langId: string; message: string }>(
    "lsp://msg",
    (payload) => {
      // Filtre par langId : un seul listener pour tous les LSP, mais
      // chaque Transport ne reçoit QUE les messages de son langage.
      if (payload.langId !== langId) return;
      // Ne pas itérer sur handlers directement (mutation possible pendant
      // l'itération si un handler unsubscribe lui-même). Copie défensive.
      for (const h of Array.from(handlers)) {
        try {
          h(payload.message);
        } catch (err) {
          diag("lsp", `${langId} handler threw: ${String(err)}`);
        }
      }
    },
  );

  return {
    send: (message: string) => {
      void invoke("lsp_send", { langId, message }).catch((err) => {
        diag("lsp", `${langId} send failed: ${String(err)}`);
      });
    },
    subscribe: (h) => {
      handlers.add(h);
    },
    unsubscribe: (h) => {
      handlers.delete(h);
    },
    dispose: () => {
      unlisten();
      handlers.clear();
    },
  };
}
