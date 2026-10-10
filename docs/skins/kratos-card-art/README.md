# Kratos skin card art

Every Ironclad card (the 61 base-set cards and the 7 Slayer Pack `slayer_*` cards) has a Kratos illustration in the Greek-era God of War 1, 2 and 3 setting. The art is generated with `gpt-image-2.5-sunburst`, quality `high`, 1536x1024, through the bundled imagegen CLI (`edit`, two candidates per card, 68 calls). It is composited into the existing Ironclad card scans so the frame, banner, title, cost orb, type tab and rules text stay the scans' own pixels; only the art window changes.

## References, in a fixed order per call

1. The committed Cleave and Shrug It Off illustrations: the style authority (bold angular silhouettes, ink outlines, flat cel-shaded planes, dark vignette).
2. `scripts/animation/sources/kratos/idle.webp`: the Kratos identity (young Greek Kratos, ash-white skin, red tattoo, goatee, Blades of Chaos; no Norse beard, fur or axe).
3. Two God of War game images chosen per card (`plan.json` `refs`), for world, costume, weapon and monster shapes.
4. The Ironclad card scan and its original text-free art (pack cards: the window cut out of the scan), so the card keeps its meaning.

`plan.json` holds one scene sentence and the game images per card. `prompts/` keeps the exact prompt of every card. `manifest.json` records model, quality, size, reference and game-image hashes and URLs, and per card the scene, chosen candidate, source, prompt and exported art SHA-256. Rejected candidates are not kept. The game images themselves stay out of git (downloaded by `fetch_refs.py` into `artifacts/skin-art/refs`; set `STS_SKIN_ART_WORK` to move the whole scratch folder, or pass `--out`); `refs.json` is the URL and hash record.

Game images used (GoW wiki, fandom):
- `athena-lvl3`: [Athena's Blades GoWII lvl3.png](https://godofwar.fandom.com/wiki/File%3AAthena%27s_Blades_GoWII_lvl3.png) (SHA-256 `94b4c0751627847b...`)
- `boc-cutscene`: [1593500 1775.jpg](https://godofwar.fandom.com/wiki/File%3A1593500_1775.jpg) (SHA-256 `22ff6b87cac8d5b7...`)
- `boc-gow1`: [919864 20050318 790screen015-1-.jpg](https://godofwar.fandom.com/wiki/File%3A919864_20050318_790screen015-1-.jpg) (SHA-256 `b95e8ffae5a6eac6...`)
- `boc-gow2`: [Gow 2 blades of chaos.png.png](https://godofwar.fandom.com/wiki/File%3AGow_2_blades_of_chaos.png.png) (SHA-256 `baa8822600df2883...`)
- `cerberus`: [God of War III Cerberus ride.jpg](https://godofwar.fandom.com/wiki/File%3AGod_of_War_III_Cerberus_ride.jpg) (SHA-256 `ea3cb37e26ddfc0c...`)
- `cestus`: [Gow3.jpg](https://godofwar.fandom.com/wiki/File%3AGow3.jpg) (SHA-256 `302ff16737b08b85...`)
- `cestus2`: [Site god-of-war-iii-ss-13.jpg](https://godofwar.fandom.com/wiki/File%3ASite_god-of-war-iii-ss-13.jpg) (SHA-256 `97bcdb075b239375...`)
- `colossus`: [GOWII-ColossusOfRhodes-1.jpg](https://godofwar.fandom.com/wiki/File%3AGOWII-ColossusOfRhodes-1.jpg) (SHA-256 `dad7fab4d3162f9f...`)
- `exile`: [1430791-blades of exile.jpg](https://godofwar.fandom.com/wiki/File%3A1430791-blades_of_exile.jpg) (SHA-256 `0740ae6e1d1e3eed...`)
- `fleece`: [895px-GOW 3 Kratos ( in game picture 3 ).jpg](https://godofwar.fandom.com/wiki/File%3A895px-GOW_3_Kratos_%28_in_game_picture_3_%29.jpg) (SHA-256 `1ce33e5ca4a3c2db...`)
- `hades`: [Hadesgow3.jpg](https://godofwar.fandom.com/wiki/File%3AHadesgow3.jpg) (SHA-256 `abf605118affb4f5...`)
- `hades2`: [Kratos-killin-hades.jpg](https://godofwar.fandom.com/wiki/File%3AKratos-killin-hades.jpg) (SHA-256 `990312b7a3f6a746...`)
- `hydra`: [Hydra Promo GoW.jpg](https://godofwar.fandom.com/wiki/File%3AHydra_Promo_GoW.jpg) (SHA-256 `cff5406be1115cf9...`)
- `kratos-athena`: [Athena (5).jpg](https://godofwar.fandom.com/wiki/File%3AAthena_%285%29.jpg) (SHA-256 `1a621f10fb20517e...`)
- `kratos1`: [56473-457.png](https://godofwar.fandom.com/wiki/File%3A56473-457.png) (SHA-256 `195093bc944b8863...`)
- `medusa`: [Medusaa.jpg](https://godofwar.fandom.com/wiki/File%3AMedusaa.jpg) (SHA-256 `9550426db7870746...`)
- `medusa2`: [Mmmde.jpg](https://godofwar.fandom.com/wiki/File%3AMmmde.jpg) (SHA-256 `9959b8cec3f93381...`)
- `minotaur`: [Minotaur (God of War Chains of Olympus).jpg](https://godofwar.fandom.com/wiki/File%3AMinotaur_%28God_of_War_Chains_of_Olympus%29.jpg) (SHA-256 `d1d410a6d271b116...`)
- `minotaur2`: [Kratos vs minotaur hammer grunt 10 - GoW.jpg](https://godofwar.fandom.com/wiki/File%3AKratos_vs_minotaur_hammer_grunt_10_-_GoW.jpg) (SHA-256 `472087aba5539dbe...`)
- `pandora-box`: [Pandora'sBoxGow2005PS3.png](https://godofwar.fandom.com/wiki/File%3APandora%27sBoxGow2005PS3.png) (SHA-256 `eb554c720252849a...`)
- `pandora-temple`: [Gate final.jpg](https://godofwar.fandom.com/wiki/File%3AGate_final.jpg) (SHA-256 `a4a5a0edd922323d...`)
- `poseidon`: [KratosMeetsPoseidon.PNG](https://godofwar.fandom.com/wiki/File%3AKratosMeetsPoseidon.PNG) (SHA-256 `0c4164117199abd1...`)
- `zeus`: [Gow3introZeus.png](https://godofwar.fandom.com/wiki/File%3AGow3introZeus.png) (SHA-256 `953d0608736519e0...`)
- `zeus2`: [KratosMeetsZeus.PNG](https://godofwar.fandom.com/wiki/File%3AKratosMeetsZeus.PNG) (SHA-256 `7531f89e27416d84...`)

## Pipeline (scripts/art/skin-cards/)

| Step | Command | Notes |
| --- | --- | --- |
| Card catalogue | `node --experimental-strip-types scripts/art/skin-cards/dump-cards.mjs` | writes `cards.json` from `src/game` |
| Game images | `python3 scripts/art/skin-cards/fetch_refs.py` | needs a browser User-Agent and Referer; records `refs.json` |
| Generate | `python3 scripts/art/skin-cards/generate.py run --all --candidates 2` | needs `OPENAI_API_KEY` and the `openai` package; resumable, skips existing candidates, retries rate limits; raw candidates go to `$STS_SKIN_ART_WORK/work-gen` (default `artifacts/skin-art/work-gen`) |
| Select | `python3 scripts/art/skin-cards/generate.py select <id>=<n> ...` | stores the chosen candidate as a WebP source (<= 150 KiB) in `scripts/art/sources/kratos-skin-cards/` and records it in `selections.json` |
| Export | `python3 scripts/art/skin-cards/export.py` | 748x420 art (<= 40 KiB) in `public/assets/skin-card-art/kratos/ironclad/` plus the manifest |
| Composite | `python3 scripts/art/skin-cards/composite.py --all --skin kratos --root public/assets` | writes `skin-cards/kratos/` (full size) and `skin-cards-sm/kratos/` (448 px), base and upgraded, keyed by the existing asset keys |
| Validate | `python3 scripts/art/skin-cards/validate.py` | needs opencv; checks every face (see below) |

Export, composite and validate make no API calls and are deterministic. `build_masks.py` rebuilds `registration.json` and `masks/` from the scans (needs opencv and scipy; only needed when the scans change).

## Why registration and masks

The scans are not pixel-registered: most sit within a few pixels of each other and ten are 960x1341. Each scan is aligned (scale plus translation) to a reference of its frame type and face, then the art window is the set of pixels that vary between cards of one frame type (art, title, cost digit, rules text), cleaned and feathered about 1 px. Pack scans share the base geometry. Composites keep each scan's own size (the 960 px scans stay 960 px wide) and the thumbnails are composited onto the existing 448 px scans.

`validate.py` reports, over all 136 faces at full size and 448 px: the art-swap difference outside the window (0 exactly), the same inside it, and the share of pixels in a 3 px ring just outside the window that still differ from the median frame of the card's rarity group (old art left over).

## In the game

A card wears the skin of the seat that owns its character in the run on screen (solo run, online snapshot, replay); screens outside a run (compendium, stats, Shop) use the viewer's saved choice. `src/ui/skin-context.tsx` provides the choices and `cardImagePath`, `cardThumbPath` and `cardArtPath` (`src/game/assets.ts`) take the skin. They resolve into `skin-cards/`, `skin-cards-sm/` and `skin-card-art/` only for the keys listed in `src/game/skin-card-faces.ts`, which `node scripts/sync-skin-card-faces.mjs` regenerates from those directories (`--check` fails when it is stale, and `verify-assets.mjs` runs that same comparison, so a stale list fails the asset verifier); every other card keeps its default scan. A card with a Gem socketed keeps the default generated socketed face for now (those faces are not re-skinned).

`scripts/verify-assets.mjs` fails when a new Ironclad card has no skin art, unless it is listed in `PENDING_SKIN_CARDS` there, and checks the inventory, dimensions, sizes and the hashes in `manifest.json`. `scripts/verify-skin-cards-browser.mjs` covers the app (screenshots in `artifacts/skin-cards/`).
