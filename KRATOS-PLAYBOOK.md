# Kratos Playbook

Strategy notes and playtest ledger for **solo Kratos**, the released DLC character. He is in
the public roster and online rooms, and AI batches use the headless playtest system
(`node --experimental-strip-types scripts/playtest.mjs init --character kratos ...`); see
`docs/playtesting.md`. His design, keywords, and balance watch list are in
`docs/kratos-design.md`. The card data is `src/game/dlc/kratos.ts`.

## Balance target

The first target (2026-10-05) was 19.0-24.0 mean floors per 15-run A0 batch; the draft
numbers met it (kratos-a0-b1 22.53, kratos-a0-b2 23.13; 8/30 wins combined).

On 2026-10-07 the owner replaced it with parity against Ironclad on the same seeds
(9001-9030, A0, full unlocks, six gpt-6.1-sol medium Codex workers per batch): mean
floors within 2.0 of Ironclad's and win rate from 10 points below to 5 points above it.
Ironclad set 28.6 floors and 21/30 wins (70%).

| Batch | Changes (cumulative) | Mean floors | Wins | Act I / II / III boss |
| --- | --- | ---: | ---: | --- |
| kratos-a0-bal0 | Draft numbers | 26.23 | 12/30 | 93% / 57% / 75% |
| kratos-a0-bal1 | Ashes of Sparta heals 1 HP at end of combat | 26.7 | 14/30 | 87% / 73% / 74% |
| kratos-a0-bal2 | Ashes 2 starting Rage; Plume Unleash 5 (6) | 29.03 | 16/30 | 93% / 86% / 67% |
| kratos-a0-bal3 | Spartan Guard Unleash 6 (7); Parry 3 (4) Block | 30.03 | 16/30 | 100% / 83% / 64% |
| kratos-a0-bal4 | Golden Fleece 3 (4); Hercules' Shoulder Guard 4 (5) | 29.33 | 15/30 | 97% / 86% / 60% |

The owner accepted kratos-a0-bal4 as the released balance. The receipts and reports are
local ignored artifacts under `artifacts/playtest/`. Every batch reported 0 execution
errors. As in the first batches, a few rejected actions returned a raw
`Cannot read properties of undefined (reading 'length')` error at the start of a combat
turn without changing state; it is most likely a start-of-turn operation sent without its
arguments, so send the documented arguments for those operations.

## What the parity batches taught

- **Sustain was the Act II gap.** Without Burning Blood's heal, Kratos reached the Act II
  boss worn down (57% boss wins). The heal, 2 starting Rage and the Plume buff lifted Act II
  to 86%, close to Ironclad's 92%.
- **Act III is the remaining wall.** In kratos-a0-bal4, 10 of the 15 losses came in Act III:
  7 at the final boss (Time Eater, Awakened One, Donu and Deca) and 3 earlier in the act;
  4 more came at the Act II boss. Extra Block (Spartan Guard, Parry and Golden Fleece from
  the commons, Hercules' Shoulder Guard from the uncommons) did not move the Act III rate
  (Act III boss wins over runs reaching Act III), which stayed at 60-67%. Kratos has no
  permanent Strength, so long boss fights favour Ironclad's scaling.
- **Workers in every batch called the starter cards (mostly Defends) the weak point late.**
  Removing them, and drafting Parry+, Spartan Guard and Army of Sparta, kept runs alive.
- **Burst cards.** In the buffed batches (bal1-bal4), across all fights, Patricide+ (13-15
  per play), Barbarian Hammer+ (14-15) and Fall of Olympus+ (13-16) did the most damage per
  play, and workers named Patricide and Blade of the Gods+ (8-10) as their boss finishers.
  Soul Summon+ keeps working under Time Eater's card limit.
- **Hubris hurts in boss fights:** the HP cost and an attack-heavy draw can leave the
  defensive gap open.

## What the first batches taught (draft numbers)

- **Act II bosses are the main wall.** They ended 12 of the 22 runs that reached Act II
  (45% boss win rate): The Champ 5, The Collector 5, Bronze Automaton 2. The amount of Block
  in final decks did not separate winners from losers (some losers had more than some
  winners), and the final decks show no clear deciding card.
- **Act I ended 8 of 30 runs:** Slime Boss 5, Hexaghost 2, and one floor-3 Fungi Beast
  (22 boss wins in 29 boss fights, 76%). Slime Boss's split turn punishes decks that spend every card on the
  kill; keep Block or a Weak source for the turn after the split. Hexaghost's sixth-turn
  attack plus Burns needs a planned defensive turn. Both Act III losses were Awakened One.
- **The starter pair works.** Blades of Chaos and Plume of Prometheus were the most played
  cards after Strike and Defend. Ashes of Sparta's 2 starting Rage now
  fires Plume's 5-damage Unleash on turn 1 (it needed Blades of Chaos or a hit under the
  draft numbers). Upgrade Blades of Chaos early.
- **Damage.** Among non-starter row and all-enemy attacks, Cyclone of Chaos (especially
  upgraded or with Blades of Exile, Deicide, Vulnerable, or Strength), Fall of Olympus,
  Poseidon's Rage, Barbarian Hammer, and Spear of Destiny did the most total damage. Among single-target attacks, Patricide (about
  15 per play, from only 2 runs), Blade of the Gods (about 9), and Blade of Olympus (about 8) hit hardest.
  Weak cuts every hit, so clear it before a multi-hit turn. (Per-card figures leave out
  damage from Powers such as Soul Summon.)
- **Worker impressions.** Soul Summon+ was named in half of the ten worker reports for
  clearing summons and working under Time Eater's card limit. Workers credited Parry+,
  Spartan Guard, Golden Fleece, Hermes' Rush, Army of Sparta, and Hercules' Shoulder Guard
  for keeping runs alive, and found starter Defends weak in Act II.
- **Capstones that won runs:** Rage of Sparta+ (Retain lets you wait for 5 Rage and its
  protection), Blade of the Gods, Blade of Olympus, God of War+, and Escape from Hades (one
  win).
- **Rage spending discipline:** spending Rage on damage right before a big enemy attack can
  leave Spartan Guard or Rage of the Titans without fuel. Hold Rage (`holdRage`) when the
  next enemy turn needs a funded Block card.

## Cards to watch (first batches, draft numbers)

- **Never picked in 30 runs:** Chains of Chaos, Atlas Quake, Hubris, Head of Euryale, Army
  of Hades, Pandora's Box (the card, not the relic). Check whether they are weak or just rarely offered.
- **Picked only once or twice (too few samples to judge):** Red Orbs, Bloodlust, Blood Oath,
  Blades of Athena, Tartarus Rage, Athena's Blessing, Claws of Hades, Ghost of Sparta,
  Nemean Cestus, Cronos' Rage, Patricide, Escape from Hades. Check again after more
  batches.
- **Felt situational:** Nemean Roar (its Weak needs 2 Rage), Blade of Artemis (single hit
  next to scaling multi-hits), Rage of the Titans (scales with banked Rage, so it is weak without steady Rage), Cyclone of Chaos
  against a lone enemy.
- **Felt strong but in band:** Soul Summon+, Cyclone of Chaos+, Bow of Apollo, Parry+.
