import { describe, it, expect } from "vitest";
import { parseSpokenPlan, deterministicPlan } from "./speakableRewrite";
import { isOutOfBandConvId, SPEAK_CONV_PREFIX } from "@/features/code/ai-edit/types";

describe("isOutOfBandConvId (fix streaming — la synthèse vocale ne doit pas clobber le chat)", () => {
  it("reconnaît le préfixe de synthèse vocale speak: comme hors-flux", () => {
    expect(isOutOfBandConvId(SPEAK_CONV_PREFIX + "mascot")).toBe(true);
  });
  it("reconnaît toujours le préfixe des éditions inline aiedit:", () => {
    expect(isOutOfBandConvId("aiedit:42")).toBe(true);
  });
  it("laisse passer les vrais conversationId du chat (et null/undefined)", () => {
    expect(isOutOfBandConvId("conv-123")).toBe(false);
    expect(isOutOfBandConvId(null)).toBe(false);
    expect(isOutOfBandConvId(undefined)).toBe(false);
  });
});

describe("parseSpokenPlan", () => {
  it("parse un JSON propre → texte + émotion + expression dérivée", () => {
    const p = parseSpokenPlan('{"spoken_text":"Bravo, ça compile enfin","emotion":"happy"}');
    expect(p).not.toBeNull();
    expect(p!.spokenText).toBe("Bravo, ça compile enfin");
    expect(p!.emotion).toBe("happy");
    expect(p!.expression).toBe("joy"); // dérivé de l'émotion (source unique)
  });

  it("gère un JSON entouré d'un bloc ```json", () => {
    const raw = "Voici :\n```json\n{\"spoken_text\": \"C'est réglé\", \"emotion\": \"calm\"}\n```";
    const p = parseSpokenPlan(raw);
    expect(p!.spokenText).toBe("C'est réglé");
    expect(p!.emotion).toBe("calm");
  });

  it("isole le JSON même noyé dans de la prose", () => {
    const raw = 'Bien sûr ! {"spoken_text":"Trois fichiers modifiés","emotion":"neutral"} voilà.';
    const p = parseSpokenPlan(raw);
    expect(p!.spokenText).toBe("Trois fichiers modifiés");
    expect(p!.emotion).toBe("neutral");
    expect(p!.expression).toBe("neutral");
  });

  it("ramène une émotion inventée sur neutral", () => {
    const p = parseSpokenPlan('{"spoken_text":"ok","emotion":"ecstatic"}');
    expect(p!.emotion).toBe("neutral");
  });

  it("nettoie un markdown qui aurait fui dans spoken_text", () => {
    const p = parseSpokenPlan('{"spoken_text":"Regarde **ici** et `foo()`","emotion":"happy"}');
    expect(p!.spokenText).not.toContain("*");
    expect(p!.spokenText).not.toContain("`");
    expect(p!.spokenText).toContain("Regarde");
  });

  it("retourne null si aucun JSON exploitable", () => {
    expect(parseSpokenPlan("désolé je n'ai pas compris")).toBeNull();
  });

  it("retourne null si spoken_text est vide (→ fallback en amont)", () => {
    expect(parseSpokenPlan('{"spoken_text":"","emotion":"happy"}')).toBeNull();
    expect(parseSpokenPlan('{"emotion":"happy"}')).toBeNull();
  });

  it("accepte aussi la clé camelCase spokenText", () => {
    const p = parseSpokenPlan('{"spokenText":"salut","emotion":"happy"}');
    expect(p!.spokenText).toBe("salut");
  });
});

describe("deterministicPlan (fallback)", () => {
  it("nettoie le markdown et dérive une émotion neutre pour un texte normal", () => {
    const p = deterministicPlan("Voici **le résultat** que tu voulais.");
    expect(p.spokenText).not.toContain("*");
    expect(p.emotion).toBe("neutral");
    expect(p.expression).toBe("neutral");
  });

  it("détecte un message d'erreur → sad", () => {
    const p = deterministicPlan("⚠ chat_send failed: timeout réseau");
    expect(p.emotion).toBe("sad");
    expect(p.expression).toBe("sad");
  });
});
