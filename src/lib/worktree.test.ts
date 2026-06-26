// Tests unitaires pour l'extraction du statut d'isolation worktree (Phase 7 #4).
// On teste la logique PURE (extractWorktreeStatus / isWorktreeRunActive) — pas
// les wrappers IPC, qui ne sont qu'un `invoke` direct.
import { describe, it, expect } from "vitest";
import {
  extractWorktreeStatus,
  isWorktreeRunActive,
  type WorktreeStatus,
} from "./worktree";
import type { AgentEvent } from "./agents";

const started = (branch = "shugu/iso-1"): AgentEvent => ({
  kind: "worktreeStarted",
  agentId: "a1",
  path: `/tmp/wt/${branch}`,
  branch,
});

const finalizedDiff = (branch = "shugu/iso-1"): AgentEvent => ({
  kind: "worktreeFinalized",
  agentId: "a1",
  outcome: "diff",
  branch,
  path: `/tmp/wt/${branch}`,
  diff: " src/foo.ts | 2 +-\n 1 file changed",
  reason: "cible non propre",
});

const finalizedMerged = (): AgentEvent => ({
  kind: "worktreeFinalized",
  agentId: "a1",
  outcome: "merged",
  commit: "abc123",
});

const skipped = (reason = "pas de dépôt git"): AgentEvent => ({
  kind: "worktreeSkipped",
  agentId: "a1",
  reason,
});

describe("extractWorktreeStatus", () => {
  it("retourne un objet vide quand aucun event worktree n'est présent", () => {
    const events: AgentEvent[] = [
      { kind: "message", agentId: "a1", role: "user", content: "salut" },
      { kind: "complete", agentId: "a1", output: "fini", ms: 10 },
    ];
    expect(extractWorktreeStatus(events)).toEqual({});
  });

  it("capte un run isolé en cours (started, pas de finalized)", () => {
    const status = extractWorktreeStatus([started()]);
    expect(status.started?.branch).toBe("shugu/iso-1");
    expect(status.finalized).toBeUndefined();
    expect(status.skipped).toBeUndefined();
  });

  it("capte started + finalized (diff prêt à relire)", () => {
    const status = extractWorktreeStatus([started(), finalizedDiff()]);
    expect(status.started).toBeDefined();
    expect(status.finalized?.outcome).toBe("diff");
    expect(status.finalized?.kind === "worktreeFinalized" && status.finalized.diff).toContain(
      "1 file changed",
    );
  });

  it("dernier finalized gagne (re-merge après un premier diff)", () => {
    const status = extractWorktreeStatus([started(), finalizedDiff(), finalizedMerged()]);
    expect(status.finalized?.outcome).toBe("merged");
    expect(status.finalized?.kind === "worktreeFinalized" && status.finalized.commit).toBe(
      "abc123",
    );
  });

  it("dernier started gagne quand plusieurs sont émis", () => {
    const status = extractWorktreeStatus([started("shugu/a"), started("shugu/b")]);
    expect(status.started?.branch).toBe("shugu/b");
  });

  it("capte worktreeSkipped avec sa raison", () => {
    const status = extractWorktreeStatus([skipped("pas de dépôt git")]);
    expect(status.skipped?.reason).toBe("pas de dépôt git");
    expect(status.started).toBeUndefined();
  });

  it("ne mélange pas les trois types", () => {
    const status = extractWorktreeStatus([started(), finalizedDiff(), skipped()]);
    expect(status.started).toBeDefined();
    expect(status.finalized?.outcome).toBe("diff");
    expect(status.skipped?.reason).toBe("pas de dépôt git");
  });
});

describe("isWorktreeRunActive", () => {
  it("est actif quand started sans finalized", () => {
    const status: WorktreeStatus = extractWorktreeStatus([started()]);
    expect(isWorktreeRunActive(status)).toBe(true);
  });

  it("n'est plus actif une fois finalisé", () => {
    const status = extractWorktreeStatus([started(), finalizedDiff()]);
    expect(isWorktreeRunActive(status)).toBe(false);
  });

  it("n'est pas actif sans aucun started", () => {
    expect(isWorktreeRunActive({})).toBe(false);
    expect(isWorktreeRunActive(extractWorktreeStatus([skipped()]))).toBe(false);
  });
});
