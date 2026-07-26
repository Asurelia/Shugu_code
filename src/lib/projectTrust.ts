import { invoke } from "@/lib/tauri";

export type ProjectTrustState = "unknown" | "readOnly" | "trusted";

export interface ProjectTrustStatus {
  rootPath: string | null;
  state: ProjectTrustState;
  projectFeaturesEnabled: boolean;
  mutationsAllowed: boolean;
  /** Frontend-only fail-closed diagnostic when native verification failed. */
  verificationError?: string;
}

export function projectTrustLabel(state: ProjectTrustState): string {
  if (state === "trusted") return "Projet approuvé";
  if (state === "readOnly") return "Lecture seule";
  return "Décision requise";
}

export function projectConfigurationEnabled(
  status: ProjectTrustStatus | null | undefined,
): boolean {
  return status?.state === "trusted"
    && status.projectFeaturesEnabled
    && status.mutationsAllowed;
}

export async function getProjectTrust(): Promise<ProjectTrustStatus> {
  return invoke<ProjectTrustStatus>("project_trust_status");
}

export async function setProjectTrust(
  state: Exclude<ProjectTrustState, "unknown">,
  expectedRootPath: string,
): Promise<ProjectTrustStatus> {
  return invoke<ProjectTrustStatus>("project_trust_set", {
    state,
    expectedRootPath,
  });
}
