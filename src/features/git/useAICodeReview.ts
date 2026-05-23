// Shugu Forge — `useAICodeReview` (Lot 7 AI code review).
//
// Génère une revue de code à partir d'un diff git (staged ou toutes modifs),
// en appelant le LLM actif (même provider que la chat). Architecture calquée
// sur `useAICommit` :
//   1. `gitDiffFile("", source)` → diff complet de la source (pathspec vide =
//      "no filter" côté libgit2, donc tous les fichiers d'un coup).
//        • source `"index"`  → staged seulement (HEAD vs index).
//        • source `"head"`   → toutes les modifs (HEAD vs index+workdir).
//   2. Tronquer à 16000 chars (budget plus large que le commit — la review
//      bénéficie de plus de contexte).
//   3. Prompt de revue strict, un seul tour, pas de streaming.
//   4. Réutilise l'IPC `chat_send` SANS `conversationId` → ne pollue pas le
//      buffer de streaming UI du chat principal (cf. useAICommit).
//
// Aucun écrit SQLite, aucun `appendMessage`. Le résultat sort via
// `review: string | null` + un `error` éventuel.

import { useCallback, useRef, useState } from "react";
import { invoke } from "@/lib/tauri";
import { gitDiffFile } from "@/lib/git";
import { resolveActiveChatProvider } from "@/features/chat/resolveProvider";
import { useActiveModel } from "@/features/chat/chat-sync";
import { useGitStatus } from "./queries";
import type { ReviewSource } from "./reviewDialogStore";

const MAX_REVIEW_DIFF_CHARS = 16000;
const TRUNCATION_SUFFIX = "\n[... TRONQUÉ — diff original > 16000 chars ...]";

/**
 * Tronque `diff` à `maxLen`. Si l'original dépasse, on coupe à
 * `maxLen - suffix.length` et on append le suffixe pour signaler au LLM que la
 * fin manque. Sinon on retourne `diff` tel quel. Pure — exportée pour vitest.
 */
export function truncateReviewDiff(diff: string, maxLen: number = MAX_REVIEW_DIFF_CHARS): string {
  if (diff.length <= maxLen) return diff;
  const slice = diff.slice(0, Math.max(0, maxLen - TRUNCATION_SUFFIX.length));
  return slice + TRUNCATION_SUFFIX;
}

/**
 * Construit le prompt de revue. Pure — exportée pour vitest.
 *
 * Demande une sortie texte concise groupée par fichier, ne commentant que les
 * lignes changées, avec sévérité + correctif. Pas de fences ni de préambule.
 */
export function buildReviewPrompt(diff: string): string {
  return `You are a senior code reviewer. Review the following git diff and report concrete, actionable findings.

Rules:
- Only comment on the CHANGED lines (those starting with + or -), not unchanged context lines.
- Group findings by file path. For each finding give, on one line: a severity tag ([blocker] / [major] / [minor] / [nit]), a short description, and a concrete fix.
- Prioritise correctness bugs and security issues first, then maintainability and style.
- If a file in the diff looks fine, say so in one line. If the entire diff is clean, reply exactly: "No issues found.".
- Be concise. Output plain text with light markdown only — NO preamble, NO restating of the diff, NO code fences around the whole answer.

Diff:
${diff}`;
}

export interface UseAICodeReviewResult {
  /** La dernière revue générée, ou null si aucun appel encore / erreur. */
  review: string | null;
  /** `true` pendant l'appel LLM. */
  isLoading: boolean;
  /** Dernière erreur, ou null. */
  error: string | null;
  /** Lance la génération pour la source donnée. Met à jour l'état en place. */
  generate: (source: ReviewSource) => Promise<string | null>;
}

export function useAICodeReview(): UseAICodeReviewResult {
  const [review, setReview] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useGitStatus();
  const [modelId] = useActiveModel();

  // Sequencer : seule la requête la plus récente écrit l'état. Changer de
  // source (ou re-cliquer Re-générer) pendant un appel en vol supplante le
  // précédent — sa réponse tardive est ignorée, sinon elle écraserait la bonne
  // (race staged↔toutes-modifs).
  const seqRef = useRef(0);

  const generate = useCallback(
    async (source: ReviewSource): Promise<string | null> => {
      const myseq = ++seqRef.current;
      const isCurrent = () => seqRef.current === myseq;
      setIsLoading(true);
      setError(null);
      try {
        // Diff complet de la source — pathspec vide = tous les fichiers.
        let diff = await gitDiffFile("", source);
        // Bretelle : si le backend renvoie "" malgré des fichiers concernés
        // (libgit2 peut interpréter la pathspec vide différemment selon les
        // versions), on agrège fichier par fichier.
        if (!diff.trim() && status) {
          const paths = status
            .filter((s) =>
              source === "index" ? s.isStaged : s.isStaged || s.worktreeStatus !== " ",
            )
            .map((s) => s.path);
          const parts: string[] = [];
          for (const p of paths) {
            const part = await gitDiffFile(p, source);
            if (part.trim()) parts.push(part);
          }
          diff = parts.join("\n");
        }
        if (!isCurrent()) return null; // supplanté pendant la récup du diff
        if (!diff.trim()) {
          const msg =
            source === "index"
              ? "rien de staged à reviewer"
              : "aucune modification à reviewer";
          setError(msg);
          setReview(null);
          return null;
        }

        const prompt = buildReviewPrompt(truncateReviewDiff(diff));

        const resolved = await resolveActiveChatProvider(modelId);
        if (!isCurrent()) return null;
        if (!resolved) {
          setError("no LLM provider configured");
          return null;
        }
        const { protocol, baseUrl, apiKey, model } = resolved;

        // One-shot, SANS conversationId → ne pollue pas le stream du chat
        // principal (même garde que useAICommit).
        const reply = await invoke<string>("chat_send", {
          messages: [{ role: "user", content: prompt }],
          model,
          protocol,
          baseUrl,
          apiKey,
        });

        if (!isCurrent()) return null; // une requête plus récente a pris le relais
        const cleaned = reply.trim();
        setReview(cleaned);
        return cleaned;
      } catch (err) {
        if (!isCurrent()) return null;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    },
    [status, modelId],
  );

  return { review, isLoading, error, generate };
}
