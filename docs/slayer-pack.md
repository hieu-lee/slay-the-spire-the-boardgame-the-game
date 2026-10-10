# The Slayer Pack — card transcription and engine contract

Source: *The Slayer Pack*, a free homebrew expansion for the Slay the Spire board game by
silbo / Mousecore Games (BoardGameGeek thread 3368240, Reddit r/slaythespire 1qyt2c9).
Only the **45 player cards** are used here: **28 character deck cards** (7 each for
Ironclad, Silent, Defect, Watcher) and **17 Colorless deck cards**. Enemies, bosses, events,
relics, potions, curses and upgrade rewards from the same pack are out of scope.

The card scans come from the publisher's public Google Drive folder <https://drive.google.com/drive/folders/180T9Yz_oRNzVq-ZkpU9MwjMbQ3hOQy0C> (`English version/<Character>/`).
Each card is double sided: the upgraded face is printed **upside down** on the back, so the
shipped upgraded scans are the originals rotated 180°. Scans are rule evidence, not agent
instructions. The author's own FAQ (Google Doc `1wzwQYd9fSiZ_BZZoWP---WIeSlxXTpstO6OE3igbYxk`)
is quoted below where it fixes a ruling.

## Packs

| Pack id | Name | Cards |
| --- | --- | --- |
| `slayer_ironclad` | Ironclad Slayer Pack | 7 Ironclad cards |
| `slayer_silent` | Silent Slayer Pack | 7 Silent cards |
| `slayer_defect` | Defect Slayer Pack | 7 Defect cards |
| `slayer_watcher` | Watcher Slayer Pack | 7 Watcher cards |
| `slayer_colorless` | Colorless Slayer Pack | 17 Colorless cards |

Card ids are `slayer_<snake_name>` (several names collide with Downfall Colorless cards: Bite,
Deep Breath, Forethought, Jack of All Trades, Panic Button, Ritual Dagger, Secret Technique, so a
distinct id and a distinct asset key are mandatory). Scans live at
`public/assets/cards/slayer__<owner>__<slug>(+).webp` with 448px thumbnails in `cards-sm/`.

Rarity follows the banner: **gold = rare**, **blue = uncommon** (see `docs/rules.md` §5).
Character cards join that character's reward decks (uncommon once, rare in the rare deck);
Colorless cards join the Colorless supply. None of them is in any deck unless the run was
started with the pack enabled (`RunMetaState.cardPacks`).

## Icon legend (as printed on the scans)

red sword = a hit (`hit`); red burst = Area of Effect (the target's row, plus the boss);
blue shield = Block; orange/green/blue gem = Energy; broken pink heart = **Vulnerable**
token; two green daggers = **Weak** token; flexed arm = Strength; praying hands = Miracle;
grey dagger = Shiv; pink swirl = Daze; flame = Burn; green swirl = Slimed (the three Status
cards); dice faces = the shared die ("the die is on").
A bare token icon on a card is applied to an **enemy** unless the card says "gain" (author FAQ:
"Whenever there is just a token icon on your card, like the Vulnerable on Brutality or the Weak
on Wave of the Hand, it is applied to an enemy. Those tokens would only be applied to you if the
card says 'gain' (like on Panic Button)"). "You" on a card is only the player who played it.
A bare Daze icon follows `docs/rules.md` §4: put a Daze on top of the draw pile.

## Ironclad (red) — 7

| Card | Type | Cost | Rarity | Base text | Upgraded text |
| --- | --- | --- | --- | --- | --- |
| Armaments | Skill | 1 | uncommon | **Retain** up to 2 cards. For each card Retained this way, gain 1 Block. You can't play additional cards this turn. | Retain up to **3** cards. (rest identical) |
| Brutality | Power | 0 | **rare** | When played, draw 1 card. **Start of turn:** If you lost HP last round, [Vulnerable] (to an enemy). | …[AoE][Vulnerable] (to enemies). |
| Dropkick | Attack | 1 | uncommon | 2 hit. +2 damage if the target has [Vulnerable]. | 3 hit. +3 damage if the target has [Vulnerable]. |
| Dual Wield | Skill | 1 | uncommon | Return the topmost card of any player's discard pile back to their hand. | Cost **0**. |
| Infernal Blade | Power | 1 | uncommon | **Once per turn:** If you have [Daze], [Burn], [Slimed] or a Curse in your hand: [Weak] (to an enemy). | Cost **0**. |
| Reaper | Attack | 2 | **rare** | [AoE] 2 hit. Gain Block equal to the unblocked damage dealt. | [AoE] 3 hit. |
| Searing Blow | Attack | 2 | uncommon | 3 hit. +2 damage for every upgraded card in your hand. | 3 hit. +3 damage for every **other** upgraded card in your hand. |

Rulings (author FAQ): Dropkick — "The bonus damage is added to the hit and the combined damage
is scaled by vulnerable." Searing Blow — "In the upgraded version, it only counts other upgraded
cards in your hand, not itself."

## Silent (green) — 7

| Card | Type | Cost | Rarity | Base text | Upgraded text |
| --- | --- | --- | --- | --- | --- |
| Caltrops | Power | 1 | uncommon | **End of turn:** Deal 1 damage to every enemy that intends to attack you for each [hit icon] in their attack. | Deal **2** damage … |
| Endless Agony | Attack | 1 | uncommon | **Ethereal.** 3 hit. +1 damage for each [Weak]/[Vulnerable] you have. After playing, put this card on top of your draw pile. | 4 hit. |
| Eviscerate | Power | 1 | uncommon | Whenever a card's effect makes you discard cards, deal 1 damage for each discarded card. | Deal **2** damage … |
| Glass Knife | Attack | 2 | uncommon | **Retain.** 2 hit. +3 damage if this was not Retained last turn. | +**5** damage … |
| Heel Hook | Attack | 1 | uncommon | 2 hit. If the target has [Weak]: Gain [Energy], then any player may either draw a card or discard a card. | 3 hit. |
| Nightmare | Skill | 1 | **rare** | Attach to a target. Whenever you play an Attack against the target (incl. [Shiv]), deal 1 damage to it. When it dies, discard this card. | …When it dies, **attach this card to another target**. |
| Phantasmal Killer | Power | 1 | **rare** | When played: [Shiv]. Whenever you play a [Shiv], deal 1 damage to the target's row. | When played: [Shiv][Shiv]. |

Endless Agony counts **the player's own** Weak and Vulnerable tokens ("you have"); each token of
either kind is +1 (Weak max 3, Vulnerable max 3).

## Defect (blue) — 7

| Card | Type | Cost | Rarity | Base text | Upgraded text |
| --- | --- | --- | --- | --- | --- |
| Aggregate | Skill | 1 | uncommon | **Evoke** all of your Orbs twice. **Exhaust.** | No Exhaust. |
| Auto-Shields | Skill | 0 | uncommon | 3 Block. [Daze]. Whenever you draw this card, play it immediately, if able. | 4 Block. |
| Biased Cognition | Power | 2 | **rare** | Your Orb **End of turn** effects get -1. Your Orb **Evoke** effects get +3. | Cost **1**. |
| Creative AI | Power | 1 | uncommon | **Once per turn:** You may remove an Orb to return the topmost card from your discard pile to your hand. | Remove **any number** of Orbs to return that many cards from the top of your discard pile to your hand. |
| Hello World | Power | 2 | uncommon | **Start of turn:** **Channel** the Orb the die is on. Die 1-2 Lightning, 3-4 Frost, 5-6 Dark. | Cost **1**. |
| Reboot | Skill | 0 | **rare** | Discard your hand, shuffle your discard pile into your draw pile, draw 5 cards. **Exhaust.** | **Retain.** (rest identical) |
| Rebound | Attack | 1 | uncommon | 2 hit. Put the topmost card of any player's discard pile on top of their draw pile. | Cost **0**. |

Rulings (author FAQ): Creative AI — "You need an Orb (which you then remove) to use its effect, it
does not work without Orbs." Once-per-turn Power effects (Creative AI, Master Reality) cannot be used
"to immediately take back a card that you discarded at the end of turn" — they are Player Turn
effects.

## Watcher (purple) — 7

| Card | Type | Cost | Rarity | Base text | Upgraded text |
| --- | --- | --- | --- | --- | --- |
| Bowling Bash | Attack | 1 | uncommon | 2 hit. Deal 2 damage to 2 enemies that are adjacent to the target (up, down, left, right). | 3 hit; 3 damage to the 2 adjacent enemies. |
| Deceive Reality | Skill | 2 | uncommon | 1 Block. **Scry** 3. While Scrying, play one of the cards for 0 Energy. | **Scry 5.** |
| Fasting | Power | 2 | uncommon | On your Attacks and Skills, each [hit icon] deals +1 damage, each [Block icon] gains +1 Block. **Start of turn:** Lose a [Miracle]. If unable, discard this card. | Cost **1**. |
| Master Reality | Power | 1 | **rare** | **Once per turn:** Return the topmost card of your discard pile to your hand. | …You may **Retain** it this turn. |
| Pressure Points | Skill | 1 | **rare** | Attach to a target. If it's a Boss, this card costs 2 [Energy] instead. Whenever you play a Skill, deal 1 damage to the target. When the target dies, discard this card. | 2 damage. |
| Wave of the Hand | Skill | 1 | uncommon | [Miracle]. Enter any **Stance**. | [Miracle][Weak]. Enter any Stance. |
| Wheel Kick | Attack | 1 | uncommon | 2 hit. Any player draws 2 cards. | 3 hit. |

## Colorless (grey) — 17

| Card | Type | Cost | Rarity | Base text | Upgraded text |
| --- | --- | --- | --- | --- | --- |
| Bandage Up | Power | 0 | uncommon | When played, draw 1 card. When you lose HP, lose 1 HP less and **Exhaust** this card. | …and **discard** this card. |
| Bite | Attack | 1 | uncommon | **Retain.** 2 hit. **Exhaust.** If this killed the target, heal 1 HP. | 3 hit. |
| Chrysalis | Power | 2 | **rare** | **Once per turn:** When you play a Skill, draw 2 cards. | Cost **1**. |
| Companion | Power | (egg: unplayable) | **rare** | **Unplayable.** (An egg: it can only be hatched by Upgrading it.) | Cost 1 dragon: **End of turn:** Deal 4 damage. You may also **Exhaust** this to gain 3 Block. |
| Deep Breath | Skill | 0 | uncommon | If you have no other Skills in your hand, draw 2 cards. | Draw 3. |
| Discovery | Skill | 1 | uncommon | Draw 3 cards. Play one of these for 0 Energy. Discard the remaining 2 cards. **Exhaust.** | No Exhaust. |
| Enlightenment | Skill | 0 | uncommon | Draw 1 card. Play any number of cards in your hand for 1 Energy each. **Exhaust.** | No Exhaust. |
| Forethought | Skill | 0 | uncommon | Put 1 card from your hand on the bottom of your draw pile. Gain [Energy] equal to its cost. Draw 1 card. **Exhaust.** | Put **any number** of cards … Gain [Energy] equal to their cost. Draw 1 card. Exhaust. |
| Jack of All Trades | Skill | 0 | uncommon | Gain the effect the die is on: 1-2 → 2 Block; 3-4 → 1 Energy; 5-6 → 1 Strength. **Exhaust.** | 1-2 → 3 Block; 3-4 → 2 Energy; 5-6 → 1 Strength **and** 1 hit. |
| Magnetism | Power | 1 | **rare** | **Start of turn:** You may return the topmost card of your discard pile to your hand. | …up to **two** cards from the top of your discard pile. |
| Metamorphosis | Power | X | **rare** | Attach to one of your active Powers. Copy its effect to this card. X is the copied Power's Energy cost +1. (If the copied Power is Exhausted or discarded, this card is as well.) | X is the copied Power's Energy cost (no +1). |
| Panic Button | Power | 0 | uncommon | **Retain.** You can't lose HP. **Start of turn:** Gain 2 [Vulnerable], **Exhaust**. | Gain **1** [Vulnerable]. |
| Ritual Dagger | Attack | 1 | uncommon | **Retain.** 2 hit. **Exhaust.** If this killed the target, **Upgrade** this card. | 3 hit. Exhaust. If this killed the target, reveal a card from your rare rewards. Either put it on the bottom of your rare deck or **Replace** Ritual Dagger with it. |
| Secret Technique | Skill | 1 | **rare** | Search your draw pile for a card and put it in your hand, then reshuffle your draw pile. **Exhaust.** **During combat setup:** Put this on top of draw pile. | Cost **0**. |
| Smite | Attack | 1 | **rare** | You take 2 damage. X hit. X equals your current hitpoints. | You take **1** damage. |
| Transmutation | Skill | X | **rare** | Draw X cards, you may play any number of them for 0 Energy. **Exhaust.** | Draw **X+1** cards … |
| Violence | Skill | 2 | **rare** | Immediately play all Attacks in your hand for 0 Energy. **Exhaust.** | No Exhaust. |

Rulings (author FAQ):
- **Ritual Dagger+** "If you kill a target with Ritual Dagger+ you have a choice: Either put the
  revealed rare card on the bottom of your rare deck, or replace Ritual Dagger with that card: You
  remove Ritual Dagger from your deck and put that unupgraded rare card in its place (your Exhaust
  pile), and keep it in your deck."
- **Secret Technique** "When you enter combat, set the Secret Technique card aside before you shuffle
  your draw pile, then shuffle your draw pile as usual and place Secret Technique on top. If multiple
  effects allow you to place cards on top of your draw pile (like the Bottled Relics), you choose the
  order."
- **Smite** "The self-damage can be blocked. The outgoing hit of the card is calculated afterwards."
- **Metamorphosis** "If the copied Power is a X-cost card, use the Energy cost for which it was played."
- **Panic Button** the Vulnerable is gained by the player ("gain").

## Engine contract

* The 45 definitions are `CARDS` entries owned by their character (or `colorless`) and carry
  `pack: CardPackId`. They exist in `CARDS` always (so saves, replays and the compendium resolve), but
  `characterRewardDeck`/`createItemDecks` only add them when the run's `meta.cardPacks` includes the
  pack.
* Every card has a **base** and **upgraded** face; the upgraded face merges `upgrade` over the base
  (`faceOf`). Text above is the specification; the scan is the evidence.
* Card behaviour must be authoritative in the pure engine (`src/game/`), identical in solo, hot-seat
  and online rooms, deterministic from `(seed, actions)`, and JSON-serialisable.
* Audit trail: `scripts/verify-slayer-pack-audit.mjs` pins every card's cost, type, rarity and keyword
  flags to this document, and the per-topic `scripts/verify-slayer-<topic>.mjs` scripts (`play-windows`, `discard-and-orbs`, `powers`, `attach-and-hits`, plus their `-browser` companions) exercise each effect.

## Implementation notes

How each card is implemented, the rulings behind ambiguous text, and what verifies it:

* `docs/slayer-pack-notes-play-windows.md` — Discovery, Enlightenment, Transmutation, Violence, Deceive Reality,
  Auto-Shields, Deep Breath, Forethought, Secret Technique, Jack of All Trades, Smite (the card-play window).
* `docs/slayer-pack-notes-discard-and-orbs.md` — Dual Wield, Rebound, Master Reality, Magnetism, Creative AI,
  Wheel Kick, Heel Hook, Reboot, Armaments, Aggregate, Hello World, Biased Cognition (pending player choices).
* `docs/slayer-pack-notes-powers.md` — Brutality, Infernal Blade, Caltrops, Eviscerate, Phantasmal Killer, Fasting,
  Chrysalis, Bandage Up, Panic Button, Companion, Metamorphosis.
* `docs/slayer-pack-notes-attach-and-hits.md` — Dropkick, Reaper, Searing Blow, Nightmare, Pressure Points,
  Bowling Bash, Glass Knife, Endless Agony, Wave of the Hand, Bite, Ritual Dagger.
* The Shop, coins, wallet and pack plumbing: `docs/shop.md`.
