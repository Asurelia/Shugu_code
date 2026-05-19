// Tests for the minimap doc-size guard (pure logic — no DOM required).

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { minimapConfig } from "./minimap";

function makeState(lines: number): EditorState {
  // Build a doc with exactly `lines` lines (each line is a single digit).
  const doc = Array.from({ length: lines }, () => "x").join("\n");
  return EditorState.create({ doc });
}

describe("minimapConfig", () => {
  it("returns null when doc has more than 5000 lines", () => {
    const state = makeState(6000);
    expect(minimapConfig(state)).toBeNull();
  });

  it("returns null exactly at 5001 lines", () => {
    const state = makeState(5001);
    expect(minimapConfig(state)).toBeNull();
  });

  it("returns a config object when doc has exactly 5000 lines", () => {
    const state = makeState(5000);
    const cfg = minimapConfig(state);
    expect(cfg).not.toBeNull();
    expect(cfg!.displayText).toBe("blocks");
    expect(cfg!.showOverlay).toBe("always");
    expect(typeof cfg!.create).toBe("function");
  });

  it("returns a config object for a small doc (100 lines)", () => {
    const state = makeState(100);
    const cfg = minimapConfig(state);
    expect(cfg).not.toBeNull();
    expect(cfg!.displayText).toBe("blocks");
  });

  it("returns a config object for a single-line doc", () => {
    const state = makeState(1);
    const cfg = minimapConfig(state);
    expect(cfg).not.toBeNull();
  });
});
