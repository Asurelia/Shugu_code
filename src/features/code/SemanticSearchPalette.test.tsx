// Phase 7 #2 — smoke / a11y guard de la palette de recherche sémantique.
//
// Pas de @testing-library dans ce projet : on monte le composant dans un vrai
// root happy-dom via react-dom/client + act(), on pilote l'input, et on assert
// sur le DOM produit. Ça attrape les régressions cheap-but-real :
//   - un composant qui throw au render ;
//   - une ligne de résultat redevenue un <div onClick> (régression a11y que ce
//     lot corrige précisément) au lieu d'un vrai <button role=option> ;
//   - l'empty-state pédagogique (index froid) qui disparaît quand le backend
//     renvoie [].

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VecHit } from "@/lib/vector";

// ── Mocks ──────────────────────────────────────────────────────────────────
// semanticSearch : contrôlé par test via une variable module-level.
let mockHits: VecHit[] = [];
const semanticSearchMock = vi.fn(async (): Promise<VecHit[]> => mockHits);

vi.mock("@/lib/vector", () => ({
  semanticSearch: (...args: unknown[]) => semanticSearchMock(...(args as [])),
}));

// useShell : la palette consomme openFile + editorViewRef. Un shell inerte
// suffit pour le rendu (les effets d'ouverture ne sont pas exercés ici).
const openFileMock = vi.fn(async () => {});
vi.mock("@/routes/shell-context", () => ({
  useShell: () => ({
    openFile: openFileMock,
    editorViewRef: { current: null },
  }),
}));

// Importé APRÈS les mocks pour qu'ils prennent effet.
import { SemanticSearchPalette } from "./SemanticSearchPalette";

// React.act lit cette globale pour valider qu'on teste bien en mode act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockHits = [];
  semanticSearchMock.mockClear();
  openFileMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** Laisse passer le debounce (200 ms) + le microtask de résolution du mock. */
async function flushSearch() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
}

/** Tape `value` dans l'input de recherche (déclenche onChange React). */
function typeQuery(value: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("input introuvable — la palette n'a pas rendu");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SemanticSearchPalette", () => {
  it("renders nothing when closed", () => {
    act(() => {
      root.render(<SemanticSearchPalette open={false} onClose={() => {}} />);
    });
    expect(container.innerHTML).toBe("");
  });

  it("shows the initial prompt when opened with no query", () => {
    act(() => {
      root.render(<SemanticSearchPalette open onClose={() => {}} />);
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Décris une intention de code");
    // Aucun appel backend tant que rien n'est tapé.
    expect(semanticSearchMock).not.toHaveBeenCalled();
  });

  it("renders each result row as a real <button role=option> (a11y guard)", async () => {
    mockHits = [
      { id: "src/a.ts#L10-20", distance: 0.11 },
      { id: "src/b.ts#L5", distance: 0.22 },
    ];
    act(() => {
      root.render(<SemanticSearchPalette open onClose={() => {}} />);
    });
    typeQuery("validation jwt");
    await flushSearch();

    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    // CHAQUE résultat doit être un vrai <button>, pas un <div onClick>.
    options.forEach((el) => {
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("type")).toBe("button");
    });
    // Le chemin (name) et le range (hint) sont affichés.
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("#L10-20");
    expect(container.textContent).toContain("src/b.ts");
    expect(container.textContent).toContain("#L5");
    expect(semanticSearchMock).toHaveBeenCalled();
  });

  it("shows the pedagogical empty-state pointing at reindex when results are []", async () => {
    mockHits = [];
    act(() => {
      root.render(<SemanticSearchPalette open onClose={() => {}} />);
    });
    typeQuery("rien ne matche");
    await flushSearch();

    expect(container.querySelectorAll('[role="option"]').length).toBe(0);
    expect(container.textContent).toContain("index pas encore construit");
    // Oriente explicitement vers la commande de réindexation.
    expect(container.textContent).toContain("Reindex code");
  });
});
