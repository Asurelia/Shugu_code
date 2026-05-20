// Shugu Forge — rendu des toasts globaux. Monté UNE FOIS dans RootLayout.

import { useToasts, dismissToast } from "./toast";

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => dismissToast(t.id)}
          title="Cliquer pour fermer"
          role="status"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
