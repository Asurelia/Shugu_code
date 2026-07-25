// Shugu Forge — P6.11 : construction de l'arbre parent↔enfants des agents
// (fan-out de délégations). Helper PUR (aucune I/O), testable en Vitest.
//
// Les événements Spawn portent déjà `parentId` et sont persistés — l'arbre se
// RECONSTRUIT après reload depuis les rows SQLite, aucun nouvel event requis.

import type { AgentRow } from "@/lib/agents";

export interface AgentTreeNode {
  row: AgentRow;
  /** 0 = racine, 1 = enfant direct, 2 = petit-enfant… */
  depth: number;
}

/** Aplatit les rows en arbre ordonné : chaque parent est suivi de ses enfants
 *  (récursif), racines et fratries triées par createdAt. Les orphelins
 *  (parent_id pointant hors liste) sont remontés en racines — jamais masqués
 *  (honnêteté : un enfant sans parent visible reste affiché). */
export function buildAgentTree(rows: AgentRow[]): AgentTreeNode[] {
  const byParent = new Map<string, AgentRow[]>();
  const roots: AgentRow[] = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    if (row.parentId && ids.has(row.parentId)) {
      const kids = byParent.get(row.parentId) ?? [];
      kids.push(row);
      byParent.set(row.parentId, kids);
    } else {
      roots.push(row);
    }
  }
  const byCreated = (a: AgentRow, b: AgentRow) => a.createdAt - b.createdAt;
  roots.sort(byCreated);
  for (const kids of byParent.values()) kids.sort(byCreated);

  const out: AgentTreeNode[] = [];
  const visit = (row: AgentRow, depth: number) => {
    out.push({ row, depth });
    for (const kid of byParent.get(row.id) ?? []) visit(kid, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return out;
}
