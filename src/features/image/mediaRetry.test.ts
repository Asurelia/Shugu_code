import { describe, expect, it } from "vitest";
import { clearMediaRetry, consumeMediaRetry, MEDIA_RETRY_KEY, peekMediaRetry, queueMediaRetry, type RetryStorage } from "./mediaRetry";

function memoryStorage(): RetryStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("media retry handoff", () => {
  it("round-trips the provider parameters once", () => {
    const storage = memoryStorage();
    queueMediaRetry({
      id: "old",
      kind: "video",
      prompt: "camera push",
      ratio: "16:9",
      hue: 20,
      ts: 10,
      model: "minimax/MiniMax-Hailuo-02",
      steps: 6,
      style: "1080P",
    }, storage);
    expect(consumeMediaRetry(storage)).toMatchObject({ kind: "video", prompt: "camera push", steps: 6 });
    expect(storage.values.has(MEDIA_RETRY_KEY)).toBe(false);
    expect(consumeMediaRetry(storage)).toBeNull();
  });

  it("rejects malformed and unknown media drafts", () => {
    const storage = memoryStorage();
    storage.setItem(MEDIA_RETRY_KEY, "not-json");
    expect(consumeMediaRetry(storage)).toBeNull();
    storage.setItem(MEDIA_RETRY_KEY, JSON.stringify({ kind: "document", prompt: "x" }));
    expect(consumeMediaRetry(storage)).toBeNull();
  });

  it("defaults legacy image drafts safely", () => {
    const storage = memoryStorage();
    storage.setItem(MEDIA_RETRY_KEY, JSON.stringify({ prompt: "legacy" }));
    expect(consumeMediaRetry(storage)).toMatchObject({ kind: "image", prompt: "legacy", ratio: "1:1" });
  });

  it("supports StrictMode-style duplicate reads before commit", () => {
    const storage = memoryStorage();
    storage.setItem(MEDIA_RETRY_KEY, JSON.stringify({ kind: "music", prompt: "twice" }));
    expect(peekMediaRetry(storage)?.prompt).toBe("twice");
    expect(peekMediaRetry(storage)?.prompt).toBe("twice");
    clearMediaRetry(storage);
    expect(peekMediaRetry(storage)).toBeNull();
  });
});
