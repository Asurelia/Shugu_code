// Shugu Forge — sélecteur de voix partagé (Profil de Shugu + onboarding).
//
// Réutilise ENTIÈREMENT le système existant : useTtsEnabled (toggle voice.tts),
// useTtsVoice (voice.ttsVoice), ttsSpeak (file séquentielle MiniMax + keychain).
// Aucune saisie de clé réinventée. Provider = minimax (OpenAI câblé plus tard).

import { useTtsEnabled, useTtsVoice, ttsSpeak } from "./useTts";
import { MASCOT_VOICE_PRESETS, normalizeVoiceId } from "./voicePresets";

export function VoicePicker() {
  const { enabled, toggle } = useTtsEnabled();
  const { voiceId, setVoice } = useTtsVoice();
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
      {!enabled && (
        <div className="sub">
          Active la voix pour choisir un timbre et l'écouter. La clé MiniMax se configure
          dans Réglages → Connexions.
        </div>
      )}
    </div>
  );
}
