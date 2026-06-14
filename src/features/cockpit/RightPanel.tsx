// src/features/cockpit/RightPanel.tsx
// Le panneau de droite EST le système de TUILES (façon Claude Code) : la grille
// redimensionnable des tuiles ouvertes via le menu « Contexte » (cf.
// ContextTiles + tilesStore). Plus d'ancienne surface mono-onglet ni de "+"-menu :
// l'éditeur est désormais une tuile (« Éditeur »), comme tout le reste. Quand
// aucune tuile n'est ouverte, ContextTiles affiche son état vide (invite à
// ouvrir un panneau depuis « Contexte »).
import { useShell } from "@/routes/shell-context";
import { ContextTiles } from "@/features/context-cards/ContextTiles";
import { openTile } from "@/features/context-cards/tilesStore";

export function RightPanel({ convId }: { convId: string }) {
  const shell = useShell();
  return (
    <div
      className="cockpit-right"
      style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}
    >
      <ContextTiles
        convId={convId}
        // Ouvrir un fichier (depuis Fichiers / Sources / Révision) le montre dans
        // la tuile Éditeur — qu'on ouvre au besoin.
        onOpenFile={(p) => { void shell.openFile(p); openTile("editor"); }}
        editor={{ openFiles: shell.openFiles, activeFile: shell.activeFile, fileContents: shell.fileContents }}
      />
    </div>
  );
}
