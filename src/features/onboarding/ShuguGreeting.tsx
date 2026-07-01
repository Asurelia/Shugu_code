// Shugu Forge — écran « rencontre avec Shugu » au premier lancement (S3).
//
// La relation AVANT la config technique : on présente la mascotte, on laisse
// choisir sa voix, et on pose une première pierre de mémoire. Indépendant du
// catalogue de modèles (les utilisateurs cloud-only rencontrent Shugu aussi).
// Précède l'overlay de téléchargement (Onboarding attend le flag greeting).

import { useState } from "react";
import { Chibi } from "@/features/mascot/Chibi";
import { VoicePicker } from "@/features/mascot/VoicePicker";
import { ttsSpeak } from "@/features/mascot/useTts";
import { useUpsertMascotFact } from "@/features/mascot/mascotMemoryStore";
import { useGreetingDone, markGreetingDone } from "./greetingFlag";

const GREETING_LINE =
  "Salut, moi c'est Shugu ! Je vais t'accompagner dans ton code — je réagis à ce " +
  "qui se passe, je retiens ce qui compte pour toi, et je peux même parler.";

export function ShuguGreeting() {
  const done = useGreetingDone();
  const upsert = useUpsertMascotFact();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [lang, setLang] = useState("");

  // null (chargement) ou true (déjà rencontrée) → on ne rend rien.
  if (done !== false) return null;

  const finish = () => {
    const v = lang.trim();
    if (v) {
      upsert.mutate({ category: "tech", key: "langage préféré", value: v, source: "user" });
    }
    void markGreetingDone();
  };

  return (
    <div className="shugu-greeting-overlay" role="dialog" aria-modal="true" aria-label="Rencontre avec Shugu">
      <div className="shugu-greeting-card">
        <div className="shugu-greeting-hero">
          <div className="shugu-greeting-glow" aria-hidden="true" />
          <Chibi size={96} mood={step === 2 ? "joy" : "smile"} />
        </div>

        {step === 0 && (
          <>
            <h2>Enchantée 👋</h2>
            <p className="shugu-greeting-bubble">{GREETING_LINE}</p>
            <div className="shugu-greeting-actions">
              <button className="lgb lgb-sm" onClick={() => ttsSpeak(GREETING_LINE)}>
                Écouter
              </button>
              <button className="lgb lgb-sm lgb-primary" onClick={() => setStep(1)}>
                Continuer
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Ma voix</h2>
            <p className="sub">
              Choisis comment je sonne — tu pourras toujours changer plus tard dans
              « Profil de Shugu ».
            </p>
            <VoicePicker />
            <div className="shugu-greeting-actions">
              <button className="lgb lgb-sm" onClick={() => setStep(0)}>Retour</button>
              <button className="lgb lgb-sm lgb-primary" onClick={() => setStep(2)}>
                Continuer
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Une dernière chose</h2>
            <p className="sub">
              Tu codes surtout en quoi ? (facultatif — je m'en souviendrai)
            </p>
            <input
              className="shugu-greeting-input"
              placeholder="ex. Rust + TypeScript"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") finish();
              }}
              autoFocus
            />
            <div className="shugu-greeting-actions">
              <button className="lgb lgb-sm" onClick={() => setStep(1)}>Retour</button>
              <button className="lgb lgb-sm lgb-primary" onClick={finish}>
                Commencer
              </button>
            </div>
          </>
        )}

        <button className="shugu-greeting-skip" onClick={finish} title="Passer la présentation">
          Passer
        </button>
      </div>
    </div>
  );
}
