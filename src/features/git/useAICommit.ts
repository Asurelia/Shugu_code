// Shugu Forge — `useAICommit` (LOT 2).
//
// Génère un message de commit "conventional" à partir du diff staged
// courant, en appelant le LLM actif (même provider que la chat).
//
// Architecture :
//   1. `useGitStatus()` → liste des fichiers staged.
//   2. `gitDiffFile("", "index")` → diff complet staged (libgit2 traite
//      un pathspec vide comme "no filter", donc on récupère tout d'un
//      coup sans itérer fichier par fichier).
//   3. Tronquer à 8000 chars avec un suffixe explicite quand on déborde.
//   4. Prompt conventional-commits, un seul tour, pas de streaming UI.
//   5. Réutilise le même IPC `chat_send` que `sendChatMessage` (cf.
//      `src/features/chat/chat-sync.ts:398`), sans `conversationId`
//      pour ne pas polluer le buffer de streaming UI.
//
// Aucun écrit SQLite, aucun `appendMessage`. Le résultat sort via
// `message: string | null` + un `error` éventuel.

import { useCallback, useState } from "react";
import { invoke } from "@/lib/tauri";
import { gitDiffFile } from "@/lib/git";
import { resolveProvider, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { useActiveModel } from "@/features/chat/chat-sync";
import { useGitStatus } from "./queries";

const MAX_DIFF_CHARS = 8000;
const TRUNCATION_SUFFIX = "\n[... TRUNCATED — original diff exceeded 8000 chars ...]";

const PROMPT_TEMPLATE = (diff: string): string =>
  `Generate a single-line conventional commit message (type(scope): description) for this staged diff:\n\n${diff}\n\nRespond with ONLY the commit message, no preamble or explanation.`;

/**
 * Tronque `diff` à `maxLen` caractères. Si la taille originale dépasse
 * `maxLen`, on coupe à `maxLen - suffix.length` et on append le suffixe
 * pour signaler au LLM que la fin manque. Sinon on retourne `diff` tel
 * quel.
 *
 * Pure function — exportée pour la couverture vitest.
 */
export function truncateDiff(diff: string, maxLen: number = MAX_DIFF_CHARS): string {
  if (diff.length <= maxLen) return diff;
  const slice = diff.slice(0, Math.max(0, maxLen - TRUNCATION_SUFFIX.length));
  return slice + TRUNCATION_SUFFIX;
}

export interface UseAICommitResult {
  /** Le dernier message généré, ou null si aucun appel encore. */
  message: string | null;
  /** `true` pendant l'appel LLM. */
  isLoading: boolean;
  /** Dernière erreur, ou null. */
  error: string | null;
  /** Lance la génération. Met à jour `message`/`error`/`isLoading` en place. */
  generate: () => Promise<string | null>;
}

export function useAICommit(): UseAICommitResult {
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useGitStatus();
  const [modelId] = useActiveModel();

  const generate = useCallback(async (): Promise<string | null> => {
    setIsLoading(true);
    setError(null);
    try {
      // Garde : au moins un fichier staged.
      const stagedCount = (status ?? []).filter((s) => s.isStaged).length;
      if (stagedCount === 0) {
        const msg = "nothing staged";
        setError(msg);
        return null;
      }

      // Diff staged complet — un pathspec vide est traité par libgit2
      // comme "no filter", donc on récupère tous les fichiers staged en
      // un seul call.
      let diff = await gitDiffFile("", "index");
      // Bretelle : si le backend renvoie une chaîne vide alors qu'on
      // savait pertinemment qu'il y avait du staged, on fallback en
      // agrégeant les diffs par fichier (libgit2 peut renvoyer "" si la
      // pathspec vide est interprétée différemment par certaines
      // versions).
      if (!diff.trim() && status) {
        const stagedPaths = status.filter((s) => s.isStaged).map((s) => s.path);
        const parts: string[] = [];
        for (const p of stagedPaths) {
          const part = await gitDiffFile(p, "index");
          if (part.trim()) parts.push(part);
        }
        diff = parts.join("\n");
      }
      if (!diff.trim()) {
        const msg = "nothing staged";
        setError(msg);
        return null;
      }

      const truncated = truncateDiff(diff);
      const prompt = PROMPT_TEMPLATE(truncated);

      // Résolution du provider — même schéma que `sendChatMessage`.
      const fullId = modelId?.includes("/") ? modelId : `anthropic/${modelId ?? "claude-haiku-4-5"}`;
      const {
        providerId,
        protocol: defaultProtocol,
        baseUrl: defaultBaseUrl,
        model: realModel,
      } = resolveProvider(fullId);

      const enabled = await getProviderEnabled(providerId);
      if (enabled !== "true") {
        const msg = "no LLM provider configured";
        setError(msg);
        return null;
      }

      const cfg = await loadProviderConfig(providerId);
      let protocol: Protocol = defaultProtocol;
      if (defaultProtocol === "custom") {
        const stored = await getConfig(providerId, "protocol");
        if (stored === "anthropic" || stored === "openai" || stored === "ollama" || stored === "custom") {
          protocol = stored;
        }
      }
      const baseUrl: string = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : defaultBaseUrl;
      const apiKey: string | undefined = cfg.apiKey && cfg.apiKey !== "" ? cfg.apiKey : undefined;

      // One-shot `chat_send` — pas de `conversationId` (la mascotte
      // streame son chat ailleurs ; on ne veut PAS polluer ce flux UI
      // avec les chunks générés pour le commit message).
      const reply = await invoke<string>("chat_send", {
        messages: [{ role: "user", content: prompt }],
        model: realModel,
        protocol,
        baseUrl,
        apiKey,
      });

      const cleaned = sanitizeCommitMessage(reply);
      setMessage(cleaned);
      return cleaned;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [status, modelId]);

  return { message, isLoading, error, generate };
}

/**
 * Nettoie la sortie LLM en single-line conventional commit.
 *
 * Les modèles entourent parfois la réponse de quotes / backticks / d'un
 * préambule "Here is the commit message:" malgré l'instruction "ONLY
 * the commit message". On supprime ces enveloppes, on garde la première
 * ligne non vide.
 *
 * Exporté pour la couverture vitest.
 */
export function sanitizeCommitMessage(reply: string): string {
  // Strip fences ```...``` et code lang prefixes.
  let s = reply.trim();
  if (s.startsWith("```")) {
    const after = s.indexOf("\n");
    if (after !== -1) s = s.slice(after + 1);
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  // Garde la première ligne non vide.
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // Enlève les quotes englobantes (simples ou doubles).
  return firstLine.replace(/^["']|["']$/g, "").trim();
}
