# Step 06: Resolve

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Resolution Log

- Correction du parseur d'exit code : recherche de la ligne structurée
  `[exit N]` dans toute la sortie au lieu d'exiger qu'elle soit la première.
- Ajout du test de régression
  `risk_banner_before_exit_does_not_hide_a_green_command`.
- Relance de la suite Rust complète après résolution : 405/405 tests verts.

## Résolution de la revue R2

| ID | Résolution appliquée |
|---|---|
| R2-01 | Résolution de profil restrictive et tests de conflits Chat/Plan/Agent. |
| R2-02 | Empreinte workspace autour de `run_command`, plan antérieur obligatoire. |
| R2-03 | Drapeau d'annulation atomique, polling et kill du Job Object/process tree. |
| R2-04 | Mutex global autour de l'étiquetage et de l'exécution MIC LOW. |
| R2-05 | CAS SQLite sur Complete/Error/Killed et émissions conditionnelles. |
| R2-06 | Migration V21, claim/finalize/release atomiques, contexte issu du run source. |
| R2-07 | MCP refusé pour Auto/Chat/Plan tant que ses effets ne sont pas typés. |
| R2-08 | Chargement des règles en `Result`, erreur bloquante, deny toujours prioritaire. |
| R2-09 | Caches dédiés sous workspace ; UI précise honnêtement lectures/réseau ouverts. |
| R2-10 | Grant Full Access natif en mémoire, unique par session, revérifié au dispatch. |
| R2-11 | Résolution canonique des définitions limitée à `.claude/agents/*.md`. |
| R2-12 | `browser_test` hors lecture seule ; capture regatée au dispatch. |
| R2-13 | Marqueurs structurés `SHUGU_VERIFY`, échec navigateur jamais vert. |
| R2-14 | Migration V22 et UI fondée sur `isolation_status` observé. |
| R2-15 | `profile_verified=0` pour tout historique antérieur à V22. |
| R2-16 | Commentaires critiques alignés sur fail-closed et vérité d'exécution. |

### Preuves finales de résolution

- Frontend : 546/546.
- Rust : 417/417 ; agents : 113/113.
- Build, UI tour et Playwright : verts.
- Tauri/SQLite natifs : migration V22 et grant Full Access testés visuellement.

**Audit R2 résolu :** 2026-07-22T18:58:00+02:00
