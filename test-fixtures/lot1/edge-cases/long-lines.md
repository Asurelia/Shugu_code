# LOT 1 — Word wrap toggle test

Ce fichier contient des lignes très longues pour vérifier le toggle word wrap. Avec wrap OFF, ces lignes doivent déborder horizontalement et nécessiter un scroll. Avec wrap ON (Alt+Z ou Settings → Editor → Word wrap), elles doivent se replier visuellement à la largeur de l'éditeur.

C'est un paragraphe délibérément verbeux conçu pour être plus large que toute fenêtre d'éditeur raisonnable, de sorte que lorsque le retour à la ligne est activé tu puisses voir le wrap visuel sans scroller, et lorsque le retour à la ligne est désactivé la scrollbar horizontale en bas de l'éditeur devienne active et indique que la ligne continue hors-écran. Le contenu réel du document reste identique quel que soit le réglage de wrap — seul le rendu visuel change.

## A code block (should NOT wrap whitespace-significantly)

```typescript
const veryLongVariableName_thatDeliberatelyExtendsBeyondNormalScreenWidth_toTestThatCodeBlocks_doNotWordWrapDestructivelyEvenWhenSurroundingTextDoes: string = "this is fine";
```

## Test checklist (visuel)

- [ ] Avec wrap OFF, ce paragraphe déborde horizontalement.
- [ ] Avec wrap ON, ce paragraphe reste dans la largeur de l'éditeur.
- [ ] Curseur placé au milieu d'un mot survit le toggle (pas de saut à la colonne 1).
- [ ] Scroll position survit le toggle.
- [ ] Toggle depuis Settings → Editor → Word wrap fait la même chose que `Alt+Z`.

## Une seule très très longue ligne

Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum.
