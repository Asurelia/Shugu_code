# Checklist de test « en voyant » — Lot A (ressenti Cursor) + Lot C (MCP exécuté)

> Objectif : valider visuellement ce qui a été mergé dans `main`.
> Coche au fur et à mesure. Si une étape échoue, note ce que tu vois → je corrige.

---

## 0. Préalables

- [ ] **(une fois) Exclure le dossier build de Windows Defender** (sinon le link est très lent).
      PowerShell **admin** : `Add-MpPreference -ExclusionPath 'F:\Dev\shugu_code\src-tauri\target'`
- [ ] Lancer l'app : `tauri-dev.cmd` (jamais `pnpm tauri dev` direct).
- [ ] La fenêtre **Shugu Forge** s'ouvre.
- [ ] **Un provider LLM est configuré** (Settings → Connections : une clé Anthropic/OpenAI activée,
      ou llama.cpp local lancé). Sans ça, le chat ne répond pas — ce n'est pas un bug de lot.
- [ ] **Node/npx disponible** (pour les serveurs MCP de la Phase C). Vérifie `npx --version` dans un terminal.

---

## Lot A — ressenti Cursor

### A1. Contexte auto (fichier ouvert + sélection)
- [ ] Ouvre un fichier de code dans l'éditeur (ex. `src/lib/diag.ts`).
- [ ] Va au chat. **Au-dessus du champ de saisie**, un petit *chip* doit apparaître : `📄 diag.ts`.
- [ ] Pose une question SANS `@mention`, ex. : « que fait ce fichier ? ».
      → **Attendu** : la réponse parle bien de CE fichier (pas une réponse générique « je ne vois pas tes fichiers »).
- [ ] Sélectionne quelques lignes dans l'éditeur. Le chip doit afficher en plus `⊿ sélection (N l.)`.
- [ ] Demande « explique cette sélection » → **Attendu** : la réponse porte sur les lignes sélectionnées.
- [ ] Clique le **×** du chip → envoie une question → **Attendu** : le contexte n'est plus injecté pour ce tour.
- **Ce que ça prouve** : le chat voit automatiquement le code en cours (cœur du « ressenti Cursor »).

### A2. Toggle du contexte auto
- [ ] Settings → (section Interface) → interrupteur **« Contexte auto du chat »**.
- [ ] Mets-le **OFF** → retourne au chat : le chip ne s'affiche plus, la réponse n'a plus le contexte.
- [ ] Remets-le **ON** → le chip réapparaît.
- **Ce que ça prouve** : le réglage pilote bien l'injection (et l'invalidation est immédiate).

### A3. Outils fs au chat — LECTURE
- [ ] Dans le chat, demande : « lis `src/lib/db.ts` et résume-le » (sans l'ouvrir dans l'éditeur).
      → **Attendu** : une **ligne d'activité** apparaît, ex. `🔍 a lu src/lib/db.ts`, puis une réponse fondée sur le vrai contenu.
- [ ] Demande : « cherche où `useShell` est utilisé » → **Attendu** : activité `🔎 grep useShell` + résultats réels.
- **Ce que ça prouve** : le chat agit lui-même (multi-tour), pas juste répondre.

### A4. Outils fs au chat — ÉCRITURE + Annuler (le test de sûreté)
- [ ] Demande : « ajoute un commentaire `// test shugu` en tête de `src/lib/diag.ts` ».
      → **Attendu** : activité `✏️ a écrit src/lib/diag.ts`, et le fichier change réellement (vérifie dans l'éditeur).
- [ ] Sous le message de l'IA, un bouton **« Annuler les modifications de ce message »** doit apparaître.
- [ ] Clique-le → **Attendu** : le fichier revient à son état d'avant (le commentaire disparaît).
- **Ce que ça prouve** : écriture directe réversible (le filet de sûreté « empêcher l'irréparable »).

### A5. Apply-from-chat (bouton Appliquer)
- [ ] Demande : « écris-moi une petite fonction TypeScript `add(a,b)` dans un bloc de code, avec en tête ```ts src/lib/_scratch.ts ```».
- [ ] Sur le **bloc de code** rendu dans le chat, un bouton **« Appliquer »** doit être présent (et actif).
- [ ] Clique « Appliquer » → **Attendu** : le fichier cible s'ouvre + un **diff inline** avec barre **Accept / Reject**.
- [ ] **Accepter** → le contenu est écrit dans le fichier. (Refaire, puis **Rejeter** → rien n'est appliqué.)
- [ ] Cas « fichier actif » : ouvre un fichier, demande un bloc SANS chemin en entête, clique Appliquer
      → **Attendu** : ça cible le fichier de l'onglet actif.
- [ ] Cas « pas de cible » : aucun fichier ouvert + bloc sans chemin → le bouton « Appliquer » est **désactivé** (tooltip explicatif).
- **Ce que ça prouve** : appliquer une proposition de code en 1 clic avec revue de diff (cœur Cursor).

---

## Lot C — MCP exécuté

### C1. Découverte d'un serveur MCP (le « Tester »)
- [ ] Crée un fichier `.mcp.json` à la racine du **workspace ouvert** :
      ```json
      { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }
      ```
- [ ] Settings → Connections → onglet **« Serveurs MCP »**.
      → **Attendu** : le serveur `fs` est listé (badge transport **stdio**, état **désactivé** par défaut).
- [ ] Clique **« Tester »** sur `fs`.
      → **Attendu** : au bout de quelques secondes, la liste des outils du serveur s'affiche
      (ex. `read_file`, `list_directory`, `write_file`…). Premier `npx` = un peu lent (téléchargement).
- **Ce que ça prouve** : Shugu lance un vrai serveur MCP et découvre ses outils (≠ placeholder).

### C2. Activation + ajout via l'UI
- [ ] Active le serveur `fs` (toggle **Activé**).
- [ ] Teste le bouton **« Ajouter un serveur »** : remplis le formulaire (nom + type stdio, command `npx`, args, scope projet) → Enregistrer.
      → **Attendu** : le serveur apparaît dans la liste **et** dans `.mcp.json` (rouvre le fichier pour vérifier qu'il y est, et que `fs` n'a pas été écrasé).
- [ ] Supprime ce serveur de test via le bouton supprimer → il disparaît de la liste et de `.mcp.json`.
- **Ce que ça prouve** : config bidirectionnelle (lecture + écriture `.mcp.json` sans casser le reste).

### C3. Outils MCP dans le CHAT
> ⚠️ Pré-requis : les **outils de lecture du chat doivent être ON** (Settings, défaut ON). Si tu les as coupés en A3, rallume-les.
- [ ] Serveur `fs` activé (C1). Dans le chat (modèle Anthropic ou OpenAI — Ollama ne fait pas de tool-use) :
      demande « avec MCP, liste les fichiers du dossier courant ».
      → **Attendu** : activité `🔌 fs__list_directory` (icône prise MCP) + un résultat réel issu du serveur.
- **Ce que ça prouve** : les outils MCP sont appelables par le LLM dans le chat (niveau Claude Desktop).

### C4. Outils MCP dans un AGENT
- [ ] Déclenche une délégation à un agent (une demande « tâche de dev » qui route vers l'orchestrateur, ou via le panneau Agents).
- [ ] Si l'agent a besoin d'un outil MCP, le **transcript de l'agent** doit montrer l'appel MCP + son résultat.
- **Ce que ça prouve** : MCP marche aussi côté agents (les 2 surfaces, comme spécifié).

### C5. Robustesse (optionnel mais utile)
- [ ] Mets une URL/commande MCP **invalide** dans `.mcp.json`, active-le, « Tester »
      → **Attendu** : une **erreur lisible** s'affiche (pas de gel de l'app), et les autres serveurs continuent de marcher.
- [ ] Désactive le serveur en erreur → l'app reste fluide.
- **Ce que ça prouve** : timeout handshake + isolation des erreurs (un serveur cassé ne casse pas le chat/agent).

---

## Récap rapide (résultats)

| # | Test | OK ? | Note si KO |
|---|------|------|-----------|
| A1 | Contexte auto (fichier + sélection) | ☐ | |
| A2 | Toggle contexte auto | ☐ | |
| A3 | Chat lit le workspace | ☐ | |
| A4 | Chat écrit + bouton Annuler | ☐ | |
| A5 | Apply-from-chat (diff accept/reject) | ☐ | |
| C1 | Tester un serveur MCP | ☐ | |
| C2 | Ajouter/supprimer via l'UI + .mcp.json | ☐ | |
| C3 | Outils MCP dans le chat | ☐ | |
| C4 | Outils MCP dans un agent | ☐ | |
| C5 | Robustesse (serveur en erreur) | ☐ | |

> Les libellés d'UI exacts (noms de boutons/sections) sont mon **meilleur estimé d'après le code** —
> rien n'a encore été validé en voyant. Si un libellé diffère ou un élément manque, dis-le-moi : c'est précisément
> ce qu'on cherche à débusquer.
