// Shugu Forge — LSP client factory + cache (LOT 3).
//
// Module-level cache des LSPClient instances, une par langId. Le client
// est partagé entre tous les fichiers ouverts du même langage (ex. tous
// les .ts utilisent le même typescript-language-server).
//
// API publique :
//   - isLspSupported(langId) → boolean (avant de tenter une init).
//   - getLspClient(langId) → Promise<{ client, workspaceUri } | null>.
//     null = unsupported OU init failed (binaire absent). Le caller doit
//     gérer ce null en montrant l'éditeur SANS LSP (graceful degradation).
//   - disconnectAllClients() → Promise<void> : à appeler quand on change
//     de workspace (le workspaceUri devient invalide pour tous les clients).
//
// Politique TanStack : le cache des LSPClient est PAS un useQuery (les
// LSPClient sont des objets stateful avec connexion vivante, pas des
// snapshots de données). useQuery est utilisé en LOT 3 plus loin pour
// CACHER les RÉPONSES LSP (hover, definition) — voir keys.ts.

import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";
import { invoke, listen } from "@/lib/tauri";
import { diag } from "@/lib/diag";
import { createTauriTransport, type TauriLspTransport } from "./transport";

/**
 * Format defensif d'une erreur de provenance inconnue (peut être Error,
 * string, JSON-RPC error object {code, message}, etc.). Sans ça, un
 * `String(err)` sur un objet plain produit "[object Object]" qui masque
 * l'erreur réelle (smoke test feedback : LSP TS initialize failed
 * affichait juste "[object Object]" sans aucune info utile).
 *
 * Exporté pour réutilisation depuis les call sites externes (e.g.
 * CodeMirrorEditor.tsx qui catch une erreur de dispatch LSP).
 */
export function fmtErr(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    // JSON-RPC error : { code, message, data? }
    const obj = err as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string") {
      return typeof obj.code === "number"
        ? `[${obj.code}] ${obj.message}`
        : obj.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Langages pour lesquels on tente une init LSP. Évite un round-trip Rust
 *  pour les langages non supportés. Doit rester en phase avec la
 *  `resolve_lsp_binary` de src-tauri/src/commands/lsp.rs. */
const SUPPORTED_LANG_IDS = new Set(["typescript", "javascript", "rust", "python"]);

export function isLspSupported(langId: string): boolean {
  return SUPPORTED_LANG_IDS.has(langId);
}

interface CachedClient {
  client: LSPClient;
  workspaceUri: string;
  transport: TauriLspTransport;
}

const clients = new Map<string, CachedClient>();

/**
 * Map des inits en cours. Permet à des appels concurrents de
 * `getLspClient(sameLangId)` de partager la MÊME promise au lieu de
 * spawn plusieurs LSP servers (BLOCKING #B1 reviewer #1 LOT 3).
 *
 * Sans cette map, deux fichiers `.ts` ouverts simultanément (split view
 * ou Cmd+Shift+F qui ouvre 2 résultats) déclenchaient deux `clients.set`
 * concurrents — le perdant restait souscrit à `lsp://msg` et causait du
 * double-dispatch sur chaque réponse hover/completion/diagnostic.
 */
const inProgressInits = new Map<
  string,
  Promise<{ client: LSPClient; workspaceUri: string } | null>
>();

async function doInit(
  langId: string,
): Promise<{ client: LSPClient; workspaceUri: string } | null> {
  // Spawn le LSP server côté Rust + récupère le workspaceUri.
  let workspaceUri: string;
  try {
    const result = await invoke<{ workspaceUri: string }>("lsp_init", {
      args: { langId },
    });
    workspaceUri = result.workspaceUri;
  } catch (err) {
    // Binaire pas installé OU pas de workspace ouvert OU spawn failed.
    // C'est le cas "gracieux" — le caller affiche l'éditeur sans LSP.
    diag("lsp", `init failed for ${langId}: ${fmtErr(err)}`);
    return null;
  }

  // Wire le Transport + le LSPClient.
  const transport = await createTauriTransport(langId);
  const client = new LSPClient({
    rootUri: workspaceUri,
    extensions: languageServerExtensions(),
    // Note : sanitizeHTML omis pour LOT 3 MVP. Les hover/diagnostics LSP
    // peuvent retourner du markdown rendu en HTML — sans sanitize, on est
    // vulnérables à un LSP malveillant qui injecterait du JS via hover.
    // Mitigation : on ne lance QUE des LSP servers résolus via which()
    // (donc installés par l'utilisateur, pas par Shugu). Risk acceptable
    // pour MVP, à ajouter DOMPurify en hardening.
  });

  try {
    client.connect(transport);
    await client.initializing;
    diag("lsp", `${langId} ready (rootUri=${workspaceUri})`);
  } catch (err) {
    diag("lsp", `${langId} initialize failed: ${fmtErr(err)}`);
    transport.dispose();
    return null;
  }

  // Insère atomically (un seul caller arrive ici via la garde inProgressInits).
  clients.set(langId, { client, workspaceUri, transport });
  return { client, workspaceUri };
}

/**
 * Obtient (ou crée) un LSPClient pour `langId`. Si la langue n'est pas
 * supportée ou si le binaire LSP n'est pas trouvé, retourne null —
 * l'éditeur fonctionne alors sans intellisense pour ce fichier.
 *
 * Le client est cached module-level : tous les fichiers du même langage
 * partagent la même instance (cohérent avec le pattern LSP "un server
 * par workspace par langue").
 *
 * Race-safety : si deux appels concurrents pour le même langId arrivent,
 * ils partagent la même in-flight promise via `inProgressInits` — un seul
 * spawn LSP server est déclenché.
 */
export async function getLspClient(
  langId: string,
): Promise<{ client: LSPClient; workspaceUri: string } | null> {
  if (!isLspSupported(langId)) return null;

  const cached = clients.get(langId);
  if (cached) {
    return { client: cached.client, workspaceUri: cached.workspaceUri };
  }

  // In-flight check : si un init est déjà en cours, await la même promise.
  let pending = inProgressInits.get(langId);
  if (!pending) {
    pending = doInit(langId);
    inProgressInits.set(langId, pending);
    // Nettoyage automatique de la map quand l'init termine (succès ou
    // échec). Permet un retry si le user installe le binaire après le
    // premier null retourné.
    void pending.finally(() => {
      inProgressInits.delete(langId);
    });
  }
  return pending;
}

/**
 * Construit le fileUri à passer à `client.plugin(uri, langId)`. Combine
 * le workspaceUri (file:///F:/Dev/shugu_code) avec un path relatif
 * (src/lib/fs.ts). Encode le path relatif pour gérer espaces/accents
 * (rust-analyzer/pylsp rejettent les URI non-RFC3986).
 *
 * `encodeURI` est préféré à `encodeURIComponent` car il préserve `/`
 * (séparateur de path) ; on encode juste les espaces, `?`, `#`, accents.
 */
export function fileUriForPath(workspaceUri: string, relativePath: string): string {
  const ws = workspaceUri.replace(/\/+$/, "");
  const rel = encodeURI(relativePath.replace(/^\/+/, ""));
  return `${ws}/${rel}`;
}

/**
 * Cleanup interne d'un client cached. Appelle disconnect() ET dispose le
 * transport ET delete du cache. Factorisé pour être réutilisé par les 3
 * paths qui doivent nettoyer un client : crash (lsp://exited), erreur de
 * framing (lsp://error), changement de workspace (disconnectAllClients).
 *
 * Sans `client.disconnect()`, le LSPClient resterait vivant dans le
 * Compartment des CodeMirrorEditor déjà mountés (NEW BUG #1 reviewer #2) :
 * les plugins continuent à essayer d'envoyer via le transport disposed,
 * les sends échouent silencieusement et hover/completion se figent.
 */
function clearClient(langId: string, reason: string): void {
  const cached = clients.get(langId);
  if (!cached) return;
  diag("lsp", `clearing ${langId} client (${reason})`);
  try {
    cached.client.disconnect();
  } catch (err) {
    diag("lsp", `${langId} disconnect threw: ${fmtErr(err)}`);
  }
  cached.transport.dispose();
  clients.delete(langId);
}

/**
 * Disconnect + shutdown TOUS les LSPClient. À appeler quand on change de
 * workspace (le workspaceUri devient invalide pour les clients existants,
 * et le LSP server doit re-indexer une nouvelle racine).
 *
 * Le shutdown LSP (côté Rust) envoie shutdown+exit JSON-RPC puis kill
 * après 500ms — voir src-tauri/src/commands/lsp.rs::lsp_shutdown.
 *
 * Wired depuis la commande palette `open-folder` (src/lib/commands.ts).
 *
 * Idempotency (NEW ISSUE #4 reviewer #2) : on snapshot puis on clear le
 * map AVANT la boucle async — un second appel concurrent voit un map
 * vide et fait no-op au lieu de re-disconnect les mêmes instances.
 */
export async function disconnectAllClients(): Promise<void> {
  const snapshot = new Map(clients);
  clients.clear(); // idempotency : 2e appel concurrent voit Map vide
  for (const [langId, cached] of snapshot) {
    try {
      cached.client.disconnect();
    } catch (err) {
      diag("lsp", `${langId} disconnect threw: ${fmtErr(err)}`);
    }
    cached.transport.dispose();
    try {
      await invoke("lsp_shutdown", { langId });
    } catch (err) {
      diag("lsp", `${langId} shutdown failed: ${fmtErr(err)}`);
    }
  }
}

// ─── Crash recovery — listen lsp://exited + lsp://error pour clear cache ─
//
// Quand le LSP server crashe (EOF sur stdout) OU émet une erreur de framing,
// le backend Rust signale via "lsp://exited" / "lsp://error". On clear le
// cache + dispose le client → le prochain getLspClient déclenche un
// nouveau spawn (retry-friendly).
//
// HMR cleanup (NEW ISSUE #3 reviewer #2) : sur Vite dev, le module se
// recharge à chaque edit. Sans `import.meta.hot.dispose`, chaque reload
// ajoute un nouveau listener → N callbacks dispatché à chaque event
// après quelques minutes de dev (faux double-dispose, logs spam).
let crashListenersCleanup: (() => void) | null = null;
void (async () => {
  try {
    const unlistenExited = await listen<{ langId: string; message: string }>(
      "lsp://exited",
      (payload) => clearClient(payload.langId, "server exited"),
    );
    const unlistenError = await listen<{ langId: string; message: string }>(
      "lsp://error",
      (payload) => clearClient(payload.langId, `transport error: ${payload.message}`),
    );
    crashListenersCleanup = () => {
      unlistenExited();
      unlistenError();
    };
  } catch (err) {
    diag("lsp", `failed to attach crash listeners: ${fmtErr(err)}`);
  }
})();

// HMR : cleanup les listeners avant le module reload (Vite dev only).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    crashListenersCleanup?.();
    crashListenersCleanup = null;
    // Disconnect tous les clients aussi — le module reload va re-créer
    // les caches Map vides, et les anciens clients seraient orphelins.
    for (const [langId, cached] of clients) {
      try {
        cached.client.disconnect();
      } catch {
        // best-effort en dev HMR
      }
      cached.transport.dispose();
      diag("lsp", `HMR cleanup ${langId}`);
    }
    clients.clear();
    inProgressInits.clear();
  });
}
