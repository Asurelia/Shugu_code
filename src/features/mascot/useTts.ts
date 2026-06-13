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

/** Un seul audio à la fois — un nouvel énoncé coupe le précédent. */
let currentAudio: HTMLAudioElement | null = null;

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
 * casser le flux visuel existant.
 */
export async function ttsSpeak(text: string): Promise<void> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
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
    currentAudio?.pause();
    currentAudio = new Audio(dataUrl);
    await currentAudio.play();
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
