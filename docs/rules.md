# Rules reference

Implementation-facing summary of *Slay the Spire: The Board Game* (Contention Games).
The board game differs from the video game in ways that matter a great deal here; §11 is
the list of traps.

## Sources

| What | Where |
| --- | --- |
| Official rulebook PDF (v2.27, 24 pages) | `https://contentiongames.com/_images/STS_KS_Rulebook.pdf` — fetch into `docs/reference/`, which is gitignored |
| Rulebook v2.30 (ships with wave 2+) | BGG filepage 276680 (login required) |
| Complete card/item/enemy manifest | Community spreadsheet, mirrored as CSV in `data/raw/` |
| Card scans incl. upgrades | `https://rustywolf.github.io/sts/` — images at `/sts/assets/images/<class>/<tier>/<n>.png` |
| Official companion app | Searchable rulebook and full card compendium; data is app-bundled |

**Version note.** v2.30 differs from v2.27 in exactly two ways: it adds teardown rules and
it *removes* the "Sequential Turns" optional rule. We target v2.30, so simultaneous turns
is the only turn mode.

**Golden rule:** card text always overrides the rulebook.

## 1. Structure

3 base Acts plus an unlockable Act IV. Each Act is a board with a randomly chosen map
layout, randomly placed face-up map tokens, and a randomly chosen boss at the top. The
party moves **as one group** (a single boot meeple) upward along connecting paths from a
fixed encounter at the bottom.

Room types: **Encounter**, **Elite**, **Event** (`?`), **Campfire** (Rest → heal 3 HP, or
Smith → upgrade a card), **Treasure** (a relic each), **Merchant** (§9), **Boss**.

Victory is defeating the boss of whichever Act you choose to stop at. **Any player reaching
0 HP loses the game for the whole party, immediately** — except under the optional Last
Stand rule (§3).

### Setup (Act I)

1. Each player takes a board, starter deck, card rewards deck (black border), rare rewards
   deck (yellow border). Shuffle each.
2. Energy → 3, Block → 0, HP → the highest printed number.
3. Shuffle the Act I decks. **Do not shuffle Summons, Daze, or Status.** Act I has a
   separate "1st Encounter!" deck kept aside.
4. Place map tokens: dark tokens on dark spaces, light on light, then flip all face up.
5. Each player takes a row on the right edge, filling the lowest open space first.
6. Roll to pick the Act I boss; place it face down at the top.
7. **Neow's Blessing:** each player draws one card, gains the red reward, then chooses one
   of three blue rewards.
8. **Solo only:** 2 gold and the Loaded Die relic. (Rulebook p.4 step 12 writes this as a
   bare `②`, which is the gold icon, not the potion flask.)

Acts II+ swap the Act decks, re-do map/boss setup, and **heal every player to full**
(Ascension 6 changes this to heal 4). Reshuffle the card rewards deck including skipped
cards; **do not** reshuffle the rare rewards deck.

## 2. Combat

Enemies sit in **rows**; each player owns one row. A normal encounter draws **one enemy
card per player**, one per row. Elites go in the bottom row only. **Bosses count as being
in every row.**

Enemy HP is printed per player count on an HP board for elites and bosses (e.g. Gremlin
Nob 14/28/42/56).

### Round: Player Turn, then Enemy Turn

**Player Turn — all players act simultaneously.**

1. **Reset.** Energy → 3, Block → 0. Player block clears here.
2. **Draw 5.** No maximum hand size. On an empty draw pile, shuffle the discard pile in; a
   card currently being played is set aside during that shuffle and lands in the new
   discard pile afterwards.
3. **Roll the die — once, shared.** Anything that modifies the result must be used now.
   That single result drives every die effect for the whole round.
4. **Start-of-turn abilities**, in any order players choose. Start-of-combat abilities fire
   on turn 1 only. Die relic abilities matching the roll fire here.
5. **Play.** Cards, potions, and abilities in any order. Playing a card: pay energy →
   choose targets → resolve printed effects top to bottom → cleanup. **Abilities triggered
   by a card do not fire until that card has completely finished resolving.** A card being
   played is in neither hand nor discard pile.
6. **End of turn.** End-of-turn abilities, then discard the entire hand **in any order**.
   Retained cards stay.

"End of turn" and "start of turn" *always* mean the Player Turn. The Enemy Turn has no
start- or end-of-turn phase.

**Enemy Turn.**

1. All enemies lose all Block.
2. Enemies act starting from the **highest row**, left to right, one action each, then the
   next row down. **Bosses always act last**, as does anything that says "acts last".
3. Slide cube-action cubes down one.

### Enemy action patterns

- **Single** — the same action every turn.
- **Die** — the action printed next to this round's die result.
- **Cube** — a cube starts at the top and slides down one per Enemy Turn; on reaching the
  bottom it returns to the **topmost red slot**. Grey slots are one-time and are skipped on
  the loop.
- **Modes** — some bosses (e.g. The Guardian) restrict actions to the current mode.
  Entering a mode moves the cube to that mode's first action.

### Targeting

Players may target **any** enemy. The AoE symbol hits all enemies in **one row** and
**always also the boss**. "ALL Enemies" hits every row plus the boss.

Enemies target the player **in their row**. AoE enemy actions hit all players — except that
an enemy gaining Strength or Block always applies it to itself.

### Damage

- **Block** prevents 1 damage per point and is spent as it prevents. **Player cap 20.**
- **Block never prevents "lose X HP".** Only damage can be blocked.
- A **hit** deals the number printed before the hit symbol and is modified by Strength,
  Weak, and Vulnerable. A plain "damage" effect is *not* a hit and is *not* modified.
- **Multi-hits:** all hits share a target unless stated otherwise; every hit is modified;
  but only **one** Weak/Vulnerable token is removed after the whole multi-hit resolves.
- **Order of operations: add damage bonuses first, then double for Vulnerable.**
- **Weak attacker into Vulnerable target: neither applies.** Afterwards remove one Weak
  from the attacker and one Vulnerable from every affected target.

### End of combat

1. End-of-combat abilities.
2. **Rewards.** In encounters you gain the rewards of the enemy in **the row you ended in**.
   In elite and boss fights **every player** gains the rewards.
3. **Reset deck** — powers, discard, and exhaust return to the deck; Status and Daze cards
   leave the deck and return to their own decks.
4. **Reset board** — block and energy tracks reset; **lose all tokens except gold**; Defect
   loses all orbs; Watcher returns to Neutral.
5. Enemy cards to the bottom of their decks; summons back to the Summons deck.
6. Players may freely switch rows before the next combat.

Combat ends the moment every enemy is dead or has left — unless a dying enemy has an
on-death ability that summons. **Summons do not flee when their summoner dies.**

## 3. Multiplayer (1–4, co-op)

Open information, with hands nominally private; the rules encourage discussing but not
reading hands. Decks, relics, and potions are per player.

- Enemy HP scales with player count.
- **Trading: potions only, and only outside combat.** Cards and relics never move.
- **Gold is the exception** — you may spend your gold on any part of another player's
  purchase, at a Merchant or an Event.
- Boss relics: reveal **(players + 1)**; solo reveals 3. Each player takes one or skips.
- Any death ends the game for everyone.

**Optional rules.** *The Last Stand* — a player who dies during a boss fight leaves the
others playing; enemies in an empty row target the nearest row with a player below, else
above. Surviving counts as beating the Act, but you may not continue to the next Act if
anyone died. *Choose Your Relic* — reveal relics equal to the player count at an Elite or
Treasure and let each player pick.

**Solo:** 2 extra gold, the Loaded Die relic, 3 boss relics, some encounters summon fewer
enemies, and Ascension unlocks by beating an **Act III** boss rather than Act II.

## 4. Keywords

Everything is capped. Caps are shared across all players for a given token type, and
**running out of a token means the effect is simply ignored** (Shivs excepted).

| Keyword | Meaning |
| --- | --- |
| Area of Effect | All enemies in one row, always including the boss. From an enemy: all players — unless it is gaining Strength or Block, which stays on itself. |
| ALL Enemies | Every enemy in every row, plus the boss. |
| Block | Prevents 1 damage each. **Player max 20.** Does not stop "lose X HP". Cleared at the start of the owner's turn — player block on the Player Turn, enemy block on the Enemy Turn. |
| Daze | Put a Daze card on **top of your draw pile**. Returns to the Daze deck when exhausted. |
| Energy | **Max 6**, reset to 3 each Player Turn. All characters' energy icons are interchangeable. |
| Ethereal | If in hand at end of turn, exhaust it. |
| Exhaust | Removed for the combat; returns to the deck at end of combat. Status and Daze return to *their* decks instead. |
| Hit | Damage equal to the printed number. Modified by Strength, Weak, Vulnerable. |
| Retain | Not discarded at end of turn. A card forgets it was retained once it leaves hand. |
| Scry X | Look at the top X of your draw pile, discard any number, return the rest **on top in the same order**. |
| Status | One physical card carries two halves (Burn / Slimed); use the half matching the icon of the enemy that gave it, ignore the other for that combat. Goes on top of the discard pile. Slimed costs 1. |
| Strength | **Max 8.** +1 damage per token **on each hit**. Enemies can have it. |
| Unplayable | Cannot be played and has no cost. An effect that tries to play it is ignored and the card is discarded. |
| Vulnerable | **Max 3.** Each hit against it is **doubled** (after bonuses); then remove **one** token. |
| Weak | **Max 3.** Each hit it deals is **−1**; then remove **one** token. |

**Statuses that do not exist in the board game:** Dexterity, Frail, Artifact, Intangible,
Thorns, Metallicize, Regen, Confused, Focus, Plated Armor, Wound, Void. Barricade and
Buffer exist only as card names, not as tracked keywords.

### Character resources

| Resource | Rules |
| --- | --- |
| **Poison** (Silent) | At **end of turn** each poisoned enemy **loses 1 HP per token**. This is HP loss, so **block does not stop it**. **Tokens are never removed until the enemy dies.** Global cap 30 across all enemies. |
| **Shivs** (Silent) | Max 5. Spend any time you could play a card to deal 1 damage. Each shiv is a **separate attack**, separately modified by Strength/Weak/Vulnerable. Not cards. If you have no shiv tokens left and gain one, you may deal its damage immediately instead. |
| **Miracles** (Watcher) | Max 5. Spend any time for 1 energy. **May exceed the 6-energy cap if spent immediately on a card.** |
| **Stances** (Watcher) | Neutral, Calm, Wrath only — **no Divinity**. Start each combat in Neutral. Entering a stance you are already in is ignored. **Calm:** leaving it grants 2 energy. **Wrath:** +1 damage on all hits; **ending your turn in Wrath costs you 1 damage** (blockable). |
| **Orbs** (Defect) | **No focus, no rotation, no slot order.** Channel places a cube in **any open** slot; if all are full, **evoke any orb of your choice** first. Evoke removes **any** orb you pick. Out of cubes → the channel is ignored. Lightning: 1 damage at end of turn, 2 on evoke. Frost: 1 block at end of turn, 1 on evoke. Dark: nothing at end of turn, **3 damage + 1 per power you have in play** on evoke. |

## 5. Cards

**Rarity by banner:** grey common (2 copies of each), blue uncommon, yellow rare. Starter
cards have grey banners *and* grey borders.

Types: Attack, Skill, Power (stays in front of you for the combat), Curse (**cannot be
transformed**), Status/Daze (leave the deck at end of every combat).

**Starter decks.** Ironclad: 5 Strike, 4 Defend, 1 Bash (10). Silent: 5 Strike, 5 Defend,
1 Neutralize, 1 Survivor (12). Defect: 4 Strike, 4 Defend, 1 Zap, 1 Dualcast (10).
Watcher: 4 Strike, 4 Defend, 1 Eruption, 1 Vigilance (10).

"Starter Strike" (a Strike from the starter deck) and "contains Strike" (any card with
Strike in its name) are different rules terms.

**Pool sizes**, from the Components page (p.3): Ironclad 85, Silent 87, Defect 85,
Watcher 85, Curses 17, Colorless 22 — **381 player cards** including unlocks. Distinct
card counts are lower: 61/64/62/64 per character plus 22 colorless and 10 curses.

### Rewards

You may take rewards in any order and skip any of them. **Full knowledge:** you may look at
every reward from a combat, and check what any upgrade does, before finalising anything.

| Reward | Rule |
| --- | --- |
| Card | Reveal the top **3** of your card rewards deck; add one or skip; rest to the bottom. |
| Golden Ticket | Also reveal the top **rare** and add it to the choices. |
| Upgraded Card | As Card, but the chosen card is immediately upgraded. |
| Rare | Reveal **3** from the rare deck. |
| Potion | Draw 1. **Limit 3** (2 at Ascension 4). Single use. |
| Relic | Draw 1; gain or skip. |
| Boss Relic | Reveal **(players + 1)**, solo 3. |
| Gold | Spendable at Merchants and some Events, including on another player's purchase. |

**Deck modification.** Remove: set aside. Upgrade: flip to the green-text side. Transform:
remove a non-curse card, then add the **top card of your card rewards deck** at random —
drawn from *your* character's deck even when transforming a colorless or foreign card.

### Playing copies

Each copy is a separate card, **costs no energy**, may pick its own targets, and is
separately modified. **Copies cannot be copied.** A card can only be affected by one
"play it multiple times" effect; extra ones wait for the next valid card. Copies resolve
first; the original hits the discard pile when it finishes.

## 6. Characters

| | Max HP | Starting ability | Mechanics |
| --- | --- | --- | --- |
| Ironclad | 10 | End of combat: heal 1 | Strength, exhaust synergy |
| Silent | 9 | Start of combat: draw 2 | Poison, shivs |
| Defect | 9 *(verify)* | Channel 1 Lightning at start of combat *(verify)* | Orbs |
| Watcher | 9 *(verify)* | Gain 1 Miracle | Stances, miracles, scry, retain |

**The rulebook states none of these numbers.** Max HP and starting abilities are printed on
the player boards; p.16 says only that "The Ironclad starts with more HP than any other
character". The values above come from board art and community sources, so confirm all four
against board scans before treating them as final.

**Cross-character cards.** Gaining stances or orbs from another character's card grants the
Prismatic Shard relic. The Defect gains no extra orb slots this way, and the Watcher cannot
enter stances via the Shard.

## 6a. What a complete implementation contains

Transcribed from the Components page (p.3). This is the concrete definition of done.

| Component | Count |
| --- | --- |
| Player cards | 381 including unlocks |
| 1st Encounters | 4 |
| Encounters | 43 — Act I/II/III 12/12/10, plus 3/3/3 Ascension |
| Summons | 89 — 35/31/20 by act |
| Elites | 27 — 3/3/3 per act, plus 6/6/6 Ascension |
| Bosses | 11 cards, 26 including unlocks |
| Events | 51 — 12/14/11 by act, plus 6/5/2 Ascension, 1 in the unlock deck |
| Status | 36 |
| Daze | 10 |
| Neow's Blessing | 14, 20 including unlocks |
| Relics | 58, plus 20 Boss Relics, 4 Prismatic Shard, 1 Solo Relic |
| Potions | 29 |
| Tokens | 113 |

## 7. Enemies

Card anatomy: rewards (upper left) · name · HP track · action block (single / die / cube) ·
special ability in yellow · summon bar in green.

Elites in Acts II–III give one **upgraded** card; Act I elites give one common. Elite gold:
2 in Acts I–II, 3 in Act III.

Act I bosses: The Guardian (die 1–2), Hexaghost (3–4), Slime Boss (5–6).
Act II: The Collector, Bronze Automaton, The Champ.
Act III: Donu + Deca, Awakened One, Time Eater.
Act IV: Corrupt Heart, with Spire Shield and Spire Spear as elites at Ascension 11.

The full roster and per-enemy rewards live in `data/raw/enemies-events-elites.csv` and
`data/raw/bosses.csv`.

## 8. Economy and the Merchant

Gold comes in 1s and 5s and is **the only token kept** through end-of-combat reset.

At a Merchant: lay out 3 relics and 3 potions; each player reveals the top 3 of their own
card rewards deck (plus 3 shared colorless once unlocked).

- Items cost the price printed bottom-right. **The relic in the top-left slot is 1 cheaper.**
- Cards: **2** common, **3** uncommon, **6** rare.
- Card removal: **3 gold** (**4** at Ascension 8), **once per player per Merchant**.

## 9. Ascension

Unlocked by beating an Act II boss (Act III solo). Cumulative, 1–13.

| # | Modifier |
| --- | --- |
| 1 | Harder elites (A1 elite deck) |
| 2 | Lose 1 max HP |
| 3 | Harder events (add A3 cards) |
| 4 | Potion limit 2 |
| 5 | Start cursed (Ascender's Bane in the starter deck) |
| 6 | Heal 4 after a boss instead of healing to full |
| 7 | Harder encounters (A7 encounters and summons) |
| 8 | Card removal costs 4 |
| 9 | Start damaged (lose 1 HP at game start) |
| 10 | Harder bosses (A10 boss deck only) |
| 11 | Harder Act IV (A11 Corrupt Heart and elites) |
| 12 | Harder elites in Acts I–III (A12 elite deck) |
| 13 | After the Act III boss, fight a second different Act III boss |

## 10. Act IV and keys

Needs the Act IV unlock and all three keys by the end of Act III.

- **Ruby** — every player simultaneously takes no action at a Campfire.
- **Sapphire** — every player simultaneously skips a relic at an Elite or Treasure.
- **Emerald** — defeat a Burning Elite; before that fight each player shuffles 2 Burn
  status cards into their deck.

## 11. Traps when porting from the video game

1. **Rows.** Enemies target the player in their row; players may hit anything.
2. Most video-game statuses **do not exist** (§4).
3. **Orbs do not rotate.** Channel into any slot, evoke any orb.
4. **No Divinity stance.**
5. **Poison never decrements** — it stays until the enemy dies, and it is HP loss, not damage.
6. **Vulnerable and Weak are capped at 3 and are consumed per attack**, not per turn.
7. Everything is capped: energy 6, block 20, strength 8, poison 30 global, shivs 5,
   miracles 5, vulnerable/weak 3.
8. **Summons do not flee** when the summoner dies.
9. **One shared die roll per round** drives die actions and die relics.
10. **Enemy block clears on the Enemy Turn**, player block on the Player Turn.
11. Infinite combos are deliberately broken — repeat triggers fire once per turn.
12. Numbers are scaled roughly 8:1 — characters have 9–10 HP and Strike deals about 1.
