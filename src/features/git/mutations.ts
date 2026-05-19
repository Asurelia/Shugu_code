// Shugu Forge — TanStack mutations pour la feature git (LOT 2).
//
// Chaque mutation invalide `gitKeys.all` au succès. Over-invalidation
// acceptable (cf. R12 du plan LOT 3) — le watcher Rust émet `git://changed`
// de toute façon après chaque opération qui touche `.git/`, donc une
// invalidation supplémentaire au commit est sans coût observable.
//
// Pas de patch optimiste : status / branches / log restent simples et
// l'opération git (CLI ou git2) reste en-dessous de 200ms en local. Une
// invalidation classique avec refetch sur un staleTime: 0 est largement
// suffisamment réactive pour l'UX.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { gitKeys } from "./keys";
import {
  gitStage,
  gitUnstage,
  gitDiscard,
  gitStageHunk,
  gitUnstageHunk,
  gitCommit,
  gitCheckout,
  gitPush,
  gitPull,
  gitFetch,
  gitStashSave,
  gitStashApply,
  gitRemoteAdd,
  gitRemoteRemove,
} from "@/lib/git";

// ---------------------------------------------------------------------------
// Index mutators
// ---------------------------------------------------------------------------

export function useStageFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => gitStage(paths),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useUnstageFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => gitUnstage(paths),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useDiscardFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => gitDiscard(paths),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useStageHunk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, hunkPatch }: { path: string; hunkPatch: string }) =>
      gitStageHunk(path, hunkPatch),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useUnstageHunk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, hunkPatch }: { path: string; hunkPatch: string }) =>
      gitUnstageHunk(path, hunkPatch),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Commit + branch
// ---------------------------------------------------------------------------

/** Returns the new commit OID. */
export function useCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ message, amend = false }: { message: string; amend?: boolean }) =>
      gitCommit(message, amend),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branch, create = false }: { branch: string; create?: boolean }) =>
      gitCheckout(branch, create),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Remote sync (push / pull / fetch)
// ---------------------------------------------------------------------------

/** Returns the `git push` CLI stdout summary. */
export function usePush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ remote, branch }: { remote: string; branch: string }) =>
      gitPush(remote, branch),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

/** Returns the `git pull` CLI stdout summary. */
export function usePull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ remote, branch }: { remote: string; branch: string }) =>
      gitPull(remote, branch),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

/** Returns the `git fetch` CLI stdout summary. */
export function useFetch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (remote?: string | null) => gitFetch(remote),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export function useStashSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message?: string | null) => gitStashSave(message),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useStashApply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ index, pop = false }: { index: number; pop?: boolean }) =>
      gitStashApply(index, pop),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

export function useAddRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, url }: { name: string; url: string }) =>
      gitRemoteAdd(name, url),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}

export function useRemoveRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => gitRemoteRemove(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.all }),
  });
}
