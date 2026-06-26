// Hook partagé entre ChatView (main IDE) et ChatPanel (mascotte).
//
// Pourquoi ce hook existe :
//   ChatView et ChatPanel affichent EXACTEMENT les mêmes infos (messages
//   user/AI, badge via_orchestrator, reasoning, streaming live de l'agent).
//   Seul le STYLE diverge — main IDE = full panel avec avatars / chips,
//   mascotte = bulle compacte. Avant ce hook, la logique data était
//   dupliquée dans chaque composant → quand on ajoutait quelque chose
//   (par exemple le live streaming agent), il fallait le coller à 2
//   endroits et risquer la désync.
//
//   Maintenant : un seul hook qui prend `m: Message`, branche
//   `useAgentTranscript` quand c'est un message agent, et retourne
//   tout ce dont les deux UIs ont besoin pour rendre — `displayBody`
//   (live OU final selon état), `liveReasoning`, le flag `isStreamingAgent`,
//   et — depuis le lot « activité live » — le journal d'activité de l'agent
//   (`activity`) + son statut/role/timing, pour que le fil de chat montre
//   CE QUE l'orchestrateur fait (lit/écrit/exécute), pas juste un placeholder
//   figé « Orchestrateur au travail… ». Les events (toolCall/toolResult) sont
//   déjà captés et tenus à jour en live par `useAgentEvents` (agent://lifecycle,
//   monté dans les deux fenêtres) — ce hook ne fait que les exposer.
//
// Les styles inline restent dans chaque composant (mascotte compact vs
// main IDE full) — c'est légitime car les contraintes spatiales diffèrent.

import { useAgentTranscript } from "@/features/agents/queries";
import type { AgentEvent, AgentStatus } from "@/lib/agents";
import type { ChatWriteRecord } from "./chatWritesStore";
import type { Message } from "@/lib/types";
import { parseRiskFlag, type RiskFlag } from "@/lib/commandRules";

/** Une ligne du journal d'activité de l'agent — un appel d'outil + son issue. */
export interface AgentActivityItem {
  /** toolCallId — stable, sert de clé React. */
  key: string;
  /** Pictogramme du type d'action (📖 lit, ✍ écrit, ⚙ exécute…). */
  icon: string;
  /** Verbe court de l'action. */
  label: string;
  /** Cible : chemin, commande, requête — tronquée pour l'affichage. */
  detail: string;
  /** running = pas encore de résultat ; ok = réussi ; error = échec/exit≠0. */
  status: "running" | "ok" | "error";
  /** Sortie de l'outil (stdout d'une commande, contenu lu…), tronquée. Présent
   *  seulement quand le toolResult est arrivé. Permet de déplier « pourquoi ✗ ». */
  result?: string;
  /** Miniature (data URL) d'un screenshot pris par l'outil capture_screen —
   *  la preuve visuelle s'affiche dépliable dans la timeline. */
  imageUrl?: string;
  /** Nom d'outil brut (ev.tool) — permet à la timeline de rendre un viewer
   *  dédié (ex. `browser_test`) plutôt que la sortie générique. */
  tool?: string;
  /** Flag de risque parsé du préfixe « [RISK: …] » d'une commande (sinon
   *  undefined). Pilote la carte de risque + le bouton « Toujours autoriser ». */
  risk?: RiskFlag;
  /** Commande brute (arg `command`) d'un appel exec — sert à dériver le motif
   *  de règle proposé. Présent seulement pour les outils d'exécution. */
  command?: string;
}

/** Une étape du plan de l'orchestrateur (tool `todo_write`). */
export interface AgentPlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface MessageDisplay {
  /** Le body à afficher — soit le streaming live de l'agent, soit m.body. */
  displayBody: string;
  /** Le reasoning streamé live pendant le run agent (vide si pas applicable). */
  liveReasoning: string;
  /** True si on est en train de stream le contenu d'un agent encore actif. */
  isStreamingAgent: boolean;
  /** True quand ce message est produit par un agent (placeholder ou relais
   *  verbatim) — i.e. viaAgent + agentId présents. */
  isAgentRun: boolean;
  /** Rôle de l'agent ("orchestrator", "researcher"…) si connu. */
  agentRole?: string;
  /** Statut courant de l'agent (running / complete / error…) si connu. */
  agentStatus?: AgentStatus;
  /** Début du run (epoch ms) — pour le chrono. */
  startedAt?: number;
  /** Fin du run (epoch ms) ou null si encore en cours. */
  finishedAt?: number | null;
  /** Journal d'activité ordonné (appels d'outils + issue). Vide hors run agent. */
  activity: AgentActivityItem[];
  /** Plan vivant de l'orchestrateur (dernier `todo_write`), undefined s'il n'en
   *  a pas posé. La checklist se met à jour à chaque nouvel appel todo_write. */
  plan?: AgentPlanStep[];
  /** Fichiers écrits par l'agent (events `write`), dédupliqués par chemin avec le
   *  PREMIER `before` (= état d'avant le run, pour un undo cohérent). Alimente la
   *  carte « ✏️ N fichiers modifiés » (ChatWritesCard) + Annuler. */
  writeRecords: ChatWriteRecord[];
  /** Populated when the message is an image attachment (m.image === true and
   *  body starts with "data:"). Renderers should show an <img> tag instead of
   *  interpreting displayBody as text. */
  imageDataUrl?: string;
}

// ── Mappage outil → libellé humain ────────────────────────────────────────
// On traduit le nom d'outil brut (fs_read_file, run_command…) en (icône, verbe,
// cible) lisibles. Couvre les outils réellement émis par le runner Rust ; un
// outil inconnu retombe sur un rendu générique honnête (pas d'invention).
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return "";
}

/** Tronque une cible longue en gardant la fin (le plus signifiant d'un path/cmd). */
function clip(s: string, max = 72): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return "…" + oneLine.slice(oneLine.length - (max - 1));
}

function describeToolCall(tool: string, args: unknown): { icon: string; label: string; detail: string } {
  const a = asRecord(args);
  const t = tool.toLowerCase();

  // En tête : `browser_test` est spécifique (lance un navigateur headless et
  // VÉRIFIE l'app web). Match EXACT — un `includes("browser")` avalerait
  // silencieusement de futurs outils (open_browser, browser_cookies…).
  if (t === "browser_test") {
    return { icon: "🌐", label: "teste", detail: clip(firstString(a, ["url", "query"]) || "le navigateur") };
  }
  if (t.includes("read") || t === "cat") {
    return { icon: "📖", label: "lit", detail: clip(firstString(a, ["path", "file_path", "filename", "file"])) };
  }
  if (t.includes("write") || t.includes("edit") || t.includes("str_replace") || t.includes("apply")) {
    return { icon: "✍️", label: "écrit", detail: clip(firstString(a, ["path", "file_path", "filename", "file"])) };
  }
  if (t.includes("list") || t.includes("ls") || t.includes("glob") || t.includes("tree")) {
    return { icon: "📁", label: "liste", detail: clip(firstString(a, ["path", "dir", "directory", "pattern", "glob"]) || ".") };
  }
  if (t.includes("search") || t.includes("grep") || t.includes("find")) {
    return { icon: "🔎", label: "cherche", detail: clip(firstString(a, ["query", "pattern", "q", "needle", "text"])) };
  }
  if (t.includes("screenshot") || t.includes("capture")) {
    return { icon: "📸", label: "capture", detail: "l'écran" };
  }
  if (t.includes("run") || t.includes("command") || t.includes("exec") || t.includes("shell") || t.includes("bash")) {
    return { icon: "⚙️", label: "exécute", detail: clip(firstString(a, ["command", "cmd", "script", "args"])) };
  }
  if (t.includes("web") || t.includes("fetch") || t.includes("http") || t.includes("url")) {
    return { icon: "🌐", label: "ouvre", detail: clip(firstString(a, ["url", "query", "q"])) };
  }
  // Inconnu — on montre le nom d'outil brut + une cible plausible, sans inventer.
  return { icon: "🔧", label: tool, detail: clip(firstString(a, ["path", "file_path", "command", "query", "input"])) };
}

/** Sortie d'un toolResult en texte (stdout, contenu lu, message d'erreur).
 *  result est `unknown` — string directe, sinon error, sinon JSON. Aligné sur
 *  AgentsPanel. Tronqué pour ne pas gonfler le DOM (les gros reads/outputs). */
const RESULT_CAP = 2000;
function extractResultString(ev: Extract<AgentEvent, { kind: "toolResult" }>): string {
  let s: string;
  if (typeof ev.result === "string") s = ev.result;
  else if (typeof ev.error === "string" && ev.error.trim() !== "") s = ev.error;
  else {
    try { s = JSON.stringify(ev.result ?? ""); } catch { s = String(ev.result ?? ""); }
  }
  return s.length > RESULT_CAP ? s.slice(0, RESULT_CAP) + "\n…(tronqué)" : s;
}

/** Un toolResult run_command préfixe son stdout par "[exit N]" / "[TIMED OUT …]"
 *  (tools.rs). On considère exit≠0 et timeout comme des échecs. */
function resultIsError(ev: Extract<AgentEvent, { kind: "toolResult" }>): boolean {
  if (typeof ev.error === "string" && ev.error.trim() !== "") return true;
  // result is `unknown` — le runner peut renvoyer une string OU du JSON structuré.
  // On stringify le cas non-string (comme supervisors.ts) pour ne pas classer en
  // succès un résultat d'erreur encodé dans un objet.
  const resStr = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? "");
  if (resStr.includes("[TIMED OUT")) return true;
  // `browser_test` signale un échec d'assertion en DONNÉES (is_error est réservé
  // aux pannes d'INFRA côté backend), donc sans ce test la timeline afficherait
  // un faux ✓ sur un test FAILED. On lit le verdict du summary.
  if (/^browser_test:\s*FAILED/m.test(resStr)) return true;
  const m = resStr.match(/\[exit\s+(-?\d+)\]/);
  return m ? m[1] !== "0" : false;
}

/** Parse les `todos` d'un appel `todo_write` en étapes de plan typées. */
export function parsePlan(args: unknown): AgentPlanStep[] | undefined {
  const todos = asRecord(args)["todos"];
  if (!Array.isArray(todos)) return undefined;
  const steps: AgentPlanStep[] = [];
  for (const t of todos) {
    const r = asRecord(t);
    const text = typeof r["text"] === "string" ? r["text"].trim() : "";
    const raw = typeof r["status"] === "string" ? r["status"] : "pending";
    const status = raw === "in_progress" || raw === "completed" ? raw : "pending";
    if (text) steps.push({ text, status });
  }
  return steps.length ? steps : undefined;
}

/**
 * Hook pour préparer un Message à l'affichage. Détecte les messages produits
 * par un agent (viaAgent + agentId) et y branche le live depuis le transcript
 * cache (updaté en temps réel par `useAgentEvents`).
 *
 * Pour les messages user / AI normaux : ne fetch rien, retourne juste
 * `m.body` (ou `m.text` pour user) + un journal d'activité vide. Aucun overhead.
 */
export function useMessageDisplay(m: Message): MessageDisplay {
  const isAgentRun =
    m.role === "ai" && m.viaAgent === true && typeof m.agentId === "string";
  const agentIdForLive = isAgentRun ? (m.agentId as string) : null;
  const { data: transcript } = useAgentTranscript(agentIdForLive);

  let liveContent = "";
  let liveReasoning = "";
  const activity: AgentActivityItem[] = [];
  let plan: AgentPlanStep[] | undefined;
  const writeRecords: ChatWriteRecord[] = [];
  const seenWritePaths = new Set<string>();

  if (isAgentRun && transcript) {
    // 1er passage : indexer issue (ok/error) + sortie texte de chaque appel,
    // et la miniature des screenshots (event `screenshot`, par toolCallId).
    const errorByCall = new Map<string, boolean>();
    const resultByCall = new Map<string, string>();
    const imageByCall = new Map<string, string>();
    for (const ev of transcript.events) {
      if (ev.kind === "toolResult") {
        errorByCall.set(ev.toolCallId, resultIsError(ev));
        resultByCall.set(ev.toolCallId, extractResultString(ev));
      } else if (ev.kind === "screenshot") {
        imageByCall.set(ev.toolCallId, ev.thumbDataUrl);
      }
    }
    // 2e passage (ordre chronologique) : deltas live + journal d'outils + plan.
    for (const ev of transcript.events) {
      if (ev.kind === "delta" && ev.deltaKind === "content") liveContent += ev.chunk;
      else if (ev.kind === "delta" && ev.deltaKind === "reasoning") liveReasoning += ev.chunk;
      else if (ev.kind === "toolCall") {
        // `todo_write` n'est PAS une action de la timeline : c'est le plan.
        // Le dernier appel gagne (il remplace la liste — cf. description du tool).
        if (ev.tool === "todo_write") {
          plan = parsePlan(ev.args) ?? plan;
          continue;
        }
        const d = describeToolCall(ev.tool, ev.args);
        const seen = errorByCall.has(ev.toolCallId);
        // Risque + commande brute uniquement pour les outils d'exécution (seul
        // run_command préfixe sa sortie par « [RISK: …] » et porte un `command`).
        const isExec = /run|command|exec|shell|bash/.test(ev.tool.toLowerCase());
        // resultByCall = sortie déjà tronquée à RESULT_CAP. Sûr ici : le préfixe
        // « [RISK: …] » est TOUJOURS la 1re ligne, très en-deçà du cap, donc la
        // troncature ne l'altère jamais (≠ resultIsError qui lit ev.result brut).
        const resultStr = resultByCall.get(ev.toolCallId);
        const risk = isExec ? parseRiskFlag(resultStr) : undefined;
        const command = isExec
          ? firstString(asRecord(ev.args), ["command", "cmd", "script"])
          : undefined;
        activity.push({
          key: ev.toolCallId,
          icon: d.icon,
          label: d.label,
          detail: d.detail,
          status: !seen ? "running" : errorByCall.get(ev.toolCallId) ? "error" : "ok",
          // Quand le risque est extrait, on retire la ligne « [RISK: …] » de la
          // sortie affichée (elle est rendue par la carte de risque).
          result: risk && resultStr ? resultStr.replace(/^\[RISK:[^\n]*\n?/, "") : resultStr,
          imageUrl: imageByCall.get(ev.toolCallId),
          tool: ev.tool,
          risk,
          command,
        });
      } else if (ev.kind === "write") {
        // 1er write d'un path gagne : son `before` = état d'avant le run, donc
        // l'undo restaure le pré-run même après plusieurs éditions (idempotent
        // par path, comme record_before côté chat).
        if (!seenWritePaths.has(ev.path)) {
          seenWritePaths.add(ev.path);
          writeRecords.push({ path: ev.path, before: ev.before ?? null });
        }
      }
    }
  }

  const stillPlaceholder = isAgentRun && m.body === "Orchestrateur au travail…";
  const isStreamingAgent = stillPlaceholder && (liveContent.length > 0 || liveReasoning.length > 0);

  const displayBody =
    stillPlaceholder && liveContent.length > 0
      ? liveContent
      : (m.text ?? m.body ?? "");

  // Detect image messages — body is a data URL when image=true.
  const imageDataUrl =
    m.image === true && typeof m.body === "string" && m.body.startsWith("data:")
      ? m.body
      : undefined;

  return {
    displayBody,
    liveReasoning,
    isStreamingAgent,
    isAgentRun,
    agentRole: transcript?.agent.role,
    agentStatus: transcript?.agent.status,
    startedAt: transcript?.agent.createdAt,
    finishedAt: transcript?.agent.finishedAt,
    activity,
    plan,
    writeRecords,
    imageDataUrl,
  };
}

/** L'action en cours d'un agent (dernier appel d'outil hors `todo_write`),
 *  pour l'onglet "Agents" du panneau Contexte — montre CE QUE l'agent fait. */
export interface AgentCurrentActivity {
  icon: string;
  label: string;
  detail: string;
  /** true tant qu'aucun `toolResult` n'est revenu pour cet appel. */
  running: boolean;
}

/**
 * Dérive la dernière action d'un agent depuis son transcript live (mis à jour
 * par `useAgentEvents`). `todo_write` est ignoré (c'est le plan, pas une
 * action). Retourne null si l'agent n'a encore rien fait d'observable.
 */
export function useAgentCurrentActivity(agentId: string | null): AgentCurrentActivity | null {
  const { data: transcript } = useAgentTranscript(agentId);
  if (!transcript) return null;

  const resultSeen = new Set<string>();
  let last: { icon: string; label: string; detail: string; toolCallId: string } | null = null;
  for (const ev of transcript.events) {
    if (ev.kind === "toolResult") {
      resultSeen.add(ev.toolCallId);
    } else if (ev.kind === "toolCall" && ev.tool !== "todo_write") {
      const d = describeToolCall(ev.tool, ev.args);
      last = { ...d, toolCallId: ev.toolCallId };
    }
  }
  if (!last) return null;
  return {
    icon: last.icon,
    label: last.label,
    detail: last.detail,
    running: !resultSeen.has(last.toolCallId),
  };
}
