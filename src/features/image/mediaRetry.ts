import type { Generation } from "@/lib/types";

export const MEDIA_RETRY_KEY = "shugu.media.retry.v1";

export interface RetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function queueMediaRetry(generation: Generation, storage: RetryStorage = sessionStorage): void {
  storage.setItem(MEDIA_RETRY_KEY, JSON.stringify(generation));
}

export function clearMediaRetry(storage: RetryStorage = sessionStorage): void {
  storage.removeItem(MEDIA_RETRY_KEY);
}

export function peekMediaRetry(storage: RetryStorage = sessionStorage): Generation | null {
  const raw = storage.getItem(MEDIA_RETRY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Generation>;
    const kind = parsed.kind ?? "image";
    if (!(["image", "video", "music"] as string[]).includes(kind)) return null;
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
    return {
      ...parsed,
      id: parsed.id ?? "retry",
      kind,
      prompt: parsed.prompt,
      ratio: typeof parsed.ratio === "string" ? parsed.ratio : "1:1",
      hue: typeof parsed.hue === "number" ? parsed.hue : 0,
      ts: parsed.ts ?? Date.now(),
    } as Generation;
  } catch {
    return null;
  }
}

export function consumeMediaRetry(storage: RetryStorage = sessionStorage): Generation | null {
  const generation = peekMediaRetry(storage);
  clearMediaRetry(storage);
  return generation;
}
