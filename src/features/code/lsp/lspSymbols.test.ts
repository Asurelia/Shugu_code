import { describe, it, expect } from "vitest";
import { lspSymbolsToOutline, type LspDocumentSymbol } from "./lspSymbols";

// DocumentSymbol minimal (range en {line,character} 0-based).
function sym(name: string, kind: number, line: number, children?: LspDocumentSymbol[]): LspDocumentSymbol {
  const pos = { line, character: 0 };
  const range = { start: pos, end: { line: line + 1, character: 0 } };
  return { name, kind, range, selectionRange: range, children };
}

// Doc factice : ligne 0-based → offset = line * 100.
const lineToOffset = (line: number) => line * 100;

describe("lspSymbolsToOutline", () => {
  it("maps LSP SymbolKind numbers to our kinds (class > method)", () => {
    const out = lspSymbolsToOutline([sym("Foo", 5, 0, [sym("bar", 6, 1)])], lineToOffset);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Foo");
    expect(out[0].kind).toBe("class");
    expect(out[0].children?.[0].kind).toBe("method");
    expect(out[0].children?.[0].name).toBe("bar");
  });

  it("computes from/to offsets using the line→offset mapper", () => {
    const out = lspSymbolsToOutline([sym("f", 12, 3)], lineToOffset);
    expect(out[0].from).toBe(300);
    expect(out[0].to).toBe(400);
    expect(out[0].kind).toBe("function");
  });

  it("maps struct(23) and interface(11)", () => {
    const out = lspSymbolsToOutline([sym("S", 23, 0), sym("I", 11, 5)], lineToOffset);
    expect(out[0].kind).toBe("class"); // struct → class
    expect(out[1].kind).toBe("interface");
  });

  it("falls back to 'variable' for unknown kinds", () => {
    const out = lspSymbolsToOutline([sym("x", 999, 0)], lineToOffset);
    expect(out[0].kind).toBe("variable");
  });

  it("handles an empty symbol list", () => {
    expect(lspSymbolsToOutline([], lineToOffset)).toEqual([]);
  });

  it("omits children key when there are none", () => {
    const out = lspSymbolsToOutline([sym("f", 12, 0)], lineToOffset);
    expect(out[0].children).toBeUndefined();
  });
});
