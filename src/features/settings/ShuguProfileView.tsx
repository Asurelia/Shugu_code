// Shugu Forge — « Profil de Shugu » : surface unifiée (S2).
//
// Regroupe en un seul endroit ce que l'utilisateur peut régler sur la mascotte :
//   • Mémoire   — ce que Shugu sait de toi (MascotMemoryPanel, socle existant)
//   • Voix      — timbre TTS + test (VoicePicker partagé)
//   • Apparence — calibration du snap de la chibi (MascotAppearance)
//
// Ancré sur la section réglages `mascot` (routée /settings/mascot), qui est aussi
// la cible du clic sur la mini-chibi du Rail. Onglets internes = état local.

import React from "react";
import { MascotMemoryPanel } from "./MascotMemoryPanel";
import { MascotAppearance } from "./MascotCalibration";
import { VoicePicker } from "@/features/mascot/VoicePicker";
import { Chibi } from "@/features/mascot/Chibi";

type ProfileTab = "memory" | "voice" | "appearance";

const TABS: { id: ProfileTab; label: string }[] = [
  { id: "memory", label: "Mémoire" },
  { id: "voice", label: "Voix" },
  { id: "appearance", label: "Apparence" },
];

export function ShuguProfileView() {
  const [tab, setTab] = React.useState<ProfileTab>("memory");

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section shugu-profile-head">
          <div className="shugu-profile-hero">
            <Chibi size={44} mood="smile" />
            <div>
              <h3>Profil de Shugu</h3>
              <p className="sub" style={{ margin: 0 }}>
                Tout ce qui rend Shugu <em>tienne</em> : ce qu'elle retient de toi, sa
                voix, et son apparence. Rien n'est caché — tu peux tout ajuster.
              </p>
            </div>
          </div>

          <div className="profile-tabs" role="tablist" aria-label="Sections du profil de Shugu">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={"profile-tab" + (tab === t.id ? " active" : "")}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === "memory" && <MascotMemoryPanel />}

        {tab === "voice" && (
          <div className="setting-section">
            <h3>Voix de Shugu</h3>
            <p className="sub">
              Choisis le timbre de la mascotte et écoute un extrait. La voix est lue
              lors des bulles (fenêtre mascotte) quand elle est activée.
            </p>
            <VoicePicker />
          </div>
        )}

        {tab === "appearance" && <MascotAppearance />}
      </div>
    </div>
  );
}
