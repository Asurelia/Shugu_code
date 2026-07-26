import { describe, it, expect } from "vitest";
import {
  pluginContributionsSummary,
  pluginSourceLabel,
  effectiveSlashName,
  buildTakenNames,
  mcpApprovalLabel,
  fileSkillSourceLabel,
} from "./pluginsUtils";
import type { PluginSummary } from "@/lib/plugins";

const plugin = (over: Partial<PluginSummary>): PluginSummary => ({
  id: "project:x",
  name: "x",
  version: null,
  description: null,
  author: null,
  source: "project",
  enabled: true,
  blockedByTrust: false,
  commands: 0,
  agents: 0,
  skills: 0,
  hooks: 0,
  mcpPending: 0,
  ...over,
});

describe("pluginContributionsSummary", () => {
  it("résume les contributions non nulles, singulier/pluriel", () => {
    expect(
      pluginContributionsSummary(plugin({ commands: 2, agents: 1, skills: 1, hooks: 1, mcpPending: 1 })),
    ).toBe("2 commandes · 1 agent · 1 skill · 1 hook · 1 MCP en attente");
  });

  it("un plugin désactivé (compteurs à zéro) affiche « aucune contribution »", () => {
    expect(pluginContributionsSummary(plugin({ enabled: false }))).toBe("aucune contribution");
  });
});

describe("pluginSourceLabel", () => {
  it("traduit les trois sources", () => {
    expect(pluginSourceLabel("user")).toBe("utilisateur");
    expect(pluginSourceLabel("project")).toBe("projet");
    expect(pluginSourceLabel("claude-cache")).toContain("lecture seule");
  });
});

describe("namespacing des slash commands", () => {
  const cmd = { plugin: "super", name: "deploy", namespacedName: "super:deploy" };

  it("nom nu sans collision, namespacé sinon", () => {
    expect(effectiveSlashName(cmd, new Set())).toBe("deploy");
    expect(effectiveSlashName(cmd, new Set(["deploy"]))).toBe("super:deploy");
  });

  it("buildTakenNames couvre agents + commandes des autres plugins", () => {
    const taken = buildTakenNames(
      ["reviewer"],
      [
        { plugin: "a", name: "deploy" },
        { plugin: "b", name: "test" },
      ],
      "a",
    );
    expect(taken.has("reviewer")).toBe(true);
    expect(taken.has("test")).toBe(true);
    expect(taken.has("deploy")).toBe(false);
  });
});

describe("mcpApprovalLabel / fileSkillSourceLabel", () => {
  it("statuts d'approbation honnêtes", () => {
    expect(mcpApprovalLabel("pending")).toContain("en attente");
    expect(mcpApprovalLabel("approved")).toBe("approuvé");
    expect(mcpApprovalLabel("rejected")).toBe("rejeté");
  });

  it("badges de source des skills fichiers", () => {
    expect(fileSkillSourceLabel("projet")).toBe("projet");
    expect(fileSkillSourceLabel("claude")).toContain("lecture seule");
    expect(fileSkillSourceLabel("plugin:super")).toBe("plugin super");
    expect(fileSkillSourceLabel("shugu")).toBe("shugu");
  });
});
