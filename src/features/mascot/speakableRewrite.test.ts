import { describe, it, expect } from "vitest";
import { parseSpokenPlan, deterministicPlan, computeSpeechTrigger } from "./speakableRewrite";
import { isOutOfBandConvId, SPEAK_CONV_PREFIX } from "@/features/code/ai-edit/types";

describe("computeSpeechTrigger (déclenchement — corrige le trou orchestrateur)", () => {
  const PH = "Orchestrateur au travail…";

  it("un nouveau message AI est prêt à lire", () => {
    const t = computeSpeechTrigger({ id: "a1", role: "ai", body: "Voici la réponse." }, null, PH);
    expect(t.speak).toBe(true);
    expect(t.text).toBe("Voici la réponse.");
  });

  it("le placeholder orchestrateur n'est JAMAIS lu", () => {
    expect(computeSpeechTrigger({ id: "a1", role: "ai", body: PH }, null, PH).speak).toBe(false);
  });

  it("détecte la transition placeholder → réponse finale (même id, body remplacé en place)", () => {
    // 1) placeholder vu → pas lu
    const t1 = computeSpeechTrigger({ id: "a1", role: "ai", body: PH }, "prev", PH);
    expect(t1.speak).toBe(false);
    // 2) même id, body devenu final → clé différente → lu UNE fois
    const t2 = computeSpeechTrigger({ id: "a1", role: "ai", body: "Le jeu est prêt." }, t1.key, PH);
    expect(t2.speak).toBe(true);
    expect(t2.text).toBe("Le jeu est prêt.");
    // 3) reconciler ré-append le MÊME body → pas de re-lecture
    const t3 = computeSpeechTrigger({ id: "a1", role: "ai", body: "Le jeu est prêt." }, t2.key, PH);
    expect(t3.speak).toBe(false);
  });

  it("ne relit pas le même message (dédup par clé id+body)", () => {
    const msg = { id: "a2", role: "ai", body: "Idem." };
    const first = computeSpeechTrigger(msg, "x", PH);
    expect(first.speak).toBe(true);
    expect(computeSpeechTrigger(msg, first.key, PH).speak).toBe(false);
  });

  it("ignore les non-AI, les images, le vide et l'absence de message", () => {
    expect(computeSpeechTrigger({ id: "u1", role: "user", body: "salut" }, null, PH).speak).toBe(false);
    expect(computeSpeechTrigger({ id: "i1", role: "ai", body: "x", image: true }, null, PH).speak).toBe(false);
    expect(computeSpeechTrigger(undefined, null, PH).speak).toBe(false);
    expect(computeSpeechTrigger({ id: "e1", role: "ai", body: "" }, null, PH).speak).toBe(false);
  });

  it("lit un message d'échec orchestrateur (contenu final ; l'émotion est gérée en aval)", () => {
    const t = computeSpeechTrigger(
      { id: "a3", role: "ai", body: "⚠ Orchestrator a échoué : timeout" },
      "prev",
      PH,
    );
    expect(t.speak).toBe(true);
  });

  it("préfère text à body quand les deux existent", () => {
    const t = computeSpeechTrigger({ id: "a4", role: "ai", body: "corps", text: "texte" }, null, PH);
    expect(t.text).toBe("texte");
  });
});

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
