# Kratos, Ghost of Sparta — DLC character design (draft 5)

Status: first playable draft for the headless playtest system only. Kratos is not
selectable in solo, daily, custom, or online play until playtest data says the
numbers are right. Scope is God of War (2005), God of War II, and God of War III:
the rage-driven, vengeful Spartan who kills the Olympians. The later Norse Kratos
is out of scope.

All numbers below use the board game scale: Strike deals 1 damage, Defend gives 1
Block, Energy resets to 3, Block caps at 20, Strength caps at 8, Vulnerable and
Weak cap at 3.

## 1. Review of the four base characters

The design is calibrated against the transcribed board-game cards in
`src/game/cards.ts`, not the video game.

### Ironclad (10 HP, Burning Blood: heal 1 at end of combat)

Starter: 5 Strike, 4 Defend, Bash (2E, 2 damage + 1 Vulnerable). Pool:
15 commons, 28 uncommons, 15 rares.

- Strength: Inflame (2E power, +1 Strength), Demon Form (3E, +1 Strength each
  turn), Limit Break, Flex, Rupture, Spot Weakness, Heavy Blade.
- Exhaust engine: True Grit, Burning Pact, Second Wind, Sever Soul, Fiend Fire,
  Feel No Pain, Dark Embrace, Berserk, Corruption, Sentinel, Exhume.
- Block: Body Slam, Entrench, Barricade, Juggernaut, Metallicize, Impervious.
- Status synergy: Wild Strike, Power Through, Immolate, Evolve, Fire Breathing.
- Rates: a 1E common is about 2 damage or 2 Block with a small rider (Pommel
  Strike 2 + draw, Shrug It Off 2 Block + draw, Cleave 2 to a row). A 2E common
  is 3 damage with a rider (Clothesline 3 + Weak). Rare spikes: Bludgeon 3E 7,
  Immolate 2E 5 to a row, Feed 1E 3 + Strength on kill.
- Weak points: little draw and Energy. Heal 1 per combat is a large long-run edge
  on a 10 HP scale.

### Silent (9 HP, Ring of the Snake: draw 2 at start of combat)

Starter: 5 Strike, 5 Defend, Neutralize, Survivor (12 cards). Pool:
13 / 32 / 15.

- Poison: Poison never decays and is a shared cap of 30. Deadly Poison, Bouncing
  Flask, Crippling Cloud, Noxious Fumes, Catalyst, Corpse Explosion, Envenom.
- Shivs: Blade Dance, Cloak and Dagger, Riddle with Holes, Infinite Blades,
  Accuracy, Storm of Steel, Unload, Finisher.
- Discard: Prepared, Acrobatics, Reflex, Tactician, Sneaky Strike, After Image,
  Concentrate, Tools of the Trade.
- Defence: Leg Sweep, Piercing Wail, Blur, Footwork, Wraith Form.
- Highest card flow in the game; low raw damage per card.

### Defect (9 HP, Cracked Core: channel 1 Lightning at start of combat)

Starter: 4 Strike, 4 Defend, Zap, Dual Cast. Pool: 17 / 26 / 15.

- Orbs without Focus: Lightning 1 at end of turn / 2 on Evoke, Frost 1 Block /
  1 on Evoke, Dark 3 + 1 per Power on Evoke.
- Power count: Streamline, Force Field, Meteor Strike, Heatsinks.
- 0-cost loops: Claw, Scrape, All for One, Steam Barrier.
- Card flow: Skim, Turbo, Overclock, Fusion, Double Energy, Seek.
- A generator plus spender starter (Zap channels, Dual Cast evokes) is the model
  for Kratos's starter.

### Watcher (9 HP, Pure Water: gain 1 Miracle at start of combat)

Starter: 4 Strike, 4 Defend, Eruption, Vigilance. Pool: 13 / 32 / 15.

- Stances: Wrath adds 1 to every hit and costs 1 damage at end of turn; leaving
  Calm gives 2 Energy. No Divinity.
- Miracles: each is 1 Energy, cap 5.
- Retain and Scry: Sands of Time, Windmill Strike, Perseverance, Establishment,
  Foresight, Weave, Nirvana.
- Highest burst damage: Wrath plus Blasphemy, Ragnarok, Brilliance.

### Downfall characters already in the repo

Hexaghost's Heat is a bank read by thresholds and per-point cards; Guardian's
Vigor is a next-attack damage bank; Hermit's Chamber stores cards. Kratos's Rage
overlaps Heat only in the few cards that count Rage: Vengeance and Spartan
Resolve read it without spending it, and Blade of Olympus, Rage of the Titans,
and Rage of Sparta count it, then spend it all. Unleash, which spends a fixed amount for a printed
bonus, has no equivalent.

### Lessons for Kratos

1. Starter relics are worth about 1 Energy per combat (Pure Water, Ring of the
   Snake), a repeating small effect (Cracked Core), or about 1 HP per combat
   (Burning Blood).
2. A 1E Power that gives about +1 per turn is uncommon-rate (Storm, Like Water,
   Infinite Blades, Noxious Fumes, Metallicize). 3E rare scaling (Demon Form,
   Echo Form, Wraith Form, Omega) defines the ceiling.
3. Kratos must not copy Ironclad's permanent Strength stacking or exhaust
   engine, the Watcher's stances, or the Guardian's Vigor. Kratos never gains
   permanent Strength; his only Strength is the one-turn surge of Rage of
   Sparta. His own space is a banked resource fed by aggression and pain, spent
   for card-specific spikes, plus boss-specific damage and kill-driven tempo.


## 2. Character identity

Kratos is a rageful, bloodthirsty, ruthless god killer. The cards must feel like
the trilogy:

- Rage builds from fighting and from pain, and is unleashed in brutal spikes.
  The three rage modes are a ladder: Rage of the Gods (GoW, common, builds the
  meter), Rage of the Titans (GoW II, uncommon, a repeatable release), and Rage of
  Sparta (GoW III, rare, the ultimate release).
- The chained Blades of Chaos sweep crowds. Other weapons (Blade of Artemis,
  Nemean Cestus, Nemesis Whip, Claws of Hades, Blade of Olympus, Spear of
  Destiny, Barbarian Hammer, Blade of the Gods) each have a distinct job.
- He steals the gods' powers and relics: magic such as Poseidon's Rage, Zeus'
  Fury, Medusa's Gaze, Army of Hades, Cronos' Rage, Atlas Quake, and Army of
  Sparta, and items such as the Head of Helios, Boots of Hermes, Golden Fleece,
  and Icarus Wings.
- He finishes enemies with brutal kills, absorbs their Red Orbs, and hits gods
  harder than anyone.
- He is not a defensive character. His Block is serviceable, and his real
  defence is killing things first.

## 3. Board, relic, and mechanics

### Board

- Max HP: 10, as for Ironclad. Kratos has no healing in his starter, so his
  long-run sustain is below Ironclad's.
- Energy, draw, and rows follow the normal rules.

### Starting relic: Ashes of Sparta

> Start of combat: gain 1 Rage. Whenever you lose HP, gain 1 Rage.

The ashes of his wife and daughter, burned into his skin by the Oracle's curse.
Pain turns into fury.

- Each separate HP loss is one event and gives 1 Rage, whatever the amount. A
  multi-hit enemy attack that gets through Block on three hits gives 3 Rage.
  Self-inflicted HP loss counts. HP loss that a cap or Buffer prevents gives no
  Rage.
- Value: about 2-4 Rage per combat (more against multi-hit attackers; the
  fallback if that proves too strong is "at most 2 Rage per enemy turn"). By the Unleash rule of thumb below that is
  worth 3-6 damage, more than Pure Water's 1 Energy. It only pays when the deck
  has Rage spenders. Kratos also spends HP as a resource (Hubris, Blood Oath,
  Pandora's Box), which is why he keeps Ironclad's 10 HP without Ironclad's
  healing.

### Rage (new resource)

- A per-player token track from 0 to 5. Gains above 5 are ignored.
- Rage is lost at the end of combat, like every token except gold.
- Rage does nothing on its own. It is spent by Unleash clauses and by three cards
  that spend all of it (Rage of the Titans, Rage of Sparta, Blade of Olympus).
  Vengeance and Spartan Resolve read it without spending it. Spending all Rage
  is not an Unleash.
- A card may read Rage and a later card may spend the same Rage in one turn.
- Text always says "Rage" for the token. Ironclad's card named Rage and
  Hexaghost's Unleash Spirits are unrelated to the Rage token and the Unleash
  keyword; logs and prompts name those cards with their owner.

### Unleash N (keyword)

> Unleash N: if you have at least N Rage, spend N Rage and resolve this bonus.

- An Unleash clause is checked where it is printed. For an "instead" clause
  ("Deal 1 damage. Unleash 2: deal 4 damage instead"), the check happens before
  the base effect, and only one of the two effects resolves. This keeps one hit
  as one hit, which matters against Block.
- The player may hold Rage for one play. All Unleash clauses on that play are
  then skipped. The default is to spend if able.
- An Unleash whose bonus only affects enemies is skipped, and keeps its Rage,
  when no target is left alive (for example Spartan Kick after a lethal hit).
- God of War lowers every Unleash cost by 1, to a minimum of 0. Extra copies do
  not lower costs further, but each copy still gives 1 Rage at the start of turn.
  An Unleash that costs 0 still resolves its bonus, but spends no Rage, so it
  does not trigger Ghost of Sparta.
- Rule of thumb: Unleash N buys about N+1 damage-equivalent, because Rage costs
  card slots and tempo to build.

### Hits and damage

The board game separates a hit (modified by Strength, Weak, and Vulnerable)
from plain damage (not modified). On Kratos's cards:

- "Deal N damage" on a card is a hit.
- Damage from a Power's trigger (Army of Hades), a reflection (Golden Fleece),
  and Rage of the Titans' release is plain damage. Those cards say so.
- Medusa's Gaze's execute and plain damage are not hits, so a kill by them does
  not trigger Bloodlust or Red Orbs.

### Godslayer +N (keyword)

> This card's hits deal +N damage to an enemy whose card is an Elite or a Boss.

The bonus is part of the hit, so Strength, Weak, and Vulnerable apply normally.
Minions summoned by a boss do not count unless their own card is an Elite or a
Boss. Godslayer cards are below rate in normal encounters and above rate against
the fights that end runs. That is a real deckbuilding choice.

### Brutal Kill (keyword)

> Brutal Kill: if this card's target is dead after the hit, resolve this bonus.

The trilogy's quick-time-event finishers (Helios's head, Hermes's legs, a
Cyclops's eye). Brutal Kill rewards tempo: Energy, Rage, and cards. Bloodlust and
Red Orbs react only to enemies killed by one of Kratos's own hits, so allies'
kills in co-op do not count. Green Orbs reacts the same way.

## 4. Starter deck (10 cards)

| Card | Type | Cost | Effect | Upgrade |
| --- | --- | --- | --- | --- |
| Strike x4 | Attack | 1 | Deal 1 damage. | Deal 2 damage. |
| Defend x4 | Skill | 1 | Gain 1 Block. | 2 Block to any player. |
| Blades of Chaos | Attack | 1 | Deal 1 damage to a row. Gain 1 Rage. | Deal 2 damage to a row. Gain 1 Rage. |
| Plume of Prometheus | Attack | 1 | Deal 1 damage. Unleash 2: deal 4 damage instead. | 2 damage; Unleash 2: 5 instead. |

Like Defect's Zap plus Dual Cast, the starter has one generator and one spender.
On turn 1 Kratos has 1 Rage from the relic. Blades of Chaos or one hit taken makes
Plume of Prometheus a 4-damage card. When both specials are in the opening hand
(about 1 hand in 4), the 3E turn of Blades of Chaos, Plume of Prometheus, and a
Strike deals 6 damage to one enemy, 1 of it from the row hit, which also hits
that enemy's neighbours. Ironclad's
Bash then Strike deals 4 (Strike then Bash deals 3 and leaves Vulnerable); Defect's
Zap, Dual Cast, and a Strike deal about 6 with Cracked Core's Lightning. Kratos's
opening is level with Defect's, slightly ahead of Ironclad's in damage, and
behind it in sustain.

## 5. Routes

### Route A — Rage of Sparta (build and unleash)

Generate Rage quickly, then spend it on large Unleash payoffs or on the
spend-all releases. Pain is fuel: Hubris and Blood Oath trade HP for cards and
Energy and refill Rage through the relic.

- Generators: Rage of the Gods, Orion's Harpoon, Parry, Hubris, Servant of Ares,
  Chains of Chaos, Sacrifice, Blood Oath, Loom of Fate, Cronos' Rage, Pandora's
  Box, Blades of Athena.
- Spenders and payoffs: Plume of Prometheus, Spartan Guard, Golden Fleece,
  Athena's Blessing, Ghost of Sparta, Poseidon's Rage, Vengeance, Spartan
  Resolve, Rage of the Titans, Rage of Sparta, Blade of Olympus, God of War.

Tension: Vengeance and Spartan Resolve scale with Rage held, while Unleash and
the releases spend it. Reading Rage first and spending it later in the same turn
is allowed, so the real choice is how much Rage to carry into the next turn.

### Route B — Blades of Chaos (chained combos and crowds)

Many cheap attacks and row sweeps, then payoffs that count Attacks played this
turn. Blades of Athena turns every Attack into Rage, so this route also feeds
Route A.

- Core: Blades of Chaos, Cyclone of Chaos, Nemesis Whip, Zeus' Fury, Spartan
  Kick, Bow of Apollo, Icarus Wings, Hermes' Rush, Apollo's Ascension, Boots of
  Hermes, Cronos' Rage, Poseidon's Rage, Atlas Quake, Nemean Roar, Army of
  Sparta, Soul Summon, Spear of Destiny, Barbarian Hammer.
- Payoffs: Tartarus Rage and Army of Hades count Attacks played this turn; Blades
  of Athena turns them into Rage; Blades of Exile adds 1 to every hit of a row
  sweep; Fall of Olympus is the once-per-combat finale.

### Route C — Godslayer (kill the gods)

Heavy single-target hits that spike against Elites and Bosses, Vulnerable and
Weak setup, Block removal, executes, and Brutal Kill tempo against minions.

- Core: Blade of Artemis, Hyperion Charge, Cyclops Eye Rip, Spartan Kick, Spartan
  Guard, Golden Fleece, Nemean Cestus, Apollo's Ascension, Medusa's Gaze, Head of
  Euryale, Typhon's Bane, Claws of Hades, Atlas Quake, Nemean Roar, Head of
  Helios, Hercules' Shoulder Guard, Bloodlust, Green Orbs, Deicide.
- Payoffs: Patricide, Blade of the Gods, Spear of Destiny, Barbarian Hammer, Red
  Orbs.

Any route can use Escape from Hades and Amulet of the Fates. Routes overlap on
purpose: Rage is the common currency, so a Godslayer deck still uses Unleash on
Hyperion Charge, and a Blades deck still wants Rage of Sparta.

## 6. Card pool (64 cards: 4 starter, 15 common, 30 uncommon, 15 rare)

64 distinct cards including Strike and Defend, against 61-64 for the base
characters. The normal reward deck has 15 x 2 + 30 = 60 cards (base: 58-60) and
the rare deck 15 (base: 15).

### Commons (15)

| Card | Type | Cost | Effect | Upgrade | Route |
| --- | --- | --- | --- | --- | --- |
| Orion's Harpoon | Attack | 1 | Deal 2 damage. Gain 1 Rage. | 3 damage. | A |
| Cyclone of Chaos | Attack | 2 | Deal 1 damage to a row 3 times. Gain 1 Rage. | 4 times. | B |
| Spartan Kick | Attack | 0 | Deal 1 damage. Unleash 1: apply 1 Weak. | 2 damage. | B/C |
| Hyperion Charge | Attack | 2 | Unleash 2: apply 1 Vulnerable. Deal 3 damage. | 4 damage. | C |
| Nemesis Whip | Attack | 1 | Deal 1 damage 2 times. Unleash 1: 3 times instead. | 3 times; Unleash 1: 4 times instead. | B |
| Blade of Artemis | Attack | 2 | Deal 3 damage. Godslayer +2. | 4 damage. | C |
| Cyclops Eye Rip | Attack | 1 | Deal 2 damage. Brutal Kill: gain 1 Energy and 2 Rage. | 3 damage. | C |
| Zeus' Fury | Attack | 1 | Deal 1 damage 2 times, choosing any enemy for each hit. | 3 hits. | B |
| Rage of the Gods | Skill | 0 | Gain 2 Rage. Exhaust. | Gain 3 Rage. | A |
| Parry | Skill | 1 | Gain 2 Block. Gain 1 Rage. | 3 Block. | A |
| Spartan Guard | Skill | 1 | Gain 2 Block. Unleash 2: gain 5 Block instead. | 3 Block; Unleash 2: 6 instead. | A/C |
| Golden Fleece | Skill | 1 | Gain 2 Block. Unleash 1: deal 1 plain damage to each enemy attacking you for each Attack icon in its intent. | 3 Block to any player; the reflection still answers enemies attacking Kratos. | A/C |
| Icarus Wings | Skill | 1 | Gain 1 Block. Draw 2 cards. | 2 Block. | B |
| Bow of Apollo | Attack | 0 | Deal 1 damage. Unleash 1: deal 3 damage instead. | 2 damage; Unleash 1: 4 instead. | B |
| Hermes' Rush | Skill | 1 | 2 Block to any player. You may switch rows with another player. Unleash 1: draw 1 card. | 3 Block. | B |

Rate checks:

- Orion's Harpoon is Pommel Strike with 1 Rage instead of a card. Parry is
  Shrug It Off with 1 Rage instead of a card.
- Hyperion Charge is 3 damage for 2E, or 6 with 2 Rage (Vulnerable doubles its
  own hit). Clothesline is 3 + Weak for 2E. Bludgeon is 7 for 3E.
- Blade of Artemis is 3 for 2E in hallways and 5 against Elites and Bosses.
- Rage of the Gods is about +1 net Energy of value, like Collect (1E for 2
  Miracles). Its Exhaust caps it at once per copy per combat. In GoW it is the
  activated rage mode; here it is the first rung of the meter.
- Golden Fleece is a 1E Flame Barrier-lite: 2 Block, and the reflection costs
  1 Rage. Flame Barrier is 2E for 3 Block plus the reflection.
- Icarus Wings matches Backflip; every character needs one plain cantrip.
- Bow of Apollo (GoW III's fire bow) is Anger-rate at 0E, or 3 damage for 1
  Rage: the cheap Attack Route B needs.
- Hermes' Rush (the GoW III Boots of Hermes dash) is Defect's Leap with a draw
  for 1 Rage, and a co-op support card.

### Uncommons (30)

| Card | Type | Cost | Effect | Upgrade | Route |
| --- | --- | --- | --- | --- | --- |
| Servant of Ares | Power | 1 | Start of turn: gain 1 Rage. | Cost 0. | A |
| Chains of Chaos | Power | 1 | Whenever you lose HP, gain 1 Rage. | Cost 0. | A |
| Bloodlust | Power | 1 | Whenever one of your hits kills an enemy, gain 2 Rage. | Cost 0. | C |
| Ghost of Sparta | Power | 1 | Whenever you spend Rage on an Unleash, gain 1 Block. | Gain 2 Block. | A |
| Deicide | Power | 1 | Your hits deal +1 damage to an enemy whose card is an Elite or a Boss. Extra copies do not add more. | Cost 0. | C |
| Vengeance | Attack | 1 | Deal 1 damage, +1 for each Rage you have. Does not spend Rage. | Base 2. | A |
| Poseidon's Rage | Attack | 2 | Deal 3 damage to a row. Unleash 2: deal 5 damage instead. | 4 damage; Unleash 2: 6 instead. | A/B |
| Atlas Quake | Attack | 2 | Deal 2 damage to a row. Unleash 2: apply 1 Weak and 1 Vulnerable to that row. | 3 damage. | B/C |
| Cronos' Rage | Attack | 2 | Deal 1 damage 3 times, choosing any enemy for each hit. Gain 2 Rage. | 4 hits. | A/B |
| Tartarus Rage | Attack | 1 | Deal 1 damage to a row once for each other Attack you played this turn. | +1 time. | B |
| Apollo's Ascension | Attack | 1 | Deal 2 damage. Unleash 1: apply 1 Vulnerable. | 3 damage. | B/C |
| Nemean Cestus | Attack | 2 | Remove all of the target's Block. Deal 3 damage. Godslayer +2. | 4 damage. | C |
| Claws of Hades | Attack | 1 | Deal 2 damage. Brutal Kill: draw 2 cards. | 3 damage. | C |
| Nemean Roar | Attack | 1 | Deal 1 damage to a row. Unleash 2: apply 1 Weak to that row. | 2 damage. | B/C |
| Army of Sparta | Attack | 2 | Deal 2 damage to a row. Gain 3 Block. | 4 Block. | B |
| Medusa's Gaze | Skill | 1 | Apply 1 Weak. If the target has 3 or fewer HP, set its HP to 0 (not a hit). | 4 or fewer HP. | C |
| Head of Helios | Skill | 1 | Apply 1 Weak to a row. Draw 1 card. Exhaust. | Cost 0. | C |
| Rage of the Titans | Skill | 1 | Spend all your Rage. Deal that much plain damage to a row and gain that much Block. | Gain that much Block +1. | A |
| Spartan Resolve | Skill | 1 | Gain Block equal to your Rage. Does not spend Rage. | 2 Block, +1 for each Rage. | A |
| Hubris | Skill | 0 | Lose 1 HP. If you did, draw 2 cards. | Draw 3 cards. | A |
| Sacrifice | Skill | 0 | Exhaust a card from your hand. If you did, gain 2 Rage. | Gain 3 Rage. | A |
| Blood Oath | Skill | 0 | Lose 1 HP. Gain 1 Energy. Exhaust. | Gain 2 Energy. | A |
| Athena's Blessing | Skill | 1 | Draw 2 cards. Unleash 2: draw 1 more card. | Draw 3 cards. | A |
| Boots of Hermes | Skill | 1 | Draw 1 card. Your next Attack this turn costs 0. Exhaust. | Draw 2 cards. | B |
| Loom of Fate | Skill | 1 | Put a card from your discard pile into your hand. Gain 1 Rage. | Gain 2 Rage. | A |
| Typhon's Bane | Skill | 1 | Assign 2 separate 1 Weak tokens to any enemies (both may go on one enemy). | 3 tokens. | C |
| Head of Euryale | Skill | 2 | Apply 1 Weak to a row. Set the HP of each enemy in that row with 3 or fewer HP to 0 (not a hit). Exhaust. | Cost 1. | C |
| Soul Summon | Power | 1 | End of turn: deal 1 plain damage to a row. | 2 damage. | B |
| Green Orbs | Power | 1 | The first time one of your hits kills an enemy, heal 1 HP, then exhaust every Green Orbs you have in play. | Cost 0. | C |
| Hercules' Shoulder Guard | Skill | 2 | Gain 3 Block. Unleash 1: gain 2 more Block. | 4 Block. | C |

Rate checks:

- Servant of Ares matches Storm (about 1 per turn for 1E). Kratos swore himself
  to Ares in exchange for the Blades and endless bloodlust.
- Deicide is half Inflame's cost for a narrower bonus that applies only against
  Elites and Bosses, and does not stack.
- Vengeance is 1E for 1 + Rage held: about 3-4 at a typical 2-3 Rage and 6 at
  5 (7 upgraded). Reach Heaven is 1E for 2 + Miracles, up to 7. Spartan Resolve
  is 1E for Block equal to Rage held: 2-3 typically, 5 at 5 (7 upgraded).
  Shrug It Off is 1E for 2 Block and a card.
- Poseidon's Rage is 3 to a row for 2E, 5 with 2 Rage, as one hit (one Weak and
  one Vulnerable token spent). Immolate, a rare, is 5
  plus two Daze.
- Atlas Quake is a repeatable Shockwave with 2 row damage: Shockwave exhausts,
  while Atlas Quake's debuffs cost 2 Rage and arrive after the hit.
- Cronos' Rage (GoW II's lingering lightning orb) is 3 chosen hits plus 2 Rage
  for 2E. Zeus' Fury is 2 chosen hits for 1E with no Rage.
- Nemean Roar is 1 row damage for 1E, and its row Weak costs 2 Rage each time.
  Every base card that puts Weak on a whole row exhausts or is conditional, so
  the Rage cost is the condition.
- Tartarus Rage (the GoW II/III Blades combo that slams a crowd) is a row version
  of the Silent's Finisher at 1 damage per hit.
- Medusa's Gaze executes small minions only; Judgment, a rare, executes at 7.
- Head of Helios is Piercing Wail with a card instead of Block.
- Rage of the Titans (GoW II's rage mode) at 5 Rage is 5 plain row damage and 5
  Block for 1E (6 Block upgraded), about 2 value per Rage, the best release rate
  in the pool. Banking 5 Rage costs several cards, and the release competes with
  every Unleash; it is on the watch list, and the first tuning lever is plain
  damage of Rage minus 1.
- Hubris is a 0E draw 2 for 1 HP. Battle Trance is a 0E draw 3 that stops
  further draws. Hubris draws only if it actually took HP, so an HP-loss cap
  (Rage of Sparta, Apparition, Ghost in a Jar) cannot turn it into a free loop.
- Athena's Blessing turns Rage into a card, never Energy, so no Rage engine can
  pay for its own replay.
- Blood Oath is net +1 Energy for 0E and 1 HP, with Exhaust (+2 upgraded: Seeing
  Red+ for 1 HP, and the relic gives back 1 Rage).
- Boots of Hermes nets up to 2 Energy once per combat: the colorless Madness at
  +1 cost, plus a draw.
- Loom of Fate is Hologram+ (1E, card back to hand) with Rage instead of Block.
  It stays at 1E so two copies cannot loop for free.
- Typhon's Bane (GoW II's wind bow) is Disarm's 2 Weak for 1E that may be split
  and does not exhaust. It gains no Rage, and it is on the watch list.
- Head of Euryale (the Gorgon head from GoW II) is a row Medusa's Gaze for 2E with
  Exhaust.
- Soul Summon (the Claws of Hades magic) is Combust without the activation: 1
  plain row damage each turn for 1E (2 upgraded).
- Green Orbs: slain enemies drop the healing orbs. It heals 1 HP once per combat
  however many copies are in play, the same as Burning Blood but only after a
  kill by Kratos's own hit. It is Kratos's only healing card, and no base card
  heals, so it is on the watch list as possibly strong.
- Hercules' Shoulder Guard (a GoW III item that reduces damage) is 3 Block for
  2E, or 5 for 1 Rage (Protect is 3 with Retain): a defensive option that does
  not need held Rage.

### Rares (15)

| Card | Type | Cost | Effect | Upgrade | Route |
| --- | --- | --- | --- | --- | --- |
| Rage of Sparta | Skill | 1 | Spend all your Rage. Gain that much Strength until end of turn. If you spent 5 Rage, you cannot lose more than 1 HP this round. Exhaust. | Retain. | A |
| Blade of Olympus | Attack | 2 | Deal 2 damage, +2 for each Rage you have. Then spend all your Rage. | Base 4. | A |
| God of War | Power | 3 | Your Unleash costs are 1 Rage lower (minimum 0). Start of turn: gain 1 Rage. Extra copies add Rage but do not lower costs further. | Cost 2. | A |
| Blades of Athena | Power | 2 | After you play an Attack, gain 1 Rage. | Cost 1. | A/B |
| Army of Hades | Power | 2 | End of turn: deal plain damage to a row equal to the number of Attacks you played this turn. | Cost 1. | B |
| Barbarian Hammer | Attack | 3 | Unleash 2: apply 1 Vulnerable to a row. Deal 5 damage to that row. | 6 damage. | B/C |
| Patricide | Attack | 3 | Deal 1 damage 5 times. Godslayer +1. | 6 times. | C |
| Blade of the Gods | Attack | 2 | Deal 3 damage. Godslayer +4. | 4 damage; Godslayer +5. | C |
| Spear of Destiny | Attack | 2 | Deal 3 damage to a row. Apply 1 Vulnerable to that row. | 4 damage. | B/C |
| Red Orbs | Power | 2 | Whenever one of your hits kills an enemy, gain 1 Energy and 1 Rage. | Cost 1. | C |
| Pandora's Box | Skill | 1 | Lose 2 HP. Gain 5 Rage. Draw 2 cards. Exhaust. | Cost 0. | A |
| Escape from Hades | Power | 2 | The first time you would lose your last HP, keep 1 HP instead and exhaust this Power. | Cost 1. | all |
| Amulet of the Fates | Skill | 2 | Apply 2 Weak to every enemy. Gain 4 Block. Exhaust. | Cost 1. | all |
| Blades of Exile | Power | 1 | Each hit of your Attacks that target a row or every enemy deals +1 damage. Extra copies do not add more. | Cost 0. | B |
| Fall of Olympus | Attack | 2 | Deal 2 damage to every enemy 3 times. Exhaust. | 4 times. | B |

Rate checks:

- Rage of Sparta is the signature card and the GoW III rage mode. At 5 Rage it
  is Wreath of Flame at X=5 for 1E plus one round of Apparition (which also caps
  self-inflicted HP loss, as Wraith Form does). It exhausts like
  Wreath of Flame, Limit Break, and Blasphemy, so it is a once-per-combat burst.
  The protection needs the full 5 Rage. Paired with Cyclone of Chaos it deals
  three hits of 6 to a row once per combat, which is the intended rare-ceiling
  fantasy. Upgraded, it can be held until the meter is full.
- Blade of Olympus is 12 damage for 2E at full Rage, against Bludgeon's 7 for 3E,
  and empties the bank.
- God of War is a Demon Form-class 3E power: every Unleash 1 becomes a free
  bonus, every Unleash 2 becomes Unleash 1, and it adds 1 Rage per turn. A free
  Unleash spends no Rage, so it does not trigger Ghost of Sparta.
- Blades of Athena gives about 2-3 Rage a turn in an attack deck. Its Rage
  arrives after the Attack resolves, so an Attack cannot pay for its own Unleash.
  Rage only matters through spenders, and the 5 cap stops hoarding.
- Army of Hades is Omega-like (3E, 5 plain damage to a row at end of turn); it
  pays 2-4 for 2E in an attack deck.
- Barbarian Hammer is 5 to a row for 3E, or 10 with 2 Rage. Immolate is 5 to a
  row for 2E plus two Daze.
- Patricide is 5 damage for 3E in hallways and 10 against a Boss or Elite. Each
  hit gets Strength and Deicide. Blade of the Gods (the pillar-sword Kratos uses
  to kill Ares) is 3 for 2E in hallways and 7 against a Boss or Elite (4 and 9
  upgraded), the same band as Bludgeon's 7 for 3E.
- Red Orbs: slain enemies spill red orbs that Kratos absorbs. In a hallway fight
  it returns about 1-2 Energy; against a lone boss it does little.
- Pandora's Box (the power to kill a god, at a price) fills the meter at once,
  which enables the releases, for 2 HP.
- Escape from Hades is a one-time save, comparable to Defect's Buffer (2E): the
  trilogy's repeated climbs out of the Underworld. It fires before Fairy in a
  Bottle, which is kept for the next lethal loss.
- Amulet of the Fates (GoW II's time-slowing amulet) is Kratos's one rare
  defensive turn: every enemy Weak 2 plus 4 Block, once per combat.
- Blades of Exile (the GoW III Blades) is a narrow Strength for sweeps at half
  Inflame's cost: Cyclone of Chaos gains 3, Barbarian Hammer 1. It is the Route B
  rare payoff.
- Fall of Olympus (GoW III's destruction of Olympus) is 6 damage to every enemy
  for 2E (8 upgraded), once per combat; Immolate is 5 to a row for 2E plus two
  Daze, repeatable. In co-op "every enemy" covers all rows.

## 7. Balance summary

- Opening power is slightly ahead of Ironclad in damage and behind in sustain:
  same HP, no heal.
- Mid-game, Rage gives Kratos card-for-card value close to Ironclad commons, with
  more spike damage and less Block scaling.
- Late-game ceilings (Rage of Sparta, God of War, Blades of Athena, Patricide)
  sit with Demon Form, Wraith Form, Echo Form, and Blasphemy. Rage of Sparta
  exhausts; Blade of Olympus and Rage of the Titans repeat but empty the bank.
- Weak points by design: no permanent Strength; Block scales only through Rage
  (Spartan Resolve, Ghost of Sparta, Rage of the Titans) or a one-time turn
  (Amulet of the Fates); almost no healing (Green Orbs, 1 HP per combat);
  HP-for-power cards; and Godslayer cards that are below rate in hallway fights.
- Watch list for the first playtest:
  - Plume of Prometheus and Ashes of Sparta together, and Ashes of Sparta against
    multi-hit enemies.
  - Rage of Sparta with a multi-hit Attack into a Vulnerable target (every hit
    doubles): Cyclone of Chaos+ can reach 48 to a row, Patricide about 70 to a
    boss, once per combat.
  - Blade of Olympus and Rage of the Titans refilled by Servant of Ares or Blades
    of Athena.
  - God of War makes every Unleash 1 free (Bow of Apollo becomes a repeatable 0E
    3-damage card, Spartan Kick a free Weak); Blades of Athena then pays for the
    Unleash 2 cards. Neither can produce Energy, so there is no loop.
  - Rage of Sparta plus Patricide plus Deicide against a boss (about 70-80). The
    planned fallback is that Patricide loses Godslayer.
  - Green Orbs (possibly strong), Typhon's Bane, Sacrifice, Soul Summon+ (2 plain
    row damage per turn for 1E), Soul Summon with Army of Hades, and Spear of
    Destiny (repeatable row Vulnerable; lever: Vulnerable to the target only).
  - Blood Oath, Hubris, and Pandora's Box HP drain.
  - Medusa's Gaze against 3 HP minion swarms, and Atlas Quake in co-op.
  - Vengeance both ways (it can read 5 Rage before an Unleash spends it).
  - Hubris, the only repeatable 0E HP-for-cards card in the game.
  - Golden Fleece against multi-attack enemies, and Kratos's total Block from
    Spartan Guard, Hercules' Shoulder Guard, Army of Sparta, Ghost of Sparta, and
    Rage of the Titans.
  - Blades of Exile with Cyclone of Chaos and Rage of Sparta.
  - Possibly weak: Spartan Resolve, Deicide, Red Orbs, Bloodlust, Blood Oath,
    Fall of Olympus, Chains of Chaos (it repeats the relic), Escape from Hades
    (Buffer is broader at the same cost).
  - How often a deck reaches 5 Rage.

## 8. Implementation notes

- `rage` is an optional player counter (absent means 0) so older saves still
  load. `CAPS.rage = 5`.
- Unleash is a `branch` on the condition `canUnleash` (which applies God of War
  and the play's hold choice). Its first clause is `unleashSpend`; `otherwise`
  holds an "instead" clause's base. Brutal Kill is a `branch` on `targetDead`.
- New effects: `gainRage`, `loseAllRage`, `unleashSpend`. New conditions:
  `rageAtLeast`, `canUnleash`, `targetDead`, `targetEliteOrBoss`,
  `exhaustedByThisCard` (Sacrifice), and `lostHpToThisCard` (Hubris). New
  counted value: `rage`. Godslayer is an Amount bonus on `targetEliteOrBoss`.
  Rage of Sparta's Strength uses `loseGainedOnly`, so only Strength gained under
  the cap of 8 is removed at end of turn.
- `PlayContext.holdRage` skips every Unleash clause on that play.
- Ashes of Sparta and Chains of Chaos add Rage inside the shared HP-loss rule,
  and Escape from Hades is checked there. Bloodlust and Red Orbs react where a
  hit kills an enemy, as does Green Orbs.
  Ghost of Sparta reacts inside `unleashSpend`. Deicide, Blades of Exile, and God
  of War are read directly while in play.
- Character ids: `kratos` is in a new `PLAYTEST_CHARACTER_IDS` list. The
  released `CHARACTER_IDS` list (character select, online rooms, daily, stats,
  other characters' reward decks) does not include it. The engine can create a
  Kratos run, and `scripts/playtest.mjs --character kratos` plays him headless.
- Every Kratos card carries `printedText`, because the playtest prompt shows raw
  card data to the AI player.

## 9. Open questions for playtesting

- Whether 10 HP with only Green Orbs for healing is right, or Kratos needs 9 HP.
- Weak appears on 8 cards; if Kratos plays too defensively, move one or two to
  Vulnerable or damage riders.
- Whether Rage should drain (lose 1 at end of turn) if banking proves too strong.
- Co-op support: Defend+, Golden Fleece+, and Hermes' Rush can protect an ally.
  Add more before Kratos leaves the playtest system.

## 10. Playtest results

Two A0 batches of 15 AI-directed runs (five Codex workers each) both landed inside the
project owner's 19.0-24.0 mean-floor target, so the draft numbers are unchanged:

| Batch | Mean floors | Wins | Notes |
| --- | ---: | ---: | --- |
| kratos-a0-b1 (seeds 7001-7015) | 22.53 | 3/15 | Merchant card purchases failed in the playtest tool, since fixed |
| kratos-a0-b2 (seeds 8001-8015) | 23.13 | 5/15 | Merchant fix in place |

Observations and card notes live in `KRATOS-PLAYBOOK.md`.

## 11. Revision log

Draft 2 applies the first design review:

- Rage of Sparta now exhausts, needs 5 Rage for its protection, and upgrades to
  Retain.
- Plume of Prometheus 1 / Unleash 4 (was 2 / 5). Hyperion Charge base 3 (was 4).
- Blood Oath exhausts. Hubris moved to uncommon. Boots of Hermes exhausts and
  upgrades to draw 2. Deicide costs 2 and does not stack. Spartan Resolve costs 2.
  Vengeance base 1. Cronos' Rage 3 hits (4 upgraded).
- Hits and plain damage are defined; Army of Sparta is an Attack.
- Rampage of the Furies (a Norse-era move) renamed Tartarus Rage. The common
  Brutal Kill renamed Cyclops Eye Rip. Spoils of the Gods renamed Red Orbs. The
  start-of-turn Rage power is Servant of Ares; the pain power is Chains of Chaos
  (avoids the Watcher's Wrath). Rage of the Titans is now a small release.
- Pandora's Box fills the Rage meter instead of giving permanent Strength.
- Bloodlust and Red Orbs count only Kratos's own hits.
- Golden Fleece moved to common with a co-op upgrade. Spear of Destiny,
  Barbarian Hammer, and Amulet of the Fates buffed. New Godslayer rare: Blade of
  the Gods.
- Rules clarified for Ashes of Sparta events, "instead" clauses, God of War's
  minimum, Blades of Athena timing, and boss minions under Godslayer.

Draft 3 applies the second design review:

- Cronos' Rage gains 2 Rage, so it no longer trails Zeus' Fury. Blade of the Gods
  3 / Godslayer +4 (4 / +5 upgraded).
- Vengeance costs 1. Nemean Roar's row Weak costs Unleash 2. Rage of the Titans
  upgrades to +2 Block instead of cost 0. Loom of Fate loses Exhaust and
  upgrades to cost 0.
- Renamed Spartan Shield to Spartan Guard (no shield in GoW 1-3) and Bloodthirst
  to Athena's Blessing (too close to Bloodlust). Route A is now "Rage of Sparta".
- Clarified God of War copies, Golden Fleece+ reflection, and that executes and
  plain damage are not hits. Route lists, Block-scaling summary, and watch list
  updated.

Draft 4 applies the third design review and the request for a 62-68 card pool:

- Nine new cards bring the pool to 64: Bow of Apollo and Hermes' Rush (common);
  Typhon's Bane, Head of Euryale, Soul Summon, Green Orbs, and Hercules' Shoulder
  Guard (uncommon); Blades of Exile and Fall of Olympus (rare).
- Loom of Fate+ no longer costs 0 (two copies looped for free); it gains 2 Rage.
- Rage of the Titans+ gives +1 Block. Spartan Resolve costs 1 (Block equal to
  Rage). Blood Oath+ gains 2 Energy.
- Spear of Destiny is B/C. Rage readers, Bash comparison, Boots of Hermes rate,
  Sacrifice with an empty hand, and the watch list are corrected.

Draft 5 applies the fourth design review:

- Green Orbs heals 1 HP once per combat, whatever the number of copies
  (upgrade: cost 0). It no longer outheals the boss relics.
- Sacrifice gains Rage only if it exhausted a card. Typhon's Bane gains no Rage
  and says that tokens may share an enemy. Hermes' Rush prints its row switch
  before its Unleash.
- Fall of Olympus costs 2 (4 hits upgraded). Blades of Exile costs 1 (0
  upgraded). Deicide uses Godslayer's wording.
- Rate notes (Blood Oath, Typhon's Bane, Soul Summon), Rage of the Titans'
  ladder wording, the healing line, the God of War and Ghost of Sparta note,
  and the watch list (with a Patricide fallback) are corrected.

After the fifth and final design review (the review cap), two infinite loops
and a few rates were fixed before implementation review:

- Hubris draws only if it actually took HP, so an HP-loss cap cannot make it a
  free loop.
- Athena's Blessing's Unleash draws a card instead of giving Energy, which
  breaks the Blades of Athena loop.
- Hercules' Shoulder Guard 3 Block (4 upgraded). Deicide costs 1 (0 upgraded).
- Clarified that prevented HP loss gives no Rage, Poseidon's Rage's second hit,
  and the opening-hand comparison.

Implementation review fixes: Poseidon's Rage became an "instead" hit (two hit
clauses spent two Weak tokens); an Unleash keeps its Rage when its enemy target
is already dead; Rage of Sparta removes only the Strength it actually gave; Escape
from Hades and Green Orbs exhaust through the shared exhaust rule.
