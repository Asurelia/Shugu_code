# Step 07: Tests

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Test Analysis and Creation

Onze tests unitaires dédiés couvrent le contrat de cycle :

- fin informative sans travail artificiel ;
- exemption read-only ;
- mutation sans plan ;
- plan + mutation sans test ;
- test dans le même tour parallèle ;
- commande exit 1 ;
- commande exit 0 dans un tour ultérieur ;
- mutation après test vert ;
- `browser_test` vert ;
- mutation échouée ;
- bannière de risque précédant l'exit code.

Tests d'intégration/produit utilisés : Vitest complet, Rust complet, smoke
Playwright du bundle, tour UI multi-vues avec captures, puis démarrage natif via
`tauri-dev-log.cmd` et capture de la vraie fenêtre WebView2.
