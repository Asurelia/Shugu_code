import { describe, it, expect } from "vitest";
import { rewindChoicesFor, rewindConfirmContent, rewindResultSummary } from "./rewind";
import type { SnapshotPreview } from "@/lib/rewind";

describe("rewindChoicesFor", () => {
  it("un tour agent (viaAgent + agentId) offre les trois choix", () => {
    expect(rewindChoicesFor({ viaAgent: true, agentId: "agent-1" })).toEqual([
      "files",
      "conversation",
      "both",
    ]);
  });

  it("un message sans run n'offre que le fork de conversation", () => {
    expect(rewindChoicesFor({})).toEqual(["conversation"]);
    expect(rewindChoicesFor({ viaAgent: true })).toEqual(["conversation"]);
    expect(rewindChoicesFor({ viaAgent: false, agentId: "a" })).toEqual(["conversation"]);
    expect(rewindChoicesFor({ viaAgent: true, agentId: "" })).toEqual(["conversation"]);
  });
});

const preview: SnapshotPreview = {
  turnId: "t1",
  refName: "refs/shugu/turn/t1",
  restored: ["src/a.ts", "src/b.ts"],
  removed: ["new-file.txt"],
};

describe("rewindConfirmContent", () => {
  it("conversation seule : pas de danger, source conservée", () => {
    const c = rewindConfirmContent("conversation", null);
    expect(c.danger).toBe(false);
    expect(c.lines.join(" ")).toContain("conservée telle quelle");
    expect(c.lines.join(" ")).not.toContain("SUPPRIMÉS");
  });

  it("fichiers : liste restaurés + supprimés + filet de sécurité, ton danger", () => {
    const c = rewindConfirmContent("files", preview);
    expect(c.danger).toBe(true);
    const body = c.lines.join("\n");
    expect(body).toContain("src/a.ts");
    expect(body).toContain("new-file.txt");
    expect(body).toContain("réversible");
  });

  it("les deux : mentionne la branche en plus des fichiers", () => {
    const c = rewindConfirmContent("both", preview);
    expect(c.lines.join(" ").toLowerCase()).toContain("branche");
    expect(c.lines.join("\n")).toContain("src/b.ts");
  });

  it("liste bornée : au-delà de 8 fichiers, un résumé « … et N autre(s) »", () => {
    const big: SnapshotPreview = {
      ...preview,
      restored: Array.from({ length: 11 }, (_, i) => `f${i}.ts`),
    };
    const c = rewindConfirmContent("files", big);
    const body = c.lines.join("\n");
    expect(body).toContain("… et 3 autre(s)");
    expect(body).not.toContain("f10.ts");
  });
});

describe("rewindResultSummary", () => {
  it("mentionne la réversibilité quand le filet existe", () => {
    expect(rewindResultSummary(2, 1, "refs/shugu/turn/pre-revert-t")).toContain("Réversible");
  });
  it("avertit honnêtement quand le filet a échoué", () => {
    expect(rewindResultSummary(2, 1, null)).toContain("non réversible");
  });
});
