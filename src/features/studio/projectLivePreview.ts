// Shugu Forge — live preview of the OPEN workspace project (not forge silo).
// Reuses the same localhost probe as the Contexte "Prévisu" card.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { previewDetectServer } from "@/lib/git";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { fsKeys } from "@/features/fs/keys";

/** Common app ports — 1420 (Shugu's own Vite) intentionally omitted so Studio
 *  never mistakes the IDE UI for the open project. */
export const PROJECT_PREVIEW_PORTS = [5173, 3000, 4173, 8080, 8000, 5000, 4321, 24678, 4000, 1234];

export function isSafeProjectPreviewUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export function useWorkspaceRoot(): string | null {
  return (
    useQuery({
      queryKey: fsKeys.workspaceRoot(),
      queryFn: fsGetWorkspaceRoot,
      staleTime: 5_000,
    }).data ?? null
  );
}

export function workspaceDisplayName(root: string | null): string {
  if (!root) return "Aucun projet";
  const parts = root.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || root;
}

/** Detected localhost ports for the open project's likely dev servers. */
export function useProjectDevPorts() {
  return useQuery({
    queryKey: ["studio", "project-dev-ports"],
    queryFn: () => previewDetectServer(PROJECT_PREVIEW_PORTS),
    refetchInterval: 2500,
    staleTime: 0,
    retry: false,
  });
}

export function useProjectLiveUrl(): {
  root: string | null;
  projectName: string;
  ports: number[];
  liveUrl: string | null;
  setLiveUrl: (u: string | null) => void;
} {
  const root = useWorkspaceRoot();
  const { data: ports = [] } = useProjectDevPorts();
  const [liveUrl, setLiveUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!ports.length) {
      setLiveUrl(null);
      return;
    }
    setLiveUrl((cur) => {
      if (cur && isSafeProjectPreviewUrl(cur)) {
        try {
          const curPort = Number(new URL(cur).port);
          if (ports.includes(curPort)) return cur;
        } catch {
          /* fall through */
        }
      }
      return `http://localhost:${ports[0]}`;
    });
  }, [ports]);

  return {
    root,
    projectName: workspaceDisplayName(root),
    ports,
    liveUrl,
    setLiveUrl: (u) => {
      if (u === null || isSafeProjectPreviewUrl(u)) setLiveUrl(u);
    },
  };
}
