// Shugu Forge — useConfirm : confirmation modale à API promesse (revue a11y 2026-07).
//
// Remplace les `window.confirm` natifs (non stylés, non accessibles, bloquants)
// par le ConfirmDialog maison, sans imposer à chaque site le boilerplate
// state + rendu. Usage :
//
//   const { confirm, dialog } = useConfirm();
//   const onDelete = async () => {
//     if (!(await confirm({ title: "Supprimer ?", tone: "danger" }))) return;
//     …action destructive…
//   };
//   return <>{…}{dialog}</>;   // ← ne pas oublier de rendre `dialog`
//
// Un seul dialog par instance de hook : un confirm() pendant qu'un autre est
// ouvert annule le précédent (résolu false). Le démontage du composant résout
// aussi false — jamais de promesse orpheline.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" → bouton Confirmer rouge (actions irréversibles). */
  tone?: "default" | "danger";
}

export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((v: boolean) => {
    resolveRef.current?.(v);
    resolveRef.current = null;
    setOpts(null);
  }, []);

  const confirm = useCallback((o: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current?.(false); // un confirm en remplace un autre → l'ancien est annulé
      resolveRef.current = resolve;
      setOpts(o);
    });
  }, []);

  // Démontage pendant une confirmation ouverte → résout false (pas de fuite).
  useEffect(
    () => () => {
      resolveRef.current?.(false);
      resolveRef.current = null;
    },
    [],
  );

  const dialog = opts ? (
    <ConfirmDialog
      open
      title={opts.title}
      body={opts.body}
      confirmLabel={opts.confirmLabel}
      cancelLabel={opts.cancelLabel}
      tone={opts.tone ?? "default"}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, dialog };
}
