// Shugu Forge — deferred / lightweight canvas persistence.
// Pan/zoom used to JSON.stringify the full doc (with huge srcDoc HTML) on every
// pointer move → main-thread jank. Cache updates stay sync; disk writes debounce
// and drop bulky html payloads (rebuilt by the workspace scan).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { db } from "@/lib/db";
import {
  createDefaultDoc,
  ensureCoreNodes,
  parseCanvasDoc,
  type StudioCanvasDoc,
} from "./studioCanvasDoc";

const KEY = ["studio", "canvas-doc"] as const;
const STORAGE_KEY = "studio.canvas-doc.v1";
const PERSIST_MS = 400;
/** Don't persist inline HTML above this — scan rebuilds it. */
const HTML_PERSIST_MAX = 2_000;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function slimForPersist(doc: StudioCanvasDoc): StudioCanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (!n.html || n.html.length <= HTML_PERSIST_MAX) return n;
      return { ...n, html: undefined };
    }),
  };
}

function readBrowserCache(): StudioCanvasDoc | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseCanvasDoc(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeBrowserCache(doc: StudioCanvasDoc): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slimForPersist(doc)));
  } catch {
    // quota / private mode — SQLite is the durable copy
  }
}

function schedulePersist(doc: StudioCanvasDoc): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const slim = slimForPersist(doc);
    writeBrowserCache(slim);
    void db.settings
      .set(STORAGE_KEY, JSON.stringify(slim))
      .catch((err) => console.warn("[studio] persist canvas doc failed:", err));
  }, PERSIST_MS);
}

async function loadCanvasDoc(): Promise<StudioCanvasDoc> {
  const raw = await db.settings.get(STORAGE_KEY).catch(() => null);
  if (raw) {
    try {
      const parsed = parseCanvasDoc(JSON.parse(raw));
      if (parsed) {
        const doc = ensureCoreNodes(parsed);
        writeBrowserCache(doc);
        return doc;
      }
    } catch {
      // fall through
    }
  }
  const cached = readBrowserCache();
  if (cached) return ensureCoreNodes(cached);
  return createDefaultDoc();
}

export function useStudioCanvasDoc(): StudioCanvasDoc {
  return (
    useQuery<StudioCanvasDoc>({
      queryKey: KEY,
      queryFn: loadCanvasDoc,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? createDefaultDoc()
  );
}

export function getStudioCanvasDoc(): StudioCanvasDoc {
  return queryClient.getQueryData<StudioCanvasDoc>(KEY) ?? readBrowserCache() ?? createDefaultDoc();
}

export function setStudioCanvasDoc(doc: StudioCanvasDoc): void {
  const next = ensureCoreNodes(doc);
  queryClient.setQueryData<StudioCanvasDoc>(KEY, next);
  schedulePersist(next);
}

export function updateStudioCanvasDoc(fn: (doc: StudioCanvasDoc) => StudioCanvasDoc): void {
  setStudioCanvasDoc(fn(getStudioCanvasDoc()));
}

export function resetStudioCanvasDoc(): void {
  setStudioCanvasDoc(createDefaultDoc());
}
