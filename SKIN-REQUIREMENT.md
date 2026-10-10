# Skin requirements

A skin changes how one hero looks and sounds, never how it plays. Rules, RNG, saves and
hashes never read a skin. Kratos (Ironclad's skin, id `kratos`) is the reference
implementation: copy its file names and checks when you add the next one.

Naming rule: a skin's assets live in the same folders and filename patterns as a
character's, with the **skin id** in place of the character id (`kratos-hero.webp`,
`portrait-kratos.png`, ...). The game keys art by a *visual id*: the skin id when a valid
skin is worn, otherwise the character id (`visualId()` in `src/game/skins.ts`).

## 1. Identity (code): the registration steps

A new skin needs exactly these edits; nothing else enumerates skins by hand.

- [ ] `src/game/skins.ts`: add the skin to `SKINS` (`<character>: ['<skin>']`), `SKIN_LABELS` and
  `SKIN_TRAITS`. Profile, lobby, saves, rooms, run logs and validators pick it up from `SKINS`;
  `SKIN_LABELS` and `SKIN_TRAITS` are `Record<SkinId, ...>`, so `tsc -b` fails until they exist.
  Traits are what code reads by visual id instead of testing a literal skin id:
  `energyOrb` (the skin paints `combat/energy-orbs/<skin>.webp` and the HUD swaps the orb) and
  `stagedAttack` (its attack animation damages enemies hit by hit, so the HP drop waits for it).
- [ ] `src/ui/combat-vfx.ts` (`actorAttack`, `actorTone`) and `src/ui/combat-sfx.ts` (`CHARACTER_RATE`):
  one entry each, `Record<CharacterId | SkinId, ...>`, so `tsc -b` enforces them. Use the hero's
  values when the skin does not change the feel.
- [ ] `src/ui/hero-art-head.json` and `scripts/calibrate-hero-head.py`: the hero-head point of the
  new idle art (hero potions and heads are positioned from it; `verify-assets.mjs` fails without it).
- [ ] `node scripts/sync-skin-card-faces.mjs` after the card art exists: regenerates
  `src/game/skin-card-faces.ts`, which lists the cards the skin has faces for.
  `verify-assets.mjs` runs the same comparison (`--check` mode), so a stale module fails it.
- [ ] `scripts/check-single-player-build.mjs`: assert one of the skin's card faces reaches the Pages output.
- [ ] Only if the skin has its own attack animation: the generated timing in
  `src/ui/styles/attack-timing.css` and `src/ui/combat-screen/vfx.tsx` (see
  `scripts/animation/kratos.py`) plus the animation code in `CombatScreen.tsx`. That code is the
  Kratos skin's animation, named and keyed by its id; a second animated skin adds its own and
  must not reuse the `kratos-*` classes.

Picked up automatically from `SKINS`/`VISUAL_IDS`: campfire scene names (`src/game/assets.ts`),
the Profile picker, and the inventories in `verify-assets.mjs`, `verify-ui-helpers.mjs` and
`verify-skins.mjs`. Those three are the only verifiers that iterate the registry; every browser
verifier names `kratos` explicitly, so a new skin must add its own cases (section 4).

## 2. Art every skin must ship

| # | What | Path pattern | Size / format |
|---|------|--------------|---------------|
| 1 | Card art for every card the hero can own: starter deck, every reward-pool card, and every purchasable pack card of that hero (Slayer Pack) | `skin-card-art/<skin>/<owner>/<cardId>.webp` (text-free art), `skin-cards/<skin>/<assetKey>.webp` (full face), `skin-cards-sm/<skin>/<assetKey>.webp` (448 px face), base **and** upgraded (`+`) | art 748×420 ≤ 40 KiB; faces keep the hero's own scan size; WebP |
| 2 | Combat idle sprite | `combat/characters/<skin>-hero.webp`, `combat/characters/<skin>.webp` (list/summary icon) | 1152×1152 and 512×512, native alpha |
| 3 | Attack animation (timed poses, hit logic stays the hero's) | `combat/characters/animated/<skin>-<pose>.webp` plus generated timing in `src/ui/styles/attack-timing.css`, `combat-screen/vfx.tsx` | one drawing per pose, fixed canvas, ground anchor |
| 4 | Attack VFX | `combat/vfx/actions/<skin>/{light,impact}.webp` | 512×512, native alpha |
| 5 | Attack sounds | `sfx/<skin>-*.mp3` (cues synchronised to the animation beats) | decodable mp3, volumes in `combat-sfx.ts` |
| 6 | Energy orb (enable the `energyOrb` trait) | `combat/energy-orbs/<skin>.webp` | 256×256, native alpha |
| 7 | Treasure hand model (open hand and gripping hand) | `noncombat/treasure/hand-<skin>.webp`, `noncombat/treasure/grip-<skin>.webp` | 384×1024, native alpha |
| 8 | Merchant standing figure | `noncombat/merchant/characters/<skin>-standing.webp` | 400×576, native alpha |
| 9 | Campfire scenes: one per party that can contain the skin. The party is named by visual ids in `VISUAL_IDS` order; the skin replaces its hero, so it needs every combination of the other heroes (0 to 3 of them) | `noncombat/campfire/<party>_firecamp.webp` (the solo scene is `<skin>_firecamp.webp`) | 3840×2161 WebP (64 scenes for a hero with seven companions) |
| 10 | Character-select portrait and wallpaper | `menu/character-select/portrait-<skin>.png`, `menu/character-select/character-<skin>-wallpaper.webp` | 256×384 and 1536×864 |
| 11 | Profile tile | uses the portrait (10); no extra file | |

Not skinned on purpose: the hero's compendium/stats/leaderboard icon
(`menu/compendium-icons/<character>.webp`), the run summary damage chart icon (hero icon), the hero's relic, powers and power icons,
cursed/status art, enemy art.

## 3. Things that are easy to miss

- Head calibration for hero potions (`hero-art-head.json`, `scripts/calibrate-hero-head.py`).
- Reduced-motion static art for the attack animation, and cold-play fallback to the idle drawing.
- The Gem-socketed card faces (`cards-socketed-sm/`) are not skinned: a card with an attached
  Gem shows the default face.
- Every new card the hero gains later needs skin art too; `verify-assets.mjs` fails until the
  face and art exist (or the card is explicitly listed as pending).
- Both screen classes: desktop and horizontal phone. Check the idle, attack, hand, treasure,
  merchant, campfire, select screen and Profile tile on both.
- Pages size budget: `dist` must stay under the Pages cap (`scripts/check-single-player-build.mjs`);
  campfire scenes and large attack art are served through the CDN rules in `src/game/assets.ts`.
- Provenance: record model, references, prompts and SHA-256 under `docs/skins/<skin>-*/`
  (see `docs/skins/kratos-card-art/README.md`) and add third-party reference credits to
  `ATTRIBUTION.md`.
- Availability: skins are bought, then worn from Profile or the Shop. See section 5.

## 4. Tests to extend

- `scripts/verify-skins.mjs` (registry, pairs, `visualId`, runs/rooms carry a valid skin only).
- `scripts/verify-assets.mjs` (inventories for every path above, dimensions, alpha, hashes).
- `scripts/verify-skin-browser.mjs`, `verify-skin-cards-browser.mjs`, `verify-skin-profile-browser.mjs`
  (what a skinned hero shows in solo and in an online room; the Profile picker).
- `scripts/verify-<skin>-animation-browser.mjs` (timing, contact line, planted feet, reduced
  motion) for skins that have their own attack animation.
- Treasure, merchant, campfire and art-scene browser verifiers (`verify-treasure-animation-browser.mjs`,
  `verify-merchant-overflow-browser.mjs`, `verify-art-scenes-browser.mjs`): each lists `kratos` by hand,
  so add the new skin's expected asset paths there.
- `scripts/verify-pipeline.mjs` and `scripts/lib/affected-verifiers.mjs`: list the new verifiers under
  the files that own the behavior (a duplicate owner entry throws).

## 5. Purchase and ownership (every skin is for sale)

Every skin costs coins from the account's wallet (docs/shop.md). Adding a skin needs:

- [ ] `src/game/coins.ts`: a price in `SKIN_PRICES` (`Record<SkinId, number>`, so `tsc -b` fails
  until it exists; 2,500 = `SKIN_PRICE` for every skin so far).
- [ ] Nothing else lists it: the Shop's Skins tab (`ShopScreen.tsx`), Profile's locked and owned
  tiles, the wallet (`skins`, `buySkin`), and the server (`syncAccountWallet`) all derive from
  `SKINS` and `SKIN_PRICES`.
- [ ] Ownership gating: `src/skin-preference.ts` only reads back skins the wallet owns
  (`preferredSkin`, `savedSkinChoices`), so character select, solo and online starts, Profile
  and `skin-context.tsx` never show an unowned skin. New code must read the worn skin through
  those functions, never from `localStorage` or a run it did not start.
- [ ] Browser fixtures that wear the skin through the preference must give the account's wallet
  `skins: ['<skin>']` (`sts-wallet:<username>`); runs built from a fixture that already carries
  `skin` need nothing.
- [ ] Extend `verify-shop-browser.mjs` (buy, refusal, owned and Wear/Worn, locked racks, short
  windows), `verify-skin-profile-browser.mjs` (locked tile with price opens the Shop, owned tile
  selectable, unowned choice ignored), `verify-wallet.mjs`, `verify-account-wallets.mjs` and
  `verify-wallet-sync-browser.mjs` for anything price- or ownership-specific.
