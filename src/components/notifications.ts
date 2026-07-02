// Shugu Forge — centre de notifications (journal persistant des toasts).
//
// Les toasts sont éphémères (5 s puis disparition) : un utilisateur qui
// détourne les yeux perd l'information (échec d'indexation, erreur de
// sauvegarde, fin d'un run agent…). Ce store conserve les N derniers
// événements pour le panneau « Notifications » de la titlebar (cloche),
// avec un compteur de non-lus.
//
// Même pattern TanStack-as-observable-slot que toast.ts / chatBusy.ts :
// pas de fetch, queryClient.setQueryData comme unique writer.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { ToastKind } from "./toast";

export interface AppNotification {
  id: string;
  message: string;
  kind: ToastKind;
  /** Epoch ms — horodatage d'émission (affiché en relatif dans le panneau). */
  ts: number;
  read: boolean;
}

const NOTIF_KEY = ["ui", "notifications"] as const;

/** Journal borné — au-delà, les plus anciennes notifications sortent. */
export const MAX_NOTIFICATIONS = 100;

function getNotifications(): AppNotification[] {
  return queryClient.getQueryData<AppNotification[]>(NOTIF_KEY) ?? [];
}

function setNotifications(next: AppNotification[]): void {
  queryClient.setQueryData<AppNotification[]>(NOTIF_KEY, next);
}

/** Enregistre une notification (les plus récentes en tête). */
export function recordNotification(
  message: string,
  kind: ToastKind = "info",
  ts: number = Date.now(),
): string {
  const id = `${ts}-${Math.random().toString(36).slice(2, 7)}`;
  const next = [{ id, message, kind, ts, read: false }, ...getNotifications()];
  setNotifications(next.slice(0, MAX_NOTIFICATIONS));
  return id;
}

/** Marque tout comme lu (ouverture du panneau). */
export function markAllNotificationsRead(): void {
  const cur = getNotifications();
  if (!cur.some((n) => !n.read)) return;
  setNotifications(cur.map((n) => (n.read ? n : { ...n, read: true })));
}

/** Vide le journal (« Tout effacer »). */
export function clearNotifications(): void {
  if (getNotifications().length === 0) return;
  setNotifications([]);
}

/** Lecture réactive du journal (plus récent d'abord). */
export function useNotifications(): AppNotification[] {
  const { data = [] } = useQuery<AppNotification[]>({
    queryKey: NOTIF_KEY,
    queryFn: getNotifications,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

/** Nombre de notifications non lues (badge cloche / statusbar). */
export function useUnreadNotificationCount(): number {
  return useNotifications().reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
}

/** « il y a 2 min » — relatif court pour le panneau. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "hier" : `il y a ${d} j`;
}
