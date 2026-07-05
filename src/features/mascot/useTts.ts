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
import {
  coerceEmotion,
  splitIntoSpeechChunks,
  stripMarkdownForSpeech,
  voiceParamsFor,
  type ShuguEmotion,
  type VoiceParams,
} from "./affect";

const TTS_SETTING_KEY = "voice.tts";
const TTS_VOICE_KEY = "voice.ttsVoice";
const TTS_MODEL_KEY = "voice.ttsModel";
const TTS_QUERY_KEY = ["settings", TTS_SETTING_KEY] as const;
const TTS_VOICE_QUERY_KEY = ["settings", TTS_VOICE_KEY] as const;
const TTS_MODEL_QUERY_KEY = ["settings", TTS_MODEL_KEY] as const;

/** Audio en cours — coupé par le toggle OFF. */
let currentAudio: HTMLAudioElement | null = null;
/** File SÉQUENTIELLE : deux énoncés proches (bulle « ✅ Terminé ! » + lecture
 * de la réponse déléguée) s'ENCHAÎNENT au lieu de se couper l'un l'autre. */
let queue: Promise<void> = Promise.resolve();
let pendingCount = 0;
/** Dédoublonnage : même clé (émotion + texte) demandée deux fois en < 4 s = un
 *  seul énoncé. La clé inclut l'émotion pour ne pas fusionner deux lectures du
 *  même texte censées sonner différemment. */
let lastText = "";
let lastAt = 0;

/** Cache LRU (mémoire) des data URLs synthétisés, keyé par (voix|modèle|émotion|
 *  prosodie|texte). Évite de re-synthétiser un énoncé identique — surtout utile
 *  pour les fragments récurrents (salutations, « ✅ Terminé ! », confirmations).
 *  Borné pour ne pas gonfler la mémoire ; éviction du plus ancien (ordre
 *  d'insertion d'une Map JS). */
const audioCache = new Map<string, string>();
const AUDIO_CACHE_MAX = 48;

function cacheGet(key: string): string | undefined {
  const hit = audioCache.get(key);
  if (hit !== undefined) {
    // Touch LRU : ré-insérer en fin d'ordre.
    audioCache.delete(key);
    audioCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, dataUrl: string): void {
  audioCache.set(key, dataUrl);
  while (audioCache.size > AUDIO_CACHE_MAX) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    audioCache.delete(oldest);
  }
}

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
 *
 * `emotion` (couche affective) pilote le `voice_setting` MiniMax via la table
 * unique EMOTION_TO_VOICE. Le texte est d'abord nettoyé du markdown/code/URLs
 * (stripMarkdownForSpeech) pour ne jamais vocaliser de symboles. Le dédoublonnage
 * tient compte de l'émotion : le MÊME texte redit avec une émotion différente
 * n'est pas avalé par le filtre anti-répétition.
 */
export function ttsSpeak(text: string, emotion?: ShuguEmotion | string): void {
  const clean = stripMarkdownForSpeech(text);
  if (!clean) return;
  const emo = coerceEmotion(emotion);
  const now = Date.now();
  const dedupKey = emo + "|" + clean;
  if (dedupKey === lastText && now - lastAt < 4000) return;
  lastText = dedupKey;
  lastAt = now;
  if (pendingCount >= 2) return;
  pendingCount += 1;
  queue = queue
    .then(() => speakNow(clean, emo))
    .catch(() => undefined)
    .finally(() => {
      pendingCount -= 1;
    });
}

/** Contexte résolu une fois par énoncé (clé, voix, modèle, base/clé provider). */
interface SpeakContext {
  voiceId: string | undefined;
  model: string | undefined;
  baseUrl: string;
  apiKey: string;
  vp: VoiceParams;
}

/** Clé de cache d'un fragment : tout ce qui influe sur l'audio produit. */
function chunkKey(ctx: SpeakContext, text: string): string {
  const { vp } = ctx;
  return [
    ctx.voiceId ?? "",
    ctx.model ?? "",
    vp.emotion ?? "",
    vp.speed,
    vp.pitch,
    vp.vol ?? "",
    text,
  ].join("|");
}

/** Synthétise UN fragment → data URL (avec cache). null si l'appel échoue. */
async function synthesizeChunk(ctx: SpeakContext, text: string): Promise<string | null> {
  const key = chunkKey(ctx, text);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const dataUrl = await invoke<string>("voice_tts", {
      text: text.slice(0, 400),
      voiceId: ctx.voiceId,
      model: ctx.model,
      // Couche affective : émotion + prosodie. `emotion` undefined (sentinelle
      // "neutral") ⇒ champ omis côté Rust ⇒ auto-sélection MiniMax.
      emotion: ctx.vp.emotion,
      speed: ctx.vp.speed,
      pitch: ctx.vp.pitch,
      vol: ctx.vp.vol,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
    });
    cacheSet(key, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn("[tts] synth failed:", err);
    return null;
  }
}

/** Joue un data URL et résout à la fin (ou à la première erreur/pause). */
function playDataUrl(dataUrl: string): Promise<void> {
  return new Promise<void>((resolve) => {
    currentAudio = new Audio(dataUrl);
    currentAudio.onended = () => resolve();
    currentAudio.onerror = () => resolve();
    currentAudio.onpause = () => resolve();
    currentAudio.play().catch(() => resolve());
  });
}

async function speakNow(clean: string, emotion: ShuguEmotion): Promise<void> {
  // Le réglage est relu au moment de JOUER : un toggle OFF pendant la file
  // coupe aussi les énoncés en attente.
  if (!(await isTtsEnabled())) return;
  try {
    const cfg = await loadProviderConfig("minimax");
    if (!cfg.apiKey) {
      // Cas d'échec voix le PLUS fréquent : voix activée mais clé MiniMax jamais
      // configurée (le TTS passe par MiniMax même si le chat tourne sur un autre
      // provider). Sans ce log, « voix ON mais rien ne sort » est indébuggable.
      console.warn("[tts] clé MiniMax absente — voix désactivée (Réglages → Connexions)");
      return;
    }
    const [voiceId, model] = await Promise.all([
      db.settings.get(TTS_VOICE_KEY).catch(() => null),
      db.settings.get(TTS_MODEL_KEY).catch(() => null),
    ]);
    const ctx: SpeakContext = {
      voiceId: voiceId || undefined,
      model: model || undefined,
      baseUrl: cfg.baseUrl || "https://api.minimax.io",
      apiKey: cfg.apiKey,
      vp: voiceParamsFor(emotion),
    };

    // PIPELINE : on découpe l'énoncé en fragments de phrase et on lance TOUTES
    // les synthèses en parallèle. La lecture consomme les fragments DANS L'ORDRE :
    // la 1re phrase (courte) démarre dès sa synthèse (~time-to-first-audio réduit),
    // et les suivantes se sont synthétisées pendant qu'elle jouait → pas de blanc.
    const chunks = splitIntoSpeechChunks(clean, 240);
    const pending = chunks.map((c) => synthesizeChunk(ctx, c));
    for (const p of pending) {
      // Un toggle OFF pendant la lecture interrompt les fragments restants.
      if (!(await isTtsEnabled())) break;
      const dataUrl = await p;
      if (dataUrl) await playDataUrl(dataUrl);
    }
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

/**
 * Hook réactif pour la voix choisie (clé `voice.ttsVoice`, déjà relue par
 * speakNow). Calqué sur useTtsEnabled : lecture + mutation d'écriture. La voix
 * vide signifie « défaut Rust » — on ne force pas d'id pour rester rétro-compat.
 */
export function useTtsVoice() {
  const { data: voiceId = "" } = useQuery({
    queryKey: TTS_VOICE_QUERY_KEY,
    queryFn: async () => (await db.settings.get(TTS_VOICE_KEY).catch(() => "")) || "",
    staleTime: 30_000,
  });
  const set = useMutation({
    mutationFn: async (id: string) => {
      await db.settings.set(TTS_VOICE_KEY, id);
      return id;
    },
    onSuccess: (id) => queryClient.setQueryData(TTS_VOICE_QUERY_KEY, id),
  });
  return { voiceId, setVoice: (id: string) => set.mutate(id) };
}

/**
 * Hook réactif pour le MODÈLE TTS (clé `voice.ttsModel`, relue par speakNow).
 * Vide = défaut Rust (speech-2.6-turbo). Permet de basculer sur speech-2.8-turbo
 * (débloque les interjections (laughs)/(sighs) inline MAIS perd whisper/fluent —
 * l'UI avertit). Calqué sur useTtsVoice.
 */
export function useTtsModel() {
  const { data: model = "" } = useQuery({
    queryKey: TTS_MODEL_QUERY_KEY,
    queryFn: async () => (await db.settings.get(TTS_MODEL_KEY).catch(() => "")) || "",
    staleTime: 30_000,
  });
  const set = useMutation({
    mutationFn: async (m: string) => {
      await db.settings.set(TTS_MODEL_KEY, m);
      return m;
    },
    onSuccess: (m) => queryClient.setQueryData(TTS_MODEL_QUERY_KEY, m),
  });
  return { model, setModel: (m: string) => set.mutate(m) };
}
