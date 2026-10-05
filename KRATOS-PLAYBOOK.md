# Kratos Playbook

Strategy notes and playtest ledger for **solo Kratos**, the playtest-only DLC character.
Kratos is reachable only through the headless playtest system
(`node --experimental-strip-types scripts/playtest.mjs init --character kratos ...`); see
`docs/playtesting.md`. His design, keywords, and balance watch list are in
`docs/kratos-design.md`. The card data is `src/game/dlc/kratos.ts`.

## Balance target

The project owner set the target: A0 batches of 15 AI-directed runs should average
**19.0-24.0 floors reached**. Both batches so far landed inside that band, so the draft
numbers are unchanged.

| Batch | Seeds | Engine | Mean floors | Wins | Act I boss | Act II boss | Act III boss | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| kratos-a0-b1 | 7001-7015 | 9faa990 | 22.53 | 3/15 | 11/15 | 4/11 | 3/4 | Merchant card purchases failed in the tool (since fixed) |
| kratos-a0-b2 | 8001-8015 | 9faa990 + tool fix | 23.13 | 5/15 | 11/15 | 6/11 | 5/6 | No Merchant failures |

Combined: 30 runs, mean 22.83 floors, 8 wins (27%). Five Codex workers (gpt-6.1-sol,
medium reasoning) played each batch; the receipts are local ignored artifacts under
`artifacts/playtest/`. Both reports show 0 execution errors. In both batches a few
rejected actions returned a raw `Cannot read properties of undefined (reading 'length')`
error at the start of a combat turn and were rejected without changing state. The worker
logs do not keep the input; it was most likely a start-of-turn operation sent without its
arguments, so send the documented arguments for those operations.

## What the runs taught

- **Act II bosses are the main wall.** They ended 12 of the 22 runs that reached Act II
  (45% boss win rate): The Champ 5, The Collector 5, Bronze Automaton 2. The amount of Block
  in final decks did not separate winners from losers (some losers had more than some
  winners), and the final decks show no clear deciding card.
- **Act I ended 8 of 30 runs:** Slime Boss 5, Hexaghost 2, and one floor-3 Fungi Beast
  (22 boss wins in 29 boss fights, 76%). Slime Boss's split turn punishes decks that spend every card on the
  kill; keep Block or a Weak source for the turn after the split. Hexaghost's sixth-turn
  attack plus Burns needs a planned defensive turn. Both Act III losses were Awakened One.
- **The starter pair works.** Blades of Chaos and Plume of Prometheus were the most played
  cards after Strike and Defend. Blades of Chaos or Orion's Harpoon plus 1 banked Rage
  fires Plume's 4-damage Unleash. Upgrade Blades of Chaos early.
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

## Cards to watch

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
