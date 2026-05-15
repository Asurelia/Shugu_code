// Shugu Forge — live calibration UI for the chibi-snap geometry.
//
// Four sliders that map directly to the four constants in mascot.tsx's
// snap math. Each change is persisted to localStorage and propagates to
// the mascot window via the `storage` event — drag-test feedback is
// instant, no reload, no rebuild.

import React from "react";
import {
  loadCalibration,
  saveCalibration,
  DEFAULT_CALIBRATION,
  type ChibiCalibration,
} from "@/features/mascot/calibration";
import { SettingRow } from "@/features/code/views-code";

export function MascotCalibration() {
  const [cal, setCal] = React.useState<ChibiCalibration>(() => loadCalibration());

  const update = (patch: Partial<ChibiCalibration>) => {
    setCal(prev => {
      const next = { ...prev, ...patch };
      saveCalibration(next);
      return next;
    });
  };

  const reset = () => {
    const fresh = { ...DEFAULT_CALIBRATION };
    setCal(fresh);
    saveCalibration(fresh);
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Mascot — calibration du snap</h3>
          <p className="sub">
            Ajuste l'emplacement du chibi visible dans son cadre 240×240 transparent.
            Chaque slider correspond à un côté du chibi. Drag la mascotte vers un bord
            d'écran pendant que tu ajustes — la fenêtre mascot se met à jour en direct
            (cross-window via <code>storage</code> event).
          </p>

          <CalibSlider
            label="Gauche — CHIBI_LEFT"
            desc="Augmente pour coller plus près du bord gauche. Default 32."
            min={-100} max={300}
            value={cal.left}
            onChange={v => update({ left: v })}
          />
          <CalibSlider
            label="Droite — CHIBI_RIGHT"
            desc="Diminue pour coller plus près du bord droit. Default 124."
            min={-100} max={300}
            value={cal.right}
            onChange={v => update({ right: v })}
          />
          <CalibSlider
            label="Haut — CHIBI_TOP"
            desc="Augmente pour coller plus près du bord haut. Default 19."
            min={-100} max={300}
            value={cal.top}
            onChange={v => update({ top: v })}
          />
          <CalibSlider
            label="Bas — CHIBI_BOTTOM"
            desc="Diminue pour coller plus près du bord bas. Default 156."
            min={-100} max={300}
            value={cal.bottom}
            onChange={v => update({ bottom: v })}
          />
          <CalibSlider
            label="Snap threshold"
            desc="Distance d'activation du snap en CSS px. Plus c'est grand, plus la zone d'aimantation est large. Default 80."
            min={20} max={300}
            value={cal.snapThreshold}
            onChange={v => update({ snapThreshold: v })}
          />

          <div className="setting-row" style={{ marginTop: 14 }}>
            <div className="info">
              <div className="label">Restaurer les défauts</div>
              <div className="desc">
                Remet les valeurs calibrées en M3-v6 par alpha-scan des sprites.
              </div>
            </div>
            <button className="lgb lgb-sm" onClick={reset}>Reset</button>
          </div>

          <div
            className="sub"
            style={{ marginTop: 16, fontFamily: "var(--font-mono)", fontSize: 11 }}
          >
            État courant : L={cal.left} · R={cal.right} · T={cal.top} · B={cal.bottom} · threshold={cal.snapThreshold}
          </div>
        </div>
      </div>
    </div>
  );
}

function CalibSlider({
  label, desc, min, max, value, onChange,
}: {
  label: string;
  desc: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <SettingRow label={label} desc={desc}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input
          type="range"
          className="slider"
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ width: 180 }}
        />
        <input
          type="number"
          value={value}
          onChange={e => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          style={{
            width: 62,
            padding: "4px 6px",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            color: "inherit",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            textAlign: "right",
          }}
        />
      </div>
    </SettingRow>
  );
}
