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

Publisher card scans, rulebook icons, and eleven Act I reference crops are fetched locally
and remain gitignored:

```bash
pnpm sync:assets     # optional card faces, icons, and reference Act I enemy crops
```

| What | Where it comes from |
| --- | --- |
| Card, relic and potion scans | a third-party card browser at `https://rustywolf.github.io/sts/` |
| Keyword and token icons | images embedded in the official rulebook PDF |
| Enemy reference crops | eleven enemy card scans embedded in the same PDF, cropped to the art window |
| Four act-specific boss backdrops (`public/assets/backgrounds/`) | original OpenAI Imagegen fan illustrations created for this implementation |
| Combat stage, actor cutouts, animation VFX, card illustrations, status, relic, potion and selected Power icons | original OpenAI Imagegen fan illustrations created for this implementation |
| Merchant room illustration (`public/assets/noncombat/merchant.webp`) | original OpenAI Imagegen fan illustration created for this implementation |
| Neow cutout (`public/assets/neow/neow.webp`) | user-supplied transparent Slay the Spire character artwork; optimized to WebP for this UI |
| Title-menu and compendium backgrounds | original OpenAI Imagegen fan illustrations created for this implementation |
| Kreon typeface | Julia Petretta and the Kreon Project Authors, SIL Open Font License 1.1 |
| UI, card and combat sound effects | `80 CC0 RPG SFX` by rubberduck, released under CC0 on OpenGameArt |

The sync scripts keep card scans, rulebook icons, source-resolution working files, and
unused enemy variants out of version control. Runtime enemy artwork is the committed
transparent combat-cutout inventory; the enemy sync only regenerates eleven optional
Act I reference crops.

`public/assets/card-art/` contains one committed, text-free generated illustration for
each character card. These are original OpenAI Imagegen restorations visually grounded
in the corresponding locally synced illustration window; the UI supplies its own frame,
title and rules text. Base and upgraded faces reuse the same illustration.

`public/assets/combat/` contains the generated Act I combat stage, transparent actor
cutouts and alternate attack poses for four characters, plus all 61 canonical enemy designs. These are original
AI-generated fan illustrations made with OpenAI Imagegen for this implementation. The
new enemy batch was visually grounded in complete enemy cards from the official Slay the
Spire board-game Tabletop Simulator workshop rather than the former low-resolution crops.
No generated asset contains a card scan, logo, or readable text.

`public/assets/combat/vfx/` contains five original transparent OpenAI Imagegen effects
used by the shared idle, hit and defeat animations for every combat actor.

`public/assets/status-icons/`, `public/assets/relic-icons/`, and
`public/assets/potion-icons/` contain committed generated transparent symbols visually grounded
in crops from their corresponding physical cards. `public/assets/power-icons/` contains
twenty-eight committed generated Power symbols. Cards without a dedicated Power symbol use a
generated generic status symbol.

`public/assets/menu/` contains the generated title-screen spire and compendium archive backdrops.
`public/assets/fonts/Kreon.ttf` is distributed under the bundled `Kreon-OFL.txt` license.

`public/assets/sfx/` contains renamed, unmodified sounds from
<https://opengameart.org/content/80-cc0-rpg-sfx> (`wood_01`, `book_01`,
`book_02`, `blade_01`, `spell_01`, `spell_02`, `creature_hurt_01`,
`creature_hurt_02`, `creature_die_01`, `metal_01`, `item_gem_03`, and
`item_gem_04`). The pack is released under CC0 1.0.

The icon and enemy-art scripts need PyMuPDF and Pillow: `pip install pymupdf pillow`.

The official rulebook PDF is likewise fetched to `docs/reference/`, which is gitignored.
Get it from `https://contentiongames.com/_images/STS_KS_Rulebook.pdf`.

## If you are the rights holder

Open an issue and the referenced material will be removed.

## Please buy the game

<https://contentiongames.com/games/slay/>
