import { describe, it, expect } from "vitest";
import { buildAgentTree } from "./fanout";
import type { AgentRow } from "@/lib/agents";

function row(id: string, parentId: string | null, createdAt: number): AgentRow {
  return {
    id,
    role: parentId ? "delegate" : "orchestrator",
    status: "running",
    parentId,
    model: "m",
    task: id,
    conversationId: null,
    createdAt,
    finishedAt: null,
    output: null,
    error: null,
    executionProfile: "auto",
    isolate: false,
    profileVerified: true,
    isolationStatus: "none",
    goalId: null,
  };
}

describe("buildAgentTree", () => {
  it("parent suivi de ses enfants (ordre createdAt), profondeurs correctes", () => {
    const rows = [
      row("child-2", "parent", 4),
      row("parent", null, 1),
      row("child-1", "parent", 3),
      row("grandchild", "child-1", 5),
      row("root-2", null, 6),
    ];
    const tree = buildAgentTree(rows);
    expect(tree.map((n) => n.row.id)).toEqual([
      "parent",
      "child-1",
      "grandchild",
      "child-2",
      "root-2",
    ]);
    expect(tree.map((n) => n.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it("un enfant dont le parent n'est pas dans la liste remonte en racine (jamais masqué)", () => {
    const tree = buildAgentTree([row("orphan", "ghost-parent", 1), row("root", null, 2)]);
    expect(tree.map((n) => n.row.id)).toEqual(["orphan", "root"]);
    expect(tree.map((n) => n.depth)).toEqual([0, 0]);
  });

  it("les fratries sont triées par createdAt", () => {
    const rows = [
      row("b", "p", 3),
      row("a", "p", 1),
      row("c", "p", 2),
      row("p", null, 0),
    ];
    expect(buildAgentTree(rows).map((n) => n.row.id)).toEqual(["p", "a", "c", "b"]);
  });

  it("liste vide", () => {
    expect(buildAgentTree([])).toEqual([]);
  });
});
