# Attribution and provenance

This is an unofficial, non-commercial fan implementation. It is not affiliated with,
endorsed by, or licensed by Contention Games or Mega Crit.

## The game

*Slay the Spire: The Board Game* is designed by Gary Dworetsky, Anthony Giovannetti and
Casey Yano, and published by **Contention Games**. It is based on the video game *Slay the
Spire* by **Mega Crit**. All game rules, card text, character and enemy designs, and
artwork are their intellectual property.

## What this repository contains

Code, and factual data about the game: card names, energy costs, rarities, deck
compositions, enemy statistics and rules text expressed as data. Facts about a game are
not themselves copyrightable, and they are recorded here so the engine can be verified
against the published rules.

## Artwork

Publisher card scans and rulebook icons are fetched locally and remain gitignored:

```bash
pnpm sync:assets     # cards, icons and enemy portraits
```

| What | Where it comes from |
| --- | --- |
| Card, relic and potion scans | a third-party card browser at `https://rustywolf.github.io/sts/` |
| Keyword and token icons | images embedded in the official rulebook PDF |
| Enemy portraits | the enemy card scans embedded in the same PDF, cropped to the art window |
| Combat stage, actor cutouts, status and selected Power icons | original OpenAI Imagegen fan illustrations created for this implementation |

The sync scripts keep those scans, rulebook icons, source-resolution working files, and
extracted legacy enemy portraits out of version control.

`public/assets/combat/` contains the generated Act I combat stage and transparent actor
cutouts for four characters and eleven Act I enemies. These are original AI-generated fan
illustrations made with OpenAI Imagegen for this implementation. The character silhouettes
were visually grounded in the locally synced board-game starter-card scans. No generated
asset contains a card scan, logo, or readable text.

`public/assets/status-icons/` contains fourteen committed generated combat-status symbols,
and `public/assets/power-icons/` contains twenty-eight committed generated Power symbols.
Cards without a dedicated Power symbol use a generated generic status symbol.

The icon and enemy-art scripts need PyMuPDF and Pillow: `pip install pymupdf pillow`.

The official rulebook PDF is likewise fetched to `docs/reference/`, which is gitignored.
Get it from `https://contentiongames.com/_images/STS_KS_Rulebook.pdf`.

## If you are the rights holder

Open an issue and the referenced material will be removed.

## Please buy the game

<https://contentiongames.com/games/slay/>
