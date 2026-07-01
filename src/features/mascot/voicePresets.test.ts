import { describe, it, expect } from "vitest";
import {
  resolveVoiceLabel,
  normalizeVoiceId,
  DEFAULT_VOICE_ID,
  MASCOT_VOICE_PRESETS,
} from "./voicePresets";

describe("voicePresets", () => {
  it("resolveVoiceLabel retourne le libellé d'une voix connue", () => {
    expect(resolveVoiceLabel("female-shaonv")).toContain("Shaonv");
  });

  it("resolveVoiceLabel retombe sur l'id brut si inconnu", () => {
    expect(resolveVoiceLabel("zzz-unknown")).toBe("zzz-unknown");
  });

  it("resolveVoiceLabel vide/null → défaut", () => {
    expect(resolveVoiceLabel("")).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceLabel(null)).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceLabel(undefined)).toBe(DEFAULT_VOICE_ID);
  });

  it("normalizeVoiceId rabat vide/espaces sur le défaut", () => {
    expect(normalizeVoiceId("")).toBe(DEFAULT_VOICE_ID);
    expect(normalizeVoiceId("   ")).toBe(DEFAULT_VOICE_ID);
    expect(normalizeVoiceId(null)).toBe(DEFAULT_VOICE_ID);
    expect(normalizeVoiceId("female-yujie")).toBe("female-yujie");
  });

  it("le défaut figure dans la liste curée", () => {
    expect(MASCOT_VOICE_PRESETS.some((v) => v.id === DEFAULT_VOICE_ID)).toBe(true);
  });
});
