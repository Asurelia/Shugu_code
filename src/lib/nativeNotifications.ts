// Shugu Forge — P6.5 : notifications OS natives (tauri-plugin-notification).
//
// Le toast natif COMPLÈTE le toast in-app (le journal), il ne le duplique pas :
// par défaut il ne part que quand la fenêtre n'est PAS au premier plan
// (`notifications.onlyWhenUnfocused`, défaut ON). Trois cas, chacun avec son
// toggle (tous défaut ON, persistés via db.settings) :
//   - `notifications.runComplete`  → run agent terminé avec succès ;
//   - `notifications.runError`     → run en échec / tué ;
//   - `notifications.hitlWaiting`  → carte HITL en attente (ask_user / submit_plan).
//
// Pas de son custom : Windows exige un fichier .wav et le repo n'en a pas
// (pas de nouvel asset binaire — décision documentée dans le rapport). Le
// toast Windows joue le son système par défaut de toute façon.
//
// Émission depuis la fenêtre PRINCIPALE uniquement : la mascotte monte le
// même listener d'events — sans ce garde, chaque event produirait DEUX
// notifications natives.

import { db } from "@/lib/db";

export type NotificationKind = "runComplete" | "runError" | "hitlWaiting";
export type NativeNotificationResult = "sent" | "denied" | "failed";

export interface NotificationSettings {
  runComplete: boolean;
  runError: boolean;
  hitlWaiting: boolean;
  onlyWhenUnfocused: boolean;
}

export const NOTIFICATION_SETTING_KEYS: Record<keyof NotificationSettings, string> = {
  runComplete: "notifications.runComplete",
  runError: "notifications.runError",
  hitlWaiting: "notifications.hitlWaiting",
  onlyWhenUnfocused: "notifications.onlyWhenUnfocused",
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  runComplete: true,
  runError: true,
  hitlWaiting: true,
  onlyWhenUnfocused: true,
};

/** Parse les valeurs persistées (défaut ON partout sauf valeur explicite "false"). */
export function parseNotificationSettings(
  raw: Record<keyof NotificationSettings, string | null | undefined>,
): NotificationSettings {
  const on = (v: string | null | undefined) => v !== "false";
  return {
    runComplete: on(raw.runComplete),
    runError: on(raw.runError),
    hitlWaiting: on(raw.hitlWaiting),
    onlyWhenUnfocused: on(raw.onlyWhenUnfocused),
  };
}

/** Décision pure : faut-il notifier nativement CE cas maintenant ?
 *  - le toggle du cas doit être ON ;
 *  - si « seulement si non focus » est ON et la fenêtre est focus → non. */
export function shouldNotify(
  settings: NotificationSettings,
  focused: boolean,
  kind: NotificationKind,
): boolean {
  if (!settings[kind]) return false;
  if (settings.onlyWhenUnfocused && focused) return false;
  return true;
}

/** Charge les 4 réglages (SQLite settings, défauts ON). */
export async function loadNotificationSettings(): Promise<NotificationSettings> {
  const [runComplete, runError, hitlWaiting, onlyWhenUnfocused] = await Promise.all([
    db.settings.get(NOTIFICATION_SETTING_KEYS.runComplete),
    db.settings.get(NOTIFICATION_SETTING_KEYS.runError),
    db.settings.get(NOTIFICATION_SETTING_KEYS.hitlWaiting),
    db.settings.get(NOTIFICATION_SETTING_KEYS.onlyWhenUnfocused),
  ]);
  return parseNotificationSettings({ runComplete, runError, hitlWaiting, onlyWhenUnfocused });
}

async function isFocused(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isFocused();
  } catch {
    return true; // doute ⇒ considérer focus (pas de notification surprise)
  }
}

function isMascotWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.location !== "undefined" &&
    window.location.pathname.includes("mascot")
  );
}

/** Envoie la notification native (demande la permission si nécessaire).
 *  Retourne un reçu sans lever d'erreur — une notification ne doit jamais
 *  casser le flux d'events du chat. */
export async function notifyNative(
  title: string,
  body: string,
): Promise<NativeNotificationResult> {
  try {
    const notif = await import("@tauri-apps/plugin-notification");
    let granted = await notif.isPermissionGranted();
    if (!granted) {
      granted = (await notif.requestPermission()) === "granted";
    }
    if (!granted) return "denied";
    notif.sendNotification({ title, body });
    return "sent";
  } catch (err) {
    console.warn("[notifications] native notify failed:", err);
    return "failed";
  }
}

/** Point d'entrée appelé par le listener d'events agent (P6.5). Applique :
 *  fenêtre mascotte ignorée, toggles, règle de focus, puis notification. */
export async function maybeNotifyAgentEvent(
  kind: NotificationKind,
  title: string,
  body: string,
): Promise<void> {
  if (isMascotWindow()) return;
  const settings = await loadNotificationSettings();
  const focused = await isFocused();
  if (!shouldNotify(settings, focused, kind)) return;
  await notifyNative(title, body);
}
