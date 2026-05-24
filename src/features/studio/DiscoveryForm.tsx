// Shugu Forge — Design Studio · discovery form (Phase D).
//
// open-design's "turn 1": a structured set of preferences captured BEFORE
// generation, so the brief stops being "make it professional" and becomes a
// concrete spec. Dimensions mirror open-design's own `design-brief` skill
// (palette / typography / layout / mood / density / constraints) plus audience
// + tone from its `brainstorming` skill.
//
// Every dimension is optional: no chip selected = "sans préférence" = the
// dimension is simply omitted from the prompt (see generationContext).

import type { DiscoveryAnswers } from "./generationContext";

interface Field {
  key: keyof DiscoveryAnswers;
  label: string;
  options: string[];
}

// Chip-based dimensions. Values are the strings injected into the prompt
// ("Palette: Sombre"); French is fine — the model reads it directly.
const FIELDS: Field[] = [
  { key: "palette", label: "Palette", options: ["Sombre", "Claire", "Colorée", "Monochrome", "Pastel"] },
  { key: "typography", label: "Typographie", options: ["Sans moderne", "Serif éditorial", "Mono technique", "Display expressif"] },
  { key: "layout", label: "Layout", options: ["Centré", "Pleine largeur", "Grille", "Asymétrique"] },
  { key: "mood", label: "Ambiance", options: ["Pro", "Ludique", "Luxe", "Minimal", "Énergique"] },
  { key: "density", label: "Densité", options: ["Aéré", "Équilibré", "Dense"] },
  { key: "audience", label: "Audience", options: ["Grand public", "Entreprise", "Développeurs", "Créatifs"] },
  { key: "tone", label: "Ton", options: ["Confiant", "Amical", "Élégant", "Audacieux"] },
];

export function DiscoveryForm({
  value,
  onChange,
  disabled = false,
}: {
  value: DiscoveryAnswers;
  onChange: (v: DiscoveryAnswers) => void;
  disabled?: boolean;
}) {
  // Toggle semantics: clicking the active chip clears it back to "no preference".
  const pick = (key: keyof DiscoveryAnswers, opt: string) => {
    if (disabled) return;
    onChange({ ...value, [key]: value[key] === opt ? "" : opt });
  };

  return (
    <div className="studio-disco">
      {FIELDS.map((f) => (
        <div className="studio-disco-field" key={f.key}>
          <span className="studio-disco-label">{f.label}</span>
          <div className="studio-disco-chips">
            {f.options.map((opt) => {
              const active = value[f.key] === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  className={`studio-chip${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => pick(f.key, opt)}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="studio-disco-field">
        <span className="studio-disco-label">Contraintes</span>
        <input
          type="text"
          className="studio-disco-input"
          value={value.constraints ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, constraints: e.target.value })}
          placeholder="ex. accessible AA, pas d'animations, mobile d'abord…"
        />
      </div>
    </div>
  );
}
