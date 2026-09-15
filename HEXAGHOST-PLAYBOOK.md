# Hexaghost A0 Playbook

This is the live playbook for solo Hexaghost runs in Slay the Spire mode. Use WebMCP only: inspect the current state, invoke a current control ID, then inspect again. Do not use Downfall. After every finished run, append one attempt entry with the result and the lesson that changes a future decision.

## Verified starting rules

- Character passive / starting relic: **Start of Combat: gain 1 Soulburn.**
- Heat is a 1–6 track. `Advance` gains 1 Heat; `Retract` loses 1 Heat, including at the cap/floor.
- Soulburn is a token, not a card. Spend it whenever a card effect allows it to deal damage equal to current Heat; maximum 6.
- Hexaghost's first positive hit is stopped by its Buffer. Do not mistake the first zero-damage hit for a failed card; use it to consume Buffer, then burst the boss.
- The character wants a compact deck with enough ordinary Block to survive while Heat/Soulburn setup becomes damage. Do not take every card that mentions Heat.

## Card priorities and build directions

- **Heat-block core:** `Volcano Visage` is the enabler; pair it with cheap Advance cards (`Kindle`, `Fast Forward`, then `Advancing Guard`) and at least one real damage payoff (`Divider`, `Charged Barrage`, or a Soulburn burst card). Do not take the payoff before the deck can advance safely and block the next attack.
- **Soulburn block core:** `Heat Shield` plus a repeatable Soulburn source (`Floatwork`, `Fleeting Flash`, or `Living Bomb`) turns each spend into both damage and 2 Block. Its must-have partner is a Heat source; at Heat 1 it is only emergency defense, not a scaling plan.
- **Exhaust/status core:** `Worthy Sacrifice`, `Time of Need`, `Firestarter`, and `Blue Candle` are premium because they remove Burns/Slimed cards while improving the current turn. Add `Ghost Shield` only when the deck can reliably exhaust first; it is then a zero-cost defensive floor.
- **Burst/control package:** `YOU ARE MINE!` is strong in any boss fight: its 2 Block plus two Vulnerable and two Weak creates a safe burst window. `Blind` is a good zero-cost alternative. Spend Vulnerable on the first hit that matters, since each hit removes a stack.
- **Good before a direction is clear:** take compact damage-plus-draw (`Firestarter`), zero-cost or status-aware Block (`Ghost Shield`, `Time of Need`), and cards that make one safe Advance (`Kindle`, `Fast Forward`). Skip duplicate small Block and expensive Heat payoffs without their enabler.

## Every room and turn

1. Use `inspect_game` and record HP, Heat, Soulburn, energy, hand, draw/discard, potions, enemy HP/Block/tokens, and enemy intents.
2. Calculate lethal first. Count the first-hit Buffer against Hexaghost and count every Soulburn as current-Heat damage.
3. If lethal is unavailable, cover the intent before advancing Heat for value. Keep one emergency defensive line for the next dangerous turn.
4. Exhaust bad cards when the hand offers a safe exhaust choice; exhaust pile is an engine for Ghost Lash, Ghost Shield, Flames from Beyond, Unleash Spirits, and Power from Beyond.
5. End the turn only after checking zero-cost cards, Soulburn timing, status cards, and whether an Advance/Retract trigger changes Block or damage.

## Live rules discovered during play

- Player Block does not carry into the next turn. Treat every turn as a fresh Block budget; leftover Block is not a reason to skip the next turn's defense.
- Start-of-turn effects are a real WebMCP step: resolve the `Resolve start of turn` control before planning from the new hand, energy, or intent.
- `Burn` is unplayable and deals 1 special damage at end of turn if it remains in hand. Hexaghost can add several Burns at once, so an apparently blocked attack can still be lethal; exhaust existing Burns whenever the turn's defense allows it.
- A targeted card is a two-step WebMCP action: invoke the card, then invoke the selected enemy. The same applies to `Spend Soulburn`.
- Soulburn deals damage equal to current Heat. At Heat 2, spending the starting Soulburn dealt 2 damage in the test fight.
- Attack Potion creates `Double Tap` for the next Attack. A copied targeted Attack may ask for its enemy first and then ask for the original Attack's enemy again; budget the potion for a lethal or high-value hit.
- Enemy Block was present during the player turn and was removed before the enemy's next action. Do not assume it survives the enemy turn.
- An enemy can telegraph a non-attack setup turn (the first Jaw Worm turn was Block plus Strength). Use those windows to deal damage or set up, but still inspect the next intent before ending the turn.
- A finished combat is not yet a recorded run: after a defeat, press `Record campaign result` (or `Stop and record result` after a victory) before starting the next run. The solo leaderboard queues only after the run is finalized; verify the leaderboard submission before moving on.
- `Empowered Flame` and `Volcano Visage` are a compact core: the former Advances at each start of turn, and the latter turns that Advance into 1 Block. With a second Advance card they rapidly reach Heat 5–6 while providing a small recurring defensive floor.
- `Rewind` can exhaust an unplayable `Burn` from hand before its end-of-turn damage, then draw 3. Pair it with `Virus` (which dealt damage after adding its two exhausted cards) and `Ghost Lash` (two 1-damage hits once the Exhaust pile has at least two cards). This is a usable two-card exhaust payoff package, not just deck thinning.
- `Bad Omen` at 2+ Heat gives 2 Block and 2 Weak before Retracting. Use it on the enemy whose current multi-hit or highest attack matters; Weak is consumed per hit, so do not assume two stacks blank a whole multi-hit action.
- Fungi Beast's `Spore Cloud` applies 1 Vulnerable when it dies. In a multi-enemy row, take a complete kill only if the remaining intent is blocked or harmless; otherwise leave it at low HP and stabilize first.
- `Virus` exhausts up to two top-deck cards before its X-damage, so even a thin Exhaust pile becomes immediate damage and deck compression. At 3 exhausted cards it dealt 3; its target/result can resolve after a short combat animation, so refresh the state rather than treating the first unchanged HP display as a miss.
- At 5+ Heat, `Haunting Echo` replayed `Virus`: the Echo's own 2 damage landed first, then the copied Virus asked for a second target and exhausted the remaining top-deck card. This is a strong boss burst only when there are enough cards left to exhaust; budget the two targeting steps and do not expect it to solve a same-turn block deficit by itself.
- `Float` is a worthwhile Heat-exhaust pickup once the deck reliably reaches 4 Heat: it converts 1 Energy into 3 Energy at the threshold, exhausts itself, and supports both a larger Virus and conditional payoff turn. Before that threshold it is merely a small, temporary energy gain, so do not prioritize it over immediate Block.
- `Attack Potion` plus `Virus` is an exceptional multi-enemy finisher. Activate the potion before Virus; the game resolves a copied Virus target first, exhausts its top two cards, then explicitly asks for the original Virus target. In the Act 2 Slavers elite, an Exhaust pile of 8 became 10 for the copy and 12 for the original, clearing separate 10- and 8-HP targets. Save this combination for a row where the two target prompts can remove the live attackers.
- `Snecko` sets the first card each turn to a displayed random cost. Inspect that cost before deciding the line; a Lantern's combat-start Energy let a 3-cost opening Power remain playable. Do not spend the first-card slot on a weak effect when the random price prevents the needed block or engine card.

## Initial draft plan

Take early cards that solve an immediate problem: one efficient attack, one real Block card, then draw/energy or a compact engine. Upgrade the card that most improves the next elite or boss; remove Strikes only after reliable damage exists.

Strong flexible targets:

- Damage and tempo: `Firestarter`, `Heat Metal`, `Flare Flick`, `Searing Wound`, `Charged Barrage`, `Step Through`, `Radiant Reverb`.
- Heat/Soulburn: `Fleeting Flash`, `Floatwork`, `Float`, `Instant Inferno`, `Living Bomb`, `Incineration`, `Heat Crush`.
- Exhaust: `Devour Flame`, `Shield of Night`, `Sword of Night`, `Nightmare Strike`, `Nightmare Vision`, `Eerie Expedition`.
- Defense: `Hexaguard`, `Ghost Shield`, `Spectral Grace`, `Advancing Guard`, `Time of Need`, `Incorporeal` only when the energy plan supports it.
- Engines: `Rain of Embers` with reliable exhaust, `Heat Shield` with repeatable Soulburn, `Volcano Visage` with repeatable Advance, `Poltergeist` with both Heat movements, `Unleash Spirits` with a real Exhaust pile, or `Power from Beyond` with several exhausted Attacks.
- Scaling: `Divider` and `Doomsday` at high Heat, `Haunting Echo` at 5+ Heat, `Step Through` at 6 Heat, `Stoke the Fire` only when a long fight can pay back its cost.

Do not commit to an engine from one card. A payoff needs at least two usable enablers and a survival plan. Avoid bloating the deck with expensive setup, and do not rely on a pure Heat deck if it cannot block the next attack.

## Hexaghost compendium inventory (64 cards)

The live Hexaghost filter showed these cards:

### Starter

- `Strike` (1): deal 1 damage.
- `Defend` (1): gain 1 Block.
- `Sear` (0): deal 1 damage, +1 at 2+ Heat.
- `Kindle` (1): gain 1 Block, Advance.

### Common

- `Advancing Guard` (2): support any player, gain 2 Block, Advance.
- `Burning Touch` (2): deal 2 damage, gain 1 Soulburn.
- `Firestarter` (1): deal 2 damage, draw 2, Exhaust.
- `Flare Flick` (1): row/boss hit once, plus once at 2+ Heat.
- `Fleeting Flash` (1): gain 1 Soulburn, Exhaust.
- `Floatwork` (2): gain 2 Block and 1 Soulburn.
- `Ghost Lash` (0): deal 1 damage, plus 1 with 2+ cards in Exhaust.
- `Ghost Shield` (0): gain 1 Block, plus 1 with 2+ cards in Exhaust.
- `Heat Crush` (1): deal 2 damage; next Soulburn deals +1.
- `Hexaguard` (1): gain 1 Block per Heat, Exhaust.
- `Nightmare Strike` (1): deal 2 damage; when Exhausted, gain 1 Strength.
- `Premonition` (1): gain 2 Block; draw 2 at 3+ Heat.
- `Shield of Night` (2): gain 3 Block, Exhaust 1 card.
- `Sword of Night` (1): deal 2 damage, Exhaust 1 card.
- `Thermal Transfer` (1): deal 1 damage, Advance.
- `Time of Need` (0): gain 1 Block, Exhaust 1 card, Retain.

### Uncommon

- `Bad Omen` (1): gain 2 Block; at 2+ Heat apply 2 Weak; Retract.
- `Catch Up` (X): Advance once per Energy spent, Exhaust.
- `Charged Barrage` (2): row/boss deal 3, plus 2 at 4+ Heat.
- `Devour Flame` (1): gain 2 Block; Exhaust the next card played.
- `Divider` (2): deal 1 damage once per Heat.
- `Eerie Expedition` (1): put up to 2 Exhaust-pile cards on top of the draw pile, Exhaust.
- `Empowered Flame` (1): start of turn Advance.
- `Fast Forward` (1): draw 2, Advance.
- `Flames from Beyond` (2): row/boss deal 2 plus 1 per Exhaust-pile card.
- `Float` (1): gain 2 Energy, plus 1 at 4+ Heat, Exhaust.
- `Haunted Hand` (1): gain 1 Strength; at 2+ Heat Retract; Exhaust.
- `Haunting Echo` (1): deal 2; at 5+ Heat replay the last Attack.
- `Heat Metal` (1): deal 2; draw 2 if Soulburn was used this turn.
- `Heat Shield` (2): once per turn, using Soulburn gains 2 Block.
- `Lingering Shades` (2): once per turn spend 1 Energy to gain 1 Soulburn.
- `Living Bomb` (2): gain 1 Soulburn, spend all Soulburn on a row/boss.
- `Nightmare Guise` (1): gain 2 Block; on Exhaust Advance twice.
- `Nightmare Vision` (1): draw 2; on Exhaust gain 2 Energy.
- `Phantom Fireball` (0): deal 1; at 4+ Heat gain 1 Soulburn.
- `Spectral Grace` (1): gain 3 Block, Exhaust.
- `Stoke the Fire` (4): gain 1 Strength, Exhaust.
- `Power from Beyond` (2): gain 1 Strength per Attack in the Exhaust pile, Exhaust.
- `Rain of Embers` (1): once per turn, an Exhaust gains 1 Soulburn.
- `Rewind` (1): Exhaust 1 card, draw 3, Retract.
- `Searing Wound` (1): deal 2, apply Vulnerable, Retract.
- `Seventh Eye` (2): deal 2, gain 2 Block; at 5+ Heat apply Weak and Vulnerable.
- `Turn It Up` (1): Advance; at 5+ Heat gain 1 Strength.
- `Volcano Visage` (1): whenever you Advance, gain 1 Block.
- `Whisper from Beyond` (1): deal 1 twice; with 2+ Exhaust cards apply Weak.
- `Worthy Sacrifice` (1): start of turn Exhaust 1 card, gain 1 Block.

### Rare

- `Bright Ritual` (1): at 3+ Heat apply two Weak and two Vulnerable, Retract twice.
- `Doomsday` (0): row/boss deal 6 at 6 Heat.
- `Devil's Dance` (2): start of turn gain 1 Energy, draw 1, Retract.
- `Extra Crispy` (1): once per turn.
- `Forked Flame` (2): choose three 1-damage hits, 2 damage plus Advance, or 3 to a row/boss.
- `Incineration` (2): spend all Soulburn on one enemy, then regain it, Exhaust.
- `Incorporeal` (6): support any player, gain 4 Block.
- `Infernal Form` (3): at 6 Heat Retract six times then gain 2 Strength; otherwise Advance twice.
- `Instant Inferno` (3): gain 3 Soulburn, Exhaust.
- `Poltergeist` (1): whenever you Advance, deal 2; whenever you Retract, deal 2.
- `Radiant Reverb` (3): deal 4 damage twice, Exhaust the hand.
- `Step Through` (1): deal 2, +4 at 6 Heat; draw 2 at 2+ Heat; gain 2 Block at 4+ Heat.
- `Unleash Spirits` (3): row/boss end-of-turn damage equal to the Exhaust pile.
- `Unlimited Power` (0): gain 2 Energy, Advance, Exhaust.

## Boss checklist

## Build directions and early-card priorities

- **Heat burst:** build around `Fast Forward`/`Unlimited Power`/`Kindle` to reach 4–6 Heat, then convert it with `Step Through+`, `Charged Barrage+`, `Divider`, or `Haunting Echo`. The must-have is reliable Heat acceleration plus at least one payoff; do not add several conditional payoffs before the accelerators.
- **Soulburn-block engine:** `Heat Shield+` is the core, with `Floatwork`, `Rain of Embers`, `Living Bomb+`, or `Lingering Shades` supplying repeatable Soulburn. Spend a Soulburn on attack turns both to damage and to turn Heat Shield into 3 Block; avoid spending the last Soulburn before checking the next enemy intent.
- **Exhaust/Virus engine:** `Rewind` or cheap exhaust cards set up `Virus`; `Firestarter` adds draw while removing itself. This build needs repeatable exhaust and a damage conversion, not merely one Virus. Exhaust basic Strikes/Defends only when the immediate draw, lethal, or defensive line is improved.
- **Heat-exhaust hybrid:** `Empowered Flame` plus `Volcano Visage` is the enabling pair; add `Fast Forward`/`Kindle` to reach Heat thresholds and `Rewind`/`Virus` plus `Ghost Lash` or `Flames from Beyond` for immediate exhaust conversion. The pair is worth prioritizing when one piece is already in deck because it supplies Heat, recurring Block, and a route to `Haunting Echo`/`Step Through` thresholds.
- **Heat-exhaust execution:** play `Volcano Visage` before an Advance, then `Poltergeist` before the next Advance or Retract whenever the current intent is covered. `Seventh Eye` at 5+ Heat is still efficient mixed defense/debuff, but `Virus` damage did not double through its Vulnerable in the Bronze Automaton fight; do not budget that as a lethal multiplier. `Time of Need+` is a strong bridge card here because it provides retained zero-cost Block while turning a basic card into Exhaust; do not spend it if its forced exhaust removes the only line for the current intent.
- **Reverb burst:** `Radiant Reverb+` is a finishing card, especially with Vulnerable/Strength or a next-Attack-free effect. It exhausts the whole hand, so use it only for lethal or when no retained defense is needed; never treat it as routine damage on a multi-enemy attack turn.
- **Generic early picks:** prioritize efficient draw (`Fast Forward`, `Firestarter`, `Rewind`), immediate block/Soulburn (`Floatwork`, `Heat Shield`), Weak (`Bad Omen`), and unconditional damage. Skip narrow cards that lack their enabler, expensive setup with no survival effect, and low-impact basic replacements unless they solve the current deck's damage or block deficit.
- **Heat-block baseline:** once `Volcano Visage` is in the deck, take at least two cheap Advances (`Kindle`, `Fast Forward`, `Unlimited Power`, or `Empowered Flame`) before adding more payoff. `Divider` is the first damage payoff to want: at 4–6 Heat it converts a two-energy turn into 4–6 damage, while Visage turns each Advance into another Block. `Premonition` and `Firestarter` are the best generic bridge cards here: they replace themselves at the relevant Heat threshold and make the low-card-quality starter deck less punishing.
- **Relic sequencing:** `Ninja Scroll` supplies three targetable zero-energy Shivs; use them to consume a boss Buffer or remove the highest-impact low-HP minion before paying Energy. `Golden Eye` should keep an imminent draw/finisher and discard dead basics when its Scry would otherwise dilute the next draw. `Ice Cream` is strongest on non-attack or status-only turns: bank Energy for `Divider` plus defense rather than spending it on a marginal basic Strike.
- **Generic combat plan:** kill or weaken the highest-impact attacker first, then compare total incoming hits after Weak/Vulnerable against actual Block before committing energy. Use start-of-turn relic modification before resolving start effects when it produces a defensive trigger, energy, or a lethal setup. In multi-enemy fights, a partial kill that leaves the same incoming total is usually worse than enough block or a complete removal line.

### Act 1

- **Sentries:** their observed cycle alternates a Daze turn and a simultaneous attack turn. Focus one Sentry to reduce future Dazes/attacks, use the Daze turn to Advance and draw, and enter the attack turn with actual Block rather than depending on next-turn cards. Do not overvalue a one-HP Sentry if finishing it costs the only Block needed to survive both attackers.
- **Lagavulin:** observed opening: one no-intent setup turn, then two 4-attack turns, then 2 Weak plus 1 Strength; it then returned to 4-attack turns with the increased Strength. Use the opening to play Powers and Heat setup, enter the first attack turn with enough Block, and hold `Bad Omen` for an attack rather than its debuff turn. Burning-Elite Burns are temporary but must be exhausted when possible.
- **Guardian:** Defense mode lasts two turns. When its shield is above zero, breaking all shield can force Defense mode; every Attack then deals 1 damage back to the attacker. Break shield only with a planned turn and enough HP/Block; do not spend the only safe defense line to trigger it early.
- **Slime Boss:** Turn 3 deals 6 damage. Exhaust redundant-energy Slimes so they do not clog the deck. After Split, kill the Spike Slime first because Vulnerable can make the next hit lethal.
- **Hexaghost:** The first hit is negated by Buffer. Consume it deliberately, then burst the boss before the Burn/status cycle compounds. Do not waste turns on a slow setup that cannot finish quickly.

### Act 2

- **Bronze Automaton:** Kill the Bronze Orbs before their attacks and do not let the boss's strength cycle get ahead of the deck. Observed sequence: initial +1 Strength, a low double attack, +1 Strength plus debuff cleanse, then a 9-damage single hit; the next cycle reached a 3×2 multi-hit and then an 11-damage single hit at 4 Strength. Treat each strength/cleanse turn as the burst window: apply `Seventh Eye` Vulnerable and immediately follow with `Virus` before ending the turn. Preserve `Bad Omen`/Block for the next attack rather than debuffing into the cleanse.
- **The Collector:** The code rotation is: (1) summon until two Torch Heads exist, (2) 3 attack and strengthen all enemies by 1, (3) 5 attack, (4) once-only AoE 2 Weak + 2 Slimed + 2 Burn. The grey fourth slot is skipped forever after it fires, so the loop becomes summon-until, 3+Strength, 5. Kill Torch Heads before their attacks, but keep enough damage to race the Collector after its strength turn; if all minions die, its summon turn is a setup window.
- **The Champ:** Phase 1 is 4 attack, then Weak/acts-last, then 5 attack plus 3 Block. On the first defeat it returns with Fury: clear debuffs once, then 4×2 attack, then +1 Strength, repeating. Enter Fury with a kill plan; every delay makes the repeated multi-hit attack worse.

### Act 3

- **Awakened One:** Kill Cultists immediately. Do not play more than two Powers in phase 1 unless the kill is guaranteed. Phase 2 clears Weak/Vulnerable and starts at 7 attack, then 4 plus 2 Slimed, then 3×2 plus Strength; play only the Powers needed to finish and burst.
- **Donu and Deca:** Donu first. Donu alternates +1 Strength and 3×3 attack; Deca alternates 3×3 attack and AoE Dazed/Slimed. Weak is unusually valuable because it reduces each hit in the multi-hit action; bring a real Block engine and consistent damage.
- **Time Eater:** The code rotation is 2×2 attack, 3 Slimed AoE, then 6 attack plus 1 Strength, with Time Warp card limits 5/4/3 as the clock advances. Damage on the first two turns when safe, count every card, and do not hand the third turn a half-finished setup. After the first defeat, it returns at 30 HP and clears Weak/Vulnerable.

## Attempt log

### Run 1 — Fallen, Act 1 Hexaghost

- Result: died on turn 10 at 0/9 HP; Hexaghost was at 7/36 HP after the final attack. Reached the Act 1 boss with 17 cards and 4× Defend / 4× Strike shown in the damage chart.
- Deck/relic direction: upgraded Firestarter and Sear; added Floatwork, Seventh Eye, Heat Shield, Ghost Lash, Shield of Night, and Bad Omen; relics were Loaded Die, Golden Idol, Nilry's Codex, and Fuel Canister. Vulnerable Potion and Ghost in a Jar were used.
- Confirmed boss sequence in this fight: attack + Burn; 2 attacks + Burn; 2 Burns; 3 attack + 5 Block; 2 attack + Burn; 2 attacks + 2 Burns + Strength; 2 attack + Burn; 2 attacks + Burn; 2 Burns; 4 attack + 5 Block. Treat this as an observed sequence, not a complete rotation specification.
- Lesson: damage was too slow and the defense plan was too thin. At 2 HP, a current Burn plus a 4-damage Hexaghost attack cannot be answered by only 3 Block; prioritize a real block engine and status exhaust before more Heat setup, and reserve Ghost in a Jar for a multi-hit/Burn turn that cannot otherwise be covered.

### Run 2 — Fallen, Act 2 Cultists

- Result: died on turn 5 at 3/9 HP after the two remaining Cultists attacked for 4 and 5 into 4 Block. The first Cultist was killed, but the second had 5/9 HP and Weak while the third remained at 9/9 HP.
- Deck/relic direction: selected Battle Buddies and Step Through after the Act 1 Guardian; added Spectral Grace after Snake Plant. The Colosseum event led to a three-Cultist fight. `Whisper from Beyond` applied Weak and dealt 2 total damage, `Shield of Night` gave 3 Block and exhausted Strike, and one Defend supplied the final Block.
- Newly verified rules: the combat-board character label is the reliable current HP/Block display; the top-level Health observation can remain stale. Cultist attack-plus-Strength turns attack first, then gain Strength, so their next attack rises by 1. Weak reduced the weakened Cultist's 5 attack to 4 for that turn. Relic controls such as Fuel Canister are available in the start-of-turn resolution window and disappear after that window is resolved. A card that spends the last available Energy can immediately advance to the next turn, so inspect after every card rather than assuming the turn remains open.
- Lesson: when multiple enemies are attacking, one Weak plus 4 Block was nowhere near enough at 3 HP. Kill or disable a second attacker before spending the turn on setup; treat a multi-enemy fight as a damage race, and use start-of-turn relic windows before resolving their order.

### Run 3 — Fallen, Act 1 Hexaghost

- Result: defeated the Act 1 Lagavulin elite, then died to Hexaghost on turn 11 at 0/9 HP. The boss was at 10/36 HP with 1 Block after two Strike+ attacks; the last turn's 3 attack plus Burn finished the 3-HP character while three Burns remained in hand.
- Deck/relic direction: took Fast Forward after the elite, upgraded Charged Barrage to Charged Barrage+ (4 damage, plus 2 at 4+ Heat), removed a basic Strike at the Rest site, and took Dead Branch. Soulburn consumed Hexaghost's Buffer when Sear was used first; the starting Soulburn then dealt 1 at 1 Heat. Shield of Night repeatedly exhausted Burns or Defend, but the deck still lacked enough damage and a way to clear the growing Burn hand.
- Newly verified rules: Dead Branch is a once-per-combat manual relic action that draws one card per card in the Exhaust pile; use it after a safe exhaust turn, not before. Peace Pipe's Rest action first opens a card-removal choice and then heals 3 HP. Shield of Night can exhaust a Burn from hand. Hexaghost's Buffer is shown as preventing the next 1 instance of damage and is consumed by the first positive hit; a zero-damage result is not a failed attack. Burn is an unplayable temporary status card: every Burn left in hand at end of turn deals 1 special damage, and Hexaghost can add multiple Burns in one intent.
- Observed Act 1 Hexaghost sequence in this run: 1 attack + 1 Burn; 2 attacks + 1 Burn; 2 Burns; 3 attack + 5 Block; 2 attacks + 2 Burns + Strength; 3 attacks + 2 Burns + Strength; 1 attack + 1 Burn; 2 attacks + 1 Burn; 2 Burns; 3 attack + 5 Block; 3 attack + 1 Burn. Treat this as an observed sequence, not a complete rotation specification.
- Lesson: against Hexaghost, plan to exhaust Burns before they accumulate and preserve a real damage line for the boss's Block turns. A fully blocked attack turn can still be lethal from status damage; once several Burns are in hand, taking a setup turn without a status-exhaust or kill line is usually losing.

### Run 4 — Fallen, Act 1 Sentries

- Result: died on turn 2 at 0/8 HP in the Sentries elite. The opening state was 4/8 HP, 2 Block, and 2 Soulburn; both Soulburns were spent on Sentry B, reducing it from 4/8 to 2/8, but the next turn began at 1 HP with only 1 Block while Sentry A attacked for 3.
- Newly verified rules: the Sentries elite has three enemies with the observed opening intents Daze, 3 attack, and 2 attack. Spending a Soulburn is a two-step target action and must be refreshed after every use. A second Soulburn can settle the turn and immediately resolve enemy actions, so do not spend the last Soulburn without checking the resulting HP and incoming damage. Player Block is not carried into the next turn. `Sword of Night` exhausts a selected card before asking for its enemy target; its 2 damage was not enough to recover the 1-HP position.
- Newly observed route rules: Cleric healing costs 1 Gold and restores 3 HP. Lab potion rewards can include an extra potion; solo rewards require selecting the player and confirming. `Liquid Memories` returns a selected discard-pile card to hand for 0 Energy that turn. The Boot can open an enemy-selection step before start-of-turn resolution. Lagavulin begins without an intent, then attacks for 4; its later pattern alternates attacks with Weak/Strength setup.
- Lesson: in multi-enemy elites, cover the current attack before spending Soulburn on a secondary target unless the spend creates lethal or removes the incoming damage. At low HP, keep enough Energy and a block line for the next intent; do not enter the next turn assuming a zero-cost Soulburn or leftover Block will save the run.

### Run 5 — Fallen, Act 1 Slime Boss

- Result: died at 0/9 HP on turn 5 after defeating the Slime Boss and reaching the split. The split produced Large Slime (10 HP), Acid Slime (5 HP), and Spike Slime (5 HP). Spike was reduced to 2 HP, then a free Radiant Reverb killed it; the surviving Large and Acid Slimes' attacks finished the run.
- Deck/relic direction: 17 cards with Radiant Reverb, Fast Forward, Heat Crush, Ghost Shield, Sear+, and Nightmare Vision; relics were Loaded Die, Black Powder, Blue Candle, and Greed Ooze. Vulnerable Potion was used for the opening Reverb burst; Blue Candle exhausted a Slimed card after the split. The run dealt 74 total damage and blocked 16.
- Newly verified rules: after the Slime Boss split, the opening intents were Large 3 attack plus 2 Slimed, Acid 1 Weak, and Spike 1 attack plus Vulnerable and acts last; after one round they escalated to Large 8 attack, Acid 4 attack, and Spike 2 attack plus Daze. Radiant Reverb can be made free by a next-Attack-free effect, but its hand-wide Exhaust still removes the block cards needed for the following multi-enemy action.
- Lesson: the split is a fresh lethal check, not cleanup. Keep enough Block or a complete kill line for the Large and Acid Slimes before spending the turn on Spike; if Spike must be killed first, disable the remaining attackers with the same turn's zero-cost damage or enter the split with substantially more HP. The result was recorded, and the exact run submission was acknowledged as already present (`added: false`) by both active leaderboard origins.

### Run 6 — Fallen, Act 1 Hexaghost

- Result: died on turn 5 at 0/9 HP with the boss at 5/36 HP. The run reached the boss at full HP with 15 cards; final damage was 80 dealt and 18 taken (13 unblocked, 5 blocked).
- Deck/relic direction: upgraded two Strikes from the opening boon and Charged Barrage+ at the campfire; took Firestarter, Sword of Night, Rain of Embers, Heat Crush, Ghost Lash, Fast Forward, Fuel Canister, and Du-Vu Doll. Two treasure rooms gave Fuel Canister and Du-Vu Doll; the latter was inactive because no Curse was drawn.
- Newly verified sequence and timing: Loaded Die rolled into Fuel Canister in the turn-4 start-of-turn window. Exhausting a Burn through that relic gave one Energy and prevented that Burn's end-of-turn damage. The boss's turn 4 was 3 attack plus 5 Block; turn 5 was 2 attack plus 1 Burn. The player entered turn 5 at 1 HP with Hexaghost on 8 HP and 5 Block, so Fast Forward into four-Heat Charged Barrage+ plus Ghost Lash left it at 5 HP but could not produce lethal.
- Lesson: Soulburn/exhaust damage reached 31 boss damage by turn 3, but insufficient Block and too many early basic-card exhausts turned the first multi-hit/Burn cycle into a 1-HP turn-5 check. Keep at least one ordinary Block or status-exhaust line through the boss's turn-2 multi-hit, and at turn 5 calculate the enemy's existing Block before spending the final energy; without a full 13-damage line, preserve survival rather than relying on the next draw.

### Run 7 — Fallen, Act 3 Donu and Deca

- Result: cleared Act 1 Guardian and Act 2 Collector, then fell to Donu and Deca on turn 3 at 0/9 HP. Donu remained at 32/50 and Deca at 50/50; the damage chart recorded 346 dealt, 31 unblocked damage, and 101 blocked.
- Deck/relic direction: the core was Rain of Embers+, Worthy Sacrifice, Feel No Pain+, Heat Shield+, Firestarter+, Flames from Beyond, and Ghost Lash. Act 2 added Coffee Dripper; Act 3 added Haunted Hand and Living Bomb+, then removed two Strikes and used the final two campfires to upgrade Living Bomb and Heat Shield. Weak Potion, Whale Ale, and Cactus Juice were acquired; Weak was spent on Deca and Cactus Juice powered Shot Glass.
- Confirmed fight interactions: Collector's minions remain after the boss dies, so the winning `Flames from Beyond` row hit had to clear both Torch Heads before rewards appeared. Against Donu and Deca, a 2-Weak potion reduced Deca's first 3×3 action to 2, 2, and 2 (then expired), while a 1-Weak Whisper reduced only the first of Donu's three hits. Pen Nib's start-of-turn target window applied Vulnerable to Donu before its next attack.
- Lesson: Weak in this implementation is consumed by each hit, so a single stack only saves one point from a multi-hit sequence; do not treat it as a full-turn shield. The Donu/Deca fight demands enough immediate Block for 8–12 damage every attack turn while the damage engine races Donu. Do not take Coffee Dripper on a low-HP route without already having repeatable Block above the incoming multi-hit total.

### Run 8 — Fallen, Act 1 Slime Boss

- Result: killed the Slime Boss on turn 4, then died at the split on turn 5 at 0/8 HP. Large Slime (10 HP), Acid Slime (5 HP), and Spike Slime (5 HP) remained. The damage chart recorded 57 total damage, 25 taken (13 unblocked, 12 blocked).
- Deck/relic direction: started with Living Bomb, Heat Crush, and Heat Shield; upgraded Heat Shield through Living Wall and Strike through Big Fish. Added Rain of Embers and Rewind+ (from a transformed Defend), then upgraded Living Bomb+ at the final campfire. Relics were Sack of Gems, Loaded Die, Gambling Chip, and Toxic Egg. The Bonfire Spirits removal of Nightmare Guise healed 3 HP and enabled the boss attempt at 7/8 HP.
- Newly verified rules: Rain of Embers grants Soulburn only for the first card exhausted each turn. Living Bomb+ creates one Soulburn, then requires a separate target selection for every available Soulburn; Heat Crush's bonus applies to the next Soulburn hit. The Slime Boss's turn 3 six-damage attack reduced the player from 7/8 to 2/8 through one Block. Its turn 4 was a non-damaging Slimed action, allowing the finish, but the split immediately created a fresh turn with 8 incoming damage.
- Lesson: killing Slime Boss at 2 HP without an immediate split defense is losing even when the Spike Slime can be targeted next. Do not cash in the final boss damage unless the transition turn includes enough Block or an all-enemy kill line; preserve HP and a block engine through the turn-3 attack first. The result was recorded on the leaderboard.

### Run 9 — Fallen, Act 3 The Maw

- Result: defeated Act 1 Hexaghost and Act 2 The Champ, then died to The Maw in Act 3 at 0/9 HP. The Maw remained at 15/28 HP; the damage chart recorded 207 dealt, 60 taken, and 40 blocked. The result was recorded on the leaderboard.
- Deck/relic direction: 15 cards, with Radiant Reverb+, Heat Crush+, Heat Shield+, Unlimited Power+, Firestarter, Floatwork, Kindle, Sear, Step Through+, three Defends, and two Strikes. Key relics were Loaded Die, Oddly Smooth Stone, Pen Nib, Black Powder, Sozu, Tungsten Rod, The Abacus, and Dolly's Mirror.
- Newly verified rules: The Abacus can be used in the start-of-turn window; on a 4 it triggered Oddly Smooth Stone for 2 Block. `Floatwork` creates a Soulburn, and spending it with Heat Shield+ gave 3 Block once that turn. The Maw's observed opening was Vulnerable/acts-last, followed by 4 damage three times. Player Vulnerable made that multi-hit turn lethal through 3 Block when no full burst was available.
- Lesson: against multi-hit turns, calculate the post-Vulnerable total before using Radiant Reverb: its hand-wide Exhaust can erase every remaining Block line. Do not take an optional 9-gold relic gamble when the revealed relic is harmful; it cost all gold and supplied no combat benefit. Preserve the Soulburn/Heat Shield block engine and a lethal Reverb line for the high-damage turn.

### Run 10 — Fallen, Act 2 Bronze Automaton

- Result: cleared Guardian and the Act 2 Slavers elite, then died to Bronze Automaton on turn 8 at 0/9 HP. The boss remained at 18/55 HP. The campaign result was recorded.
- Deck/relic direction: 24 cards with the Heat-exhaust core of Empowered Flame, Volcano Visage, Poltergeist, Fast Forward, Rewind, Virus, Firestarter, Ghost Lash, Ghost Shield, Bad Omen, Premonition, Seventh Eye, and Time of Need+. Relics included Black Blood, Lantern, Anchor, The Courier, Self-Forming Clay, and Regal Pillow.
- Newly verified interactions: Anchor's opening 2 Block and Lantern's opening Energy support fragile setup turns. The Courier offered Energy Drink for 2 gold; it made only the next card free, despite temporarily displaying zero costs for the whole hand. At 5+ Heat, Seventh Eye applied Weak and Vulnerable, but Virus's X damage was not doubled by Vulnerable. The lethal 11-damage Automaton single hit could only be reduced to 10 by one Weak, while the available hand produced 6 Block; preserve at least one further Block source before that part of the cycle.
- Lesson: this engine can erase the Bronze Orb (a 7-Exhaust Virus killed a 3-HP orb, and a 10-Exhaust Virus hit for 10), but it needs a higher immediate block floor before taking an Act 2 boss. Against Automaton, spend its strength/cleanse turns on setup and burst, but do not enter the escalating single-hit turn at 4 HP without 10 Block or a kill.

### Run 11 — Fallen, Act 1 Hexaghost

- Result: cleared Sentries and reached the Act 1 Hexaghost, then died on turn 7 at 0/9 HP with the boss at 14/36 HP. The damage chart recorded 81 dealt, 42 taken, and 22 blocked. The campaign result was recorded.
- Deck/relic direction: a 17-card Heat-block deck with `Volcano Visage`, `Divider`, `Fast Forward`, `Kindle`, `Premonition`, `Firestarter`, and `Whisper from Beyond`; relics included Loaded Die, Greed Ooze, Ninja Scroll, Golden Eye, Oddly Smooth Stone, and Ice Cream.
- Newly verified interactions: Gambler's Brew can force Loaded Die to 6 before the start-turn die resolves; its secondary-relic selector can then trigger Greed Ooze's 2 damage. Liquid Void returned an exhausted Firestarter to hand at zero cost for another use that turn. Ninja Scroll's three zero-cost Shivs are individual target actions, ideal for Buffer or a fragile priority minion. Soulburn deals damage equal to current Heat (2 at Heat 2, 3 at Heat 3). Divider's per-Heat damage is consumed by enemy Block before reducing HP.
- Lesson: `Volcano Visage + cheap Advance` was enough to build Block on quiet turns, but not enough by itself against Hexaghost's stacked Burn plus multi-hit turns. At 1 HP, one attack can be covered by Oddly Smooth Stone, but Burns remain special end-of-turn damage; retain an exhaust/status answer or a much faster payoff before relying on the engine for the boss.

### Run 12 — Fallen, Act 2 Chosen

- Result: cleared the Act 1 Hexaghost on turn 14, then died in the first Act 2 Chosen/Cultist encounter on turn 7 at 0/8 HP. The Chosen was left at 1/14 HP. The campaign result was recorded on the leaderboard.
- Deck/relic direction: `Volcano Visage`, `Heat Shield`, `Worthy Sacrifice`, `Poltergeist`, `Fast Forward`, `Kindle`, `Bad Omen`, `Divider`, `Floatwork`, `Firestarter`, `Ghost Shield`, and `Time of Need`; relic support was Blue Candle, Captain's Wheel, Loaded Die, and Black Blood.
- Newly verified interactions: `Poltergeist` makes each Advance or Retract a targetable 2 damage in multi-enemy fights, so it needs at least two movement cards (`Fast Forward`/`Kindle` and `Bad Omen` were enough) rather than being treated as generic damage. With `Volcano Visage`, each Advance also gained 1 Block, making movement cards both damage and defense. `Bad Omen` at 2+ Heat applied 2 Weak before Retract and was the key survival card in the Chosen fight. `YOU ARE MINE!` doubled the next two hits and made its own Weak lower the immediate attack. `Time of Need` could exhaust a Daze for 1 Block but did not leave a second same-turn exhaust activation available.
- Lesson: the Poltergeist movement package is a valid early build direction only when it has a real 5+ Block answer for the first Act 2 strength turn. The Chosen alternated Daze pressure with attacks that rose from 3 to 6 as Strength accumulated; do not spend all defense to deal partial damage when the next two turns cannot cover that ramp. Against Chosen plus Cultist, kill the Cultist before it stacks Strength, then use Vulnerable on a high-value Poltergeist/Sear hit and retain enough block for the lone Chosen.

### Run 13 — Fallen, Act 1 Jaw Worm

- Result: fell at floor 5, in the second Jaw Worm fight, at 0/9 HP. The campaign result was recorded on the leaderboard.
- Deck/relic direction: early `Premonition`, `Fleeting Flash`, `Bad Omen`, `Firestarter+`, `Floatwork`, and `Rain of Embers`; obtained `Unceasing Top` and a Block Potion. The `Ominous Forge` upgrade cost 2 HP.
- Newly verified interactions: `Unceasing Top` becomes an active once-per-combat draw-3 control at one or fewer cards in hand, so spend it after the current defensive line is covered and before ending a safe turn. `Rain of Embers` gave one Soulburn when the upgraded `Firestarter+` exhausted. Enemy Block absorbs low-Heat Soulburn first, making a Heat-1 exhaust/Soulburn engine too slow to stabilize a 4-HP position. A player Weak stack lowered Sear from 2 to 1 at Heat 2 and is consumed by that hit.
- Lesson: do not pay HP for an upgrade before confirming a nearby rest/low-risk route when the deck cannot yet cover a 3–4 damage Jaw Worm attack. The early exhaust package needs a second movement card or `Heat Shield`/a larger damage payoff; otherwise prioritize immediate HP preservation and ordinary Block over repeated one-damage Soulburn trades into Block.

### Run 14 — Multiplayer migration verification, Fallen on floor 1

- Result: the always-on production host accepted a two-character room (`AMRMYP`) with Ironclad and Silent, synchronized both Neow resolutions, entered the first encounter, and reflected one attack from each browser in the shared combat state. The party then unanimously gave up, the defeat screen showed both characters' damage, and `Record campaign result` completed before the room returned to its next-run lobby.
- Server verification: the run used the WebMCP tools exposed by the deployed GitHub Pages client against the new sslip.io origin. Both seats remained connected through room creation, character selection, campaign start, Neow, map travel, combat, the give-up vote, and campaign recording.
- Leaderboard note: this two-character result correctly did not change the solo leaderboard. `queueFinishedSoloRun` intentionally accepts only finalized one-player runs, so a co-op campaign cannot appear there; no subsequent campaign was started.
