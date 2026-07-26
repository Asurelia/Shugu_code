# Security advisories

Dernière revue locale : 26 juillet 2026.

`pnpm audit` doit terminer sans advisory JavaScript connu. `cargo audit` garde
trois exceptions explicites et vérifiables ; aucune ne correspond à du code
atteignable dans le binaire Windows SQLite de Shugu.

| Advisory | Dépendance verrouillée | Justification bornée | Sortie attendue |
|---|---|---|---|
| RUSTSEC-2026-0194 | `quick-xml` 0.30/0.39 | Dépendances de build Linux de `xcb` et `wayland-scanner`, via `xcap`. Elles analysent les descriptions de protocoles XML embarquées au build, pas une entrée utilisateur. La chaîne Tauri active a été migrée vers `plist` 1.10 / `quick-xml` 0.41. | Retirer l’exception dès que `xcb` et `wayland-scanner` acceptent `quick-xml >=0.41`. |
| RUSTSEC-2026-0195 | `quick-xml` 0.30/0.39 | Même chaîne et même absence d’entrée XML non fiable que ci-dessus. | Même condition de sortie. |
| RUSTSEC-2023-0071 | `rsa` 0.9.10 | Paquet optionnel verrouillé par `sqlx-mysql`; `cargo tree --target all -i rsa@0.9.10` est vide et `tauri-plugin-sql` est compilé uniquement avec la feature `sqlite`. Shugu n’effectue donc aucune opération RSA avec ce crate. RustSec ne publie aucune version corrigée. | Retirer l’exception si SQLx cesse de verrouiller `rsa` ou si un backend MySQL est ajouté. |

Les exceptions sont passées individuellement à `cargo audit`; tout nouvel avis
reste bloquant. Les avertissements RustSec `unmaintained`/`unsound` non classés
comme vulnérabilités restent visibles dans la sortie et doivent être revus lors
de chaque mise à niveau Tauri, `xcap`, `fastembed` ou ripgrep.

Revue du 26 juillet : `pnpm audit` est revenu à zéro après retrait de
`@convex-dev/react-query` (dépendance inutilisée de la synchro Convex dormante)
et verrouillage de `brace-expansion` 5.0.8. Les avis RustSec atteignables
`anyhow` et `memmap2` ont été corrigés respectivement en 1.0.104 et 0.9.11 ;
la commande bornée ci-dessus reste verte avec uniquement les trois exceptions
du tableau.
