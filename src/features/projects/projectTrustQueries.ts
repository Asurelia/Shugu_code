import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { listen } from "@/lib/tauri";
import {
  getProjectTrust,
  type ProjectTrustStatus,
} from "@/lib/projectTrust";

export const projectTrustKey = ["projects", "trust", "current"] as const;
let workspaceGeneration = 0;

function comparablePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function currentFailClosedStatus(): ProjectTrustStatus {
  return (
    queryClient.getQueryData<ProjectTrustStatus>(projectTrustKey) ?? {
      rootPath: null,
      state: "unknown",
      projectFeaturesEnabled: false,
      mutationsAllowed: false,
    }
  );
}

async function getProjectTrustFailClosed(): Promise<ProjectTrustStatus> {
  const generation = workspaceGeneration;
  try {
    const status = await getProjectTrust();
    return generation === workspaceGeneration ? status : currentFailClosedStatus();
  } catch (error) {
    const rootPath = await fsGetWorkspaceRoot().catch(() => null);
    if (generation !== workspaceGeneration) return currentFailClosedStatus();
    return {
      rootPath,
      state: "unknown",
      projectFeaturesEnabled: false,
      mutationsAllowed: false,
      verificationError: String(error),
    };
  }
}

export function useProjectTrust() {
  return useQuery({
    queryKey: projectTrustKey,
    queryFn: getProjectTrustFailClosed,
    staleTime: Infinity,
    retry: false,
  });
}

export function setProjectTrustCache(status: ProjectTrustStatus): void {
  queryClient.setQueryData(projectTrustKey, status);
}

/** Un seul listener global : changement de workspace ou révocation native. */
export function useProjectTrustEvents(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const retain = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void listen<string>("workspace://changed", (rootPath) => {
      workspaceGeneration += 1;
      setProjectTrustCache({
        rootPath,
        state: "unknown",
        projectFeaturesEnabled: false,
        mutationsAllowed: false,
      });
      void queryClient.invalidateQueries({ queryKey: projectTrustKey });
    })
      .then(retain)
      .catch((error) => {
        console.warn("[project-trust] workspace listener unavailable:", error);
      });
    void listen<ProjectTrustStatus>("workspace://trust-changed", (status) => {
      const current = queryClient.getQueryData<ProjectTrustStatus>(projectTrustKey);
      if (
        current?.rootPath &&
        status.rootPath &&
        comparablePath(current.rootPath) !== comparablePath(status.rootPath)
      ) {
        return;
      }
      setProjectTrustCache(status);
    })
      .then(retain)
      .catch((error) => {
        console.warn("[project-trust] trust listener unavailable:", error);
      });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);
}
