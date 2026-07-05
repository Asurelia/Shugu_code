// Shugu Forge — sélecteur de voix partagé (Profil de Shugu + onboarding).
//
// Réutilise ENTIÈREMENT le système existant : useTtsEnabled (toggle voice.tts),
// useTtsVoice (voice.ttsVoice), useTtsModel (voice.ttsModel), ttsSpeak (pipeline
// séquentiel MiniMax + keychain). Aucune saisie de clé réinventée. Provider =
// minimax (OpenAI câblé plus tard).
//
// Palier 3 (couche affective) : sélecteur de modèle 2.6/2.8 (avec avertissement
// whisper/fluent) + boutons de test PAR ÉMOTION — l'utilisateur ENTEND la
// couche affective directement, sans passer par le chat.

import { useTtsEnabled, useTtsVoice, useTtsModel, ttsSpeak } from "./useTts";
import { MASCOT_VOICE_PRESETS, normalizeVoiceId } from "./voicePresets";
import type { ShuguEmotion } from "./affect";

/** Modèles T2A exposés. Vide = défaut Rust (speech-2.6-turbo). Les modèles 2.8
 *  débloquent les interjections inline mais perdent les modes whisper/fluent. */
const TTS_MODELS: { id: string; label: string; hint: string }[] = [
  { id: "", label: "speech-2.6-turbo (défaut)", hint: "Rapide · émotions + whisper/fluent" },
  { id: "speech-2.6-hd", label: "speech-2.6-hd", hint: "Qualité HD · émotions + whisper/fluent" },
  { id: "speech-2.8-turbo", label: "speech-2.8-turbo", hint: "Interjections (rires/soupirs) · PERD whisper/fluent" },
  { id: "speech-2.8-hd", label: "speech-2.8-hd", hint: "HD + interjections · PERD whisper/fluent" },
];

/** Extraits de démonstration : une phrase par émotion pour l'A/B à l'oreille. */
const EMOTION_TESTS: { emotion: ShuguEmotion; label: string; phrase: string }[] = [
  { emotion: "happy", label: "😊 Joyeuse", phrase: "Bravo, ton code compile enfin !" },
  { emotion: "calm", label: "😌 Posée", phrase: "Voilà, c'est réglé tranquillement." },
  { emotion: "surprised", label: "😮 Surprise", phrase: "Oh ! Je ne m'attendais pas à ça." },
  { emotion: "sad", label: "😢 Désolée", phrase: "Aïe, ça n'a pas marché cette fois." },
];

function is28(model: string): boolean {
  return model.startsWith("speech-2.8");
}

export function VoicePicker() {
  const { enabled, toggle } = useTtsEnabled();
  const { voiceId, setVoice } = useTtsVoice();
  const { model, setModel } = useTtsModel();
  const current = normalizeVoiceId(voiceId);

  return (
    <div className="voice-picker">
      <label className="voice-picker-row">
        <input type="checkbox" checked={enabled} onChange={toggle} />
        <span>Activer la voix de Shugu (TTS MiniMax)</span>
      </label>
      <div className="voice-picker-row">
        <select
          value={current}
          onChange={(e) => setVoice(e.target.value)}
          disabled={!enabled}
          aria-label="Voix de Shugu"
        >
          {MASCOT_VOICE_PRESETS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="lgb lgb-sm"
          onClick={() => ttsSpeak("Salut, c'est Shugu !")}
          disabled={!enabled}
          title={enabled ? "Écouter un extrait" : "Active la voix d'abord"}
        >
          Tester
        </button>
      </div>

      <div className="voice-picker-row">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!enabled}
          aria-label="Modèle de synthèse vocale"
        >
          {TTS_MODELS.map((m) => (
            <option key={m.id} value={m.id} title={m.hint}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {enabled && is28(model) && (
        <div className="sub">
          ⚠ Les modèles 2.8 ajoutent les interjections (rires, soupirs) mais ne
          gèrent plus les modes <em>whisper</em> et <em>fluent</em>. Vérifie ton
          quota MiniMax avant un usage intensif.
        </div>
      )}

      {enabled && (
        <div className="voice-picker-emotions">
          <div className="sub">Écouter la couche affective :</div>
          <div className="voice-picker-row" style={{ flexWrap: "wrap", gap: 6 }}>
            {EMOTION_TESTS.map((t) => (
              <button
                key={t.emotion}
                type="button"
                className="lgb lgb-sm"
                onClick={() => ttsSpeak(t.phrase, t.emotion)}
                title={`Émotion « ${t.emotion} »`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!enabled && (
        <div className="sub">
          Active la voix pour choisir un timbre et l'écouter. La clé MiniMax se configure
          dans Réglages → Connexions.
        </div>
      )}
    </div>
  );
}
