# Downfall card artwork audit — 8 September 2026

Compared all 198 installed Slime Boss, Hexaghost, and Hermit definitions (394 base/upgraded faces) with the full-resolution bundled card artwork. Guardian is recorded separately in [guardian-card-audit.md](guardian-card-audit.md).

Coverage: printed costs, card types, effect values, resource icons, targeting, conditional clauses, Retain/Exhaust, upgrade changes, and all 13 Slime level tables. Hermit's Golden Ticket is included in its definition count; Slime Boss and Hexaghost reward-ticket handling is covered by their existing acquisition verifiers. Duplicate physical copies are counted once per face.

Energy, Strength, Soulburn, and Guardian Vigor are distinct resources. Slime Strength retains the historical internal field name `vigor`; it is not Guardian Vigor. Multiple hit icons share a target unless the card explicitly permits separate targets (rules.md, multi-hits); plain “damage” uses the unmodified damage path. Snapshot follows the recorded official FAQ's printed-damage rule.

Six card definitions needed corrections, on both faces, listed below. Shared Command resolution also now skips a target killed by an earlier Command without spending the later Slime's command allowance; unknown targets still fail validation. Horizontal-phone combat also reserves space for End turn so it cannot cover active Power buttons. This existing regression failed on unchanged master and now passes.

## Validation

- `node scripts/verify-downfall-card-audit.mjs`: 13 focused gameplay checks covering all six corrections, both faces, resource payment, modifiers, zero Slimes, private-zone/invalid Curse selection, and a stale target midway through Ooze Bath. All 13 fail on pristine pre-fix master, all pass after the corrections.
- `node scripts/verify-downfall-hexaghost.mjs`, `node scripts/verify-downfall-hermit.mjs`, `node scripts/verify-downfall-slime.mjs`: existing character mechanics and acquisition coverage.
- `node scripts/verify-downfall-card-browser.mjs`: base/upgraded Shadow Cloak hand-Curse selection and Forked Flame single-target play on desktop 1440×900 and horizontal phone 844×390. Shared CombatScreen serves solo and online; authoritative gameplay checks reject foreign card IDs. Screenshots in ignored `artifacts/downfall-card-audit/`.
- `pnpm build`: TypeScript and production build.

This is a visual definition audit plus focused runtime regressions and existing character suites, not an exhaustive test of every possible card combination.

## Slime Boss — 67 definitions, 133 faces

| Card | Faces | Result |
| --- | --- | --- |
| Armored Slime | Base + upgrade | Printed definition matches. |
| Bruiser Slime | Base only | Printed definition matches. |
| Combo Tackle | Base + upgrade | Printed definition matches. |
| Consult Playbook | Base + upgrade | Printed definition matches. |
| Darkling Duo | Base + upgrade | Printed definition matches. |
| Defend | Base + upgrade | Printed definition matches. |
| Delegate | Base + upgrade | Printed definition matches. |
| Digest | Base + upgrade | Printed definition matches. |
| Dive Tackle | Base + upgrade | Printed definition matches. |
| Divide & Conquer | Base + upgrade | Printed definition matches. |
| Duplicated Form | Base + upgrade | Printed definition matches. |
| Evolution Slime | Base + upgrade | Printed definition matches. |
| Feeding Frenzy | Base + upgrade | Printed definition matches. |
| Flame Tackle | Base + upgrade | Printed definition matches. |
| Forward Tackle | Base + upgrade | Printed definition matches. |
| Glop Chop | Base + upgrade | Printed definition matches. |
| Gluttony | Base + upgrade | Printed definition matches. |
| Goop Armor | Base + upgrade | Printed definition matches. |
| Goop Spray | Base + upgrade | Printed definition matches. |
| Growth | Base + upgrade | Fixed: both faces cost 2 Energy. |
| Haunting Lick | Base + upgrade | Printed definition matches. |
| Hungry Tackle | Base + upgrade | Printed definition matches. |
| It Looks Tasty | Base + upgrade | Printed definition matches. |
| Just Desserts | Base + upgrade | Printed definition matches. |
| Leech Energy | Base + upgrade | Fixed: conditional printed Block uses the standard Block modifiers and triggers. |
| Leeching Slime | Base + upgrade | Printed definition matches. |
| Level Up | Base + upgrade | Printed definition matches. |
| Lick | Base + upgrade | Printed definition matches. |
| Living Wall | Base + upgrade | Printed definition matches. |
| Massive Slime | Base + upgrade | Printed definition matches. |
| Minion Master | Base + upgrade | Printed definition matches. |
| Muscle Slime | Base + upgrade | Printed definition matches. |
| Nibble and Lick | Base + upgrade | Printed definition matches. |
| Ooze Bath | Base + upgrade | Printed definition matches. |
| Opening Tackle | Base + upgrade | Printed definition matches. |
| Overexert | Base + upgrade | Printed definition matches. |
| Pile On! | Base + upgrade | Fixed: one 1/2-damage hit per Slime, including zero hits with no Slimes. |
| Prepare Crush | Base + upgrade | Fixed: 15/20 plain damage ignores hit modifiers; discard after resolving. |
| Protect the Boss | Base + upgrade | Printed definition matches. |
| Psychic Slime | Base + upgrade | Printed definition matches. |
| Quick Snack | Base + upgrade | Printed definition matches. |
| Rain of Goop | Base + upgrade | Printed definition matches. |
| Rally the Troops | Base + upgrade | Printed definition matches. |
| Ravenous Tackle | Base + upgrade | Printed definition matches. |
| Recklessness | Base + upgrade | Printed definition matches. |
| Recollect | Base + upgrade | Printed definition matches. |
| Reformation | Base + upgrade | Printed definition matches. |
| Relentless Tackle | Base + upgrade | Printed definition matches. |
| Replication | Base + upgrade | Printed definition matches. |
| Repurpose | Base + upgrade | Printed definition matches. |
| Royal Slime | Base + upgrade | Printed definition matches. |
| Scrappy Slime | Base + upgrade | Printed definition matches. |
| Shape of Puddle | Base + upgrade | Printed definition matches. |
| Slime Brawl | Base + upgrade | Printed definition matches. |
| Slime Slap | Base + upgrade | Printed definition matches. |
| Slime Tap | Base + upgrade | Printed definition matches. |
| Slippery | Base + upgrade | Printed definition matches. |
| Smothering Tackle | Base + upgrade | Printed definition matches. |
| Spear Tackle | Base + upgrade | Printed definition matches. |
| Spike Slime | Base + upgrade | Printed definition matches. |
| Spit | Base + upgrade | Printed definition matches. |
| Spreading Slime | Base + upgrade | Printed definition matches. |
| Sticky Slime | Base + upgrade | Printed definition matches. |
| Strike | Base + upgrade | Printed definition matches. |
| Taunting Slime | Base + upgrade | Printed definition matches. |
| Tongue Lash | Base + upgrade | Printed definition matches. |
| Vicious Tackle | Base + upgrade | Printed definition matches. |

## Hexaghost — 64 definitions, 128 faces

| Card | Faces | Result |
| --- | --- | --- |
| Advancing Guard | Base + upgrade | Printed definition matches. |
| Bad Omen | Base + upgrade | Printed definition matches. |
| Bright Ritual | Base + upgrade | Printed definition matches. |
| Burning Touch | Base + upgrade | Printed definition matches. |
| Catch Up | Base + upgrade | Printed definition matches. |
| Charged Barrage | Base + upgrade | Printed definition matches. |
| Defend | Base + upgrade | Printed definition matches. |
| Devil's Dance | Base + upgrade | Printed definition matches. |
| Devour Flame | Base + upgrade | Printed definition matches. |
| Divider | Base + upgrade | Printed definition matches. |
| Doomsday | Base + upgrade | Printed definition matches. |
| Eerie Expedition | Base + upgrade | Printed definition matches. |
| Empowered Flame | Base + upgrade | Printed definition matches. |
| Extra Crispy | Base + upgrade | Printed definition matches. |
| Fast Forward | Base + upgrade | Printed definition matches. |
| Firestarter | Base + upgrade | Printed definition matches. |
| Flames from Beyond | Base + upgrade | Printed definition matches. |
| Flare Flick | Base + upgrade | Printed definition matches. |
| Fleeting Flash | Base + upgrade | Printed definition matches. |
| Float | Base + upgrade | Printed definition matches. |
| Floatwork | Base + upgrade | Printed definition matches. |
| Forked Flame | Base + upgrade | Fixed: three hits share one target; modifiers apply to each hit. |
| Ghost Lash | Base + upgrade | Printed definition matches. |
| Ghost Shield | Base + upgrade | Printed definition matches. |
| Haunted Hand | Base + upgrade | Printed definition matches. |
| Haunting Echo | Base + upgrade | Printed definition matches. |
| Heat Crush | Base + upgrade | Printed definition matches. |
| Heat Metal | Base + upgrade | Printed definition matches. |
| Heat Shield | Base + upgrade | Printed definition matches. |
| Hexaguard | Base + upgrade | Printed definition matches. |
| Incineration | Base + upgrade | Printed definition matches. |
| Incorporeal | Base + upgrade | Printed definition matches. |
| Infernal Form | Base + upgrade | Printed definition matches. |
| Instant Inferno | Base + upgrade | Printed definition matches. |
| Kindle | Base + upgrade | Printed definition matches. |
| Lingering Shades | Base + upgrade | Printed definition matches. |
| Living Bomb | Base + upgrade | Printed definition matches. |
| Nightmare Guise | Base + upgrade | Printed definition matches. |
| Nightmare Strike | Base + upgrade | Printed definition matches. |
| Nightmare Vision | Base + upgrade | Printed definition matches. |
| Phantom Fireball | Base + upgrade | Printed definition matches. |
| Poltergeist | Base + upgrade | Printed definition matches. |
| Power from Beyond | Base + upgrade | Printed definition matches. |
| Premonition | Base + upgrade | Printed definition matches. |
| Radiant Reverb | Base + upgrade | Printed definition matches. |
| Rain of Embers | Base + upgrade | Printed definition matches. |
| Rewind | Base + upgrade | Printed definition matches. |
| Sear | Base + upgrade | Printed definition matches. |
| Searing Wound | Base + upgrade | Printed definition matches. |
| Seventh Eye | Base + upgrade | Printed definition matches. |
| Shield of Night | Base + upgrade | Printed definition matches. |
| Spectral Grace | Base + upgrade | Printed definition matches. |
| Step Through | Base + upgrade | Printed definition matches. |
| Stoke the Fire | Base + upgrade | Printed definition matches. |
| Strike | Base + upgrade | Printed definition matches. |
| Sword of Night | Base + upgrade | Printed definition matches. |
| Thermal Transfer | Base + upgrade | Printed definition matches. |
| Time of Need | Base + upgrade | Printed definition matches. |
| Turn It Up | Base + upgrade | Printed definition matches. |
| Unleash Spirits | Base + upgrade | Printed definition matches. |
| Unlimited Power | Base + upgrade | Printed definition matches. |
| Volcano Visage | Base + upgrade | Printed definition matches. |
| Whisper from Beyond | Base + upgrade | Printed definition matches. |
| Worthy Sacrifice | Base + upgrade | Printed definition matches. |

## Hermit — 67 definitions, 133 faces

| Card | Faces | Result |
| --- | --- | --- |
| Black Wind | Base + upgrade | Printed definition matches. |
| Body Armor | Base + upgrade | Printed definition matches. |
| Brawl | Base + upgrade | Printed definition matches. |
| Called Shot | Base + upgrade | Printed definition matches. |
| Cheat | Base + upgrade | Printed definition matches. |
| Coalescence | Base + upgrade | Printed definition matches. |
| Combo | Base + upgrade | Printed definition matches. |
| Covet | Base + upgrade | Printed definition matches. |
| Cursed Weapon | Base + upgrade | Printed definition matches. |
| Dead Or Alive | Base + upgrade | Printed definition matches. |
| Deadeye | Base + upgrade | Printed definition matches. |
| Defend | Base + upgrade | Printed definition matches. |
| Desperado | Base + upgrade | Printed definition matches. |
| Determination | Base + upgrade | Printed definition matches. |
| Dive | Base + upgrade | Printed definition matches. |
| Enervate | Base + upgrade | Printed definition matches. |
| Eternal Form | Base + upgrade | Printed definition matches. |
| Eye Of The Storm | Base + upgrade | Printed definition matches. |
| Fan the Hammer | Base + upgrade | Printed definition matches. |
| Fatal Desire | Base + upgrade | Printed definition matches. |
| Feint | Base + upgrade | Printed definition matches. |
| Flash Powder | Base + upgrade | Printed definition matches. |
| Fully Loaded | Base + upgrade | Printed definition matches. |
| Gestalt | Base + upgrade | Printed definition matches. |
| Ghostly Presence | Base + upgrade | Printed definition matches. |
| Golden Bullet | Base + upgrade | Printed definition matches. |
| Golden Ticket | Base only | Printed definition matches. |
| Grudge | Base + upgrade | Printed definition matches. |
| Headshot | Base + upgrade | Printed definition matches. |
| Heroic Bravado | Base + upgrade | Printed definition matches. |
| High Noon | Base + upgrade | Printed definition matches. |
| High-Caliber | Base + upgrade | Printed definition matches. |
| Horror | Base + upgrade | Printed definition matches. |
| Itchy Trigger | Base + upgrade | Printed definition matches. |
| Lone Wolf | Base + upgrade | Printed definition matches. |
| Low Profile | Base + upgrade | Printed definition matches. |
| Magnum | Base + upgrade | Printed definition matches. |
| Maintenance | Base + upgrade | Printed definition matches. |
| Malice | Base + upgrade | Printed definition matches. |
| Manifest | Base + upgrade | Printed definition matches. |
| Midnight | Base + upgrade | Printed definition matches. |
| Misfire | Base + upgrade | Printed definition matches. |
| No Holds Barred | Base + upgrade | Printed definition matches. |
| Overwhelming Power | Base + upgrade | Printed definition matches. |
| Pistol Whip | Base + upgrade | Printed definition matches. |
| Purgatory | Base + upgrade | Printed definition matches. |
| Quickdraw | Base + upgrade | Printed definition matches. |
| Roulette | Base + upgrade | Printed definition matches. |
| Roundhouse Kick | Base + upgrade | Printed definition matches. |
| Rummage | Base + upgrade | Printed definition matches. |
| Scorn | Base + upgrade | Printed definition matches. |
| Shadow Cloak | Base + upgrade | Fixed: discard a Curse from hand or Chamber; no Block without payment. |
| Short Fuse | Base + upgrade | Printed definition matches. |
| Showdown | Base + upgrade | Printed definition matches. |
| Smoking Barrel | Base + upgrade | Printed definition matches. |
| Snapshot | Base + upgrade | Printed definition matches. |
| Snipe | Base + upgrade | Printed definition matches. |
| Specter | Base + upgrade | Printed definition matches. |
| Strike | Base + upgrade | Printed definition matches. |
| Take Aim | Base + upgrade | Printed definition matches. |
| Take Cover | Base + upgrade | Printed definition matches. |
| Tracking Shots | Base + upgrade | Printed definition matches. |
| Trick Shot | Base + upgrade | Printed definition matches. |
| Undead | Base + upgrade | Printed definition matches. |
| Vantage | Base + upgrade | Printed definition matches. |
| Virtue | Base + upgrade | Printed definition matches. |
| Wide Open | Base + upgrade | Printed definition matches. |
