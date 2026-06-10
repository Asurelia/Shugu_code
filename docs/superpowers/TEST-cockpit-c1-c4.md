# Cockpit C1–C4 — Checklist de vérification « en voyant »

Lancer l'app depuis `F:\Dev\shugu_code` (Ctrl+R si déjà ouverte).
Filet, à tout moment : `git -C F:\Dev\shugu_code reset --hard af69559` (annule tout le cockpit).

## 0. Non-régression (flag OFF) — AVANT d'activer
- [ ] Le chat normal s'affiche **comme avant** (rien de changé).
- [ ] Réglages (⚙️) → Interface : la ligne **« Cockpit (chat + IDE) — expérimental »** existe, switch **OFF**.
- [ ] Console dev (F12) : pas de **nouvelle** erreur rouge au chargement.

## 1. C1 — Le shell
- [ ] Activer le switch **Cockpit** → aucune erreur.
- [ ] Rail → **Chat** → le chat s'affiche + bouton **« Panneau »** en haut à droite.
- [ ] Clic **« Panneau »** → un panneau s'ouvre à droite (Éditeur par défaut).
- [ ] **Glisser la poignée** centrale → le panneau se redimensionne (fluide, pas de saut).
- [ ] Le **`+`** (barre d'onglets) → menu : Éditeur / Révision / Terminal / Fichiers / Navigateur.
- [ ] Le **`×`** referme le panneau ; re-« Panneau » le rouvre **à la même taille**.

## 2. C2 — Révision
*Prépare : modifie + enregistre 2-3 fichiers quelconques pour avoir des changements.*
- [ ] Onglet **Révision** → la **liste des fichiers changés** s'affiche.
- [ ] Sélectionner un fichier → son **diff** s'affiche (lignes `+` vert / `−` rouge + numéros).
- [ ] **Toggle de portée** : Non-commités (défaut) / Indexé / Non-indexé → le diff change en conséquence.
- [ ] **Clic sur le NOM** d'un fichier → il s'ouvre dans l'**Éditeur** (l'onglet bascule).
- [ ] **Ctrl+clic** sur une ligne du diff → l'Éditeur s'ouvre au **bon fichier ET à cette ligne** (curseur posé).
- [ ] **Survol** d'une ligne → un **`+`** apparaît → clic → champ de note → écris → valide → la note apparaît dans un **bac au-dessus du composer**.
- [ ] **Envoie un message chat** → la/les note(s) sont jointes (l'IA en tient compte) puis le bac **se vide**.
- [ ] Sur une ligne fichier : **Stage (+)** / **Unstage (−)** / **Discard (↺, avec confirmation)** → la liste se met à jour.

## 3. C3 — Carte d'opération in-chat
*Prépare : Réglages → Interface → « Le chat peut modifier les fichiers » **ON**.*
- [ ] Demande au chat de **modifier/créer** un fichier (ex : « ajoute un commentaire en tête de `src/…` »).
- [ ] Sous la réponse → carte **« ✏️ N fichier(s) modifié(s) »** + bouton **« Annuler ↺ »**.
- [ ] **Déplie** un fichier de la carte → son diff s'affiche.
- [ ] Clic sur le **nom** d'un fichier de la carte → s'ouvre dans l'éditeur.
- [ ] **« Annuler ↺ »** → le(s) fichier(s) reviennent à l'état d'avant ; la carte disparaît.

## 4. C4 — Surfaces
- [ ] Onglet **Terminal** → un **vrai shell** (tape `echo hi`, `ls`) → il répond.
- [ ] Change d'onglet puis reviens sur Terminal → la **session est toujours là** (pas de reset).
- [ ] Onglet **Fichiers** → l'explorateur ; clic un fichier → s'ouvre dans l'**Éditeur**.
- [ ] Onglet **Navigateur** → barre d'URL ; tape une URL locale (ex : `http://localhost:5173`) → s'affiche dans l'iframe. *(certains sites externes bloquent l'iframe — normal)*

## 5. Transverse
- [ ] Ouvre l'**Éditeur**, tape du texte → il répond (l'éditeur est vivant **hors `/code`**).
- [ ] Règle la taille + laisse le panneau **ouvert** + **recharge (Ctrl+R)** → disposition **restaurée** (taille + onglet actif).
- [ ] Bascule plusieurs fois entre onglets → **pas de lag** notable, pas de scintillement.
- [ ] Console dev : **pas d'erreur rouge** en utilisant le cockpit.

## 6. Si quelque chose cloche
Pour chaque souci, note : **l'écran** + **l'action faite** + **le message d'erreur** (console F12 ou `dev-logs\`).
→ je corrige par lots.
