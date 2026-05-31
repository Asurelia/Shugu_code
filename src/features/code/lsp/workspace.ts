// Shugu Forge — Workspace LSP custom (Lot B §2).
//
// Le Workspace par défaut de @codemirror/lsp-client (DefaultWorkspace, NON
// exporté par le package) a displayFile()→null : « Aller à la définition » vers
// un AUTRE fichier ne fait rien. ShuguWorkspace réplique le suivi de fichiers de
// DefaultWorkspace — les méthodes de la classe de base Workspace sont ABSTRAITES
// (vérifié dans le .d.ts), donc PAS de super.openFile/closeFile/syncFiles
// possible (erreur TS2513) — et branche displayFile sur lspBridge.openFile.
//
// Contrainte : architecture mono-éditeur (un seul EditorView vivant = le fichier
// actif). displayFile ouvre le fichier (→ devient actif) puis attend que son
// EditorView AIT le plugin LSP attaché (le plugin s'attache dans un useEffect
// async APRÈS le mount ; attendre juste que la view existe donnerait au
// lsp-client une view sans plugin → le jump ne ferait rien).
import {
  Workspace,
  LSPPlugin,
  type LSPClient,
  type WorkspaceFile,
} from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import type { Text, ChangeSet } from "@codemirror/state";

// @codemirror/lsp-client définit l'interface WorkspaceFileUpdate dans son .d.ts
// mais NE L'EXPORTE PAS. On réplique sa forme structurelle (vérifiée dans le
// .d.ts : { file, prevDoc, changes }) pour typer le retour de syncFiles().
interface WorkspaceFileUpdate {
  file: WorkspaceFile;
  prevDoc: Text;
  changes: ChangeSet;
}
import { getLspBridge } from "./lspBridge";
import { relativePathFromUri } from "./uri";
import { diag } from "@/lib/diag";

/** Réplique DefaultWorkspaceFile (dist/index.js) : un fichier ouvert. */
class ShuguWorkspaceFile implements WorkspaceFile {
  constructor(
    public uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    public view: EditorView,
  ) {}
  getView(): EditorView { return this.view; }
}

export class ShuguWorkspace extends Workspace {
  files: ShuguWorkspaceFile[] = [];
  private fileVersions: Record<string, number> = Object.create(null);
  private readonly workspaceUri: string;

  constructor(client: LSPClient, workspaceUri: string) {
    super(client);
    this.workspaceUri = workspaceUri;
  }

  private nextFileVersion(uri: string): number {
    const v = (this.fileVersions[uri] ?? -1) + 1;
    this.fileVersions[uri] = v;
    return v;
  }

  // ── Répliques de DefaultWorkspace (méthodes abstraites de la base) ────────
  syncFiles(): readonly WorkspaceFileUpdate[] {
    const result: WorkspaceFileUpdate[] = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        result.push({ changes, file, prevDoc: file.doc });
        file.doc = file.view.state.doc;
        file.version = this.nextFileVersion(file.uri);
        plugin.clear();
      }
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    // Mono-éditeur : un fichier = au plus une view. Si déjà suivi, on remplace
    // (re-mount sur changement de fichier même-langage). On envoie d'ABORD un
    // didClose : le protocole LSP interdit deux didOpen consécutifs pour la même
    // URI (tsserver rejette le 2e et casse la synchro du document). Symétrie
    // didClose→didOpen garantie.
    if (this.getFile(uri)) {
      this.files = this.files.filter((f) => f.uri !== uri);
      this.client.didClose(uri);
    }
    const file = new ShuguWorkspaceFile(
      uri,
      languageId,
      this.nextFileVersion(uri),
      view.state.doc,
      view,
    );
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string): void {
    const file = this.getFile(uri);
    if (file) {
      this.files = this.files.filter((f) => f !== file);
      this.client.didClose(uri);
    }
  }

  // ── Le seul vrai ajout : navigation cross-fichier ─────────────────────────
  /** Ouvre le fichier cible et retourne son EditorView une fois le PLUGIN LSP
   *  attaché (pas seulement la view : le plugin s'attache async après le mount,
   *  et le lsp-client a besoin du plugin pour piloter le jump). */
  async displayFile(uri: string): Promise<EditorView | null> {
    const bridge = getLspBridge();
    if (!bridge) {
      diag("lsp", "displayFile: no bridge (RootLayout pas monté ?)");
      return null;
    }
    const relPath = relativePathFromUri(this.workspaceUri, uri);
    if (!relPath) {
      diag("lsp", `displayFile: uri hors workspace: ${uri}`);
      return null;
    }
    await bridge.openFile(relPath);
    // Poll borné : view existe ET LSPPlugin.get(view) truthy. ~2.4 s max.
    for (let i = 0; i < 60; i++) {
      const v = bridge.getViewForPath(relPath);
      if (v && LSPPlugin.get(v)) return v;
      await new Promise((r) => setTimeout(r, 40));
    }
    diag("lsp", `displayFile: view+plugin jamais prêts pour ${relPath}`);
    return null;
  }
}
