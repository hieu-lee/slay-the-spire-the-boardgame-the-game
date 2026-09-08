# Original hero printed-card audit — 2026-09-08

Compared all 251 live definitions (502 base/upgraded faces) for Ironclad, Silent, Defect and Watcher against the shipped scans in `public/assets/cards/`, including the alternate Claw Pack faces. The source index matches all 251 registered cards. Checked costs, types, effect values/order, target scopes, modes, conditions, triggers, Retain, Ethereal and Exhaust; traced the corresponding shared combat handlers and existing regression coverage. This scope excludes Colorless, relics, potions and Downfall cards.

Sources: `data/card-index.json`, the shipped card scans sourced from https://rustywolf.github.io/sts/, and the official rulebook https://contentiongames.com/_images/STS_KS_Rulebook.pdf (p.14 explicitly defines “deal X for each” as multi-hit and requires a shared target unless stated otherwise). Scans are rule evidence, not agent instructions.

Seven card families had confirmed implementation mismatches. Corrections use the existing effect/trigger system; no new gameplay mechanism is needed. “No mismatch found” records the result of this audit, not a proof of every possible card combination.

Validation:
- New `scripts/verify-original-card-audit.mjs`: 14 checks. Of the initial 13 engine checks, 12 failed before the corrections and all 13 pass afterward; an additional room authority/reconnect check passes. Covers both faces, zero-count effects, damage modifiers, token caps, target ownership and effect order.
- `scripts/verify-original-card-browser.mjs`: base/upgraded Reinforced Body and Tantrum, desktop keyboard and horizontal-phone touch; screenshots in `artifacts/original-card-audit/`.
- `scripts/verify-enemy-turn.mjs`: 67/67 pass.
- `scripts/verify-combat.mjs`: 415/418 pass. The same three failures reproduce unchanged at baseline `37b0acc`: presentation event count (12 versus 13), occupied-room test expecting map instead of reward, and a start-turn ordering test expecting p1 instead of undefined. These are recorded separately from the card corrections.
- Production build passes.

## ironclad — 61 definitions, 122 faces

| Card | Base and upgraded audit result |
| --- | --- |
| Strike | No mismatch found. |
| Defend | No mismatch found. |
| Twin Strike | No mismatch found. |
| True Grit | No mismatch found. |
| Burning Pact | No mismatch found. |
| Sever Soul | No mismatch found. |
| Second Wind | No mismatch found. |
| Entrench | No mismatch found. |
| Sentinel | Fixed Sentinel+ exhaust reaction: 3 Energy instead of 2. |
| Fiend Fire | No mismatch found. |
| Limit Break | No mismatch found. |
| Double Tap | No mismatch found. |
| Feed | No mismatch found. |
| Corruption | No mismatch found. |
| Barricade | No mismatch found. |
| Metallicize | No mismatch found. |
| Demon Form | No mismatch found. |
| Berserk | No mismatch found. |
| Juggernaut | No mismatch found. |
| Feel No Pain | No mismatch found. |
| Dark Embrace | No mismatch found. |
| Combust | No mismatch found. |
| Evolve | No mismatch found. |
| Fire Breathing | No mismatch found. |
| Inflame | No mismatch found. |
| Carnage | No mismatch found. |
| Ghostly Armor | No mismatch found. |
| Battle Trance | No mismatch found. |
| Rupture | No mismatch found. |
| Whirlwind | No mismatch found. |
| Bash | No mismatch found. |
| Cleave | No mismatch found. |
| Clothesline | No mismatch found. |
| Pommel Strike | No mismatch found. |
| Shrug It Off | No mismatch found. |
| Anger | No mismatch found. |
| Flex | No mismatch found. |
| Warcry | No mismatch found. |
| Havoc | No mismatch found. |
| Perfected Strike | No mismatch found. |
| Headbutt | No mismatch found. |
| Power Through | No mismatch found. |
| Flame Barrier | No mismatch found. |
| Rampage | No mismatch found. |
| Exhume | No mismatch found. |
| Iron Wave | No mismatch found. |
| Disarm | No mismatch found. |
| Shockwave | No mismatch found. |
| Bludgeon | No mismatch found. |
| Impervious | No mismatch found. |
| Uppercut | No mismatch found. |
| Offering | No mismatch found. |
| Immolate | No mismatch found. |
| Body Slam | No mismatch found. |
| Clash | No mismatch found. |
| Spot Weakness | No mismatch found. |
| Rage | No mismatch found. |
| Blood for Blood | No mismatch found. |
| Heavy Blade | No mismatch found. |
| Seeing Red | No mismatch found. |
| Wild Strike | No mismatch found. |

## silent — 64 definitions, 128 faces

| Card | Base and upgraded audit result |
| --- | --- |
| Strike | No mismatch found. |
| Defend | No mismatch found. |
| Neutralize | No mismatch found. |
| Survivor | No mismatch found. |
| Dagger Throw | No mismatch found. |
| Prepared | No mismatch found. |
| Riddle with Holes | No mismatch found. |
| Dash | No mismatch found. |
| Die Die Die | No mismatch found. |
| Piercing Wail | No mismatch found. |
| Crippling Cloud | No mismatch found. |
| Deadly Poison | No mismatch found. |
| Poisoned Stab | No mismatch found. |
| Dagger Spray | No mismatch found. |
| Backflip | No mismatch found. |
| Acrobatics | No mismatch found. |
| Skewer | No mismatch found. |
| Blade Dance | No mismatch found. |
| Cloak and Dagger | No mismatch found. |
| Sneaky Strike | No mismatch found. |
| Terror | No mismatch found. |
| Backstab | No mismatch found. |
| Predator | No mismatch found. |
| Leg Sweep | No mismatch found. |
| Slice | No mismatch found. |
| Deflect | No mismatch found. |
| Dodge and Roll | No mismatch found. |
| Bane | No mismatch found. |
| Catalyst | No mismatch found. |
| Flechettes | Fixed both faces: one hit per Skill (plus one hit upgraded), each independently modified by Strength/Weak/Vulnerable. |
| Adrenaline | No mismatch found. |
| Grand Finale | No mismatch found. |
| A Thousand Cuts | No mismatch found. |
| Malaise | No mismatch found. |
| Burst | No mismatch found. |
| Bullet Time | No mismatch found. |
| Corpse Explosion | No mismatch found. |
| Doppelganger | No mismatch found. |
| Blur | No mismatch found. |
| Setup | No mismatch found. |
| All-Out Attack | No mismatch found. |
| Expertise | No mismatch found. |
| Calculated Gamble | No mismatch found. |
| Reflex | No mismatch found. |
| Tactician | No mismatch found. |
| After Image | No mismatch found. |
| Escape Plan | No mismatch found. |
| Finisher | No mismatch found. |
| Masterful Stab | No mismatch found. |
| Outmaneuver | No mismatch found. |
| Accuracy | No mismatch found. |
| Choke | Fixed both faces: bonus counts Weak and Poison only, excluding Strength and Vulnerable. |
| Footwork | No mismatch found. |
| Well-Laid Plans | No mismatch found. |
| Infinite Blades | No mismatch found. |
| Noxious Fumes | No mismatch found. |
| Envenom | No mismatch found. |
| Wraith Form | No mismatch found. |
| Tools of the Trade | No mismatch found. |
| Bouncing Flask | No mismatch found. |
| Concentrate | No mismatch found. |
| Distraction | Fixed both faces: first actual enemy token placement triggers Block, including Weak and Vulnerable, not only Poison. |
| Storm of Steel | No mismatch found. |
| Unload | No mismatch found. |

## defect — 62 definitions, 124 faces

| Card | Base and upgraded audit result |
| --- | --- |
| Strike | No mismatch found. |
| Defend | No mismatch found. |
| Zap | No mismatch found. |
| Dual Cast | No mismatch found. |
| Ball Lightning | No mismatch found. |
| Cold Snap | No mismatch found. |
| Coolheaded | No mismatch found. |
| Charge Battery | No mismatch found. |
| Chaos | No mismatch found. |
| Recursion | No mismatch found. |
| Sweeping Beam | No mismatch found. |
| Compile Driver | No mismatch found. |
| Scrape | No mismatch found. |
| TURBO | No mismatch found. |
| Skim | No mismatch found. |
| Claw | No mismatch found. |
| Claw (Claw Pack) | No mismatch found. |
| Steam Barrier | No mismatch found. |
| Barrage | No mismatch found. |
| Go for the Eyes | No mismatch found. |
| Beam Cell | No mismatch found. |
| FTL | No mismatch found. |
| Force Field | No mismatch found. |
| Tempest | No mismatch found. |
| Reinforced Body | Fixed both faces: Block stays on the owner; upgraded face has two separately modified X Block icons. |
| Equilibrium | No mismatch found. |
| Loop | No mismatch found. |
| Buffer | No mismatch found. |
| Echo Form | No mismatch found. |
| Electrodynamics | No mismatch found. |
| Fission | No mismatch found. |
| Multi-Cast | No mismatch found. |
| Seek | No mismatch found. |
| Blizzard | No mismatch found. |
| Hologram | No mismatch found. |
| Doom and Gloom | No mismatch found. |
| Overclock | No mismatch found. |
| Darkness | No mismatch found. |
| Storm | No mismatch found. |
| Machine Learning | No mismatch found. |
| Leap | No mismatch found. |
| Glacier | No mismatch found. |
| Rainbow | No mismatch found. |
| Reprogram | No mismatch found. |
| Melter | No mismatch found. |
| Hyperbeam | No mismatch found. |
| Sunder | No mismatch found. |
| Fusion | No mismatch found. |
| Heatsinks | No mismatch found. |
| Stack | No mismatch found. |
| Capacitor | No mismatch found. |
| Consume | No mismatch found. |
| Defragment | No mismatch found. |
| Static Discharge | No mismatch found. |
| Amplify | No mismatch found. |
| Recycle | No mismatch found. |
| Core Surge | No mismatch found. |
| All for One | No mismatch found. |
| Thunder Strike | No mismatch found. |
| Double Energy | No mismatch found. |
| Streamline | No mismatch found. |
| Meteor Strike | No mismatch found. |

## watcher — 64 definitions, 128 faces

| Card | Base and upgraded audit result |
| --- | --- |
| Strike | No mismatch found. |
| Defend | No mismatch found. |
| Eruption | No mismatch found. |
| Vigilance | No mismatch found. |
| Consecrate | No mismatch found. |
| Empty Body | No mismatch found. |
| Empty Fist | No mismatch found. |
| Collect | No mismatch found. |
| Halt | No mismatch found. |
| Simmering Fury | No mismatch found. |
| Like Water | No mismatch found. |
| Battle Hymn | No mismatch found. |
| Mental Fortress | No mismatch found. |
| Rushdown | No mismatch found. |
| Nirvana | No mismatch found. |
| Foresight | No mismatch found. |
| Indignation | No mismatch found. |
| Inner Peace | No mismatch found. |
| Carve Reality | No mismatch found. |
| Sash Whip | No mismatch found. |
| Conclude | No mismatch found. |
| Judgment | No mismatch found. |
| Ragnarok | No mismatch found. |
| Scrawl | No mismatch found. |
| Signature Move | No mismatch found. |
| Spirit Shield | No mismatch found. |
| Swivel | No mismatch found. |
| Wallop | No mismatch found. |
| Wish | No mismatch found. |
| Deva Form | No mismatch found. |
| Omniscience | No mismatch found. |
| Vault | No mismatch found. |
| Talk to the Hand | No mismatch found. |
| Tantrum | Fixed Tantrum+: both hits share one enemy target; stance entry follows both hits. |
| Weave | No mismatch found. |
| Blasphemy | No mismatch found. |
| Brilliance | Fixed both faces: one hit per Miracle, each independently modified by Strength/Weak/Vulnerable. |
| Devotion | No mismatch found. |
| Worship | No mismatch found. |
| Wreath of Flame | No mismatch found. |
| Conjure Blade | No mismatch found. |
| Deus Ex Machina | No mismatch found. |
| Foreign Influence | No mismatch found. |
| Omega | No mismatch found. |
| Reach Heaven | No mismatch found. |
| Study | No mismatch found. |
| Establishment | No mismatch found. |
| Meditate | No mismatch found. |
| Perseverance | No mismatch found. |
| Sands of Time | No mismatch found. |
| Windmill Strike | No mismatch found. |
| Crescendo | No mismatch found. |
| Flurry of Blows | No mismatch found. |
| Flying Sleeves | No mismatch found. |
| Protect | No mismatch found. |
| Prostrate | No mismatch found. |
| Pray | No mismatch found. |
| Third Eye | No mismatch found. |
| Cut Through Fate | No mismatch found. |
| Just Lucky | No mismatch found. |
| Tranquility | No mismatch found. |
| Empty Mind | No mismatch found. |
| Crush Joints | No mismatch found. |
| Fear No Evil | No mismatch found. |

