# Audit UI/UX - Shugu Forge

Date: 2026-06-21
Contexte: comparaison produit avec Claude Desktop, Codex app et OpenCode Desktop.

## Verdict court

Shugu a une identite visuelle forte et une densite fonctionnelle ambitieuse.
Mais l'UX actuelle donne encore trop l'impression d'un atelier experimental:
beaucoup de surfaces, beaucoup de boutons, beaucoup de texte explicatif, et pas
assez de signaux de confiance au moment ou l'agent peut agir sur le disque.

Pour une app agentique, l'UX n'est pas seulement "beau ou pas beau". L'UX est
le modele de securite visible. L'utilisateur doit comprendre en 1 seconde:

- qui va agir;
- ou il va agir;
- avec quelles permissions;
- si le reseau est autorise;
- si les modifications sont isolees;
- comment annuler;
- ce qui vient de Claude/Codex/OpenCode/MCP/Shugu.

Aujourd'hui, Shugu montre beaucoup de capacites, mais ne hierarchise pas assez
le risque.

## Ce qui marche deja

### Identite forte

La direction "Celestial Veil + Liquid Glass" donne une vraie presence a Shugu.
L'app n'a pas l'air d'un clone de VS Code ou de Claude. C'est bien.

### Shell riche

Le rail, la titlebar, le panneau lateral, la command palette, le dock, les
surfaces Cockpit et les panels donnent une base de "desktop workbench".

### Bonnes idees produit

- Chat + contexte editeur automatique.
- ModeSelector Chat / Plan / Agent.
- Cartes de contexte.
- Cockpit avec chat, panneau droit et terminal.
- Connexions centralisees.
- MCP avec empty state pedagogique.
- AgentsPanel avec transcript minimal.
- Git comme surface de review.

### Local-first visible

Les chips `workspace`, `branch`, `local` dans le chat vont dans le bon sens:
l'utilisateur voit le contexte d'execution.

## Probleme central UX

Le projet melange trois experiences qui devraient etre plus separees:

1. assistant conversationnel;
2. IDE local;
3. agent autonome qui modifie le disque.

Ces trois experiences sont dans le meme shell, avec le meme niveau visuel, donc
l'utilisateur ne sent pas assez quand il passe de "je discute" a "je donne les
cles de mon projet".

Dans Codex, l'UX met en avant threads, worktrees, reviews et sandbox. Dans
Claude Desktop, l'UX met en avant connecteurs/extensions et permissions. Dans
OpenCode, l'UX distingue Plan/Build/agents/config. Shugu doit rendre ces
frontieres aussi evidentes.

## Ecarts par rapport aux references

### Codex app

Codex est sobre et centre sur:

- projet;
- thread;
- worktree;
- permissions;
- diff/review;
- terminal/resultats.

Shugu a plus de surfaces creatives, mais moins de clarte sur le cycle:

demande -> plan -> execution isolee -> diff -> validation -> merge/nettoyage.

UX a copier:

- badge de permission permanent;
- worktree visible par thread;
- bouton review/apply;
- terminal/logs rattaches au thread;
- etat "ce thread est local" vs "ce thread est en worktree".

### Claude Desktop

Claude Desktop travaille beaucoup la confiance par l'installation:

- connecteurs;
- extensions;
- settings lisibles;
- etats d'installation;
- directory;
- prompts de configuration.

Shugu a une bonne page Connections, mais elle doit devenir un inventaire clair:

- source de chaque MCP;
- statut;
- outils exposes;
- secrets manquants;
- niveau de risque;
- provenance Claude/Codex/OpenCode/Shugu.

### OpenCode Desktop

OpenCode valorise les modes et permissions:

- Plan pour analyser sans modifier;
- Build pour agir;
- snapshots/rollback;
- config agents/rules/plugins/MCP.

Shugu a ModeSelector, mais l'information doit etre plus explicite dans le
composer et l'AgentsPanel. "Agent" ne suffit pas. Il faut afficher:

- read-only;
- workspace-write;
- full local;
- network off/on;
- approval required;
- worktree/local checkout.

## Findings UI/UX principaux

### P0 - Le CTA le plus dangereux est trop positif

Fichier: `src/features/agents/AgentsPanel.tsx`

Le bloc `Grounded Run` est vert, avec une iconographie positive, et le texte dit
que le filet de securite est Git. Or c'est l'action la plus risquee de l'app:
l'agent execute sur le vrai projet.

Probleme UX:

- le vert evoque "safe / good";
- le danger reel est sous-exprime;
- le warning Git est non bloquant;
- le bouton ressemble a une action normale.

Correction UX:

- remplacer le vert par un profil d'execution clairement nomme;
- afficher une carte de risque avant lancement:
  - Projet: `F:\Dev\shugu_code`
  - Mode: `Full local`
  - Reseau: `autorise/interdit`
  - Ecriture: `workspace`
  - Isolation: `aucune/worktree`
  - Annulation: `Git diff`
- exiger confirmation si pas de worktree ou dirty tree;
- bouton primaire: `Run in Worktree`;
- bouton secondaire dangereux: `Run on Current Checkout`.

### P0 - Le chip `local` est ambigu

Fichier: `src/features/chat/views-chat.tsx`

Le composer affiche un chip `local` avec un shield. "Local" peut etre percu
comme securise, alors que local veut seulement dire "sur cette machine".

Correction UX:

- remplacer `local` par un badge de permission:
  - `Read-only`
  - `Workspace write`
  - `Full local`
  - `Network off/on`
- garder le shield uniquement pour un etat vraiment borne/sandboxe.

### P0 - Plan / Agent doit etre un vrai contrat visible

Fichier: `src/features/chat/ModeSelector.tsx`

Le mode existe, c'est bien. Mais il doit etre plus contractuel:

- Plan = ne modifie jamais;
- Agent = peut proposer;
- Full = peut executer;
- Worktree = agit dans une copie isolee.

Correction UX:

- tooltip detaille;
- couleur par risque;
- confirmation de changement vers mode plus permissif;
- afficher le mode dans chaque message/resultat agent, pas seulement dans le composer.

### P1 - Navigation trop large pour un premier niveau

Fichier: `src/components/components.tsx`

Le rail expose Chat, Editor, Source Control, Image, Studio, Agents, Gallery,
Settings. C'est beaucoup pour une app qui veut etre un agent IDE.

Probleme:

- l'utilisateur ne sait pas quelle surface est principale;
- "Agents" est une page separee alors que les agents sont aussi dans Chat;
- Image/Studio/Gallery distraient du coeur agentique;
- Settings/Connections sont separes dans certains flux.

Correction UX:

- regrouper:
  - Work: Chat/Cockpit, Code, Git;
  - Agents: Runs, Skills, Definitions;
  - Create: Image, Studio, Gallery;
  - Configure: Connections, Settings.
- faire du Cockpit l'ecran principal pour les taches agentiques;
- garder Image/Studio derriere un mode/section secondaire si le but premier est code.

### P1 - Beaucoup d'elements cliquables ne sont pas des controles semantiques

Fichiers:

- `src/components/components.tsx`
- `src/features/chat/views-chat.tsx`
- `src/features/connections/Connections.tsx`
- `src/features/context-cards/cards.tsx`

Exemples:

- `tb-search` est un `div` cliquable;
- plusieurs `side-item` sont des `div` avec `onClick`;
- `conn-add-card` est un `div` avec `onClick`;
- `via-agent` est un `span` avec `onClick`;
- plusieurs lignes de fichiers/actions sont des `div` cliquables.

Probleme:

- navigation clavier incomplete;
- lecteurs d'ecran moins fiables;
- focus states inconsistants;
- comportement Cmd/Ctrl plus pauvre.

Correction:

- transformer en `button` ou `a` selon l'action;
- ajouter `aria-label` aux icon-only buttons;
- gerer `Enter`/`Space` si un role custom est inevitable;
- focus visible partout.

### P1 - Les styles inline empechent une UI coherente

Fichiers:

- `src/routes/RootLayout.tsx`
- `src/features/agents/AgentsPanel.tsx`
- `src/features/connections/Connections.tsx`
- `src/features/mcp/McpServersSection.tsx`
- `src/features/chat/ChatPanel.tsx`

Probleme:

- impossible d'obtenir une grammaire visuelle stable;
- focus/hover/disabled states oublies;
- dark/light/theming difficiles;
- maintenance lourde.

Correction:

- creer des composants primitifs:
  - `RiskBadge`;
  - `PermissionBadge`;
  - `ExecutionProfileCard`;
  - `SettingsCard`;
  - `InlineNotice`;
  - `ToolbarIconButton`;
  - `SegmentedControl`;
- deplacer le style vers CSS modules/classes.

### P1 - Le MCP est pedagogique, mais pas encore operationnellement clair

Fichier: `src/features/mcp/McpServersSection.tsx`

Bon point: l'empty state explique MCP.

Manques UX:

- pas de source visible: Claude Desktop / Codex / OpenCode / Shugu;
- pas de niveau de risque;
- pas de difference claire entre stdio local et remote HTTP;
- warning secrets en clair existe, mais l'action reste permise sans alternative;
- pas de statut "config invalide mais ignoree".

Correction UX:

- tableau inventaire:
  - Source
  - Nom
  - Type
  - Enabled
  - Tools
  - Secrets
  - Risk
  - Last test
- badges:
  - `Local process`
  - `Remote HTTP`
  - `Needs token`
  - `Plaintext secret`
  - `Imported from Claude`
  - `Imported from Codex`
  - `Imported from OpenCode`

### P1 - L'app est visuellement tres marquee violet/cyan

Fichier: `src/styles/styles.css`

L'identite "Celestial Veil" est forte, mais le risque est une palette trop
monolithique pour un outil de travail intensif. Les etats importants doivent
etre plus neutres et plus fonctionnels.

Correction:

- reserver violet/cyan a la marque et aux accents;
- utiliser des fonds plus neutres pour IDE/agent surfaces;
- couleurs d'etat strictes:
  - vert = verifie/safe;
  - jaune = attention;
  - rouge = danger/destructif;
  - bleu = info;
  - violet = Shugu/AI.

### P2 - Focus et motion a durcir

Fichiers CSS:

- `src/styles/styles.css`
- `src/styles/chat-codex.css`
- `src/styles/panels.css`
- `src/styles/forge-integrations.css`

Constats:

- plusieurs `transition: all`;
- plusieurs `outline: none`;
- animations aurora sans garde visible `prefers-reduced-motion`.

Correction:

- remplacer `transition: all` par `background-color`, `border-color`,
  `color`, `opacity`, `transform`;
- ajouter `:focus-visible`;
- respecter `@media (prefers-reduced-motion: reduce)`;
- ne retirer `outline` qu'avec remplacement focus-visible.

### P2 - Les destructive actions doivent etre uniformes

Bon:

- suppression fichier a une confirmation modale.

Moins bon:

- MCP remove utilise `window.confirm`;
- agents kill/run ont des confirmations faibles;
- "Force stop external" est tres puissant et doit etre visuellement dangereux.

Correction:

- composant `ConfirmDialog`;
- niveaux: normal, destructive, irreversible;
- undo window quand possible;
- logs visibles apres action.

## Recommandation produit: nouvelle IA de Shugu

### Ecran principal recommande

Un "Cockpit" comme ecran par defaut:

- gauche: conversation;
- droite: contexte/review/diff;
- bas: terminal/logs;
- haut: projet + branche + execution profile + worktree;
- composer: mode + permissions + modele + contexte.

### Trois modes comprehensibles

1. `Ask`
   - lit seulement;
   - pas d'ecriture;
   - pas de commande.

2. `Plan`
   - lit;
   - peut proposer un plan;
   - pas d'ecriture;
   - pas de commande mutative.

3. `Act`
   - demande worktree par defaut;
   - affiche permissions;
   - diff obligatoire avant merge.

### Execution profile visible

Badge permanent:

```text
Acting in: worktree/shugu-agent-123
Files: workspace-write
Network: off
Approval: ask before shell
Rollback: git diff + worktree delete
```

Si l'utilisateur choisit "current checkout":

```text
Danger: current checkout
Uncommitted files: 3
Network: on
Rollback: manual git restore
```

### MCP UX cible

Page Connections -> MCP Inventory:

```text
Source        Name       Type    Status     Tools   Risk
Claude        filesystem stdio   connected  12      local fs
Codex         node_repl  stdio   connected  1       code exec
OpenCode      unityMCP   http    offline    ?       localhost
Shugu global  MiniMax    stdio   token err  0       plaintext env
```

## Roadmap UI/UX

### Phase 1 - Trust UX

- Remplacer `local` par `ExecutionProfileBadge`.
- Redessiner `Grounded Run` comme action risquee.
- Ajouter confirmation pour execution directe.
- Afficher worktree/current checkout dans le chat.
- Ajouter `RiskNotice` reusable.

### Phase 2 - Navigation

- Faire du Cockpit l'ecran principal.
- Reorganiser le rail en groupes.
- Fusionner les agents dans le flux cockpit.
- Connections devient inventory + setup wizard.

### Phase 3 - Accessibility pass

- Remplacer `div/span onClick`.
- Ajouter aria-labels manquants.
- Focus visible global.
- Respect reduced motion.
- Uniformiser modals et dialogs.

### Phase 4 - Design system

- Extraire primitives UI.
- Supprimer le maximum d'inline styles.
- Stabiliser tokens de couleur et etats.
- Reduire la dominance decorative sur les surfaces de travail.

## Priorite absolue

Ne commence pas par refaire les couleurs.

Commence par l'UX de confiance:

1. un badge de permissions comprehensible;
2. un Grounded Run qui fait sentir le risque;
3. un worktree par defaut;
4. un diff/review avant application;
5. un inventaire MCP qui explique la provenance et le risque.

Ensuite seulement, travaille le polish visuel.

