import { describe, it, expect } from "vitest";
import {
  shouldRequestCompletion,
  RequestSequencer,
  sanitizeCompletion,
} from "./autocompleteState";

describe("shouldRequestCompletion", () => {
  it("empty / blank prefix → false", () => {
    expect(shouldRequestCompletion("", "x")).toBe(false);
    expect(shouldRequestCompletion("   \n", "x")).toBe(false);
  });

  it("cursor in the middle of an identifier → false", () => {
    expect(shouldRequestCompletion("const fo", "o = 1")).toBe(false);
  });

  it("end of token / before punctuation or EOL → true", () => {
    expect(shouldRequestCompletion("const x = ", "")).toBe(true);
    expect(shouldRequestCompletion("foo(", ")")).toBe(true);
    expect(shouldRequestCompletion("x", "\n")).toBe(true);
  });
});

describe("RequestSequencer", () => {
  it("a fresh request is current", () => {
    const s = new RequestSequencer();
    const a = s.next();
    expect(s.isCurrent(a)).toBe(true);
  });

  it("a newer request invalidates the older one", () => {
    const s = new RequestSequencer();
    const a = s.next();
    const b = s.next();
    expect(s.isCurrent(a)).toBe(false);
    expect(s.isCurrent(b)).toBe(true);
  });

  it("cancel() invalidates the in-flight request without opening a new one", () => {
    const s = new RequestSequencer();
    const a = s.next();
    s.cancel();
    expect(s.isCurrent(a)).toBe(false);
  });
});

describe("sanitizeCompletion", () => {
  it("empty → ''", () => expect(sanitizeCompletion("")).toBe(""));

  it("strips leaked FIM sentinels", () => {
    expect(sanitizeCompletion("foo<|fim_middle|>bar")).toBe("foobar");
    expect(sanitizeCompletion("a<PRE>b<SUF>c<MID>d")).toBe("abcd");
  });

  it("cuts at an end-of-stream sentinel", () => {
    expect(sanitizeCompletion("done<|endoftext|>ignored")).toBe("done");
  });

  it("caps to maxLines", () => {
    expect(sanitizeCompletion("1\n2\n3\n4\n5", 3)).toBe("1\n2\n3");
  });
});
