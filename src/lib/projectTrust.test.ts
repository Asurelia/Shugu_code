import { describe, expect, it } from "vitest";
import {
  projectConfigurationEnabled,
  projectTrustLabel,
  type ProjectTrustStatus,
} from "./projectTrust";

function status(
  state: ProjectTrustStatus["state"],
  enabled = state === "trusted",
): ProjectTrustStatus {
  return {
    rootPath: "C:/Dev/project",
    state,
    projectFeaturesEnabled: enabled,
    mutationsAllowed: enabled,
  };
}

describe("project trust presentation", () => {
  it("keeps unknown and read-only states fail-closed", () => {
    expect(projectConfigurationEnabled(status("unknown"))).toBe(false);
    expect(projectConfigurationEnabled(status("readOnly"))).toBe(false);
    expect(projectTrustLabel("unknown")).toBe("Décision requise");
    expect(projectTrustLabel("readOnly")).toBe("Lecture seule");
  });

  it("requires the native capability flags as well as the trusted label", () => {
    expect(projectConfigurationEnabled(status("trusted"))).toBe(true);
    expect(projectConfigurationEnabled(status("trusted", false))).toBe(false);
    expect(projectTrustLabel("trusted")).toBe("Projet approuvé");
  });
});
