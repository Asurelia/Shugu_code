import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { db } from "@/lib/db";

export interface StudioBrandBoard {
  audience: string;
  voice: string;
  notes: string;
  pinnedAssetIds: string[];
  updatedAt: number;
}

const KEY = ["studio", "brand-board"] as const;
const STORAGE_KEY = "studio.brand-board.v1";

const INITIAL: StudioBrandBoard = {
  audience: "",
  voice: "",
  notes: "",
  pinnedAssetIds: [],
  updatedAt: 0,
};

function normalize(value: Partial<StudioBrandBoard> | null | undefined): StudioBrandBoard {
  return {
    audience: value?.audience ?? "",
    voice: value?.voice ?? "",
    notes: value?.notes ?? "",
    pinnedAssetIds: Array.isArray(value?.pinnedAssetIds) ? value.pinnedAssetIds.map(String) : [],
    updatedAt: typeof value?.updatedAt === "number" ? value.updatedAt : 0,
  };
}

function readBrowserCache(): StudioBrandBoard | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return normalize(JSON.parse(raw) as Partial<StudioBrandBoard>);
  } catch {
    return null;
  }
}

function writeBrowserCache(board: StudioBrandBoard): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
  } catch {
    // SQLite persistence is the durable copy.
  }
}

async function loadBrandBoard(): Promise<StudioBrandBoard> {
  const raw = await db.settings.get(STORAGE_KEY).catch(() => null);
  if (!raw) return readBrowserCache() ?? INITIAL;
  try {
    const board = normalize(JSON.parse(raw) as Partial<StudioBrandBoard>);
    writeBrowserCache(board);
    return board;
  } catch {
    return readBrowserCache() ?? INITIAL;
  }
}

export function useStudioBrandBoard(): StudioBrandBoard {
  return (
    useQuery<StudioBrandBoard>({
      queryKey: KEY,
      queryFn: loadBrandBoard,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? INITIAL
  );
}

export function getStudioBrandBoard(): StudioBrandBoard {
  return queryClient.getQueryData<StudioBrandBoard>(KEY) ?? readBrowserCache() ?? INITIAL;
}

export function setStudioBrandBoard(patch: Partial<StudioBrandBoard>): void {
  const current = getStudioBrandBoard();
  const next = normalize({ ...current, ...patch, updatedAt: Date.now() });
  queryClient.setQueryData<StudioBrandBoard>(KEY, next);
  writeBrowserCache(next);
  void db.settings
    .set(STORAGE_KEY, JSON.stringify(next))
    .catch((err) => console.warn("[studio] persist brand board failed:", err));
}

export function togglePinnedAsset(id: string): void {
  const board = getStudioBrandBoard();
  const exists = board.pinnedAssetIds.includes(id);
  setStudioBrandBoard({
    pinnedAssetIds: exists
      ? board.pinnedAssetIds.filter((x) => x !== id)
      : [id, ...board.pinnedAssetIds].slice(0, 12),
  });
}
