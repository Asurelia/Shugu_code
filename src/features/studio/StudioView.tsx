// Shugu Forge — Design Studio · "Créer" workspace (Phase A→F).
//
// A CHAT-DRIVEN studio (open-design's model on Shugu's in-process agent):
//   - No conversation yet → a 3-step composer (system optional + brief +
//     discovery + direction).
//   - On "Générer" → spawn the orchestrator, append turn 1, and switch to the
//     CONVERSATION: the user keeps chatting ("rends le hero plus grand") and
//     each message is a new turn that reads + edits the existing project files.
// Agent work shows as curated cards (StudioTurnView) driven by the agents query
// cache — the raw system prompt is never rendered. The preview live-reloads on
// fs://changed and on each turn's completion.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Icon } from "@/components/components";
import { ProjectPreview } from "./ProjectPreview";
import { StudioFiles } from "./StudioFiles";
import { slugifyName } from "./studioExport";
import { useActiveDesignSystem, setActiveDesignSystem } from "@/features/design/activeDesignSystem";
import { useDesignSkills } from "@/features/design/queries";
import { resolveOrchestrator } from "@/features/chat/chat-sync";
import { spawnAgent } from "@/lib/agents";
import { useAgentTranscript } from "@/features/agents/queries";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { useShell } from "@/routes/shell-context";
import { buildGenerationContext } from "./generationContext";
import { useStudioDraft, setStudioDraft } from "./studioDraft";
import {
  studioProjectUpsertAuto,
  studioProjectSaveAs,
  setStudioCurrentProject,
  invalidateStudioProjects,
} from "./studioProjects";
import {
  useStudioChat,
  appendStudioTurn,
  clearStudioChat,
  buildTurnContext,
  buildIterationTask,
  buildElementEditTask,
  buildTweakBakeTask,
  type SelectedElement,
} from "./studioChat";
import { DiscoveryForm } from "./DiscoveryForm";
import { DirectionPicker } from "./DirectionPicker";
import { StudioConversation } from "./StudioConversation";
import { CodeMirrorEditor } from "@/features/code/CodeMirrorEditor";
import { useScopedTree } from "@/features/fs/queries";

const PREVIEW_DIR = ".shugu-forge/preview";

export function StudioView() {
  const navigate = useNavigate();
  const active = useActiveDesignSystem();
  const skills = useDesignSkills().data ?? [];
  const draft = useStudioDraft();
  const turns = useStudioChat();

  const [reloadKey, setReloadKey] = useState(0);
  const [gateError, setGateError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"preview" | "code">("preview");
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  // UX: in-Studio editor split + collapsible right pane (runtime-only state).
  // The "start a new project" intent lives in studioDraft (survives sub-tab nav).
  const [splitFile, setSplitFile] = useState<string | null>(null);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const { openFile, fileContents, setFileContents, editorPrefs } = useShell();

  // A project already exists on disk when the preview has an index.html — the
  // durable source of truth. In-memory `turns` reset on app reload but the
  // generated files don't, so we key "creation vs iteration" off the disk.
  // Read ONLY the preview subtree (fs_read_dir_scoped) — no whole-workspace
  // walk, so this is unaffected by the 5000-entry cap on big projects.
  const { data: previewFiles = [] } = useScopedTree(PREVIEW_DIR);
  const hasProject = useMemo(
    () => previewFiles.some((c) => c.name === "index.html"),
    [previewFiles],
  );

  // `busy` is DERIVED from the last turn's live status (agents query cache, fed
  // app-wide by useAgentEvents in RootLayout) — NOT local component state. The
  // generation runs in the Rust backend regardless of the active view, so this
  // stays correct even if you navigate away and come back mid-run: the composer
  // stays locked until the turn actually finishes (no 2nd concurrent turn on the
  // same files). `undefined` status (transcript still loading) counts as busy.
  const lastTurn = turns[turns.length - 1];
  const lastTx = useAgentTranscript(lastTurn?.agentId);
  const lastStatus = lastTx.data?.agent.status;
  const busy =
    !!lastTurn && lastStatus !== "complete" && lastStatus !== "error" && lastStatus !== "killed";
  // Display name for the auto/saved project = the brief (first turn), trimmed.
  const projectName = () => (turns[0]?.userText ?? draft.brief).trim().slice(0, 60) || "Projet";

  // Guaranteed preview refresh when a turn finishes (once per agent). The live
  // fs://changed reload covers in-flight writes; this is the final settle, and
  // it also fires once when you return to a turn that completed while away.
  const bumpedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = lastTurn?.agentId;
    if (!id) return;
    const done = lastStatus === "complete" || lastStatus === "error" || lastStatus === "killed";
    if (done && bumpedRef.current !== id) {
      bumpedRef.current = id;
      setReloadKey((k) => k + 1);
      if (lastStatus === "complete") {
        // Auto-create/refresh this session's project snapshot (Projets grid).
        void studioProjectUpsertAuto(projectName(), draft.convId)
          .then((pid) => {
            setStudioCurrentProject(pid);
            invalidateStudioProjects();
          })
          .catch(() => {});
      }
    }
  }, [lastTurn?.agentId, lastStatus]);

  // Workspace + orchestrator guards, shared by the first generation and every
  // iteration. Returns the resolved orchestrator (narrowed to ok) or null.
  const ready = async () => {
    const root = await fsGetWorkspaceRoot().catch(() => null);
    if (!root) {
      setGateError(
        "Ouvre d'abord un dossier de travail (barre latérale Fichiers) — la génération écrit le projet dans .shugu-forge/preview/.",
      );
      return null;
    }
    const orch = await resolveOrchestrator();
    if (orch.kind !== "ok") {
      setGateError(
        orch.kind === "no-orchestrator"
          ? "Aucun orchestrator configuré. Va dans Settings → Connections (section Routing)."
          : `Le provider orchestrator « ${orch.providerId} » n'est pas activé (Settings → Connections).`,
      );
      return null;
    }
    return orch;
  };

  const spawnTurn = async (task: string, userText: string, context?: string) => {
    const orch = await ready();
    if (!orch) return;
    const designContext = buildGenerationContext({
      system: active,
      skills,
      discovery: draft.discovery,
      direction: active ? null : draft.direction, // system XOR direction
      brief: draft.brief.trim() || userText,
    });
    // Dedicated Studio conversation id (per session), minted lazily so each
    // project is its own conversation (clean history reconstruction; Studio
    // agents stay out of the main chat's reconciler).
    let convId = draft.convId;
    if (!convId) {
      convId = crypto.randomUUID();
      setStudioDraft({ convId });
    }
    try {
      const agentId = await spawnAgent({
        role: "orchestrator",
        task,
        model: orch.model,
        protocol: orch.protocol,
        baseUrl: orch.baseUrl,
        apiKey: orch.apiKey,
        conversationId: convId,
        designContext: designContext || undefined,
      });
      appendStudioTurn({ id: crypto.randomUUID(), userText, agentId, context });
      setGateError(null);
    } catch (err) {
      setGateError(`Échec du lancement : ${String(err)}`);
    }
  };

  // Turn 1 — the composer's "Générer".
  const generate = () => {
    const task = draft.brief.trim();
    if (!task || busy) return;
    if (draft.startingNew) clearStudioChat(); // fresh project → fresh conversation thread
    setStudioDraft({ startingNew: false });
    void spawnTurn(task, task, buildTurnContext(active, draft));
  };

  // Turn N — a follow-up adjustment. Disk files are the visual source of truth;
  // we add intent history (buildIterationTask) so "undo that" etc. work.
  const sendIteration = (instruction: string) => {
    if (busy) return;
    const sel = selectedElement;
    if (sel) {
      // Element-scoped edit: the agent locates the picked element and changes it.
      setSelectedElement(null);
      void spawnTurn(buildElementEditTask(instruction, sel), instruction, `Élément ciblé : ${sel.selector}`);
    } else {
      void spawnTurn(buildIterationTask(turns, instruction), instruction);
    }
  };

  // Bake live Tweaks (CSS-token overrides nudged in the preview) into the
  // project source via an agent turn. Requires an existing project (turns) and
  // a free orchestrator (busy guard) — same one-turn-at-a-time rule as edits.
  const bakeTokens = (overrides: Record<string, string>) => {
    if (busy || turns.length === 0 || Object.keys(overrides).length === 0) return;
    void spawnTurn(buildTweakBakeTask(overrides), "Appliquer les ajustements visuels", "Tweaks live → projet");
  };

  const onNew = () => {
    clearStudioChat();
    // startingNew:true forces the wizard; convId:null mints a fresh conversation
    // for the next generation (a new project, not a continuation of the old one).
    setStudioDraft({ step: 1, brief: "", discovery: {}, direction: null, startingNew: true, convId: null });
    setSplitFile(null);
    setStudioCurrentProject(null);
    setGateError(null);
  };

  // Save the current preview as a named, frozen fork in the Projets grid.
  const onSaveAs = () => {
    if (turns.length === 0) return;
    void studioProjectSaveAs(`${projectName()} (copie)`, draft.convId)
      .then(() => invalidateStudioProjects())
      .catch((err) => setGateError(`Échec de la sauvegarde : ${String(err)}`));
  };

  // Open a generated file in an IN-STUDIO split (preview stays visible, editor
  // below) — NOT a jump to /code. Mirrors the chat's handoff: openFile loads the
  // content into the shared fileContents store, then we reveal the editor pane.
  const handleOpenFile = (path: string) => {
    void (async () => {
      try {
        await openFile(path);
        setSplitFile(path);
        setRightTab("code");        // surface the Code view (Lovable-style toggle)
        setRightCollapsed(false);   // ensure the editor is visible
      } catch (err) {
        setGateError(`Impossible d'ouvrir ${path} : ${String(err)}`);
      }
    })();
  };
  const closeSplit = () => setSplitFile(null);
  // Escape hatch to the full IDE (the file is already open via openFile above).
  const openFullEditor = () => {
    setSplitFile(null);
    navigate({ to: "/code" });
  };
  // Light edits write through to the SAME fileContents store /code uses (marking
  // dirty); saving is via "Plein écran" → /code (Ctrl+S), as in the chat split.
  const onSplitChange = (v: string) => {
    if (!splitFile) return;
    setFileContents((c: Record<string, { text?: string; dirty?: boolean }>) => ({
      ...c,
      [splitFile]: { ...c[splitFile], text: v, dirty: true },
    }));
  };

  // ── Wizard (composer) derived state ──────────────────────────
  const lastStep = active ? 2 : 3;
  const step = Math.min(draft.step, lastStep) as 1 | 2 | 3;
  const canAdvance = draft.brief.trim().length > 0;
  const next = () => setStudioDraft({ step: Math.min(step + 1, lastStep) as 1 | 2 | 3 });
  const back = () => setStudioDraft({ step: Math.max(step - 1, 1) as 1 | 2 | 3 });
  const steps: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: "Cadre" },
    { n: 2, label: "Découverte" },
    ...(active ? [] : [{ n: 3 as const, label: "Direction" }]),
  ];

  // Creation (wizard) vs iteration (conversation): show the wizard only when the
  // user explicitly started fresh, or when there's genuinely nothing yet — no
  // turns AND no project on disk. This keeps the chatbox over an existing project
  // after an app reload (turns reset in memory, but the disk files persist).
  const showWizard = draft.startingNew || (turns.length === 0 && !hasProject);

  return (
    <div className={"studio-shell" + (rightCollapsed ? " right-collapsed" : "")}>
      <aside className="studio-side scroll">
        {gateError && (
          <div className="studio-status studio-status-err">
            <Icon name="x" size={13} /> {gateError}
          </div>
        )}

        {!showWizard ? (
          <StudioConversation
            turns={turns}
            busy={busy}
            onSend={sendIteration}
            onNew={onNew}
            onSaveAs={onSaveAs}
            onOpenFile={(rel) => handleOpenFile(`.shugu-forge/preview/${rel}`)}
            selectedElement={selectedElement}
            onClearSelected={() => setSelectedElement(null)}
          />
        ) : (
          <>
            {/* Step indicator */}
            <div className="studio-steps">
              {steps.map((s) => (
                <button
                  key={s.n}
                  className={`studio-step-pip${s.n === step ? " is-active" : ""}${s.n < step ? " is-done" : ""}`}
                  onClick={() => setStudioDraft({ step: s.n })}
                >
                  <span className="studio-step-n">{s.n < step ? <Icon name="check" size={11} /> : s.n}</span>
                  {s.label}
                </button>
              ))}
            </div>

            {/* Step 1 — Cadre */}
            {step === 1 && (
              <div className="studio-step">
                {active ? (
                  <div className="studio-ds-active">
                    <Icon name="palette" size={15} />
                    <div className="studio-ds-info">
                      <div className="studio-ds-name">{active.name}</div>
                      <div className="studio-ds-sub">base active</div>
                    </div>
                    <button className="studio-ds-change" onClick={() => navigate({ to: "/studio/inspiration" })}>
                      Changer
                    </button>
                    <button className="studio-ds-change" onClick={() => setActiveDesignSystem(null)}>
                      Retirer
                    </button>
                  </div>
                ) : (
                  <>
                    <button className="studio-ds-empty" onClick={() => navigate({ to: "/studio/inspiration" })}>
                      <Icon name="palette" size={15} /> Partir d'un design system… (optionnel)
                    </button>
                    <p className="studio-hint studio-hint-sm">
                      Sans système, tu choisiras une direction visuelle à l'étape 3.
                    </p>
                  </>
                )}

                <label className="studio-label" htmlFor="studio-brief">Décris l'UI à générer</label>
                <textarea
                  id="studio-brief"
                  className="studio-brief"
                  value={draft.brief}
                  onChange={(e) => setStudioDraft({ brief: e.target.value })}
                  placeholder="ex. une landing page SaaS : hero avec CTA, section features en 3 colonnes, témoignages, pricing, footer."
                />
                <p className="studio-hint studio-hint-sm">
                  <Icon name="sparkle" size={12} /> L'agent choisira automatiquement les skills adaptés à ta demande.
                </p>
              </div>
            )}

            {/* Step 2 — Découverte */}
            {step === 2 && (
              <div className="studio-step">
                <p className="studio-hint studio-hint-sm">
                  Affine la direction (tout est optionnel — laisse vide pour « sans préférence »).
                </p>
                <DiscoveryForm value={draft.discovery} onChange={(v) => setStudioDraft({ discovery: v })} />
              </div>
            )}

            {/* Step 3 — Direction (only without a system) */}
            {step === 3 && !active && (
              <div className="studio-step">
                <DirectionPicker
                  brief={draft.brief}
                  discovery={draft.discovery}
                  value={draft.direction}
                  onChange={(d) => setStudioDraft({ direction: d })}
                />
              </div>
            )}

            {/* Wizard navigation */}
            <div className="studio-nav">
              {step > 1 && (
                <button className="lgb" onClick={back}>
                  <Icon name="chevron-left" size={13} /> Retour
                </button>
              )}
              <span style={{ flex: 1 }} />
              {step < lastStep ? (
                <button className="lgb lgb-primary" onClick={next} disabled={!canAdvance}>
                  Suivant <Icon name="chevron-right" size={13} />
                </button>
              ) : (
                <button className="lgb lgb-primary lgb-lg studio-generate" onClick={generate} disabled={!canAdvance}>
                  <Icon name="sparkle" size={14} /> Générer le projet
                </button>
              )}
            </div>

            <p className="studio-hint">
              Le projet est écrit sur disque (réutilisable dans l'éditeur et Git) puis rendu en live
              à droite. Après génération, tu peux demander des ajustements en continu.
            </p>
          </>
        )}
      </aside>

      {rightCollapsed ? (
        <button
          className="studio-right-rail"
          onClick={() => setRightCollapsed(false)}
          title="Afficher l'aperçu"
        >
          <Icon name="chevron-left" size={14} />
          <span className="studio-right-rail-label">Aperçu</span>
        </button>
      ) : (
        <div className="studio-right">
          <div className="studio-right-tabs">
            <div className="studio-viewtoggle" role="tablist">
              <button
                className={"studio-vt-btn" + (rightTab === "preview" ? " is-active" : "")}
                onClick={() => setRightTab("preview")}
                role="tab"
                aria-selected={rightTab === "preview"}
              >
                <Icon name="image" size={12} /> Aperçu
              </button>
              <button
                className={"studio-vt-btn" + (rightTab === "code" ? " is-active" : "")}
                onClick={() => setRightTab("code")}
                role="tab"
                aria-selected={rightTab === "code"}
              >
                <Icon name="code" size={12} /> Code
              </button>
            </div>
            <span style={{ flex: 1 }} />
            <button
              className="studio-rtab-collapse"
              onClick={() => setRightCollapsed(true)}
              title="Replier le panneau"
            >
              <Icon name="chevron-right" size={14} />
            </button>
          </div>
          <div className="studio-right-body">
            {rightTab === "preview" ? (
              <ProjectPreview reloadKey={reloadKey} onSelectElement={setSelectedElement} onBakeTokens={bakeTokens} />
            ) : (
              <div className="studio-code-view">
                <div className="studio-code-tree">
                  <StudioFiles onOpen={handleOpenFile} defaultName={slugifyName(turns[0]?.userText ?? draft.brief)} />
                </div>
                <div className="studio-code-editor">
                  {splitFile ? (
                    <>
                      <div className="studio-split-head">
                        <span className="dot ide" />
                        <span className="label">Éditeur</span>
                        <span className="sep">·</span>
                        <span className="path" title={splitFile}>{splitFile}</span>
                        <span style={{ flex: 1 }} />
                        <button className="lgb lgb-sm" onClick={openFullEditor} title="Ouvrir en plein écran (IDE)">
                          <Icon name="code" size={11} /> Plein écran
                        </button>
                        <button className="split-close" onClick={closeSplit} title="Fermer le fichier">
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                      <div className="studio-split-cm">
                        <CodeMirrorEditor
                          value={fileContents[splitFile]?.text ?? ""}
                          onChange={onSplitChange}
                          path={splitFile}
                          wordWrap={editorPrefs.wordWrap}
                          stickyScroll={editorPrefs.stickyScroll}
                          minimap={editorPrefs.minimap}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="studio-code-empty">
                      <Icon name="code" size={22} />
                      <div>Sélectionne un fichier à gauche pour l'éditer.</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
