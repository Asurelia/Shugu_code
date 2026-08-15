// Shugu Forge — Studio workspace (canvas-first).
// Single surface: layers · infinite canvas · dock (chat + inspector).
// No sub-tabs, no design-system catalogue, no 3-step wizard.

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/components";
import { resolveOrchestrator } from "@/features/chat/chat-sync";
import { useDesignSkills } from "@/features/design/queries";
import { spawnAgent } from "@/lib/agents";
import { fsGetWorkspaceRoot, fsListFiles, fsReadFile, fsReadFiles, fsWriteFile } from "@/lib/fs";
import { useAgentTranscript } from "@/features/agents/queries";
import { useScopedTree } from "@/features/fs/queries";
import { useShell } from "@/routes/shell-context";

import { CanvasLayers } from "./canvas/CanvasLayers";
import { StudioCanvas } from "./canvas/StudioCanvas";
import {
  addPinToNode,
  buildPinsTask,
  commentedPins,
  pinsOfNode,
  removePinFromNode,
  setPinComment,
} from "./canvas/canvasPins";
import {
  EXPLORATIONS_DIR,
  explorationsChanged,
  mergeExplorationsIntoDoc,
  slugFromFileName,
  titleFromHtml,
  type ExplorationFile,
} from "./canvas/canvasExplorations";
import {
  atlasVisualFingerprint,
  extractComponentsFromHtml,
  mergeProductAtlas,
  type AtlasComponent,
  type AtlasPage,
} from "./canvas/productAtlas";
import {
  aggregateCss,
  buildComponentHtml,
  buildUiKitHomeHtml,
  discoverRoutesFromSource,
  discoverSvgComponents,
  discoverWorkspacePages,
  extractCssUiSpecimens,
  extractIconsFromTsSource,
  packIconsSheet,
} from "./canvas/workspaceUiAtlas";
import {
  BRAND_NODE_ID,
  getSelectedNode,
  LIVE_HOME_ID,
  setCamera,
  type StudioCanvasDoc,
} from "./canvas/studioCanvasDoc";
import {
  getStudioCanvasDoc,
  resetStudioCanvasDoc,
  setStudioCanvasDoc,
  useStudioCanvasDoc,
} from "./canvas/studioCanvasStore";
import {
  buildElSliders,
  buildStyleEditTask,
  buildTextEditTask,
  isColorStyle,
  patchStyleInHtml,
  patchTextInHtml,
  sourcePathForNode,
  type ElStyle,
} from "./directEdit";
import type { DomTreeItem } from "./domLayers";
import type {
  PinPlacedPayload,
  ProjectPreviewHandle,
  TextEditedPayload,
} from "./ProjectPreview";
import { buildVariationTask, defaultVariations } from "./variations";
import { useStudioBrandBoard, setStudioBrandBoard } from "./brandBoard";
import { DirectionPicker } from "./DirectionPicker";
import { buildGenerationContext, type DiscoveryAnswers } from "./generationContext";
import { useProjectLiveUrl } from "./projectLivePreview";
import { StudioConversation } from "./StudioConversation";
import {
  appendStudioTurn,
  buildElementEditTask,
  buildIterationTask,
  buildTweakBakeTask,
  buildTurnContext,
  clearStudioChat,
  useStudioChat,
  type SelectedElement,
} from "./studioChat";
import { useStudioDraft, setStudioDraft } from "./studioDraft";
import {
  invalidateStudioProjects,
  setStudioCurrentProject,
  studioProjectLoad,
  studioProjectSaveAs,
  studioProjectUpsertAuto,
  useStudioCurrentProject,
  useStudioProjects,
} from "./studioProjects";
const LS_LAYERS = "studio.ui.layersOpen";
const LS_DOCK = "studio.ui.dockOpen";

function readUiFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return v === "1";
}

export function StudioWorkspace() {
  const doc = useStudioCanvasDoc();
  const draft = useStudioDraft();
  const brandBoard = useStudioBrandBoard();
  const turns = useStudioChat();
  const skills = useDesignSkills().data ?? [];
  const projects = useStudioProjects().data ?? [];
  const currentProjectId = useStudioCurrentProject();
  const { generations } = useShell();

  const [reloadKey, setReloadKey] = useState(0);
  const [gateError, setGateError] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [dockTab, setDockTab] = useState<"chat" | "inspector">("chat");
  const [projectMenu, setProjectMenu] = useState(false);
  const [layersOpen, setLayersOpen] = useState(() => readUiFlag(LS_LAYERS, true));
  const [dockOpen, setDockOpen] = useState(() => readUiFlag(LS_DOCK, true));
  // Lot A/B/E — direct manipulation state.
  const [editing, setEditing] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [elStyles, setElStyles] = useState<ElStyle[]>([]);
  const [elOverrides, setElOverrides] = useState<Record<string, string>>({});
  const [domTree, setDomTree] = useState<DomTreeItem[]>([]);
  const selectedPreviewRef = useRef<ProjectPreviewHandle | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_LAYERS, layersOpen ? "1" : "0");
      localStorage.setItem(LS_DOCK, dockOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [layersOpen, dockOpen]);

  // Disk → canvas: agent deposits via studio_deposit_exploration / fs_write_file.
  const { data: explorationEntries = [] } = useScopedTree(EXPLORATIONS_DIR);
  useEffect(() => {
    let cancelled = false;
    const htmlFiles = explorationEntries.filter(
      (e) => e.isDir !== true && !!slugFromFileName(e.name),
    );
    void (async () => {
      const files: ExplorationFile[] = [];
      for (const entry of htmlFiles) {
        const slug = slugFromFileName(entry.name);
        if (!slug) continue;
        try {
          const content = await fsReadFile(entry.path);
          const html = content.text ?? "";
          files.push({ slug, name: titleFromHtml(html, slug), html });
        } catch {
          // File vanished mid-sync — skip.
        }
      }
      if (cancelled) return;
      const cur = getStudioCanvasDoc();
      const next = mergeExplorationsIntoDoc(cur, files);
      if (explorationsChanged(cur, next)) setStudioCanvasDoc(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [explorationEntries]);

  const brandAssets = useMemo(
    () =>
      brandBoard.pinnedAssetIds
        .map((id) => generations.find((g: any) => (g.kind ?? "image") === "image" && String(g.id) === id))
        .filter(Boolean)
        .map((g: any) => ({
          prompt: g.prompt,
          model: g.model,
          ratio: g.ratio,
          resultUrl: g.resultUrl ?? null,
        })),
    [brandBoard.pinnedAssetIds, generations],
  );

  const { projectName: workspaceName, liveUrl } = useProjectLiveUrl();
  const [hasAtlas, setHasAtlas] = useState(false);

  // Scan OPEN workspace → pages + component cards (icons, buttons, cards…).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await fsListFiles(
          [
            "png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "ttf", "otf",
            "mp4", "webm", "zip", "gz", "7z", "exe", "dll", "so", "dylib",
            "safetensors", "bin", "pt", "onnx", "wasm", "map", "lock",
          ],
          2_500,
        );
        if (cancelled) return;
        const paths = listed.paths.map((p) => p.replace(/\\/g, "/"));

        const htmlPaths = paths.filter((p) => /\.html?$/i.test(p));
        let pages: AtlasPage[] = discoverWorkspacePages(htmlPaths);

        // Vite/SPA shells are not faithful UI without the bundler — skip as page frames.
        const spaRoutes = new Set<string>();
        for (const page of [...pages].slice(0, 10)) {
          try {
            const file = await fsReadFile(page.route);
            const html = file.text ?? "";
            if (/type=["']module["']/i.test(html) && /\/src\//i.test(html)) {
              spaRoutes.add(page.route);
            }
          } catch {
            /* keep */
          }
        }
        pages = pages.filter((p) => !spaRoutes.has(p.route)).slice(0, 5);

        // Prefer lean CSS (foundations + main sheet) — huge CSS × N iframes = freeze.
        const cssPaths = paths
          .filter((p) => /\.css$/i.test(p) && !p.includes("node_modules"))
          .filter(
            (p) =>
              /celestial|foundation|token|styles\.css|typography/i.test(p) ||
              (p.startsWith("src/styles/") && p.split("/").length <= 4),
          )
          .slice(0, 8);
        const cssFiles = await fsReadFiles(cssPaths);
        if (cancelled) return;
        const css = aggregateCss(
          Object.entries(cssFiles).map(([path, f]) => ({ path, text: f.text ?? "" })),
        );

        const iconBits: AtlasComponent[] = [];
        const components: AtlasComponent[] = [];

        const iconSources = paths
          .filter(
            (p) =>
              /\/components\.(tsx|jsx)$/i.test(p) ||
              /Icons?\.(tsx|jsx)$/i.test(p),
          )
          .slice(0, 2);
        for (const path of iconSources) {
          try {
            const file = await fsReadFile(path);
            iconBits.push(...extractIconsFromTsSource(file.text ?? "", path));
          } catch {
            /* skip */
          }
        }

        const svgMetas = discoverSvgComponents(paths);
        for (const meta of svgMetas.slice(0, 8)) {
          try {
            const file = await fsReadFile(meta.pageRoute);
            const raw = (file.text ?? "").trim();
            iconBits.push({
              ...meta,
              outerHtml: raw.startsWith("<")
                ? `<div style="display:grid;place-items:center;min-height:40px;color:#e8e8ec">${raw}</div>`
                : meta.outerHtml,
            });
          } catch {
            /* skip */
          }
        }

        const sheet = packIconsSheet(iconBits);
        if (sheet) components.push(sheet);

        components.push(...extractCssUiSpecimens(css));

        for (const page of pages.slice(0, 3)) {
          try {
            const file = await fsReadFile(page.route);
            components.push(...extractComponentsFromHtml(file.text ?? "", page.route).slice(0, 2));
          } catch {
            /* skip */
          }
        }

        const routerPaths = paths
          .filter((p) => /(^|\/)router\.(tsx|jsx|ts|js)$/i.test(p))
          .slice(0, 1);
        if (pages.length === 0) {
          for (const path of routerPaths) {
            try {
              const file = await fsReadFile(path);
              pages.push(...discoverRoutesFromSource(file.text ?? "").slice(0, 5));
            } catch {
              /* skip */
            }
          }
        }

        // Cap before wrap — each wrap embeds CSS.
        const trimmed = components.slice(0, 6);
        const wrapped = buildComponentHtml(trimmed, css);

        if (!pages.some((p) => p.route === "index.html" || p.route === "dist/index.html")) {
          if (wrapped.length > 0) {
            pages = [
              {
                route: "ui-kit-home.html",
                name: workspaceName && workspaceName !== "Aucun projet" ? workspaceName : "Atlas UI",
                html: buildUiKitHomeHtml(wrapped, css, workspaceName || "Projet"),
              },
              ...pages.slice(0, 4),
            ];
          }
        } else {
          pages = pages.slice(0, 5);
        }

        if (cancelled) return;
        const found = pages.length > 0 || wrapped.length > 0;
        setHasAtlas(found);
        if (!found) return;

        const cur = getStudioCanvasDoc();
        const next = mergeProductAtlas(cur, { pages, components: wrapped, css });
        if (atlasVisualFingerprint(cur) !== atlasVisualFingerprint(next)) {
          setStudioCanvasDoc(next);
        }
      } catch (err) {
        console.warn("[studio] workspace UI scan failed:", err);
        if (!cancelled) setHasAtlas(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceName, reloadKey]);

  useEffect(() => {
    if (!workspaceName || workspaceName === "Aucun projet") return;
    const cur = getStudioCanvasDoc();
    const live = cur.nodes.find((n) => n.id === LIVE_HOME_ID);
    if (!live || live.html || live.name === workspaceName) return;
    if (live.name !== "Produit live" && live.name !== "Produit · Accueil") return;
    setStudioCanvasDoc({
      ...cur,
      nodes: cur.nodes.map((n) =>
        n.id === LIVE_HOME_ID ? { ...n, name: workspaceName } : n,
      ),
    });
  }, [workspaceName]);

  const lastTurn = turns[turns.length - 1];
  const lastTx = useAgentTranscript(lastTurn?.agentId);
  const lastStatus = lastTx.data?.agent.status;
  const busy =
    !!lastTurn && lastStatus !== "complete" && lastStatus !== "error" && lastStatus !== "killed";

  const chatProjectName = useMemo(
    () => (turns[0]?.userText ?? draft.brief).trim().slice(0, 60) || workspaceName,
    [turns, draft.brief, workspaceName],
  );
  const hasProject = hasAtlas || Boolean(liveUrl);
  const projectName = chatProjectName;

  const bumpedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = lastTurn?.agentId;
    if (!id) return;
    const done = lastStatus === "complete" || lastStatus === "error" || lastStatus === "killed";
    if (done && bumpedRef.current !== id) {
      bumpedRef.current = id;
      setReloadKey((k) => k + 1);
      if (lastStatus === "complete") {
        void studioProjectUpsertAuto(chatProjectName, draft.convId)
          .then((pid) => {
            setStudioCurrentProject(pid);
            invalidateStudioProjects();
          })
          .catch(() => {});
      }
    }
  }, [lastTurn?.agentId, lastStatus, chatProjectName, draft.convId]);

  // Selecting the brand node focuses the inspector.
  const selected = getSelectedNode(doc);
  useEffect(() => {
    if (selected?.kind === "brand") setDockTab("inspector");
  }, [selected?.id, selected?.kind]);

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
          : orch.kind === "disabled"
            ? `Le provider orchestrator « ${orch.providerId} » n'est pas activé (Settings → Connections).`
            : `Le provider orchestrator « ${orch.providerId} » est inutilisable : ${orch.reason}.`,
      );
      return null;
    }
    return orch;
  };

  const spawnTurn = async (task: string, userText: string, context?: string) => {
    const orch = await ready();
    if (!orch) return;
    const designContext = buildGenerationContext({
      system: null, // catalogue removed — brand + direction only
      skills,
      discovery: draft.discovery,
      direction: draft.direction,
      brand: {
        audience: brandBoard.audience,
        voice: brandBoard.voice,
        notes: brandBoard.notes,
        assets: brandAssets,
      },
      brief: draft.brief.trim() || userText,
    });
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
        isolate: false,
      });
      appendStudioTurn({ id: crypto.randomUUID(), userText, agentId, context });
      setGateError(null);
      setDockTab("chat");
    } catch (err) {
      setGateError(`Échec du lancement : ${String(err)}`);
    }
  };

  const generate = () => {
    const task = draft.brief.trim();
    if (!task || busy) return;
    if (draft.startingNew) clearStudioChat();
    setStudioDraft({ startingNew: false });
    void spawnTurn(task, task, buildTurnContext(null, draft));
  };

  // Lot C — three contrasting directions explored in PARALLEL (fan-out), each
  // deposited as its own exploration frame; the live product is untouched.
  const generateVariations = () => {
    const task = draft.brief.trim();
    if (!task || busy) return;
    if (draft.startingNew) clearStudioChat();
    setStudioDraft({ startingNew: false });
    for (const v of defaultVariations(task)) {
      void spawnTurn(buildVariationTask(task, v), `Variante — ${v.direction}`);
    }
  };

  // ── Lot A/B/E — direct-manipulation bridge handlers ──────────────────────

  /** Element picked in a frame → inspector + styles probe of that element. */
  const handleSelectElement = (el: SelectedElement) => {
    setSelectedElement(el);
    setSelecting(false);
    setElOverrides({});
    setElStyles([]);
    setDockOpen(true);
    setDockTab("inspector");
    // The controller remembers the picked element synchronously before the
    // "selected" message reaches us, so probing right away is safe; the small
    // defer covers the ref hand-off when the frame was not selected yet.
    window.setTimeout(() => selectedPreviewRef.current?.post({ type: "shugu:probeStyles" }), 60);
  };

  /** Apply a text edit durably: doc patch → file patch → agent fallback. */
  const handleTextEdited = async (nodeId: string, p: TextEditedPayload) => {
    const cur = getStudioCanvasDoc();
    const node = cur.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.kind === "exploration" && !node.route && node.html) {
      const r = patchTextInHtml(node.html, p.oldText, p.newText);
      if (r.ok && r.html) {
        setStudioCanvasDoc({
          ...cur,
          nodes: cur.nodes.map((n) => (n.id === nodeId ? { ...n, html: r.html! } : n)),
        });
        return;
      }
    } else {
      const path = sourcePathForNode(node);
      if (path) {
        try {
          const file = await fsReadFile(path);
          const r = patchTextInHtml(file.text ?? "", p.oldText, p.newText);
          if (r.ok && r.html) {
            await fsWriteFile(path, r.html);
            return;
          }
        } catch {
          /* fall through to the agent turn */
        }
      }
    }
    void spawnTurn(
      buildTextEditTask(p.el, p.oldText, p.newText),
      `Texte : « ${p.oldText.slice(0, 40)} » → « ${p.newText.slice(0, 40)} »`,
    );
  };

  /** Live element style nudge (runtime-only until baked). */
  const handleElStyle = (prop: string, value: string) => {
    setElOverrides((o) => ({ ...o, [prop]: value }));
    selectedPreviewRef.current?.post({ type: "shugu:setElStyle", prop, value });
  };

  /** Re-apply the probed originals and drop the pending overrides. */
  const resetElStyles = () => {
    for (const s of elStyles) {
      if (elOverrides[s.prop] !== undefined) {
        selectedPreviewRef.current?.post({ type: "shugu:setElStyle", prop: s.prop, value: s.value });
      }
    }
    setElOverrides({});
  };

  /** Bake pending element overrides into the source (patch) or via an agent. */
  const bakeElStyles = async () => {
    const keys = Object.keys(elOverrides);
    if (!selectedElement || keys.length === 0 || busy) return;
    const cur = getStudioCanvasDoc();
    const node = getSelectedNode(cur);
    let done = false;
    if (node) {
      if (node.kind === "exploration" && !node.route && node.html) {
        let html = node.html;
        let okAll = true;
        for (const k of keys) {
          const r = patchStyleInHtml(html, selectedElement.open, k, elOverrides[k]);
          if (!r.ok || !r.html) { okAll = false; break; }
          html = r.html;
        }
        if (okAll) {
          setStudioCanvasDoc({
            ...cur,
            nodes: cur.nodes.map((n) => (n.id === node.id ? { ...n, html } : n)),
          });
          done = true;
        }
      } else {
        const path = sourcePathForNode(node);
        if (path) {
          try {
            const file = await fsReadFile(path);
            let html = file.text ?? "";
            let okAll = true;
            for (const k of keys) {
              const r = patchStyleInHtml(html, selectedElement.open, k, elOverrides[k]);
              if (!r.ok || !r.html) { okAll = false; break; }
              html = r.html;
            }
            if (okAll) {
              await fsWriteFile(path, html);
              done = true;
            }
          } catch {
            /* agent fallback below */
          }
        }
      }
    }
    const pending = elOverrides;
    setElOverrides({});
    if (!done) {
      void spawnTurn(buildStyleEditTask(selectedElement, pending), "Ajustements style élément");
    }
  };

  /** Lot B — pin dropped on a frame → persist on the node, open the inspector. */
  const handlePinPlaced = (nodeId: string, p: PinPlacedPayload) => {
    const cur = getStudioCanvasDoc();
    const { doc } = addPinToNode(cur, nodeId, p.el, p.relX, p.relY);
    setStudioCanvasDoc(doc);
    setDockOpen(true);
    setDockTab("inspector");
  };

  const applyPins = (nodeId: string, nodeName: string) => {
    const cur = getStudioCanvasDoc();
    const node = cur.nodes.find((n) => n.id === nodeId);
    const pins = commentedPins(node);
    if (busy || pins.length === 0) return;
    void spawnTurn(buildPinsTask(nodeName, pins), `Résoudre ${pins.length} commentaire(s) — ${nodeName}`);
    // Applied pins are consumed: drop them so the badges reflect reality.
    let next = cur;
    for (const p of pins) next = removePinFromNode(next, nodeId, p.id);
    setStudioCanvasDoc(next);
  };

  // Lot E — DOM layers of the selected frame: refresh on selection / reload.
  const selectedHasPreview =
    !!selected &&
    (selected.kind === "live" || selected.kind === "exploration") &&
    (Boolean(selected.route) || Boolean(selected.html) || selected.id === LIVE_HOME_ID);
  useEffect(() => {
    setDomTree([]);
    if (!selectedHasPreview) return;
    const t = window.setTimeout(
      () => selectedPreviewRef.current?.post({ type: "shugu:getDomTree" }),
      250,
    );
    return () => window.clearTimeout(t);
  }, [selected?.id, selectedHasPreview, reloadKey]);

  const sendIteration = (instruction: string) => {
    if (busy) return;
    const sel = selectedElement;
    if (sel) {
      setSelectedElement(null);
      void spawnTurn(buildElementEditTask(instruction, sel), instruction, `Élément ciblé : ${sel.selector}`);
    } else {
      void spawnTurn(buildIterationTask(turns, instruction), instruction);
    }
  };

  const bakeTokens = (overrides: Record<string, string>) => {
    if (busy || turns.length === 0 || Object.keys(overrides).length === 0) return;
    void spawnTurn(buildTweakBakeTask(overrides), "Appliquer les ajustements visuels", "Tweaks live → projet");
  };

  const onNew = () => {
    clearStudioChat();
    setStudioDraft({
      step: 1,
      brief: "",
      discovery: {},
      direction: null,
      startingNew: true,
      convId: null,
    });
    resetStudioCanvasDoc();
    setStudioCurrentProject(null);
    setGateError(null);
    setSelectedElement(null);
    setEditing(false);
    setPinning(false);
    setElStyles([]);
    setElOverrides({});
    setDomTree([]);
    setDockTab("chat");
  };

  const onSaveAs = () => {
    if (!hasProject && turns.length === 0) return;
    void studioProjectSaveAs(`${projectName} (copie)`, draft.convId)
      .then(() => invalidateStudioProjects())
      .catch((err) => setGateError(`Échec de la sauvegarde : ${String(err)}`));
  };

  const openProject = (id: string) => {
    void studioProjectLoad(id)
      .then(() => {
        const p = projects.find((x) => x.id === id);
        setStudioCurrentProject(id);
        setStudioDraft({
          startingNew: false,
          convId: p?.conversationId ?? null,
          brief: p?.name ?? draft.brief,
        });
        setReloadKey((k) => k + 1);
        setProjectMenu(false);
        setGateError(null);
      })
      .catch((err) => setGateError(`Impossible d'ouvrir le projet : ${String(err)}`));
  };

  const showCompose = draft.startingNew || (turns.length === 0 && !hasProject);
  const zoomPct = Math.round(doc.camera.zoom * 100);

  return (
    <div className="studio-workspace">
      <header className="studio-toolbar">
        <div className="studio-toolbar-proj">
          <button
            type="button"
            className="studio-proj-btn"
            onClick={() => setProjectMenu((v) => !v)}
            aria-expanded={projectMenu}
          >
            <Icon name="folder" size={13} />
            <span>{currentProjectId ? projectName : hasProject ? projectName : "Nouveau projet"}</span>
            <Icon name="down" size={12} />
          </button>
          {projectMenu && (
            <div className="studio-proj-menu">
              <button type="button" onClick={onNew}>
                <Icon name="plus" size={12} /> Nouveau
              </button>
              <button type="button" onClick={onSaveAs} disabled={!hasProject && turns.length === 0}>
                <Icon name="copy" size={12} /> Sauvegarder une copie
              </button>
              {projects.length > 0 && <div className="studio-proj-sep" />}
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === currentProjectId ? "is-active" : ""}
                  onClick={() => openProject(p.id)}
                >
                  {p.name}
                  {p.kind === "saved" ? " · sauvé" : ""}
                </button>
              ))}
              {projects.length === 0 && (
                <div className="studio-proj-empty">Aucun projet enregistré</div>
              )}
            </div>
          )}
        </div>

        <div className="studio-toolbar-toggles">
          <button
            type="button"
            className={"studio-panel-toggle" + (layersOpen ? " is-on" : "")}
            title={layersOpen ? "Replier les layers" : "Afficher les layers"}
            aria-pressed={layersOpen}
            onClick={() => setLayersOpen((v) => !v)}
          >
            <Icon name="list" size={13} />
          </button>
          <button
            type="button"
            className={"studio-panel-toggle" + (dockOpen ? " is-on" : "")}
            title={dockOpen ? "Replier le dock" : "Afficher le dock"}
            aria-pressed={dockOpen}
            onClick={() => setDockOpen((v) => !v)}
          >
            <Icon name="chat" size={13} />
          </button>
        </div>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          className="lgb lgb-sm"
          title="Réinitialiser le zoom"
          onClick={() => setStudioCanvasDoc(setCamera(doc, { x: 0, y: 0, zoom: 0.65 }))}
        >
          {zoomPct}%
        </button>
        <button
          type="button"
          className={"lgb lgb-sm" + (selecting ? " studio-select-on" : "")}
          disabled={!hasProject}
          onClick={() => {
            setSelecting((v) => !v);
            setPinning(false);
            setDockOpen(true);
            setDockTab("inspector");
          }}
          title="Sélectionner un élément dans la frame live"
        >
          <Icon name="sparkle" size={12} /> Sélectionner
        </button>
        <button
          type="button"
          className={"lgb lgb-sm" + (editing ? " studio-select-on" : "")}
          disabled={!hasProject}
          onClick={() => {
            setEditing((v) => !v);
            setSelecting(false);
            setPinning(false);
          }}
          title="Édition directe : double-clique un texte dans la frame pour le modifier"
        >
          <Icon name="pencil" size={12} /> Éditer
        </button>
        <button
          type="button"
          className={"lgb lgb-sm" + (pinning ? " studio-select-on" : "")}
          disabled={!hasProject}
          onClick={() => {
            setPinning((v) => !v);
            setSelecting(false);
            setEditing(false);
            setDockOpen(true);
            setDockTab("inspector");
          }}
          title="Épingler un commentaire : clique un élément de la frame"
        >
          <Icon name="pin" size={12} /> Commenter
        </button>
      </header>

      <div
        className={
          "studio-workspace-body" +
          (layersOpen ? "" : " layers-collapsed") +
          (dockOpen ? "" : " dock-collapsed")
        }
      >
        {layersOpen ? (
          <CanvasLayers
            doc={doc}
            domTree={domTree}
            onRefreshDomTree={() => {
              setDomTree([]);
              selectedPreviewRef.current?.post({ type: "shugu:getDomTree" });
            }}
            onDomHover={(i) => {
              selectedPreviewRef.current?.post(
                i === null ? { type: "shugu:unhighlight" } : { type: "shugu:highlight", i },
              );
            }}
            onDomPick={(i) => selectedPreviewRef.current?.post({ type: "shugu:pickIndex", i })}
          />
        ) : (
          <button
            type="button"
            className="studio-rail-expand is-left"
            title="Afficher les layers"
            onClick={() => setLayersOpen(true)}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        )}

        <StudioCanvas
          doc={doc}
          reloadKey={reloadKey}
          liveUrl={liveUrl}
          hasAtlas={hasAtlas}
          selecting={selecting}
          onSelectElement={handleSelectElement}
          onSelectingChange={setSelecting}
          onBakeTokens={bakeTokens}
          selectedPreviewRef={selectedPreviewRef}
          bridge={{
            editing,
            pinning,
            onSelectElement: handleSelectElement,
            onTextEdited: (nodeId, p) => void handleTextEdited(nodeId, p),
            onElStyles: setElStyles,
            onPinPlaced: handlePinPlaced,
            onDomTree: setDomTree,
            onBakeTokens: bakeTokens,
          }}
        />

        {dockOpen ? (
        <aside className="studio-dock">
          <div className="studio-dock-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={"studio-dock-tab" + (dockTab === "chat" ? " is-active" : "")}
              aria-selected={dockTab === "chat"}
              onClick={() => setDockTab("chat")}
            >
              <Icon name="chat" size={13} /> Chat
            </button>
            <button
              type="button"
              role="tab"
              className={"studio-dock-tab" + (dockTab === "inspector" ? " is-active" : "")}
              aria-selected={dockTab === "inspector"}
              onClick={() => setDockTab("inspector")}
            >
              <Icon name="gear" size={13} /> Inspector
            </button>
            <button
              type="button"
              className="studio-panel-toggle studio-dock-collapse"
              title="Replier le dock"
              onClick={() => setDockOpen(false)}
            >
              <Icon name="chevron-right" size={13} />
            </button>
          </div>

          {gateError && (
            <div className="studio-status studio-status-err">
              <Icon name="x" size={13} /> {gateError}
            </div>
          )}

          {dockTab === "chat" ? (
            showCompose ? (
              <ComposePanel
                brief={draft.brief}
                busy={busy}
                discovery={draft.discovery}
                onDiscover={(key, value) =>
                  setStudioDraft({ discovery: { ...draft.discovery, [key]: value } })
                }
                onBrief={(brief) => setStudioDraft({ brief })}
                onGenerate={generate}
                onGenerateVariations={generateVariations}
              />
            ) : (
              <StudioConversation
                turns={turns}
                busy={busy}
                onSend={sendIteration}
                onNew={onNew}
                onSaveAs={onSaveAs}
                selectedElement={selectedElement}
                onClearSelected={() => setSelectedElement(null)}
              />
            )
          ) : (
            <InspectorPanel
              doc={doc}
              brand={brandBoard}
              hasProject={hasProject}
              selecting={selecting}
              onSelectingChange={setSelecting}
              direction={draft.direction}
              onDirection={(direction) => setStudioDraft({ direction })}
              brief={draft.brief}
              onReloadPreview={() => setReloadKey((k) => k + 1)}
              selectedElement={selectedElement}
              elStyles={elStyles}
              elOverrides={elOverrides}
              onElStyle={handleElStyle}
              onResetElStyles={resetElStyles}
              onBakeElStyles={() => void bakeElStyles()}
              busy={busy}
              onPinComment={(nodeId, pinId, comment) =>
                setStudioCanvasDoc(setPinComment(getStudioCanvasDoc(), nodeId, pinId, comment))
              }
              onPinDelete={(nodeId, pinId) =>
                setStudioCanvasDoc(removePinFromNode(getStudioCanvasDoc(), nodeId, pinId))
              }
              onApplyPins={applyPins}
            />
          )}
        </aside>
        ) : (
          <button
            type="button"
            className="studio-rail-expand is-right"
            title="Afficher le dock"
            onClick={() => setDockOpen(true)}
          >
            <Icon name="chevron-left" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// Lot D — guided brief: quick chip questions folded into the discovery answers
// (they feed buildGenerationContext like the retired wizard did).
const QUIZ: { key: keyof DiscoveryAnswers; label: string; options: string[] }[] = [
  {
    key: "mood",
    label: "Ambiance",
    options: ["minimaliste", "premium sombre", "expressive", "corporate"],
  },
  {
    key: "layout",
    label: "Structure",
    options: ["hero centré", "sidebar + contenu", "grille de cartes", "one-page scroll"],
  },
  {
    key: "density",
    label: "Densité",
    options: ["aérée", "équilibrée", "compacte"],
  },
];

function ComposePanel({
  brief,
  busy,
  discovery,
  onDiscover,
  onBrief,
  onGenerate,
  onGenerateVariations,
}: {
  brief: string;
  busy: boolean;
  discovery: DiscoveryAnswers;
  onDiscover: (key: keyof DiscoveryAnswers, value: string) => void;
  onBrief: (v: string) => void;
  onGenerate: () => void;
  onGenerateVariations: () => void;
}) {
  return (
    <div className="studio-compose">
      <div className="studio-compose-hd">
        <Icon name="sparkle" size={14} />
        <span>Créer sur le canvas</span>
      </div>
      <p className="studio-hint studio-hint-sm">
        Le canvas montre l’atlas du <b>projet ouvert</b> : pages, boutons, cartes, icônes…
        Décris l’UI, affine avec les puces ci-dessous, puis génère une direction unique ou
        <b> 3 variations en parallèle</b>.
      </p>
      <label className="studio-label" htmlFor="studio-brief-canvas">
        Décris l’UI à générer
      </label>
      <textarea
        id="studio-brief-canvas"
        className="studio-brief"
        value={brief}
        onChange={(e) => onBrief(e.target.value)}
        placeholder="ex. dashboard analytics : sidebar, KPI cards, graphique, table filtrable…"
      />

      {QUIZ.map((q) => (
        <div className="studio-quiz-row" key={q.key}>
          <span className="studio-quiz-label">{q.label}</span>
          <div className="studio-quiz-chips">
            {q.options.map((opt) => {
              const active = (discovery[q.key] ?? "") === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  className={"studio-chip" + (active ? " is-active" : "")}
                  aria-pressed={active}
                  onClick={() => onDiscover(q.key, active ? "" : opt)}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <button
        type="button"
        className="lgb lgb-primary lgb-lg studio-generate"
        onClick={onGenerate}
        disabled={busy || !brief.trim()}
      >
        <Icon name="sparkle" size={14} /> Générer sur le canvas
      </button>
      <button
        type="button"
        className="lgb lgb-lg studio-generate studio-generate-alt"
        onClick={onGenerateVariations}
        disabled={busy || !brief.trim()}
        title="Lance 3 agents en parallèle : direction sombre, éditoriale et expressive"
      >
        <Icon name="gallery" size={14} /> Explorer 3 directions
      </button>
    </div>
  );
}

function InspectorPanel({
  doc,
  brand,
  hasProject,
  selecting,
  onSelectingChange,
  direction,
  onDirection,
  brief,
  onReloadPreview,
  selectedElement,
  elStyles,
  elOverrides,
  onElStyle,
  onResetElStyles,
  onBakeElStyles,
  busy,
  onPinComment,
  onPinDelete,
  onApplyPins,
}: {
  doc: StudioCanvasDoc;
  brand: ReturnType<typeof useStudioBrandBoard>;
  hasProject: boolean;
  selecting: boolean;
  onSelectingChange: (on: boolean) => void;
  direction: ReturnType<typeof useStudioDraft>["direction"];
  onDirection: (d: NonNullable<ReturnType<typeof useStudioDraft>["direction"]>) => void;
  brief: string;
  onReloadPreview: () => void;
  selectedElement: SelectedElement | null;
  elStyles: ElStyle[];
  elOverrides: Record<string, string>;
  onElStyle: (prop: string, value: string) => void;
  onResetElStyles: () => void;
  onBakeElStyles: () => void;
  busy: boolean;
  onPinComment: (nodeId: string, pinId: string, comment: string) => void;
  onPinDelete: (nodeId: string, pinId: string) => void;
  onApplyPins: (nodeId: string, nodeName: string) => void;
}) {
  const selected = getSelectedNode(doc);
  const kind = selected?.kind;

  if (!selected) {
    return (
      <div className="studio-inspector">
        <p className="studio-hint">Sélectionne un node sur le canvas (layers ou frame).</p>
        <button
          type="button"
          className="lgb lgb-sm"
          onClick={() => setStudioCanvasDoc({ ...doc, selectedId: BRAND_NODE_ID })}
        >
          <Icon name="palette" size={12} /> Ouvrir Marque
        </button>
      </div>
    );
  }

  if (kind === "brand") {
    return (
      <div className="studio-inspector scroll">
        <div className="studio-inspector-hd">
          <Icon name="palette" size={14} />
          <span>Marque</span>
        </div>
        <label className="studio-label">Audience</label>
        <textarea
          className="studio-brief studio-brief-sm"
          value={brand.audience}
          onChange={(e) => setStudioBrandBoard({ audience: e.target.value })}
          placeholder="Pour qui ?"
        />
        <label className="studio-label">Voix</label>
        <textarea
          className="studio-brief studio-brief-sm"
          value={brand.voice}
          onChange={(e) => setStudioBrandBoard({ voice: e.target.value })}
          placeholder="Ton, personnalité…"
        />
        <label className="studio-label">Notes</label>
        <textarea
          className="studio-brief"
          value={brand.notes}
          onChange={(e) => setStudioBrandBoard({ notes: e.target.value })}
          placeholder="Contraintes, références, do/don’t…"
        />
        <div className="studio-inspector-hd" style={{ marginTop: 12 }}>
          <Icon name="image" size={14} />
          <span>Direction visuelle</span>
        </div>
        <DirectionPicker brief={brief} discovery={{}} value={direction} onChange={onDirection} />
      </div>
    );
  }

  // live / component / exploration: frame inspector with element tools + pins.
  const pins = pinsOfNode(selected);
  const actionable = commentedPins(selected);
  const showElementTools = kind === "live" || kind === "exploration";

  return (
    <div className="studio-inspector scroll">
      <div className="studio-inspector-hd">
        <Icon
          name={kind === "live" ? "image" : kind === "component" ? "gallery" : "sparkle"}
          size={14}
        />
        <span>{selected.name}</span>
      </div>
      <p className="studio-hint studio-hint-sm">
        {kind === "live" && (
          <>
            Frame page · <code>{selected.route || "—"}</code>
            {hasProject ? " · extrait du projet ouvert" : " · en attente d’UI"}
          </>
        )}
        {kind === "component" && (
          <>
            Composant isolé · page source <code>{selected.route || "?"}</code>
          </>
        )}
        {kind === "exploration" && "Frame d’exploration — variante libre, hors jumeau produit."}
      </p>

      {kind === "live" && (
        <>
          <button
            type="button"
            className={"lgb lgb-sm" + (selecting ? " studio-select-on" : "")}
            disabled={!hasProject}
            onClick={() => onSelectingChange(!selecting)}
          >
            <Icon name="sparkle" size={12} />{" "}
            {selecting ? "Clique un élément dans la frame…" : "Sélectionner un élément"}
          </button>
          <button
            type="button"
            className="lgb lgb-sm"
            disabled={!hasProject}
            onClick={onReloadPreview}
          >
            <Icon name="history" size={12} /> Recharger l’aperçu
          </button>
        </>
      )}

      {showElementTools && selectedElement && (
        <ElementStyleSection
          el={selectedElement}
          styles={elStyles}
          overrides={elOverrides}
          onChange={onElStyle}
          onReset={onResetElStyles}
          onBake={onBakeElStyles}
          busy={busy}
        />
      )}

      {showElementTools && (
        <div className="studio-pins">
          <div className="studio-inspector-hd" style={{ marginTop: 12 }}>
            <Icon name="pin" size={13} />
            <span>Commentaires ({pins.length})</span>
          </div>
          {pins.length === 0 ? (
            <p className="studio-hint studio-hint-sm">
              Active « Commenter » dans la toolbar puis clique un élément de la frame pour épingler
              une annotation.
            </p>
          ) : (
            <ul className="studio-pins-list">
              {pins.map((p, i) => (
                <li key={p.id} className="studio-pin-item">
                  <div className="studio-pin-head">
                    <span className="studio-pin-num">{i + 1}</span>
                    <code className="studio-pin-sel" title={p.selector}>
                      {p.selector}
                    </code>
                    <button
                      type="button"
                      className="studio-sel-clear"
                      title="Supprimer ce commentaire"
                      onClick={() => onPinDelete(selected.id, p.id)}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                  <textarea
                    className="studio-brief studio-brief-sm"
                    value={p.comment}
                    onChange={(e) => onPinComment(selected.id, p.id, e.target.value)}
                    placeholder="ex. « augmente l’espacement », « titre en gras »…"
                    rows={2}
                  />
                </li>
              ))}
            </ul>
          )}
          {actionable.length > 0 && (
            <button
              type="button"
              className="lgb lgb-primary lgb-sm"
              disabled={busy}
              onClick={() => onApplyPins(selected.id, selected.name)}
              title="Envoie tous les commentaires annotés à l’agent en un seul tour"
            >
              <Icon name="send" size={12} /> Résoudre {actionable.length} commentaire
              {actionable.length > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lot A — contextual sliders + colour fields for the element picked in a frame. */
function ElementStyleSection({
  el,
  styles,
  overrides,
  onChange,
  onReset,
  onBake,
  busy,
}: {
  el: SelectedElement;
  styles: ElStyle[];
  overrides: Record<string, string>;
  onChange: (prop: string, value: string) => void;
  onReset: () => void;
  onBake: () => void;
  busy: boolean;
}) {
  const sliders = buildElSliders(styles);
  const colors = styles.filter((s) => isColorStyle(s.prop));
  const dirty = Object.keys(overrides).length > 0;

  return (
    <div className="studio-elstyles">
      <div className="studio-inspector-hd" style={{ marginTop: 12 }}>
        <Icon name="pencil" size={13} />
        <span>Élément ciblé</span>
      </div>
      <p className="studio-hint studio-hint-sm">
        <code>{el.selector}</code>
        {el.text ? ` — « ${el.text.slice(0, 50)} »` : ""}
      </p>

      {sliders.length === 0 && colors.length === 0 && (
        <p className="studio-hint studio-hint-sm">
          Styles en lecture… re-clique l’élément si le panneau reste vide.
        </p>
      )}

      {colors.map((s) => {
        const cur = overrides[s.prop] ?? s.value;
        return (
          <div className="studio-tweak-crow" key={s.prop}>
            <span className="studio-tweak-cname" title={s.prop}>
              {s.prop === "color" ? "texte" : "fond"}
            </span>
            <span className="studio-tweak-swatch" style={{ background: cur }} />
            <input
              className="twk-field studio-tweak-cinput"
              value={cur}
              spellCheck={false}
              onChange={(e) => onChange(s.prop, e.target.value)}
            />
          </div>
        );
      })}

      {sliders.map((s) => {
        const cur = overrides[s.prop];
        const curN = cur ? parseFloat(cur) || 0 : s.value;
        return (
          <div className="studio-elslider" key={s.prop}>
            <span className="studio-tweak-cname" title={s.prop}>
              {s.label}
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={curN}
              onChange={(e) => onChange(s.prop, `${e.target.value}${s.unit}`)}
              aria-label={s.label}
            />
            <span className="studio-elslider-val">
              {curN}
              {s.unit}
            </span>
          </div>
        );
      })}

      {dirty && (
        <div className="studio-tweaks-actions">
          <button type="button" className="lgb lgb-sm" onClick={onReset}>
            Réinitialiser
          </button>
          <button
            type="button"
            className="lgb lgb-primary lgb-sm"
            disabled={busy}
            onClick={onBake}
            title="Écrit les ajustements dans le source (patch direct, sinon tour agent)"
          >
            Appliquer au projet
          </button>
        </div>
      )}
    </div>
  );
}
