// Shugu Forge — Continual Harness panel (lot 1 UI).
//
// Observe + steer the self-evolving harness per role:
//   - active generation: view/edit the system prompt + memory, save as a new
//     manual generation
//   - evolution log: every generation (seed / manual / stuck:*) with rollback
//   - per-generation metrics: runs, success, stalls, avg iterations
//   - Refiner provider config (which model evolves the harness on a stall)
//
// Visual language reuses the AgentsPanel conventions (inline styles + CSS
// custom properties of the Celestial Veil theme, with safe fallbacks).
// TanStack for reads (per feedback_tanstack_mandatory); mutations call the
// Tauri wrappers then invalidate.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  rollbackHarness,
  saveManualHarness,
  getHarnessRefiner,
  setHarnessRefiner,
  benchRunSuite,
  benchCompareGenerations,
  benchAddTask,
  type AgentRole,
  type HarnessGeneration,
  type BenchSuiteResult,
  type BenchComparison,
} from "@/lib/agents";
import {
  useHarnessGenerations,
  useHarnessMetrics,
  useBenchList,
  invalidateHarness,
  invalidateBench,
} from "./harnessQueries";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { PROVIDER_REGISTRY } from "@/lib/providers";
import { loadProviderConfig, getConfig } from "@/lib/credentials";

const ROLES: AgentRole[] = ["orchestrator", "coder", "researcher", "tester", "mascot"];

// Example bench tasks (the "milestones" of Forge). Create-from-scratch file
// tasks judged by the NON-executing `files` verifier — enough to prove the bench
// runs + measures; harder edge-of-capability tasks come later. Seeded against the
// CURRENTLY selected role (role overridden at insert time).
const EXAMPLE_TASKS: Array<{
  id: string;
  domain: string;
  title: string;
  prompt: string;
  verifierKind: string;
  verifierSpec: string;
}> = [
  {
    id: "ex-fizzbuzz",
    domain: "code",
    title: "FizzBuzz (JS)",
    prompt:
      'Crée un fichier `fizzbuzz.js` à la racine du workspace qui exporte une fonction `fizzbuzz(n)` retournant le tableau des chaînes FizzBuzz de 1 à n (multiple de 3 → "Fizz", de 5 → "Buzz", des deux → "FizzBuzz", sinon le nombre). Utilise l\'outil fs_write_file.',
    verifierKind: "files",
    verifierSpec: JSON.stringify({
      required: ["fizzbuzz.js"],
      contains: [
        { path: "fizzbuzz.js", substring: "Fizz" },
        { path: "fizzbuzz.js", substring: "Buzz" },
      ],
    }),
  },
  {
    id: "ex-readme",
    domain: "code",
    title: "README + section Usage",
    prompt:
      "Crée un fichier `README.md` à la racine décrivant un projet nommé Demo, avec un titre et une section `## Usage`. Utilise l'outil fs_write_file.",
    verifierKind: "files",
    verifierSpec: JSON.stringify({
      required: ["README.md"],
      contains: [{ path: "README.md", substring: "Usage" }],
    }),
  },
  {
    id: "ex-config",
    domain: "code",
    title: "config.json",
    prompt:
      'Crée un fichier `config.json` à la racine : un objet JSON valide avec les clés "name" (chaîne) et "version" (chaîne). Utilise l\'outil fs_write_file.',
    verifierKind: "files",
    verifierSpec: JSON.stringify({
      required: ["config.json"],
      contains: [{ path: "config.json", substring: "version" }],
    }),
  },
];

// ── Tokens (fallbacks mirror the dark Celestial Veil theme) ──────────
const C = {
  surface: "var(--surface, #16161f)",
  surfaceAlt: "var(--surface-alt, #1d1d2b)",
  border: "var(--border, rgba(255,255,255,0.10))",
  text: "var(--on-surface, #e7e7ef)",
  muted: "var(--on-surface-muted, #9a9aae)",
  primary: "var(--primary, #7c3aed)",
  success: "var(--success, #4ade80)",
  warn: "var(--warn, #fbbf24)",
  error: "var(--error, #ff6b6b)",
};

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** Colour + label for a generation's trigger reason. */
function triggerStyle(reason: string | null): { label: string; color: string } {
  if (!reason) return { label: "—", color: C.muted };
  if (reason === "seed") return { label: "seed", color: C.muted };
  if (reason === "manual") return { label: "manuel", color: C.primary };
  if (reason.startsWith("stuck:")) return { label: reason.replace("stuck:", "↻ "), color: C.warn };
  return { label: reason, color: C.muted };
}

// ── Small presentational helpers ─────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: 0.2 }}>{title}</h2>
        {hint ? <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "default",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "warn";
  type?: "button" | "submit";
}) {
  const bg =
    variant === "primary"
      ? C.primary
      : variant === "warn"
        ? "transparent"
        : "transparent";
  const fg = variant === "primary" ? "#fff" : variant === "warn" ? C.warn : C.text;
  const border = variant === "primary" ? C.primary : variant === "warn" ? C.warn : C.border;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: "none",
        font: "inherit",
        fontSize: 12,
        fontWeight: 600,
        padding: "6px 12px",
        borderRadius: 8,
        border: `1px solid ${border}`,
        background: bg,
        color: fg,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "filter 150ms ease, opacity 150ms ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.filter = "brightness(1.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
      }}
    >
      {children}
    </button>
  );
}

const fieldStyle: CSSProperties = {
  font: "inherit",
  fontSize: 13,
  color: C.text,
  background: C.surfaceAlt,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "8px 10px",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

// ── Main panel ───────────────────────────────────────────────────────

export function HarnessPanel() {
  const [role, setRole] = useState<AgentRole>("orchestrator");
  const gensQ = useHarnessGenerations(role);
  const metricsQ = useHarnessMetrics(role);
  const benchListQ = useBenchList(role);

  const generations = gensQ.data ?? [];
  const active = useMemo(() => generations.find((g) => g.active === 1), [generations]);

  // Draft edit state — re-synced whenever the active generation changes.
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftMemory, setDraftMemory] = useState("");
  useEffect(() => {
    setDraftPrompt(active?.systemPrompt ?? "");
    setDraftMemory(active?.memory ?? "[]");
  }, [active?.id, active?.systemPrompt, active?.memory]);

  // Refiner = a model chosen from the auto-discovered list. We persist only the
  // non-secret resolution (providerId / protocol / baseUrl / model); the API key
  // is read from the OS keychain by the Rust side at evolution time — never
  // re-typed here, never stored in settings.
  const discovered = useDiscoveredModels();
  const [refModelId, setRefModelId] = useState("");
  useEffect(() => {
    void getHarnessRefiner()
      .then((raw) => {
        if (!raw) return;
        try {
          const c = JSON.parse(raw) as Record<string, string>;
          if (c.providerId && c.model) setRefModelId(`${c.providerId}/${c.model}`);
        } catch {
          /* ignore malformed setting */
        }
      })
      .catch(() => {});
  }, []);

  // One busy/error channel for all mutations (only one runs at a time).
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Bench (banc de mesure) local state.
  const [benchModelId, setBenchModelId] = useState("");
  const [benchResult, setBenchResult] = useState<BenchSuiteResult | null>(null);
  const [comparison, setComparison] = useState<BenchComparison | null>(null);

  async function run(tag: string, fn: () => Promise<void>) {
    setBusy(tag);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const promptDirty = !!active && draftPrompt !== active.systemPrompt;
  const memoryDirty = !!active && draftMemory !== active.memory;
  const dirty = promptDirty || memoryDirty;

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: "var(--bg, #0e0e16)",
        color: C.text,
        padding: 20,
      }}
    >
      <div style={{ maxWidth: 920, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Header + role selector */}
        <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>Harness auto-évolutif</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
              Là où tes agents apprennent de leurs blocages, par rôle.
            </p>
          </div>
          <div role="tablist" aria-label="Rôle" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ROLES.map((r) => {
              const selected = r === role;
              return (
                <button
                  key={r}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setRole(r)}
                  style={{
                    appearance: "none",
                    font: "inherit",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "6px 14px",
                    borderRadius: 99,
                    border: `1px solid ${selected ? C.primary : C.border}`,
                    background: selected ? C.primary : "transparent",
                    color: selected ? "#fff" : C.muted,
                    cursor: "pointer",
                    transition: "all 150ms ease",
                  }}
                >
                  {r}
                </button>
              );
            })}
          </div>
        </header>

        {/* Inline feedback */}
        {error ? (
          <div
            role="alert"
            style={{
              fontSize: 12,
              color: C.error,
              background: "rgba(255,107,107,0.12)",
              border: `1px solid ${C.error}`,
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            {error}
          </div>
        ) : null}
        {notice ? (
          <div
            role="status"
            style={{
              fontSize: 12,
              color: C.success,
              background: "rgba(74,222,128,0.12)",
              border: `1px solid ${C.success}`,
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            {notice}
          </div>
        ) : null}

        {/* How it works — onboarding (the panel must explain itself) */}
        <div
          style={{
            background: "rgba(124,58,237,0.08)",
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <strong style={{ fontSize: 13, color: C.text }}>En clair, à quoi ça sert&nbsp;?</strong>
          <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            Chaque rôle d'agent travaille avec une fiche d'instructions. Quand un agent{" "}
            <strong style={{ color: C.text }}>bloque</strong> (tourne en rond, enchaîne les erreurs), le modèle{" "}
            <strong style={{ color: C.text }}>Refiner</strong> réécrit cette fiche{" "}
            <strong style={{ color: C.text }}>tout seul</strong> pour le débloquer — sans tout recommencer. Chaque
            réécriture est sauvegardée comme une <strong style={{ color: C.text }}>génération</strong>.
          </p>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.muted, lineHeight: 1.7 }}>
            <li>La fiche de départ d'un rôle = <strong style={{ color: C.text }}>génération&nbsp;0</strong>.</li>
            <li>Sur blocage, le Refiner la réécrit → génération 1, 2, 3…</li>
            <li>Tu vois ici l'historique, si ça réussit mieux (métriques), et tu peux revenir en arrière ou éditer à la main.</li>
          </ol>
          <p style={{ margin: 0, fontSize: 12.5, color: C.warn, lineHeight: 1.5 }}>
            C'est vide pour l'instant car aucun agent n'a encore tourné pour ce rôle. Lance un agent depuis l'onglet
            Agents : sa génération&nbsp;0 apparaîtra ici.
          </p>
        </div>

        {/* Active generation editor */}
        <Section
          title="Génération active"
          hint={
            active
              ? `Génération ${active.generation} · ${triggerStyle(active.triggerReason).label} · par ${active.createdBy ?? "?"}`
              : undefined
          }
        >
          {gensQ.isLoading ? (
            <p style={{ fontSize: 13, color: C.muted }}>Chargement…</p>
          ) : !active ? (
            <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              Aucune génération pour <strong style={{ color: C.text }}>{role}</strong> : ce rôle utilise encore son
              prompt de base. La génération 0 est créée automatiquement au premier lancement d'un agent de ce rôle.
            </p>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={labelStyle} htmlFor="harness-prompt">
                  System prompt
                </label>
                <textarea
                  id="harness-prompt"
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  spellCheck={false}
                  style={{ ...fieldStyle, minHeight: 200, resize: "vertical", lineHeight: 1.5, fontFamily: "ui-monospace, monospace" }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={labelStyle} htmlFor="harness-memory">
                  Mémoire (JSON)
                </label>
                <textarea
                  id="harness-memory"
                  value={draftMemory}
                  onChange={(e) => setDraftMemory(e.target.value)}
                  spellCheck={false}
                  style={{ ...fieldStyle, minHeight: 100, resize: "vertical", lineHeight: 1.5, fontFamily: "ui-monospace, monospace" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Button
                  variant="primary"
                  disabled={!dirty || busy !== null}
                  onClick={() =>
                    run("save", async () => {
                      await saveManualHarness(role, draftPrompt, draftMemory);
                      invalidateHarness(role);
                      setNotice("Nouvelle génération enregistrée et activée.");
                    })
                  }
                >
                  {busy === "save" ? "Enregistrement…" : "Enregistrer comme nouvelle génération"}
                </Button>
                {dirty ? <span style={{ fontSize: 12, color: C.warn }}>Modifications non enregistrées</span> : null}
              </div>
            </>
          )}
        </Section>

        {/* Refiner provider */}
        <Section
          title="Modèle Refiner"
          hint="Le modèle qui réécrit le harness sur blocage. Vide = l'agent se raffine avec son propre modèle (souvent sous le plancher de capacité)."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={labelStyle} htmlFor="ref-model">Modèle (parmi tes providers configurés)</label>
            <select
              id="ref-model"
              value={refModelId}
              onChange={(e) => setRefModelId(e.target.value)}
              style={fieldStyle}
              disabled={discovered.isLoading}
            >
              <option value="">
                {discovered.isLoading ? "Détection des modèles…" : "(self-fallback : le modèle de l'agent)"}
              </option>
              {discovered.data.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.providerLabel}
                </option>
              ))}
            </select>
            {discovered.data.length === 0 && !discovered.isLoading ? (
              <span style={{ fontSize: 11, color: C.muted }}>
                Aucun modèle détecté — configure un provider dans Connections d'abord.
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() =>
                run("refiner", async () => {
                  if (!refModelId) {
                    await setHarnessRefiner("{}");
                    setNotice("Refiner réinitialisé (self-fallback).");
                    return;
                  }
                  const m = discovered.data.find((x) => x.id === refModelId);
                  if (!m) throw new Error("Modèle introuvable — rafraîchis la liste.");
                  const reg = PROVIDER_REGISTRY[m.providerId];
                  const cfg = await loadProviderConfig(m.providerId);
                  const protocol =
                    reg?.protocol ?? (await getConfig(m.providerId, "protocol")) ?? "custom";
                  const baseUrl = cfg.baseUrl || reg?.baseUrl || "";
                  await setHarnessRefiner(
                    JSON.stringify({ providerId: m.providerId, protocol, baseUrl, model: m.modelId }),
                  );
                  setNotice("Modèle Refiner enregistré — sa clé sera lue depuis le keychain.");
                })
              }
            >
              {busy === "refiner" ? "Enregistrement…" : "Enregistrer le Refiner"}
            </Button>
            <Button variant="default" disabled={busy !== null} onClick={() => discovered.refresh()}>
              Rafraîchir
            </Button>
          </div>
        </Section>

        {/* Bench — banc de mesure (legibility spine) */}
        <Section
          title="Banc de mesure"
          hint="Rejoue une suite de tâches fixes contre une génération, sur une COPIE jetable du workspace (jamais ton vrai projet). Tu vois combien réussissent — et l'écart entre générations."
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.muted }}>
              {benchListQ.isLoading
                ? "Chargement des tâches…"
                : `${benchListQ.data?.length ?? 0} tâche(s) pour ${role}`}
            </span>
            <Button
              disabled={busy !== null}
              onClick={() =>
                run("bench-seed", async () => {
                  for (const t of EXAMPLE_TASKS) {
                    await benchAddTask({ ...t, role, fixtureDir: null });
                  }
                  invalidateBench(role);
                  setNotice(`Tâches d'exemple ajoutées pour ${role}.`);
                })
              }
            >
              {busy === "bench-seed" ? "Ajout…" : "Seed exemples"}
            </Button>
          </div>

          {(benchListQ.data?.length ?? 0) > 0 ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {benchListQ.data!.map((t) => (
                <li key={t.id} style={{ fontSize: 12, color: C.muted, display: "flex", gap: 8 }}>
                  <span style={{ color: C.text }}>{t.title}</span>
                  <span>· {t.verifierKind}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={labelStyle} htmlFor="bench-model">Modèle qui exécute l'agent (pour le banc)</label>
            <select
              id="bench-model"
              value={benchModelId}
              onChange={(e) => setBenchModelId(e.target.value)}
              style={fieldStyle}
              disabled={discovered.isLoading}
            >
              <option value="">{discovered.isLoading ? "Détection…" : "(choisir un modèle)"}</option>
              {discovered.data.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.providerLabel}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button
              variant="primary"
              disabled={busy !== null || !benchModelId || (benchListQ.data?.length ?? 0) === 0}
              onClick={() =>
                run("bench-run", async () => {
                  const m = discovered.data.find((x) => x.id === benchModelId);
                  if (!m) throw new Error("Modèle introuvable — rafraîchis la liste (section Refiner).");
                  const reg = PROVIDER_REGISTRY[m.providerId];
                  const cfg = await loadProviderConfig(m.providerId);
                  const protocol = reg?.protocol ?? (await getConfig(m.providerId, "protocol")) ?? "custom";
                  const baseUrl = cfg.baseUrl || reg?.baseUrl || "";
                  const gen = active?.generation ?? 0;
                  const res = await benchRunSuite({
                    role,
                    generation: gen,
                    model: m.modelId,
                    providerId: m.providerId,
                    protocol,
                    baseUrl,
                  });
                  setBenchResult(res);
                  setNotice(`Suite lancée sur gén ${gen} : ${res.passed}/${res.total} réussies.`);
                })
              }
            >
              {busy === "bench-run" ? "Exécution…" : `Lancer la suite sur gén ${active?.generation ?? 0}`}
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() =>
                run("bench-compare", async () => {
                  const gen = active?.generation ?? 0;
                  const cmp = await benchCompareGenerations(role, 0, gen);
                  setComparison(cmp);
                  setNotice(
                    `Comparaison gén 0 → gén ${gen} : ${cmp.aPassed}/${cmp.total} → ${cmp.bPassed}/${cmp.total}, ${cmp.regressions} régression(s).`,
                  );
                })
              }
            >
              {busy === "bench-compare" ? "…" : "Comparer gén 0 ↔ active"}
            </Button>
          </div>

          {benchResult ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: benchResult.passed === benchResult.total ? C.success : C.text,
                }}
              >
                Gén {benchResult.generation} : {benchResult.passed}/{benchResult.total} réussies
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                {benchResult.results.map((r) => (
                  <li key={r.taskId} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ color: r.passed ? C.success : C.error, fontWeight: 700 }}>{r.passed ? "✓" : "✗"}</span>
                    <span style={{ color: C.text }}>{r.title}</span>
                    <span style={{ color: C.muted }}>— {r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {comparison ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: C.muted, textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>Tâche</th>
                    <th style={{ padding: "6px 8px" }}>Gén {comparison.generationA}</th>
                    <th style={{ padding: "6px 8px" }}>Gén {comparison.generationB}</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.tasks.map((t) => (
                    <tr
                      key={t.taskId}
                      style={{ borderTop: `1px solid ${C.border}`, background: t.regression ? "rgba(255,107,107,0.10)" : "transparent" }}
                    >
                      <td style={{ padding: "6px 8px", color: C.text }}>{t.title || t.taskId}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {t.passedA === null ? (
                          <span style={{ color: C.muted }}>—</span>
                        ) : (
                          <span style={{ color: t.passedA ? C.success : C.error, fontWeight: 700 }}>{t.passedA ? "✓" : "✗"}</span>
                        )}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        {t.passedB === null ? (
                          <span style={{ color: C.muted }}>—</span>
                        ) : (
                          <span style={{ color: t.passedB ? C.success : C.error, fontWeight: 700 }}>{t.passedB ? "✓" : "✗"}</span>
                        )}
                        {t.regression ? <span style={{ color: C.error, marginLeft: 6 }}>↓ régression</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Section>

        {/* Metrics */}
        <Section title="Métriques par génération" hint="Calculées à partir des runs d'agents (succès, blocages, itérations moyennes).">
          {metricsQ.isLoading ? (
            <p style={{ fontSize: 13, color: C.muted }}>Chargement…</p>
          ) : (metricsQ.data?.length ?? 0) === 0 ? (
            <p style={{ fontSize: 13, color: C.muted }}>Aucun run enregistré pour ce rôle.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: C.muted, textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>Gén.</th>
                    <th style={{ padding: "6px 8px" }}>Runs</th>
                    <th style={{ padding: "6px 8px" }}>Succès</th>
                    <th style={{ padding: "6px 8px" }}>Blocages</th>
                    <th style={{ padding: "6px 8px" }}>Itér. moy.</th>
                  </tr>
                </thead>
                <tbody>
                  {metricsQ.data!.map((m) => {
                    const rate = m.runs > 0 ? Math.round((m.successes / m.runs) * 100) : 0;
                    return (
                      <tr key={m.generation ?? -1} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: "6px 8px", fontVariantNumeric: "tabular-nums" }}>{m.generation ?? "—"}</td>
                        <td style={{ padding: "6px 8px", fontVariantNumeric: "tabular-nums" }}>{m.runs}</td>
                        <td style={{ padding: "6px 8px", color: rate >= 60 ? C.success : rate >= 30 ? C.warn : C.error, fontVariantNumeric: "tabular-nums" }}>
                          {m.successes} ({rate}%)
                        </td>
                        <td style={{ padding: "6px 8px", fontVariantNumeric: "tabular-nums" }}>{m.stuckCount}</td>
                        <td style={{ padding: "6px 8px", fontVariantNumeric: "tabular-nums" }}>{m.avgIterations.toFixed(1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Evolution log */}
        <Section title="Journal d'évolution" hint="Chaque génération du harness, la plus récente en premier. Rollback = réactiver une génération antérieure.">
          {gensQ.isLoading ? (
            <p style={{ fontSize: 13, color: C.muted }}>Chargement…</p>
          ) : generations.length === 0 ? (
            <p style={{ fontSize: 13, color: C.muted }}>Aucune génération encore.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {generations.map((g: HarnessGeneration) => {
                const t = triggerStyle(g.triggerReason);
                const isActive = g.active === 1;
                return (
                  <li
                    key={g.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: isActive ? "rgba(124,58,237,0.12)" : C.surfaceAlt,
                      border: `1px solid ${isActive ? C.primary : C.border}`,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>
                          Génération {g.generation}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: t.color }}>{t.label}</span>
                        {isActive ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: C.primary, border: `1px solid ${C.primary}`, borderRadius: 99, padding: "1px 8px" }}>
                            ACTIVE
                          </span>
                        ) : null}
                      </div>
                      <span style={{ fontSize: 11, color: C.muted }}>
                        {g.createdBy ?? "?"} · {fmtDate(g.createdAt)}
                      </span>
                    </div>
                    {!isActive ? (
                      <Button
                        variant="warn"
                        disabled={busy !== null}
                        onClick={() =>
                          run(`rollback-${g.generation}`, async () => {
                            await rollbackHarness(role, g.generation);
                            invalidateHarness(role);
                            setNotice(`Génération ${g.generation} réactivée.`);
                          })
                        }
                      >
                        {busy === `rollback-${g.generation}` ? "…" : "Rollback"}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

export default HarnessPanel;
