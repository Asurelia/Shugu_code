// Shugu Forge — liste curée statique de voix MiniMax (lot Voix, bloc UI).
//
// Étape 1 = liste statique (pas de dépendance réseau). Étape 2 (plus tard) :
// commande Rust `voice_list_voices` (/v1/get_voice) pour une liste dynamique.
// Les IDs sont les voix système documentées de MiniMax T2A (endpoint t2a_v2).
// `female-shaonv` est le défaut historique déjà câblé côté Rust (voice.rs).

export interface VoicePreset {
  id: string;
  label: string;
}

/** Voix par défaut (alignée sur le défaut Rust de voice_tts). */
export const DEFAULT_VOICE_ID = "female-shaonv";

/** Sous-ensemble curé, étiqueté en français. Élargissable sans migration. */
export const MASCOT_VOICE_PRESETS: readonly VoicePreset[] = [
  { id: "female-shaonv", label: "Shaonv — jeune femme (défaut)" },
  { id: "female-tianmei", label: "Tianmei — douce" },
  { id: "female-yujie", label: "Yujie — posée" },
  { id: "female-chengshu", label: "Chengshu — mature" },
  { id: "male-qn-qingse", label: "Qingse — jeune homme" },
  { id: "male-qn-jingying", label: "Jingying — assuré" },
  { id: "presenter_female", label: "Présentatrice" },
  { id: "presenter_male", label: "Présentateur" },
] as const;

/** Libellé d'une voix par id (retombe sur l'id brut si inconnu). Pur, testable. */
export function resolveVoiceLabel(id: string | null | undefined): string {
  const found = MASCOT_VOICE_PRESETS.find((v) => v.id === id);
  return found ? found.label : (id || DEFAULT_VOICE_ID);
}

/** Normalise l'id de voix courant : vide/inconnu → défaut. Pur, testable. */
export function normalizeVoiceId(id: string | null | undefined): string {
  const clean = (id ?? "").trim();
  return clean || DEFAULT_VOICE_ID;
}
