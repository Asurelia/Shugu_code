// Shugu Forge — Lot 5 / Phase 7 #1 — déclencheur live du FIM autocomplete.
//
// ViewPlugin qui, sur frappe (docChanged non-AI), debounce ~350ms puis demande
// une complétion FIM EN STREAMING et l'affiche en ghost text au fil des tokens.
// Monté UNIQUEMENT quand la pref `tabAutocomplete` est ON (via fimCompartment) —
// quand OFF le compartment tient [] donc aucune requête. RequestSequencer ignore
// les réponses obsolètes ; une frappe annule le flux EN VOL via `chat_abort`
// (le backend s'arrête à la prochaine frontière de token, pas de tokens gâchés).

import { ViewPlugin, type ViewUpdate, type EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { aiEditStreamAnnotation } from "../ai-edit/unifiedDiffExtension";
import { fimWindow } from "./fimPrompt";
import { shouldRequestCompletion, RequestSequencer } from "./autocompleteState";
import { startFimCompletionStream } from "./runFimCompletion";
import { showGhost, clearGhost, currentGhost } from "./ghostText";
import { invoke } from "@/lib/tauri";
import { pushToast } from "@/components/toast";

/** Compartment singleton : porte le déclencheur si activé, [] sinon. */
export const fimCompartment = new Compartment();

const DEBOUNCE_MS = 350;

// Id unique monotone par requête (le backend le préfixe par `fim:`). Module-level
// pour rester unique même entre plusieurs éditeurs/instances de déclencheur.
let fimRequestCounter = 0;

// Un seul toast d'échec par session : sinon chaque frappe en spammerait un
// (l'endpoint /v1/completions reste 404 sur un gateway chat-only). Reset au
// reload de l'app.
let fimErrorToastShown = false;

class FimTrigger {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = new RequestSequencer();
  /** Id préfixé du flux en vol (ou null) — passé à `chat_abort` pour annuler. */
  private inflightAbortId: string | null = null;

  constructor(_view: EditorView) {}

  update(u: ViewUpdate): void {
    if (!u.docChanged) return;
    // Ignore les transactions pilotées par l'AI (stream inline / apply) — ce
    // n'est pas une frappe utilisateur.
    if (u.transactions.some((tr) => tr.annotation(aiEditStreamAnnotation))) return;
    // Une frappe invalide la suggestion affichée + toute requête en vol.
    if (currentGhost(u.view)) clearGhost(u.view);
    this.seq.cancel();
    this.abortInflight();
    if (this.timer) clearTimeout(this.timer);
    const view = u.view;
    this.timer = setTimeout(() => void this.fire(view), DEBOUNCE_MS);
  }

  /** Annule le flux FIM en vol côté backend (best-effort, jamais bloquant). */
  private abortInflight(): void {
    if (!this.inflightAbortId) return;
    const id = this.inflightAbortId;
    this.inflightAbortId = null;
    // `chat_abort` prend la clé du registry partagé (param `conversationId`).
    void invoke("chat_abort", { conversationId: id }).catch(() => {});
  }

  private async fire(view: EditorView): Promise<void> {
    const pos = view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const { prefix, suffix } = fimWindow(doc, pos);
    if (!shouldRequestCompletion(prefix, suffix)) return;

    const id = this.seq.next();
    const rawId = `r${(fimRequestCounter += 1)}`;

    // onText : affichage INCRÉMENTAL — uniquement si toujours la requête
    // courante ET le curseur n'a pas bougé (sinon la suggestion serait
    // ancrée au mauvais endroit).
    const stream = startFimCompletionStream(
      doc,
      pos,
      rawId,
      (text) => {
        if (!this.seq.isCurrent(id)) return;
        if (view.state.selection.main.head !== pos) return;
        if (text) showGhost(view, text, pos);
      },
      // Garde anti-fenêtre (revue H2) : si une frappe supplante AVANT que le
      // backend soit invoqué, on n'envoie pas la requête (pas de token gâché).
      () => this.seq.isCurrent(id),
    );
    this.inflightAbortId = stream.requestId;

    const res = await stream.done;
    // Ne nettoie l'id que s'il n'a pas déjà été remplacé par un flux plus récent.
    if (this.inflightAbortId === stream.requestId) this.inflightAbortId = null;

    if (!this.seq.isCurrent(id)) return; // supplantée par une frappe plus récente
    if (!res.ok) {
      // Échec (souvent : endpoint /v1/completions non supporté par le gateway,
      // ou modèle non FIM). Un seul toast par session pour ne pas spammer.
      if (!fimErrorToastShown) {
        fimErrorToastShown = true;
        pushToast(
          `Autocomplete FIM indisponible : ${res.error ?? "endpoint /v1/completions non supporté"}. Désactive-le dans Settings → Editor si ton modèle ne fait pas de FIM.`,
          "error",
          9000,
        );
      }
      return;
    }
    if (!res.text) return; // réponse vide → pas de suggestion (pas une erreur)
    if (view.state.selection.main.head !== pos) return; // curseur bougé → obsolète
    // Affichage final autoritatif (couvre un éventuel chunk manqué).
    showGhost(view, res.text, pos);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.seq.cancel();
    this.abortInflight();
  }
}

/** Le déclencheur FIM à placer dans le fimCompartment quand l'autocomplete est ON. */
export function buildFimTrigger() {
  return ViewPlugin.fromClass(FimTrigger);
}
