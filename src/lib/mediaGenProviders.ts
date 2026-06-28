// Presets de modèles génératifs MiniMax pour la VIDÉO et la MUSIQUE.
// Parallèle à imageProviders.ts (image) — données pures, pas de React.
// Consommés par les onglets Vidéo/Musique du Studio média (views-chat.tsx).
//
// La vidéo et la musique MiniMax passent par la MÊME clé/host que l'image et le
// texte (provider id "minimax", host par défaut https://api.minimax.io). On
// résout donc la config via loadProviderConfig("minimax") côté appelant.

export interface MediaModelPreset {
  /** Nom de modèle exact passé à l'API (champ `model`). */
  id: string;
  label: string;
  meta: string;
}

/** Hôte global MiniMax (.io). ⚠ .com = Chine continentale — clé liée à l'hôte. */
export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io";

/** Modèles vidéo (endpoint /v1/video_generation). */
export const VIDEO_MODEL_PRESETS: MediaModelPreset[] = [
  { id: "MiniMax-Hailuo-02",      label: "Hailuo 02",        meta: "T2V/I2V · jusqu'à 1080P · 6–10 s" },
  { id: "MiniMax-Hailuo-2.3",     label: "Hailuo 2.3",       meta: "mouvement & physique améliorés" },
  { id: "MiniMax-Hailuo-2.3-Fast", label: "Hailuo 2.3 Fast", meta: "I2V économique (moins de points)" },
  { id: "T2V-01-Director",        label: "T2V-01 Director",  meta: "contrôles caméra [Pan]/[Zoom]/[Push in]…" },
];

/** Modèles musique (endpoint /v1/music_generation). */
export const MUSIC_MODEL_PRESETS: MediaModelPreset[] = [
  { id: "music-2.6",      label: "Music 2.6",        meta: "chanson · voix + accompagnement" },
  { id: "music-2.6-free", label: "Music 2.6 (free)", meta: "tier gratuit · RPM réduit (tests)" },
];

/** Résolutions vidéo proposées dans l'UI (selon modèle Hailuo). */
export const VIDEO_RESOLUTIONS = ["768P", "1080P"] as const;

/** Durées vidéo proposées (secondes). */
export const VIDEO_DURATIONS = [6, 10] as const;
