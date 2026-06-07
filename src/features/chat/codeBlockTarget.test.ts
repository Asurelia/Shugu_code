// src/features/chat/codeBlockTarget.test.ts
import { describe, it, expect } from "vitest";
import { parseCodeBlockTarget } from "./codeBlockTarget";

describe("parseCodeBlockTarget", () => {
  it("extrait un chemin de l'info-string (```ts src/foo.ts)", () => {
    expect(parseCodeBlockTarget("ts src/foo.ts", "const x = 1;")).toBe("src/foo.ts");
  });
  it("extrait un chemin d'un commentaire en 1ʳᵉ ligne (// src/foo.ts)", () => {
    expect(parseCodeBlockTarget("ts", "// src/foo.ts\nconst x = 1;")).toBe("src/foo.ts");
  });
  it("supporte les commentaires # (Python/yaml)", () => {
    expect(parseCodeBlockTarget("python", "# app/main.py\nprint(1)")).toBe("app/main.py");
  });
  it("renvoie null sans indice de chemin", () => {
    expect(parseCodeBlockTarget("ts", "const x = 1;")).toBeNull();
  });
  it("ignore un faux positif (pas de slash ni extension)", () => {
    expect(parseCodeBlockTarget("ts hello", "const x = 1;")).toBeNull();
  });
});
