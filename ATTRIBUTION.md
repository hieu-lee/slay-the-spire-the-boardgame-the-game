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

Card scans, icons, and refreshed source art remain gitignored and are fetched on demand:

```bash
pnpm sync:assets     # cards, icons and enemy portraits
```

| What | Where it comes from |
| --- | --- |
| Card, relic and potion scans | a third-party card browser at `https://rustywolf.github.io/sts/` |
| Keyword and token icons | images embedded in the official rulebook PDF |
| Enemy portraits | the enemy card scans embedded in the same PDF, cropped to the art window |
| Board backgrounds | original OpenAI Imagegen fan illustrations created for this implementation |
| Combat status and Power pictograms | original OpenAI Imagegen fan illustrations created for this implementation |
| Title-menu and compendium backgrounds | original OpenAI Imagegen fan illustrations created for this implementation |
| Kreon typeface | Julia Petretta and the Kreon Project Authors, SIL Open Font License 1.1 |

The repository tracks 90 portraits extracted from the enemy cards. The sync scripts keep card
scans and icons out of version control; enemy portrait refreshes overwrite the tracked bundle
and should be reviewed before committing.

`public/assets/backgrounds/` contains four original act-specific backdrops,
`public/assets/combat/` contains the generated combat stage and transparent actor cutouts,
and `public/assets/status-icons/` plus `public/assets/power-icons/` contain generated
transparent HUD pictograms normalized to consistent visible bounds.
`public/assets/menu/` contains the generated title-screen spire and compendium archive backdrops.
`public/assets/fonts/Kreon.ttf` is distributed under the bundled `Kreon-OFL.txt` license.
These are original AI-generated fan illustrations made with OpenAI Imagegen for this
implementation. The character silhouettes were visually grounded in the locally synced
board-game starter-card scans; the combat stage extends the Act I background palette. No
generated asset contains a card scan, logo, or readable text.

The icon and enemy-art scripts need PyMuPDF and Pillow: `pip install pymupdf pillow`.

The official rulebook PDF is likewise fetched to `docs/reference/`, which is gitignored.
Get it from `https://contentiongames.com/_images/STS_KS_Rulebook.pdf`.

## If you are the rights holder

Open an issue and the referenced material will be removed.

## Please buy the game

<https://contentiongames.com/games/slay/>
