// Shugu Forge — Lot 5 (activation) — déclencheur live du FIM autocomplete.
//
// ViewPlugin qui, sur frappe (docChanged non-AI), debounce ~350ms puis demande
// une complétion FIM et l'affiche en ghost text. Monté UNIQUEMENT quand la pref
// `tabAutocomplete` est ON (via fimCompartment) — quand OFF le compartment tient
// [] donc aucune requête. RequestSequencer annule les requêtes obsolètes ; une
// réponse tardive ou un curseur qui a bougé est ignorée.
//
// ⚠ Qualité/latence = réglage runtime (modèle FIM openai-compatible requis).

import { ViewPlugin, type ViewUpdate, type EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { aiEditStreamAnnotation } from "../ai-edit/unifiedDiffExtension";
import { fimWindow } from "./fimPrompt";
import { shouldRequestCompletion, RequestSequencer } from "./autocompleteState";
import { runFimCompletion } from "./runFimCompletion";
import { showGhost, clearGhost, currentGhost } from "./ghostText";
import { pushToast } from "@/components/toast";

/** Compartment singleton : porte le déclencheur si activé, [] sinon. */
export const fimCompartment = new Compartment();

const DEBOUNCE_MS = 350;

// Un seul toast d'échec par session : sinon chaque frappe en spammerait un
// (l'endpoint /v1/completions reste 404 sur un gateway chat-only). Reset au
// reload de l'app.
let fimErrorToastShown = false;

class FimTrigger {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = new RequestSequencer();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_view: EditorView) {}

  update(u: ViewUpdate): void {
    if (!u.docChanged) return;
    // Ignore les transactions pilotées par l'AI (stream inline / apply) — ce
    // n'est pas une frappe utilisateur.
    if (u.transactions.some((tr) => tr.annotation(aiEditStreamAnnotation))) return;
    // Une frappe invalide la suggestion affichée + toute requête en vol.
    if (currentGhost(u.view)) clearGhost(u.view);
    this.seq.cancel();
    if (this.timer) clearTimeout(this.timer);
    const view = u.view;
    this.timer = setTimeout(() => void this.fire(view), DEBOUNCE_MS);
  }

  private async fire(view: EditorView): Promise<void> {
    const pos = view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const { prefix, suffix } = fimWindow(doc, pos);
    if (!shouldRequestCompletion(prefix, suffix)) return;
    const id = this.seq.next();
    const res = await runFimCompletion(doc, pos);
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
    showGhost(view, res.text, pos);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.seq.cancel();
  }
}

/** Le déclencheur FIM à placer dans le fimCompartment quand l'autocomplete est ON. */
export function buildFimTrigger() {
  return ViewPlugin.fromClass(FimTrigger);
}
