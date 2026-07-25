# Analyse UX concurrentielle — Claude desktop, OpenCode desktop, Cursor

Date : 24 juillet 2026. Source : dissection des installations locales (Claude
desktop 1.24012.9 MSIX, OpenCode desktop 1.17.9, Cursor 3.8.11 dev — l'UI
« agent-first » de Cursor 2.0 y est présente et étendue). Extraits d'analyse :
`dev-logs/competitor-ux/`. Aucun code ni asset repris ; seules des constantes
de design (px, ms, couleurs, easings) et des patterns sont réutilisés comme
référence. Alimente le lot P6.14 de `shugu-viability-roadmap.md`.

## 1. Motion — ce que les trois ont en commun

- **Rien de fonctionnel au-delà de ~300 ms.** Micro-interactions 85–100 ms,
  standard 150 ms, panneaux 200–220 ms, 300 ms max.
- **Easings de référence** : standard `cubic-bezier(0.4,0,0.2,1)` ; sorties
  douces `cubic-bezier(.165,.84,.44,1)` (easeOutQuart, Cursor ×7) ;
  `cubic-bezier(.22,1,.36,1)` (easeOutQuint, signature OpenCode) ; rebond doux
  `cubic-bezier(0.165,0.85,0.45,1)` (Claude, réservé aux ouvertures).
- **Signatures réutilisables** :
  - Barre de progression « whip » 2 px en haut du flux pendant le run agent
    (OpenCode : `clip-path` animé, `will-change`, fade-out .22 s).
  - **Shimmer de texte** (gradient `background-position` balayé) pour
    streaming/« l'agent réfléchit » (Cursor, OpenCode, Claude — 1.5–2.25 s).
  - **Stop-pulse** : le bouton d'interruption « respire » 1.8 s (OpenCode).
  - **Border-pulse one-shot 1.5 s** (`box-shadow 0 0 0 2px accent`, 1 itération)
    pour signaler un élément nouveau (hunk de diff, review) (Cursor).
  - Skeletons = barres fines (6 px) à largeurs variées (72 %/48 %), pas de blocs.
  - Dialogs : overlay fade + contenu `scale .98→1` ; toasts entrée
    `translateY(8–20px)` + fade 200/100 ms.

## 2. Tokens visuels convergents

- **Bordures hairline** : blanc 5–10 % d'alpha en dark (Cursor `#ffffff0d`,
  Claude `rgba(255,255,255,.2)` en 0.5 px) ; ombre « élément » tripartite
  `0 0 0 0.5px, 0 0 20px .05, 0 1px 5px .1` + ring 0.5 px (Claude, OpenCode).
- **Hiérarchie de texte par opacité** : primary/secondary/tertiary =
  blanc bleuté à **.85 / .62 / .42** (Cursor, valeurs directement transplantables).
- **Radii** : 2/4/6/8/12/16 px + pills 9999 px ; cohérence 8/12 pour cartes,
  16 pour surfaces flottantes.
- **Densité** : texte UI 12–14 px, hauteurs d'inputs 28/32 px, dialogs
  ~480×368 px radius 6–16 px ; `tabular-nums` pour tout compteur (tokens, %).
- **Pills de mode** : 9999 px, 12 px/16 lh, padding 2×8 px, fond blanc 6 %→10 %
  au hover, transition 100 ms (Cursor — mode switcher agent/chat/plan).
- **Élévations** : bouton `0 1px 1.5px a.1 + ring .5px` ; flottant
  `0 8px 16px + 0 4px 8px + ring` ; overlay `0 16px 32px + ring`.
- Thème appliqué **avant le premier paint** (classe sur `<body>` + script de
  preload inline + `background-color` sur `<html>`) → zéro flash ; chrome natif
  synchronisé (titlebar overlay / `setBackgroundColor`).

## 3. Navigation & shell

- **Hiérarchie projets → sessions → messages**, sessions groupées
  **Today / Yesterday / Older** avec recherche (OpenCode home V2).
- **Onglets de sessions dans la titlebar** (`mod+t/w`, `mod+alt+←/→`, fades de
  débordement) (OpenCode) ; onglets typés chez Cursor (fichier, diff, PR,
  canvas, browser).
- **Sidebar → rail replié** : cartes empilées avec « peek » de l'élément actif
  (Cursor) ; tuile inactive atténuée par `filter: brightness(.965) saturate(.9)`.
- **Sessions non lues** : badge + navigation `shift+alt+↑/↓` (OpenCode).
- **Palette de commandes unifiée** fichiers + commandes + sessions
  (`mod+shift+p`), registre déclaratif unique alimentant palette + menus +
  keybinds, raccourcis affichés en chip mono, détection de conflits (OpenCode) ;
  dialog flottant radius 16 + blur 16 px (Cursor).
- **Quick entry global** (Claude : `Ctrl+Alt+Space`, fenêtre 556×420 frameless,
  alwaysOnTop, close-on-blur, resize natif piloté par le contenu en debounce
  750 ms) — différenciateur, à évaluer à part.
- Menu « Open in… » (VS Code, Cursor, Zed, terminal…) (OpenCode ; Codex a 28
  cibles).
- **Confiance par projet avant chargement de configuration active** : l'état
  trusted/read-only doit être visible et réversible ; tant que le projet n'est
  pas approuvé, ses hooks/plugins/règles ne s'exécutent pas. C'est la couche de
  sûreté qui rend les automatisations projet acceptables sans multiplier les
  confirmations outil par outil.

## 4. UX du transcript agent

- **Cartes d'appel d'outil** : fond éditeur, bordure 1 px, radius 12 px,
  `contain: paint`, padding 10×8, états loading/pending/running + preview
  repliée + expansion (Cursor) ; réglages « expand edit/shell par défaut »
  (OpenCode — rejoint P6.6).
- **Divider « checkpoint »** entre messages : 12 px, icône + « Restore » en
  opacity .7→1 au hover (Cursor) — à relier au rewind P6.3.
- Markdown long replié avec fondu 120 px + toggle (Cursor).
- Breadcrumb de sous-agents (Cursor) ; « Back to main session » (OpenCode).
- **Barre de statut contextuelle sous le composer** (12 px, tertiary,
  tabular-nums) + jauge de quota/usage masquée tant qu'on n'est pas en bas
  (Cursor) — rejoint la jauge de contexte P6.2.
- Composer : bulle radius 12 + blur 10 px, bordure qui se renforce au
  `:focus-within`, ring de drag `0 0 0 2px` accent à 20 % ; mode shell dédié ;
  prompts d'exemple rotatifs en empty state (OpenCode, 25) ; pills de
  quickstart + tip rotatif bas-centré (Cursor).
- Cycle de session : share, **fork from message**, compact, undo/redo de
  messages, archive (OpenCode — fork et compact couverts par P6.3/compaction).
- Permissions : prompt docké avec **Allow once / Allow always**, permissions
  granulaires par outil, notification + son à l'arrivée d'une demande
  (OpenCode — rejoint P6.5/P6.10).

## 5. Performance perçue

- **Transcript virtualisé** (Cursor, maison ; OpenCode, virtualizer ×58) —
  indispensable pour les longues sessions streamées.
- `contain: paint` sur les cartes d'outils ; code-splitting agressif +
  `modulepreload` ; assets lourds (thèmes, grammaires, sons) en lazy.
- Persistance des bounds de fenêtre ; thème préchargé (anti-flash) ;
  `overscroll-none` sur le body ; mesure continue des janks chez Cursor.

## 6. Périmètre proposé pour le lot P6.14 (dans le style Celestial Veil)

1. **Confiance projet (tranche prioritaire)** : dialog au premier accès avec
   « Ouvrir en lecture seule » / « Faire confiance », badge persistant et action
   de révocation ; aucune règle, hook, skill ou contribution de plugin projet
   active avant confiance. Le choix est local et lié au chemin canonique.
2. **Système de motion Celestial Veil** : variables `--cv-dur-{100,150,220,300}`
   + `--cv-ease-standard` / `--cv-ease-out-quart` / `--cv-ease-spring` ;
   application aux hovers, panels, dialogs, toasts ; whip bar 2 px pendant un
   run ; shimmer de streaming ; stop-pulse ; border-pulse one-shot sur nouveau
   hunk ; skeletons en barres fines.
3. **Tokens de surface** : bordures hairline blanc 5–10 %, ring 0.5 px + ombre
   tripartite sur les verres, hiérarchie texte .85/.62/.42, tabular-nums sur
   compteurs/jauges, pills 9999 px pour le sélecteur de profil du composer.
4. **Sidebar conversations** : groupes Today/Yesterday/Older, recherche,
   badge non-lu + navigation clavier, hover-timestamps.
5. **Palette unifiée Ctrl+K** : fichiers + commandes + sessions, registre
   déclaratif (converger avec `docs/command-registry-mapping.md`), dialog
   radius 16 + blur, chips de raccourcis.
6. **Transcript agent** : cartes d'outils aux états normalisés, divider
   checkpoint relié au rewind, fondu markdown long, breadcrumbs sous-agents,
   empty state avec exemples rotatifs + quickstart pills.
7. **Fluidité** : virtualisation du flux de messages, `contain: paint`, script
   de preload de thème anti-flash + sync `backgroundColor` Tauri au boot.
8. **Différé** (à évaluer séparément) : quick entry global `Ctrl+Alt+Space`,
   onglets typés dans la titlebar, menu « Open in… », tiling multi-agents.

Gate de sortie P6.14 : chaque point livré avec ses tokens dans
`src/styles/` (Celestial Veil respecté, pas de réécriture du prototype),
`pnpm ui:tour` vert, budgets de perf P5.2 non régressés (mesurés), audit
contraste P5.1 repassé sur les surfaces modifiées.
