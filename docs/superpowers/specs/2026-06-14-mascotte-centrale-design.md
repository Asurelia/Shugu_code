# Mascotte centrale — design de programme + spec du socle

> Date : 2026-06-14 · Branche : `claude/pedantic-noyce-50be22`
> Statut : design validé en brainstorming, spec du socle à relire avant plan d'implémentation.

## 1. Objectif

Rendre la mascotte Shugu **centrale** à l'application, en fusionnant trois rôles dans
un seul personnage évolutif :

- **Compagnon affectif** — une présence vivante, attachante, qui réagit et se souvient.
- **Interface agent** — on lui parle (voix), elle agit (code, recherche, capture écran).
- **Coach de productivité** — elle suit la progression et motive, mais en douceur.

Cinq ambitions concrètes la composent :

- (a) une **persona qui apprend** et se personnalise ;
- (b) un **choix de modèle de voix** (TTS) par l'utilisateur ;
- (c) une **bulle de réponse + dialogue évolutif** ;
- (d) une **personnalisation progressive** (apparence, identité, comportement) ;
- (e) une **gamification** de l'app et de la mascotte.

## 2. Décisions validées (brainstorming)

| Sujet | Décision |
|---|---|
| Rôle | Les trois fusionnés (compagnon + agent + coach), séquencé en lots. |
| Séquencement | Voix → Socle mémoire → Bulles → Persona → Gamification → Personnalisation. |
| **Spec détaillée d'abord** | **Le socle (mémoire/état)**, pas la voix. La voix reste un quick win autonome. |
| Apprentissage | **Hybride inspectable** : Shugu déduit des faits, mais l'utilisateur les voit / édite / supprime dans un panneau « Ce que Shugu sait de toi ». |
| Santé de l'XP | XP centré sur **la relation** (interactions, missions, streaks de présence) avant le coaching ; pas de farming de lignes/commits bruts. |
| Voix | Multi-provider **au choix utilisateur**, MiniMax actif d'abord, OpenAI (plan GPT de l'utilisateur) ensuite ; réutilise le système de clés (keychain). |
| Apprentissage actif | Shugu peut **poser des questions / mini-jeux** pour mieux connaître l'utilisateur (Lot Persona, rapporte de l'XP → pont vers Gamification). |
| Génération d'image | Sert aux **skins générés** (Lot Personnalisation) et comme capacité débloquable. |

## 3. État actuel (cartographié par exploration du code)

Ce qui **existe déjà** et sera réutilisé :

- **Mascotte chibi** rendue en 7 PNG d'expressions dans une fenêtre Tauri transparente,
  avec drag, snap multi-écrans et calibration (`src/features/mascot/Chibi.tsx`,
  `src/mascot.tsx`, `src/features/mascot/calibration.ts`).
- **Système d'humeurs** hiérarchisé + réactions transitoires sur événements
  (`src/features/mascot/useChibiMood.ts`, `moodReactions.ts`, `moodReactionStore.ts`).
- **Bulles de speech** fire-and-forget avec TTL et tons visuels, mais **une seule à la
  fois** (`src/features/mascot/SpeechBubble.tsx`, `speechStore.ts`).
- **TTS MiniMax** : `voice_tts` (Rust) accepte **déjà** `voice_id` et `model` ; seul le
  défaut `female-shaonv` est figé. La clé `voice.ttsVoice` est **déjà lue et transmise**
  (`src/features/mascot/useTts.ts`, `src-tauri/.../voice.rs`). Il manque seulement l'UI.
- **Persona Shugu** : prompt système figé (~120 tokens) injecté à chaque envoi via
  `apiMessages.unshift()` (`src/features/chat/persona.ts`, `chat-sync.ts`).
- **Boucle d'apprentissage** déjà rodée pour le code : RAG sémantique
  `vec_patterns` → top-3 leçons validées injectées (`src-tauri/.../agents/lessons.rs`).
  Patron directement transposable à la mémoire persona.
- **Firehose d'événements** : `moodReactions.ts` + `useAgentEvents`
  (`src/features/agents/useEvents.ts`) émettent déjà sur `agent-complete`,
  `edit-accept`, `skill-learned`, `lessons-injected`…
- **Persistance** : SQLite versionnée (`src-tauri/src/lib.rs`, migrations V1…**V14**),
  table clé/valeur `settings`, et patron de broadcast cross-fenêtre
  (`calibration.ts`, diffusion par `storage event` + event Tauri custom).

Ce qui **manque** (le cœur du travail) :

- **Aucune mémoire/état persistant de la mascotte** : pas de table, pas de profil,
  pas d'XP, pas de préférences durables au-delà de `voice.ttsVoice`.
- La persona est une **constante** : non composite, n'apprend rien.
- Les bulles n'ont **ni file, ni historique, ni streaming** ; elles s'écrasent.
- **Zéro infrastructure de gamification**.
- **Aucune UI** de choix de voix, ni d'édition de la personnalité, ni d'apparence.

## 4. Architecture du socle commun

**Insight directeur** : les ambitions (a) apprentissage, (d) déblocages progressifs et
(e) gamification ont **toutes** besoin du même objet manquant — un état persistant de la
mascotte. On construit donc **une fois** un *pattern d'état persistant mascotte*
réutilisable, plutôt que trois silos.

Le socle se compose de quatre briques, chacune calquée sur un pattern existant :

1. **Stockage SQLite** — une nouvelle migration (V15 dans ce worktree, à revérifier au
   moment de coder car une autre branche peut réserver V15). Le socle introduit la
   première table, `mascot_memory` (cf. §6). Les lots ultérieurs ajouteront leurs propres
   tables (`mascot_progression`, `mascot_unlocks`) via leurs migrations — on n'anticipe
   pas de tables vides (politique « pas de code/schéma mort »).

2. **Store TanStack `mascotState`** — queries + mutations calquées sur `useTtsEnabled`
   (`useTts.ts:91`) et `agentDefsQueries.ts`. TanStack obligatoire par défaut (politique
   projet) ; toute dérogation serait justifiée et documentée à l'endroit du code.

3. **Broadcast cross-fenêtre** — toute mutation invalide le cache **dans les deux
   webviews** (IDE + mascotte) via le pattern existant (`calibration.ts:63-155`,
   en-tête `speechStore.ts`). C'est non négociable : la désync main ↔ mascotte est un
   piège déjà rencontré et documenté.

4. **Panneau « Profil de Shugu »** — la surface de transparence. Au socle, il porte
   **un seul onglet réel et fonctionnel : « Ce que Shugu sait de toi »** (CRUD sur
   `mascot_memory`). Les onglets *Progression* et *Apparence & voix* seront ajoutés par
   leurs lots respectifs — pas d'onglets vides. Le panneau est conçu **extensible** pour
   les accueillir. Travail visuel → skill `ui-ux-pro-max` (obligatoire).

Le firehose d'événements existant (`fireMoodReaction`) reste la **source unique** : les
lots Gamification/Persona y brancheront leurs hooks (`fireXp`, extraction de faits)
plutôt que de créer des canaux parallèles.

## 5. Découpage en lots (vue programme)

Chaque lot = sa propre spec → plan → implémentation. Effort relatif : S < M < L.

| Lot | Cœur | Dépend de | Effort |
|---|---|---|---|
| **Voix au choix** | sélecteur de voix + test + abstraction provider | rien (autonome) | S |
| **Socle** *(cette spec)* | `mascot_memory` + store + broadcast + panneau Profil | rien | M |
| **Bulles évolutives** | file de bulles + streaming + réponse dans la bulle + historique | Socle (historique) | M |
| **Persona apprend** | extracteur de faits + persona composite + mini-jeux + feedback 👍/👎 | Socle | L |
| **Gamification** | XP/niveaux/streaks/badges (centrés relation) + cérémonies + garde-fous | Socle | L |
| **Personnalisation** | éditeur de ton + identité (nom) + skins (génération d'image) + déblocages | Socle, Gamification | M–L |

## 6. Spec détaillée — Lot Socle

### 6.1 Périmètre

Le socle livre, **testable et utile seul** :

- la table `mascot_memory` (migration) ;
- les commandes Rust de persistance ;
- le store TanStack `mascotMemory` avec broadcast cross-fenêtre ;
- le panneau « Profil de Shugu » avec l'onglet « Ce que Shugu sait de toi » permettant
  d'**ajouter, éditer, supprimer manuellement** des faits.

Hors périmètre du socle (lots ultérieurs) : extraction automatique de faits (Persona),
XP/badges (Gamification), apparence/skins (Personnalisation).

> Note de cohérence : au socle, `mascot_memory` se remplit **manuellement** via le
> panneau. C'est réel et testable. Le Lot Persona ajoutera ensuite l'extracteur qui
> propose des faits (`validated = 0`) que l'utilisateur valide dans ce même panneau.

### 6.2 Schéma — `mascot_memory`

```sql
CREATE TABLE IF NOT EXISTS mascot_memory (
  id         TEXT    PRIMARY KEY,            -- uuid
  category   TEXT    NOT NULL DEFAULT 'general', -- tech | relation | habits | shared | general
  key        TEXT    NOT NULL,               -- ex. "langage_prefere"
  value      TEXT    NOT NULL,               -- ex. "Rust + TypeScript"
  source     TEXT    NOT NULL DEFAULT 'user',-- user | extracted
  confidence REAL    NOT NULL DEFAULT 1.0,   -- 0..1 (extracted < 1, user = 1)
  validated  INTEGER NOT NULL DEFAULT 1,     -- user=1 d'office ; extracted=0 jusqu'à validation
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mascot_memory_cat       ON mascot_memory(category);
CREATE INDEX IF NOT EXISTS idx_mascot_memory_validated ON mascot_memory(validated);
```

Décisions de schéma :

- `category` est une **chaîne libre contrôlée** côté TS (pas un enum SQL) pour rester
  évolutive sans migration. Les valeurs initiales suivent les 4 axes choisis par
  l'utilisateur : préférences techniques, style relationnel, habitudes, souvenirs.
- `source` + `confidence` + `validated` portent la **transparence** : on distingue ce que
  l'utilisateur a saisi (sûr) de ce que Shugu déduira plus tard (à valider).
- Pas de table `progression`/`unlocks` ici — créées par leurs lots.

### 6.3 Commandes Rust

À placer dans un nouveau module `src-tauri/src/commands/mascot_memory.rs`, suivant le
style des commandes existantes (`agents/lessons.rs`, `agents/*`), enregistrées dans
`invoke_handler`. Toutes async, erreurs typées (pas de `unwrap` silencieux), retour
`Result<…, String>` comme le reste du code.

- `mascot_memory_list(category: Option<String>, validated_only: bool) -> Vec<MascotFact>`
- `mascot_memory_upsert(fact: MascotFactInput) -> MascotFact` (génère id + timestamps)
- `mascot_memory_delete(id: String) -> ()`
- `mascot_memory_validate(id: String) -> MascotFact` (passe `validated = 1`, `confidence = 1.0`)

> Alternative considérée : tout faire côté TS via `tauri-plugin-sql` (comme `db.ts`).
> Retenu côté Rust pour garder une frontière nette et préparer l'extracteur (Lot Persona)
> qui appellera un LLM côté Rust. À confirmer dans le plan d'implémentation si le simple
> CRUD justifie du Rust ou peut rester en TS via `db.ts` (cohérence avec l'existant).

### 6.4 Store TanStack + broadcast

Nouveau fichier `src/features/mascot/mascotMemoryStore.ts` :

- `useMascotMemory(category?)` — `useQuery` sur `mascot_memory_list`.
- `useUpsertMascotFact()`, `useDeleteMascotFact()`, `useValidateMascotFact()` —
  `useMutation` qui, en `onSuccess`, invalident la query **et émettent un event Tauri
  `mascot-memory://changed`** capté par les deux fenêtres pour réinvalider (pattern
  `calibration.ts`). Clés de query centralisées (cf. `src/features/agents/keys.ts`).

### 6.5 Panneau « Profil de Shugu » — onglet « Ce que Shugu sait de toi »

- Point d'entrée : un onglet/bouton dans la zone réglages mascotte
  (`src/features/settings/MascotCalibration.tsx`) ou une nouvelle surface du cockpit
  (`ProfileView.tsx` existe). À trancher dans le plan — préférence : étendre la surface
  de réglages mascotte déjà connue de l'utilisateur.
- Contenu : liste des faits groupés par `category`, chaque ligne éditable (clé/valeur),
  bouton supprimer, bouton « + ajouter un fait ». Les faits `validated = 0` (futurs)
  apparaîtront avec un état visuel « proposé » + actions valider/rejeter.
- Bandeau pédagogique en tête (politique « UI auto-explicative ») expliquant en langage
  simple : « Voici ce que Shugu retient de toi. Tu peux tout corriger ou effacer. »
- A11y + tons via le design kit Celestial Veil ; passer par `ui-ux-pro-max`.

### 6.6 Critères d'acceptation

1. La migration crée `mascot_memory` ; l'app démarre sans erreur sur une base existante
   (rétro-compat) et sur une base neuve.
2. Depuis le panneau, on peut **ajouter, éditer, supprimer** un fait ; la persistance
   survit à un redémarrage de l'app.
3. Une modification faite dans la fenêtre IDE est **reflétée dans la fenêtre mascotte**
   (et inversement) sans rechargement (broadcast vérifié).
4. Aucun secret en clair ; aucun `any` ; build Rust + TS verts ; lint vert.
5. Tests : unitaires sur le store (mutations → invalidation) et sur la sérialisation
   Rust des faits ; un test d'intégration léger du round-trip upsert→list.

### 6.7 Vérification (l'utilisateur juge en voyant)

Au-delà des tests automatiques, livrer une **démo visible** : ouvrir le panneau, ajouter
« je préfère pnpm », le voir persister et apparaître dans la fenêtre mascotte. Politique
projet : ne pas annoncer « terminé » sans avoir lancé l'app et montré la chose en marche
(build via `tauri-dev.cmd`, jamais `pnpm tauri dev` direct ; cargo headless via
`vcvars64.bat`).

## 7. Annexe — Lot Voix (quick win, hors spec détaillée)

Conservé ici car quasi gratuit et autonome :

- `useTtsVoice` calqué sur `useTtsEnabled` : lit/écrit `voice.ttsVoice` + `voice.ttsProvider`.
- Liste de voix **curée statique** d'abord ; commande Rust `voice_list_voices`
  (`/v1/get_voice`) dynamique ensuite.
- Sélecteur + bouton « Tester la voix » (`ttsSpeak`) dans les réglages mascotte.
- Abstraction `provider` (`minimax` | `openai`) : MiniMax actif, OpenAI câblé ensuite via
  `loadProviderConfig` + keychain (jamais de saisie de clé réinventée).
- Exposer la prosodie (vitesse/émotion) figée dans `voice.rs`.

## 8. Risques & garde-fous

- **Désync cross-fenêtre** (récurrent) → broadcast obligatoire et testé (§6.6.3).
- **Numéro de migration** : V15 supposé ; revérifier le `max(version)` au moment de coder
  (fork ouvert — une autre branche peut l'avoir réservé).
- **Transparence vs magie** : tant que l'extracteur n'existe pas (Lot Persona), aucun
  fait n'est inventé ; quand il arrivera, tout fait déduit reste `validated = 0` et
  éditable. La persona ne doit jamais injecter de faits non validés sans le signaler.
- **Dérive de personnalité** : l'injection composite (Lot Persona) gardera un noyau figé
  et un bloc mémoire borné en tokens (~budget de la persona actuelle).
- **Politiques projet** : pnpm only ; TanStack par défaut ; réutiliser providers/keychain ;
  `ui-ux-pro-max` pour tout visuel ; brancher puis auto-merge vers main après revue par un
  agent sans contexte.

## 9. Forks ouverts (à trancher au plan d'implémentation)

- CRUD `mascot_memory` en Rust (préparé pour l'extracteur) **ou** en TS via `db.ts`
  (cohérence avec l'existant) ?
- Point d'ancrage du panneau Profil : réglages mascotte **ou** surface cockpit dédiée ?
- Nom de la mascotte : « Shugu » par défaut ; l'identité renommable est au Lot Personnalisation.
