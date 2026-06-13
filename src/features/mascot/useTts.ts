// Shugu Forge — useTts : la mascotte PARLE (TTS MiniMax, lot voix bloc A).
//
// IMPORTANT fenêtres : `sayMascot()` est émis depuis les DEUX webviews (main
// + mascotte) mais l'audio doit sortir UNE seule fois — le TTS est donc
// branché côté RENDU mascotte uniquement (SpeechBubble + ChatPanel, montés
// dans la seule fenêtre mascotte), jamais dans le store partagé.
//
// Clé/baseUrl : réutilise le système provider existant
// (`loadProviderConfig("minimax")` → keychain) — politique « jamais
// réinventer la saisie de clé ». Réglage `voice.tts` (défaut OFF) togglable
// par le bouton haut-parleur du composer mascotte.

import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { invoke } from "@/lib/tauri";
import { loadProviderConfig } from "@/lib/credentials";
import { db } from "@/lib/db";

const TTS_SETTING_KEY = "voice.tts";
const TTS_VOICE_KEY = "voice.ttsVoice";
const TTS_QUERY_KEY = ["settings", TTS_SETTING_KEY] as const;

/** Audio en cours — coupé par le toggle OFF. */
let currentAudio: HTMLAudioElement | null = null;
/** File SÉQUENTIELLE : deux énoncés proches (bulle « ✅ Terminé ! » + lecture
 * de la réponse déléguée) s'ENCHAÎNENT au lieu de se couper l'un l'autre. */
let queue: Promise<void> = Promise.resolve();
let pendingCount = 0;
/** Dédoublonnage : même texte demandé deux fois en < 4 s = un seul énoncé. */
let lastText = "";
let lastAt = 0;

export async function isTtsEnabled(): Promise<boolean> {
  try {
    return (await db.settings.get(TTS_SETTING_KEY)) === "true";
  } catch {
    return false;
  }
}

/**
 * Fait parler la mascotte (fire-and-forget). No-op silencieux si le réglage
 * est OFF, si la clé MiniMax manque, ou hors Tauri — la voix ne doit jamais
 * casser le flux visuel existant. Les énoncés sont joués en SÉQUENCE (file) ;
 * au-delà de 2 en attente, les nouveaux sont ignorés (pas de monologue).
 */
export function ttsSpeak(text: string): void {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const now = Date.now();
  if (clean === lastText && now - lastAt < 4000) return;
  lastText = clean;
  lastAt = now;
  if (pendingCount >= 2) return;
  pendingCount += 1;
  queue = queue
    .then(() => speakNow(clean))
    .catch(() => undefined)
    .finally(() => {
      pendingCount -= 1;
    });
}

async function speakNow(clean: string): Promise<void> {
  // Le réglage est relu au moment de JOUER : un toggle OFF pendant la file
  // coupe aussi les énoncés en attente.
  if (!(await isTtsEnabled())) return;
  try {
    const cfg = await loadProviderConfig("minimax");
    if (!cfg.apiKey) return;
    const voiceId = (await db.settings.get(TTS_VOICE_KEY).catch(() => null)) || undefined;
    const dataUrl = await invoke<string>("voice_tts", {
      text: clean.slice(0, 400),
      voiceId,
      baseUrl: cfg.baseUrl || "https://api.minimax.io",
      apiKey: cfg.apiKey,
    });
    await new Promise<void>((resolve) => {
      currentAudio = new Audio(dataUrl);
      currentAudio.onended = () => resolve();
      currentAudio.onerror = () => resolve();
      currentAudio.onpause = () => resolve();
      currentAudio.play().catch(() => resolve());
    });
  } catch (err) {
    console.warn("[tts] speak failed:", err);
  }
}

/** Hook réactif pour le bouton haut-parleur : état du réglage + toggle. */
export function useTtsEnabled() {
  const { data: enabled = false } = useQuery({
    queryKey: TTS_QUERY_KEY,
    queryFn: isTtsEnabled,
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: async () => {
      const next = !(await isTtsEnabled());
      await db.settings.set(TTS_SETTING_KEY, next ? "true" : "false");
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(TTS_QUERY_KEY, next);
      if (!next) currentAudio?.pause();
    },
  });
  return { enabled, toggle: () => toggle.mutate() };
}
