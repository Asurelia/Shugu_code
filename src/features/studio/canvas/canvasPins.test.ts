import { describe, expect, it } from "vitest";
import {
  addPinToNode,
  buildPinsTask,
  commentedPins,
  parsePins,
  pinsOfNode,
  removePinFromNode,
  setPinComment,
} from "./canvasPins";
import {
  createDefaultDoc,
  parseCanvasDoc,
  LIVE_HOME_ID,
  type StudioCanvasDoc,
} from "./studioCanvasDoc";

const EL = { tag: "h1", selector: "h1.hero", text: "Bienvenue", open: `<h1 class="hero">` };

function docWithPin(): { doc: StudioCanvasDoc; pinId: string } {
  const { doc, pin } = addPinToNode(createDefaultDoc(), LIVE_HOME_ID, EL, 0.25, 0.5);
  return { doc, pinId: pin.id };
}

describe("canvas pins", () => {
  it("adds a pin with clamped relative position", () => {
    const { doc, pin } = addPinToNode(createDefaultDoc(), LIVE_HOME_ID, EL, 1.4, -2);
    expect(pin.relX).toBe(1);
    expect(pin.relY).toBe(0);
    expect(pin.comment).toBe("");
    const node = doc.nodes.find((n) => n.id === LIVE_HOME_ID);
    expect(pinsOfNode(node)).toHaveLength(1);
  });

  it("sets and edits a comment", () => {
    const { doc, pinId } = docWithPin();
    const next = setPinComment(doc, LIVE_HOME_ID, pinId, "Agrandir ce titre");
    expect(pinsOfNode(next.nodes.find((n) => n.id === LIVE_HOME_ID))[0].comment).toBe(
      "Agrandir ce titre",
    );
  });

  it("removes a pin and clears the field when empty", () => {
    const { doc, pinId } = docWithPin();
    const next = removePinFromNode(doc, LIVE_HOME_ID, pinId);
    expect(next.nodes.find((n) => n.id === LIVE_HOME_ID)?.pins).toBeUndefined();
  });

  it("keeps other nodes untouched", () => {
    const { doc } = docWithPin();
    const brand = doc.nodes.find((n) => n.id === "brand");
    expect(pinsOfNode(brand)).toHaveLength(0);
  });
});

describe("parsePins (lenient)", () => {
  it("returns undefined for non-arrays and empty results", () => {
    expect(parsePins(null)).toBeUndefined();
    expect(parsePins("x")).toBeUndefined();
    expect(parsePins([])).toBeUndefined();
    expect(parsePins([{ nope: true }])).toBeUndefined();
  });

  it("keeps valid pins and drops malformed ones", () => {
    const pins = parsePins([
      { id: "p1", selector: "h1", relX: 2, relY: -1, comment: "c" },
      { id: 42 },
    ]);
    expect(pins).toHaveLength(1);
    expect(pins![0]).toMatchObject({ id: "p1", relX: 1, relY: 0, comment: "c" });
  });

  it("round-trips through parseCanvasDoc", () => {
    const { doc } = docWithPin();
    const parsed = parseCanvasDoc(JSON.parse(JSON.stringify(doc)));
    expect(parsed).not.toBeNull();
    expect(pinsOfNode(parsed!.nodes.find((n) => n.id === LIVE_HOME_ID))).toHaveLength(1);
  });
});

describe("buildPinsTask", () => {
  it("lists only commented pins, in order", () => {
    const { doc, pinId } = docWithPin();
    const withMore = addPinToNode(doc, LIVE_HOME_ID, { ...EL, selector: "p.lede" }, 0.5, 0.5);
    const next = setPinComment(withMore.doc, LIVE_HOME_ID, pinId, "Titre plus grand");
    const pins = commentedPins(next.nodes.find((n) => n.id === LIVE_HOME_ID));
    expect(pins).toHaveLength(1);
    const task = buildPinsTask("Accueil", pins);
    expect(task).toContain("Accueil");
    expect(task).toContain("Titre plus grand");
    expect(task).toContain("h1.hero");
    expect(task).not.toContain("p.lede");
  });
});
