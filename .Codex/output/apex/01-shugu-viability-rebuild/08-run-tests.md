# Step 08: Run Tests

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Test Runner Log

| Commande / contrôle | Résultat |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ 45 fichiers, 543 tests |
| `pnpm build` | ✅ 567 modules |
| `pnpm lint` | ✅ 0 erreur, 302 warnings préexistants |
| `cargo check` via vcvars64 | ✅ 2 warnings préexistants |
| `cargo test` via vcvars64 | ✅ 405 tests |
| `pnpm test:e2e` | ✅ 1 smoke Chromium |
| `pnpm ui:tour` | ✅ 8 captures structurées |
| `tauri-dev-log.cmd` | ✅ Tauri/WebView2 réel démarré et répondant |

### Incidents de validation résolus

1. Chromium Playwright absent : installé avec
   `pnpm exec playwright install chromium`, puis relance.
2. Le smoke classait `transformCallback` comme fatal alors que le tour UI le
   documente comme absence normale du bridge Tauri en navigateur : allowlist
   alignée, puis test vert.

### Preuves natives

- `src-tauri/target/debug/shugu-forge.exe` vivant et `Responding=True`.
- Fenêtres réelles `Shugu Forge` et `Shugu Mascot` détectées.
- Hooks `agent-events`, `chat-stream`, `fs-events`, `git-events` attachés.
- SQLite réelle ouverte en WAL :
  `C:/Users/rafai/AppData/Roaming/dev.shugu.forge/shugu.db`.
- Index vectoriel réel chargé (`vec_code=23485 chunks`).
- Capture : `dev-logs/native-tauri-window.png`.
- Log : `dev-logs/run-20260722-165017.log`.

L'exit `0xffffffff` en fin de log est le teardown forcé et ciblé de l'instance
de test après collecte des preuves, pas un crash spontané ; le processus était
vivant et répondant immédiatement avant cette fermeture.

## Campagne finale de la tranche 4

| Commande / contrôle | Résultat |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ 47 fichiers, 548 tests |
| `cargo check` via vcvars64 | ✅ |
| `cargo test --no-fail-fast` via vcvars64 | ✅ 428 tests |
| `pnpm lint` | ✅ 0 erreur, 297 warnings hérités |
| `pnpm build` | ✅ 566 modules |
| `pnpm exec playwright test` | ✅ 1/1 |
| `pnpm ui:tour` | ✅ après correction du chargement de polices externes |
| `tauri-dev-log.cmd` | ✅ Tauri/WebView2 réel, processus réactif |
| Migration SQLite V23 | ✅ backup intègre, 18 assets conservés, 0 kind invalide |
| Teardown | ✅ aucun `shugu-forge`, port 1420 libre |

Le test natif a utilisé la base locale existante en lecture applicative normale
et a créé un backup automatique avant migration. Aucun test mutatif d'agent n'a
été lancé contre le workspace utilisateur pendant ce passage.

## Campagne finale — 23 juillet 2026

| Commande / contrôle | Résultat |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ 51 fichiers, 559 tests |
| `pnpm lint` | ✅ 0 erreur, 0 warning |
| `pnpm build` | ✅ Vite 8, 554 modules |
| `cargo fmt --all -- --check` | ✅ |
| `cargo check` via vcvars64 | ✅ |
| `cargo test --no-fail-fast` via vcvars64 | ✅ 455 tests |
| `pnpm run audit` | ✅ JS propre, RustSec avec 3 exceptions documentées |
| `pnpm ui:tour` | ✅ |
| `pnpm exec playwright test` | ✅ 1/1 |
| `pnpm native:smoke` | ✅ deux boots Tauri/WebView2 isolés |
| `pnpm perf:smoke` | ✅ 1 200 fichiers + streaming concurrent |
| `pnpm release:smoke` | ✅ assets embarqués, IPC, 0 erreur runtime |
| `pnpm tauri build` | ✅ binaire release + MSI + NSIS x64 |
| `git diff --check` | ✅ (warnings CRLF Windows uniquement) |

Preuve native : `dev-logs/native-smoke/20260723-085036/summary.json` et
`native-proof.txt`. La base copiée est celle du profil de test (479 232 octets),
jamais la base personnelle. À la sortie : 0 `shugu-forge`, port 1420 libre et
profil `dev.shugu.forge.native-smoke` absent.

Preuve release : `dev-logs/release-smoke/20260723-090150/`. L'URL est
`http://tauri.localhost/`, l'IPC répond, les erreurs page/console/requête sont à
0 et le profil `dev.shugu.forge.release-smoke` est supprimé à la sortie.

Preuve de charge : `dev-logs/perf-smoke/20260723-085249/`. Le full-index
produit 6 000 chunks depuis 1 200 fichiers en 88,55 s, le scan chaud dure
97,4 ms, l'incrémental 120 fichiers 10,41 s et la recherche 54,5 ms. Le flux
concurrent conserve ses 1 200 fragments, avec 0 erreur et teardown complet.

Artefacts release :

- `src-tauri/target/release/shugu-forge.exe` — 75 343 872 octets — SHA-256
  `23030AC846BE8ED783DC7D18EAF7026A412C467D263CA170F88374CECCA04C10` ;
- `src-tauri/target/release/bundle/msi/Shugu Forge_0.1.0_x64_en-US.msi` —
  30 064 640 octets — SHA-256
  `20E1C1AA67D4D9F51B4858BFBA50AD077318EF3E0BE94E0974CBDA03B1E8A906` ;
- `src-tauri/target/release/bundle/nsis/Shugu Forge_0.1.0_x64-setup.exe` —
  22 740 318 octets — SHA-256
  `34C2ECA1CE24A9D5BB940B97C6E84F631FB14C9C785FAF40C679377FC91E4E66`.

## Campagne actualisée — providers live et RC courante

| Commande / contrôle | Résultat |
|---|---|
| `pnpm provider:smoke:live` | ✅ Codex réel + Qwen 2B chat + Qwen3 8B et Llama 3.1 8B agents |
| Cycle Agent persistant | ✅ plan → write → vérification verte |
| Full Access natif | ✅ confirmation sessionnelle unique, révocation finale |
| `pnpm typecheck` / `lint` / `build` | ✅ |
| `pnpm test` | ✅ 51 fichiers, 559 tests |
| `cargo fmt` / `check` / `test --no-fail-fast` | ✅ 455 tests |
| `pnpm audit:js` / `git diff --check` | ✅ |
| `pnpm ui:tour` / Playwright | ✅ |
| `pnpm native:smoke` | ✅ `20260723-085036` |
| `pnpm perf:smoke` | ✅ `20260723-085249` |
| `pnpm release:smoke` | ✅ `20260723-090150` |
| `tauri-dev.cmd build` | ✅ EXE + MSI + NSIS |

Preuves live :
`dev-logs/live-provider-smoke/20260723-083956/summary.json` pour Llama 3.1 8B,
`20260723-084138/summary.json` pour Qwen3 8B et
`20260723-065615/summary.json` pour Codex probe/chat. Les deux cycles agents
finaux utilisent exactement `todo_write → fs_write_file → run_command`,
vérifient les 13 octets `LIVE_AGENT_OK` et terminent sans ressource résiduelle.
Le quota Codex était épuisé pendant les deux runs locaux finaux ; le skip est
explicite et aucune inférence n'est comptée. Mistral n'est pas revendiqué.

Artefacts RC courants :

- `src-tauri/target/release/shugu-forge.exe` — 75 343 872 octets — SHA-256
  `23030AC846BE8ED783DC7D18EAF7026A412C467D263CA170F88374CECCA04C10` ;
- `src-tauri/target/release/bundle/msi/Shugu Forge_0.1.0_x64_en-US.msi` —
  30 064 640 octets — SHA-256
  `20E1C1AA67D4D9F51B4858BFBA50AD077318EF3E0BE94E0974CBDA03B1E8A906` ;
- `src-tauri/target/release/bundle/nsis/Shugu Forge_0.1.0_x64-setup.exe` —
  22 740 318 octets — SHA-256
  `34C2ECA1CE24A9D5BB940B97C6E84F631FB14C9C785FAF40C679377FC91E4E66`.
