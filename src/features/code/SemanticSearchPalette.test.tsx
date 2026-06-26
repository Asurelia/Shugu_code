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
    options.forEach((el, i) => {
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("type")).toBe("button");
      // M2 — chaque option porte un id stable `sem-opt-N`.
      expect(el.getAttribute("id")).toBe(`sem-opt-${i}`);
    });
    // Le chemin (name) et le range (hint) sont affichés.
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("#L10-20");
    expect(container.textContent).toContain("src/b.ts");
    expect(container.textContent).toContain("#L5");
    expect(semanticSearchMock).toHaveBeenCalled();
  });

  it("wires the combobox pattern: input.aria-activedescendant points at the active option", async () => {
    mockHits = [
      { id: "src/a.ts#L1-2", distance: 0.1 },
      { id: "src/b.ts#L3-4", distance: 0.2 },
      { id: "src/c.ts#L5-6", distance: 0.3 },
    ];
    act(() => {
      root.render(<SemanticSearchPalette open onClose={() => {}} />);
    });
    typeQuery("combobox aria");
    await flushSearch();

    const input = container.querySelector("input")!;
    // M2 — le pattern combobox éditable est complet sur l'input.
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe("sem-listbox");
    // La listbox référencée existe bien avec cet id.
    expect(container.querySelector("#sem-listbox")).not.toBeNull();

    // aria-activedescendant pointe vers l'id du bouton ACTIF (idx 0 au départ),
    // et cet id résout vers un élément réel role=option sélectionné.
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBe("sem-opt-0");
    const target = container.querySelector(`#${active}`);
    expect(target).not.toBeNull();
    expect(target!.getAttribute("role")).toBe("option");
    expect(target!.getAttribute("aria-selected")).toBe("true");

    // Fléchage ↓ : l'activedescendant suit la nouvelle ligne active.
    act(() => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(input.getAttribute("aria-activedescendant")).toBe("sem-opt-1");
    expect(
      container.querySelector("#sem-opt-1")!.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps ARIA coherent during a re-search: expanded=false + no activedescendant while loading", async () => {
    // 1re recherche résolue → 2 options, loading=false.
    mockHits = [
      { id: "src/a.ts#L1-2", distance: 0.1 },
      { id: "src/b.ts#L3-4", distance: 0.2 },
    ];
    act(() => {
      root.render(<SemanticSearchPalette open onClose={() => {}} />);
    });
    typeQuery("première requête");
    await flushSearch();

    const input = container.querySelector("input")!;
    // État stable post-recherche : expanded + activedescendant pointent du réel.
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("sem-opt-0");

    // 2e requête : loading=true repart AUSSITÔT (setLoading(true) synchrone dans
    // l'effet), mais `hits` garde l'ancien jeu jusqu'à résolution → les
    // <button role=option> sont masqués par `!loading`. On NE laisse PAS passer
    // le debounce (200 ms) : on reste dans la fenêtre de chargement.
    typeQuery("deuxième requête");
    await act(async () => {
      await Promise.resolve();
    });

    // Les options sont retirées du DOM pendant le chargement…
    expect(container.querySelectorAll('[role="option"]').length).toBe(0);
    expect(container.textContent).toContain("Recherche sémantique en cours");
    // …donc l'input NE DOIT PLUS annoncer expanded ni pointer un id absent
    //   (sinon aria-activedescendant référence un nœud inexistant — bug ARIA).
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    // Laisse la 2e recherche se résoudre proprement (cleanup afterEach).
    await flushSearch();
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
