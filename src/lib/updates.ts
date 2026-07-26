import { invoke, listen } from "@/lib/tauri";

export const UPDATE_QUERY_KEY = ["app", "update"] as const;
export const UPDATE_AUTO_CHECK_KEY = "updates.autoCheck";
export const UPDATE_DISMISSED_VERSION_KEY = "updates.dismissedVersion";
export const UPDATE_OPEN_EVENT = "shugu:open-update";

export type UpdateState = "available" | "upToDate" | "channelUnavailable";

export interface UpdateAsset {
  id: string;
  name: string;
  bytes: number;
  digest: string | null;
}

export interface UpdateStatus {
  currentVersion: string;
  state: UpdateState;
  latestVersion: string | null;
  releaseName: string | null;
  notes: string | null;
  publishedAt: string | null;
  releaseUrl: string;
  asset: UpdateAsset | null;
}

export interface UpdateDownloadResult {
  path: string;
  bytes: number;
  verified: boolean;
  digest: string;
}

export interface UpdateDownloadProgress {
  received: number;
  total: number;
}

export function checkForUpdate(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("update_check");
}

export function downloadUpdate(assetId: string): Promise<UpdateDownloadResult> {
  return invoke<UpdateDownloadResult>("update_download", { assetId });
}

export function revealDownloadedUpdate(): Promise<void> {
  return invoke<void>("update_reveal_download");
}

export function listenUpdateProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<() => void> {
  return listen<UpdateDownloadProgress>("update://download-progress", handler);
}

export function updateProgressPercent(
  progress: UpdateDownloadProgress | null,
): number {
  if (!progress || progress.total <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((progress.received / progress.total) * 100)),
  );
}
