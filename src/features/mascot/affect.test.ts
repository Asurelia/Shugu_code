import { describe, it, expect } from "vitest";
import {
  coerceEmotion,
  voiceParamsFor,
  moodFor,
  deriveEmotionHeuristic,
  stripMarkdownForSpeech,
  splitIntoSpeechChunks,
  EMOTION_TO_VOICE,
  EMOTION_TO_MOOD,
  MINIMAX_EMOTIONS,
  type ShuguEmotion,
} from "./affect";

describe("coerceEmotion", () => {
  it("garde une émotion valide", () => {
    expect(coerceEmotion("happy")).toBe("happy");
    expect(coerceEmotion("whisper")).toBe("whisper");
    expect(coerceEmotion("neutral")).toBe("neutral");
  });
  it("retombe sur neutral pour toute entrée inconnue/absente", () => {
    expect(coerceEmotion("excited")).toBe("neutral"); // valeur non-MiniMax
    expect(coerceEmotion("auto")).toBe("neutral"); // interdit
    expect(coerceEmotion(undefined)).toBe("neutral");
    expect(coerceEmotion(null)).toBe("neutral");
    expect(coerceEmotion(42)).toBe("neutral");
    expect(coerceEmotion("")).toBe("neutral");
  });
});

describe("voiceParamsFor", () => {
  it("happy porte l'émotion MiniMax + une prosodie enjouée", () => {
    const vp = voiceParamsFor("happy");
    expect(vp.emotion).toBe("happy");
    expect(vp.speed).toBeGreaterThan(1);
    expect(vp.pitch).toBeGreaterThan(0);
  });
  it("neutral N'ENVOIE PAS d'émotion (champ omis → auto MiniMax)", () => {
    const vp = voiceParamsFor("neutral");
    expect(vp.emotion).toBeUndefined();
    expect(vp.speed).toBe(1.0);
    expect(vp.pitch).toBe(0);
  });
  it("whisper baisse le volume", () => {
    expect(voiceParamsFor("whisper").vol).toBeLessThan(1);
  });
  it("chaque émotion MiniMax envoie une valeur emotion identique à sa clé", () => {
    for (const e of MINIMAX_EMOTIONS) {
      expect(EMOTION_TO_VOICE[e].emotion).toBe(e);
    }
  });
  it("pitch est toujours un entier (contrainte API)", () => {
    for (const e of Object.keys(EMOTION_TO_VOICE) as ShuguEmotion[]) {
      expect(Number.isInteger(EMOTION_TO_VOICE[e].pitch)).toBe(true);
    }
  });
});

describe("moodFor", () => {
  it("projette les émotions sur les 5 poses chat existantes", () => {
    expect(moodFor("happy")).toBe("joy");
    expect(moodFor("surprised")).toBe("smile");
    expect(moodFor("sad")).toBe("sad");
    expect(moodFor("angry")).toBe("sad"); // pas de pose colère → repli triste
    expect(moodFor("calm")).toBe("neutral");
    expect(moodFor("neutral")).toBe("neutral");
  });
  it("toutes les émotions ont un mood défini (pas d'undefined)", () => {
    for (const e of Object.keys(EMOTION_TO_MOOD) as ShuguEmotion[]) {
      expect(EMOTION_TO_MOOD[e]).toBeDefined();
    }
  });
});

describe("deriveEmotionHeuristic", () => {
  it("détecte les marqueurs d'échec fiables → sad", () => {
    expect(deriveEmotionHeuristic("⚠ chat_send failed: timeout")).toBe("sad");
    expect(deriveEmotionHeuristic("❌ Raté")).toBe("sad");
    expect(deriveEmotionHeuristic("Erreur de compilation détectée")).toBe("sad");
  });
  it("une réponse normale reste neutral (auto MiniMax)", () => {
    expect(deriveEmotionHeuristic("Voici la fonction que tu voulais.")).toBe("neutral");
    expect(deriveEmotionHeuristic("C'est vert, tout compile !")).toBe("neutral");
  });
  it("ne se déclenche pas sur un « erreur » loin dans le texte", () => {
    const long = "x".repeat(60) + " erreur";
    expect(deriveEmotionHeuristic(long)).toBe("neutral");
  });
});

describe("stripMarkdownForSpeech", () => {
  it("retire les blocs de code entiers", () => {
    const out = stripMarkdownForSpeech("Voici :\n```ts\nconst x = 1;\n```\nVoilà.");
    expect(out).not.toContain("const x");
    expect(out).toContain("Voici");
    expect(out).toContain("Voilà");
  });
  it("retire le code inline", () => {
    expect(stripMarkdownForSpeech("Appelle `useTts()` maintenant")).not.toContain("`");
  });
  it("garde le libellé des liens, jette l'URL", () => {
    const out = stripMarkdownForSpeech("Va voir [la doc](https://example.com/x)");
    expect(out).toContain("la doc");
    expect(out).not.toContain("example.com");
  });
  it("retire les puces, titres et emphase", () => {
    const out = stripMarkdownForSpeech("# Titre\n- **gras** point\n- autre");
    expect(out).not.toContain("#");
    expect(out).not.toContain("*");
    expect(out).not.toContain("-");
    expect(out).toContain("gras");
    expect(out).toContain("Titre");
  });
  it("condense les espaces", () => {
    expect(stripMarkdownForSpeech("a\n\n\n   b")).toBe("a b");
  });
});

describe("splitIntoSpeechChunks", () => {
  it("un texte court reste en un seul fragment", () => {
    expect(splitIntoSpeechChunks("Salut, c'est Shugu !", 240)).toEqual(["Salut, c'est Shugu !"]);
  });
  it("découpe aux frontières de phrase quand ça dépasse maxLen", () => {
    const text = "Première phrase courte. Deuxième phrase un peu plus longue. Et une troisième.";
    const chunks = splitIntoSpeechChunks(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    // Aucun fragment ne dépasse la borne.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    // Aucune perte de mot : la concaténation contient tous les mots d'origine.
    expect(chunks.join(" ")).toContain("troisième");
  });
  it("coupe sur un espace une phrase unique trop longue (jamais au milieu d'un mot)", () => {
    const long = "mot ".repeat(60).trim(); // ~240 car sans ponctuation
    const chunks = splitIntoSpeechChunks(long, 50);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
      expect(c.startsWith(" ")).toBe(false);
      expect(c.endsWith(" ")).toBe(false);
    }
  });
  it("texte vide → aucun fragment", () => {
    expect(splitIntoSpeechChunks("   ", 240)).toEqual([]);
  });
});
