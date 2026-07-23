// Shugu Forge — panneau « Notifications » (popover cloche de la titlebar).
//
// Journal des événements récents (indexation, erreurs fichier, feedback
// d'actions…) alimenté par pushToast via recordNotification. Même pattern
// scrim + popover que AccountDropdown (fixed transparent scrim → clic
// extérieur ferme, Escape ferme).

import { useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import {
  useNotifications,
  markAllNotificationsRead,
  clearNotifications,
  formatRelativeTime,
} from "./notifications";
import { useModalFocusTrap } from "@/lib/modalFocus";

export function NotificationCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap({ open, containerRef: dialogRef, onEscape: onClose });
  // Ouvrir le panneau = consulter → tout passe en lu (le badge s'éteint).
  useEffect(() => {
    if (open) markAllNotificationsRead();
  }, [open]);

  const notifications = useNotifications();

  if (!open) return null;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={onClose} />
      <div ref={dialogRef} className="notif-pop" role="dialog" aria-modal="true" aria-label="Notifications" tabIndex={-1}>
        <div className="notif-head">
          <div className="notif-title">Notifications</div>
          <div style={{ flex: 1 }} />
          {notifications.length > 0 && (
            <button className="notif-clear" onClick={clearNotifications}>
              Tout effacer
            </button>
          )}
          <button className="tb-action" aria-label="Fermer" title="Fermer" onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="notif-list scroll">
          {notifications.length === 0 && (
            <div className="notif-empty">
              <Icon name="bell" size={20} />
              <p>Aucune notification pour l'instant.</p>
              <p className="muted">
                Les événements importants — indexation du code, erreurs,
                fins de tâches — apparaîtront ici, même après la disparition
                de leur toast.
              </p>
            </div>
          )}
          {notifications.map((n) => (
            <div key={n.id} className={`notif-item notif-${n.kind}`}>
              <span className="notif-dot" aria-hidden="true" />
              <div className="notif-body">
                <div className="notif-msg">{n.message}</div>
                <div className="notif-time">{formatRelativeTime(n.ts)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
