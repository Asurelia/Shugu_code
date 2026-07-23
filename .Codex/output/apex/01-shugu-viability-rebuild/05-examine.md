# Step 05: Examine

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Adversarial Review

Questions appliquées au contrat :

1. Un simple texte « terminé » peut-il encore contourner la preuve ? Non après
   mutation : il déclenche un tour de réparation.
2. Un test rouge peut-il compter comme vert puisque `run_command` renvoie un
   `ToolResult` normal ? Non : l'exit code structuré est parsé.
3. Un test parallèle à l'écriture peut-il courir avant elle ? Il n'est pas
   accepté ; la preuve doit venir d'un tour strictement postérieur.
4. Une correction après test vert peut-elle conserver une preuve périmée ? Non,
   chaque mutation réussie invalide la preuve.
5. Un write échoué impose-t-il inutilement une dette ? Non.
6. Une commande avec bannière `[RISK: ...]` masque-t-elle `[exit 0]` ? Oui dans
   la première version : défaut trouvé pendant la revue.
7. Les tours informatifs et le mode Plan sont-ils forcés à modifier/tester ? Non.

Limite volontaire de cette tranche : le contrôleur reconnaît une commande
verte comme preuve d'exécution, mais ne classe pas encore sa pertinence
sémantique (par exemple empêcher `dir` d'être présenté comme un test). Le plan
global prévoit un `VerificationPolicy` typé et des scénarios de tâche complets.

## Revue contradictoire tranche 2 — profils et sandbox

Trois revues indépendantes (sécurité, logique/concurrence, maintenabilité) ont
inspecté le diff et les chemins IPC réels. Les doublons ci-dessous sont fusionnés.

| ID | Sévérité | Catégorie | Constat | Validité |
|---|---|---|---|---|
| R2-01 | Critique | Autorisation | Un `executionProfile=plan/chat` sans `mode` cohérent pouvait être promu en Auto. | Réel |
| R2-02 | Critique | Lifecycle | `run_command` pouvait muter le workspace sans être compté comme mutation ; un plan pouvait arriver après l'écriture. | Réel |
| R2-03 | Critique | Annulation | Kill abandonnait le future Rust sans tuer le processus bloquant/enfant. | Réel |
| R2-04 | Haute | Concurrence | Deux commandes Auto parallèles couraient sur le même label MIC transitoire. | Réel |
| R2-05 | Haute | État | Une course Kill/Complete pouvait écraser `killed` par `complete`/`error`. | Réel |
| R2-06 | Haute | HITL | La reprise perdait profil/isolation et consommait l'interaction avant que le nouveau run existe. | Réel |
| R2-07 | Haute | MCP | Les outils MCP inconnus contournaient la promesse workspace d'Auto. | Réel |
| R2-08 | Haute | Règles | Une erreur de lecture des `deny` retombait sur une liste vide ; l'ordre allow/deny était non déterministe. | Réel |
| R2-09 | Haute | Sandbox | Lectures et réseau restent ouverts ; les caches utilisateur LOW persistants élargissaient la surface supply-chain. | Réel |
| R2-10 | Haute | Full Access | Le backend faisait confiance à la valeur IPC sans activation native sessionnelle. | Réel |
| R2-11 | Haute | IPC | `agent_def_path` pouvait pointer vers un fichier arbitraire. | Réel |
| R2-12 | Haute | Outils | `browser_test` était autorisé en lecture seule bien qu'il clique/remplisse/lance Chrome ; capture n'était pas regatée au dispatch. | Réel |
| R2-13 | Haute | Preuve | Un résumé `browser_test` FAILED pouvait compter vert ; les descripteurs d'effets étaient dupliqués. | Réel |
| R2-14 | Moyenne | Observabilité | Logs `blocked=false` malgré provenance bloquée ; isolation demandée affichée comme effective. | Réel |
| R2-15 | Moyenne | Historique | Les anciens runs reçoivent `auto` par défaut sans prouver leur ancien confinement. | Réel |
| R2-16 | Moyenne | Qualité | Commentaires/fonctions décrivaient encore l'ancien fallback direct. | Réel |

### Décision

Configuration APEX `auto=true` : correction automatique de tous les constats
réels avant de reprendre le chantier providers. Aucun constat classé bruit ou
incertain n'est modifié.

---
## Step Complete — tranche 2
**Status:** ✓ Complete
**Findings:** 16 fusionnés
**Critical:** 3
**Next:** step-06-resolve.md
**Timestamp:** 2026-07-22T17:49:06+02:00
