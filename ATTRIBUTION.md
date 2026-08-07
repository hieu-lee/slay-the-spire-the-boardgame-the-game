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

## What this repository does NOT contain

**No artwork is committed.** `public/assets/cards/` is gitignored.

Everything under `public/assets/` is gitignored and fetched on demand:

```bash
pnpm sync:assets     # cards, icons and enemy portraits
```

| What | Where it comes from |
| --- | --- |
| Card, relic and potion scans | a third-party card browser at `https://rustywolf.github.io/sts/` |
| Keyword and token icons | images embedded in the official rulebook PDF |
| Enemy portraits | the enemy card scans embedded in the same PDF, cropped to the art window |

They are stored only on the machine that runs the scripts. Redistributing the publisher's
artwork in this repository would be a different act from referencing it locally, so the
repository does not do it.

The icon and enemy-art scripts need PyMuPDF and Pillow: `pip install pymupdf pillow`.

The official rulebook PDF is likewise fetched to `docs/reference/`, which is gitignored.
Get it from `https://contentiongames.com/_images/STS_KS_Rulebook.pdf`.

## If you are the rights holder

Open an issue and the referenced material will be removed.

## Please buy the game

<https://contentiongames.com/games/slay/>
