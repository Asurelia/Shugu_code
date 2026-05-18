# LOT 1 Test Fixtures

Fichiers fabriqués à la main pour smoke-tester visuellement les features LOT 1 qui demandent des yeux (rendu UI, couleurs syntaxiques, clic gutter). Le comportement des fonctions pures est couvert par la suite vitest (`pnpm test` — 110 tests).

## Où tester quoi

### `languages/` — coloration syntaxique (visuel)

Ouvre chaque fichier, confirme 3 couleurs distinctes : **mot-clé** (violet `#d180ef`/`#e08efe`), **string** (teal `#8aefc7`), **commentaire** (gris-italique `#6e6a89`).

| Fichier | Teste |
|---------|-------|
| `Sample.rs` | Rust `fn`, `struct`, `impl`, `use` |
| `MainApp.java` | Java `class`, `public`, `static`, imports |
| `HelloWorld.vue` | Vue SFC `<template>`, `<script>`, `<style>` |
| `Counter.svelte` | Svelte `$:`, `{#if}`, `on:click` |
| `Dockerfile` | Match par basename (sans extension), `FROM`, `RUN`, `COPY` |
| `Cargo.toml` | TOML `[section]`, `key = "value"` |

### `regions/` — clic sur fold gutter (interaction)

Clique le marqueur de fold sur la ligne `#region` de chaque fichier. Le corps se replie, les deux marqueurs restent visibles.

| Fichier | Style commentaire | Teste |
|---------|-------------------|-------|
| `c-style.ts` | `// #region` | TypeScript / Rust / Go / Java / C++ / PHP |
| `python-style.py` | `# region` | Python / Ruby / YAML |
| `html-style.html` | `<!-- #region -->` | HTML / Vue / Svelte / Markdown |

Voir aussi `languages/Dockerfile` qui contient des `# region` (regression: tombait sur `//` avant le fix).

### `edge-cases/`

| Fichier | Teste |
|---------|-------|
| `long-lines.md` | Word wrap toggle visuel (Alt+Z) — paragraphes wrappent, code blocks restent scrollables |
| `UPPERCASE.YAML` | Matching d'extension case-insensitive (`.YAML` → highlighting yaml) |

## Déjà vérifié automatiquement par `pnpm test` (pas besoin de smoke)

- `langFromPath` mappings pour TOUTES les 30+ extensions + edge cases (Dockerfile basename, alias .htm/.scss, unknown → text, normalisation majuscules). **58 tests** dans `src/lib/fs.test.ts`.
- `langExtensionFor` retourne une Extension CodeMirror pour chaque langId supporté, `[]` pour les non-supportés. **31 tests** dans `src/features/code/languages.test.ts`.
- Region folding `foldable()` ranges pour les 5 styles de commentaire, régression Dockerfile, regions non-fermées, scan borné (fichier 6000 lignes ne freeze PAS), strictness `\b` word boundary, `#` optionnel, tolérance whitespace. **21 tests** dans `src/features/code/extensions/regionFolding.test.ts`.

Total : **110 tests automatisés** sur la partie fonctionnelle de LOT 1.

## Ce qui demande des yeux humains (ce dossier)

1. **Couleurs justes** — ouvre les fichiers ci-dessus, scanne pour les 3 couleurs attendues.
2. **Live-sync des Settings** — toggle Word wrap dans Settings → Editor, l'éditeur se reconfigure SANS remount. Curseur reste à sa position logique.
3. **Fold gutter region** — clique le marker, le corps se replie avec l'animation CodeMirror standard.
4. **Persistance** — toggle, reload (Ctrl+R), état restauré.
5. **Pas de régression** — LSP attache toujours sur `.ts`, snippets toujours OK, `Ctrl+F` search OK, `Cmd+Shift+F` ripgrep OK.
