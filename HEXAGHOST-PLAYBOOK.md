# Hexaghost Playbook

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
- **Proven boss-killing engine:** upgraded `Poltergeist+` deals 3 per Advance *or* Retract; `Devil's Dance+` and `Empowered Flame+` together deal 6 at each start of turn and keep Heat stable above Heat 1 if Dance resolves first. `Lingering Shades+` turns 1 Energy into a Soulburn every turn, and `Extra Crispy+` doubles one Soulburn (12 damage at Heat 6). Against Awakened One, delay unnecessary Powers until the first form can be blocked or killed: Curiosity adds 1 attack per Power. The reborn form has no Curiosity, but at A10+ it gains 1 permanent Strength per player Power active when it returns; save nonessential Powers until after rebirth.
- **A1+ preparation from the saved run-16/17 logs:** rest instead of upgrading when the next mandatory encounter can kill you; three Jaw Worms took run 16 from 6 HP to 1 HP on their opening turn, and Donu's repeat attack finished run 17 while Donu still had 4 HP. Before taking a draw or Heat upgrade, budget two dangerous turns of Block and favor repeatable defense, Weak, or a defensive potion if either turn cannot be covered. Keep A1 until a win unlocks the next Ascension.

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
- `Heat Crush`'s next-Soulburn bonus resets at the **start of each turn**; it cannot be saved or stacked across turns. In run 20, a Heat-4 Soulburn after that turn's `Heat Crush` dealt 5, not 7 from earlier turns' Crushes.
- Attack Potion creates `Double Tap` for the next Attack. A copied targeted Attack may ask for its enemy first and then ask for the original Attack's enemy again; budget the potion for a lethal or high-value hit.
- Enemy Block was present during the player turn and was removed before the enemy's next action. Do not assume it survives the enemy turn.
- An enemy can telegraph a non-attack setup turn (the first Jaw Worm turn was Block plus Strength). Use those windows to deal damage or set up, but still inspect the next intent before ending the turn.
- A finished combat is not yet a recorded run: after a defeat, press `Record campaign result` (or `Stop and record result` after a victory) before starting the next run. The solo leaderboard queues only after the run is finalized; verify the leaderboard submission before moving on.
- `Purity Potion` exhausting `Nightmare Vision` triggers its Exhaust reaction for 2 Energy; use it as emergency defense or to reach a key draw line. `Unceasing Top` is a manually activated once-per-combat draw-three when the hand has at most one card, not an automatic trigger. `Time of Need+` grants 2 Block for no Energy by exhausting an unneeded hand card, including an ordinary Defend after playing the other copies.
- `Empowered Flame` and `Volcano Visage` are a compact core: the former Advances at each start of turn, and the latter turns that Advance into 1 Block. With a second Advance card they rapidly reach Heat 5–6 while providing a small recurring defensive floor.
- `Rewind` can exhaust an unplayable `Burn` from hand before its end-of-turn damage, then draw 3. Pair it with `Virus` (which dealt damage after adding its two exhausted cards) and `Ghost Lash` (two 1-damage hits once the Exhaust pile has at least two cards). This is a usable two-card exhaust payoff package, not just deck thinning.
- `Bad Omen` at 2+ Heat gives 2 Block and 2 Weak before Retracting. Use it on the enemy whose current multi-hit or highest attack matters; Weak is consumed per hit, so do not assume two stacks blank a whole multi-hit action.
- Fungi Beast's `Spore Cloud` applies 1 Vulnerable when it dies. In a multi-enemy row, take a complete kill only if the remaining intent is blocked or harmless; otherwise leave it at low HP and stabilize first.
- `Virus` exhausts up to two top-deck cards before its X-damage, so even a thin Exhaust pile becomes immediate damage and deck compression. At 3 exhausted cards it dealt 3; its target/result can resolve after a short combat animation, so refresh the state rather than treating the first unchanged HP display as a miss.
- At 5+ Heat, `Haunting Echo` replayed `Virus`: the Echo's own 2 damage landed first, then the copied Virus asked for a second target and exhausted the remaining top-deck card. This is a strong boss burst only when there are enough cards left to exhaust; budget the two targeting steps and do not expect it to solve a same-turn block deficit by itself.
- `Float` is a worthwhile Heat-exhaust pickup once the deck reliably reaches 4 Heat: it converts 1 Energy into 3 Energy at the threshold, exhausts itself, and supports both a larger Virus and conditional payoff turn. Before that threshold it is merely a small, temporary energy gain, so do not prioritize it over immediate Block.
- `Attack Potion` plus `Virus` is an exceptional multi-enemy finisher. Activate the potion before Virus; the game resolves a copied Virus target first, exhausts its top two cards, then explicitly asks for the original Virus target. In the Act 2 Slavers elite, an Exhaust pile of 8 became 10 for the copy and 12 for the original, clearing separate 10- and 8-HP targets. Save this combination for a row where the two target prompts can remove the live attackers.
- `Snecko` sets the first card each turn to a displayed random cost. Inspect that cost before deciding the line; a Lantern's combat-start Energy let a 3-cost opening Power remain playable. Do not spend the first-card slot on a weak effect when the random price prevents the needed block or engine card.
- Below 2 Heat, `Haunted Hand` exhausts itself but grants no Strength or Retract: its Heat threshold gates both effects despite the card wording. Its Exhaust can trigger `Rain of Embers` once per turn; an Ethereal Daze at end of turn grants Soulburn only if no earlier Exhaust triggered it. Bank that Soulburn for a stronger Advance next turn.

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

- **Three Jaw Worms:** each has 10 HP; their die faces are 3 Block plus Strength, 3 attack plus 1 Block, or 4 attack. Expect two incoming attackers immediately, then rising Strength. At low HP, kill an attacker or cover the entire wave before setup; if the map offers a rest before this fight, take it rather than upgrading a marginal card.
- **Awakened One:** Kill Cultists immediately. Do not play more than two Powers in phase 1 unless the kill is guaranteed. Phase 2 clears Weak/Vulnerable and opens with 7 attack at A0–A9; at A10+ its base opener is 6 plus 1 Strength per Power active at rebirth. It then attacks for 4 and adds 2 Slimed, then attacks 3×2 and gains Strength; count accumulated Strength on every hit.
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

### Run 14 — Fallen, Act 1 Guardian

- Result: reached the Act 1 Guardian at full 9/9 HP, but fell on turn 11 at 0/9 HP with the Guardian at 22/40 HP. The damage chart recorded 73 dealt, 13 unblocked damage, and 31 blocked. The campaign result was recorded locally and retained for automatic leaderboard retry after the leaderboard was unavailable.
- Deck/relic direction: 14 cards including `Fast Forward`, `Kindle`, `Sear`, `Divider+`, `Charged Barrage`, `Haunted Hand`, `Shield of Night`, four Defends, two Strike+, and basic attacks; relics were Loaded Die, Ice Cream, Peace Pipe, and Potion Belt. Fruit Juice was used before a late heavy attack.
- Newly verified Guardian interactions: removing its 5 Block changed the 6/7/8-attack intents into Defense Mode. Defense Mode adds Sharp Hide, so each attack also costs 1 HP; use its 2–3 attack turns to build Heat, Strength, and Block rather than trading small attacks. `Divider+` at Heat 2 plus Strength cleared 5 Block and dealt 1 HP damage; at higher Heat, Charged Barrage cleared Block efficiently before the heavy attack.
- Lesson: preserve Shield of Night and enough ordinary Block for the Monster Mode transition. Ice Cream only helps if an Energy survives the prior turn; spending all Energy on a partial burst left an unavoidable 4 damage at 3 HP. Against Guardian, breaking Block before its heavy attack is correct, but do not then enter Sharp Hide with no full block line.

### Run 15 — Fallen, Act 1 Slime Boss

- Result: killed Slime Boss on turn 4, then fell to its split on turn 6 at 0/9 HP. The damage chart recorded 73 dealt, 13 unblocked damage, and 31 blocked. The campaign result was retained locally for automatic leaderboard retry after the leaderboard was unavailable.
- Deck/relic direction: 16 cards with `Firestarter+`, `Flare Flick+`, `Shield of Night`, `Time of Need`, `Fleeting Flash`, `Spectral Grace`, `Ghost Shield`, `Kindle`, and basic attacks/Block; relics were Loaded Die, Mummified Hand, and Clasped Locket. Vulnerable Potion plus Attack Potion made the turn-2 Firestarter+ burst deal 9, but the deck did not retain enough defense for the split.
- Newly verified Slime Boss interaction: after the boss dies, the split can immediately place Large Slime (10 HP), Acid Slime (5 HP), and Spike Slime (5 HP) into a separate turn. The first attack wave was 4 + 2 + 1 (with Spike applying Vulnerable); the next was 8 + 4 + 2. A partial Spike kill still leaves a lethal Large/Acid line.
- Lesson: do not cash in a boss burst merely because it crosses the split threshold. Before killing Slime Boss, reserve enough current-turn Block for all three split attackers or a complete removal line for at least two; in a thin deck, a large Firestarter burst is less valuable than surviving the following turn.

### Run 16 — Fallen, Act 3 Jaw Worms

- Result: beat Slime Boss and Bronze Automaton, then died on Act 3 floor 6 against three Jaw Worms on turn 3. The damage chart recorded 305 dealt, 32 unblocked damage, and 93 blocked. Downloaded the 492-event run log and explicitly recorded the campaign result.
- Deck/relic direction: `Empowered Flame+`, `Living Bomb+`, `Rain of Embers+`, `Ghost Shield+`, `Fast Forward+`, `Bad Omen`, `Haunted Hand`, `Whirlwind`, and `Doomsday`; Battle Buddies, Sundial, Clasped Locket, Ninja Scroll, Loaded Die, and Regal Pillow. Won the Automaton at 4 HP using Sundial's extra Energy and a Soulburn burst; entered Act 3 healed, but lost 5 HP to Orb Walker.
- Mistakes: played `Haunted Hand` at Heat 1, producing no Strength or Retract. At 6/8 HP with Regal Pillow making Rest heal 6, upgraded `Rain of Embers` to cost 0 instead of resting, then chose a treasure route into a mandatory encounter. The Worms opened with 7 total attack against only 2 Block, leaving 1 HP; a turn-3 `Whirlwind` damaged both survivors but could not kill them before the remaining 4 attack pierced 2 Block.
- Lesson: an Act 3 encounter with 6 HP and no potion needs reliable opening defense or an immediate kill. Rest instead of Smith at the preceding fire, or plan a map route to the next fire before another multi-enemy fight. A cost reduction is not worth giving up the survival margin; prioritize block/draw over further setup in a 27-card deck. Check the following draw pile and whether the next turn can actually survive before committing all Energy to `Whirlwind`.

### Run 17 — Fallen, Act 3 Donu and Deca

- Result: defeated the Act 1 Guardian and Act 2 Collector; killed Deca on turn 3 of the final fight, but fell on turn 4 with Donu at **4/50 HP**. Downloaded the run log and explicitly recorded the campaign result. Damage chart: 404 dealt, 18 unblocked, 90 blocked.
- Deck/relic direction: 27 cards with `Poltergeist+`, `Empowered Flame`, `Worthy Sacrifice+`, `Fast Forward` ×2, `Phantom Fireball`, `Flare Flick+`, `Doomsday`, `Firestarter`, `Nightmare Vision`, `Nightmare Guise` and `Step Through+`; Coffee Dripper, Nilry's Codex, Pen Nib, Ninja Scroll, Red Mask, Dead Branch and White Beast Statue. Used Gambler's Brew, Whale Ale and Pizzaz in the boss fight; entered turn 4 at 2 HP, with no potions left.
- Verified sequence: Donu strengthens on odd turns and attacks for 3 hits on even turns; Deca attacks for 3 hits on odd turns and adds statuses on even turns. `Worthy Sacrifice+` exhausting `Nightmare Guise` triggers two `Advance`s even at six Heat, each dealing 3 from `Poltergeist+`; `Empowered Flame` contributes another 3. On turn 4 this reduced Donu from 24 to 15 before any plays. `Phantom Fireball` (1), its Soulburn (6), `Kindle`/Poltergeist (3), and `Strike` (1) left 4 HP; the remaining four draw-pile cards included `Flare Flick+` and `Nightmare Strike` but no draw effect in hand. The Courier's potion offered a 3-Gold Blood Potion at only 1 Gold.
- Lesson: **plan a full kill or survival line before spending the final potion and ending the previous turn.** The final 4 damage existed in the draw pile, not the hand; preserve a `Fast Forward`/`Firestarter` draw or one Soulburn rather than merely gaining energy for a turn with no draws. At Donu/Deca, block Donu's turn-2 multi-hit and preserve defense for its turn-4 repeat: starting turn 4 at 2 HP makes its three strengthened hits lethal even with ordinary Defends. Do not take Coffee Dripper without enough repeatable block or draw to survive the Act 3 boss; the boss-room full heal does not solve a four-turn damage race.

### Run 18 — Won A0, Act 3 Awakened One

- Result: **first A0 victory**, 6/9 HP after defeating Awakened One's reborn form on turn 7. Downloaded the run log and explicitly used `Stop and record result`; the game acknowledged the leaderboard recording. Damage chart: 394 dealt (143 attack, 251 special), 9 unblocked damage, 96 blocked.
- Deck/relic direction: 25 cards with `Poltergeist+`, `Devil's Dance+`, `Empowered Flame+`, `Extra Crispy+`, `Lingering Shades+`, `Step Through+`, `Bad Omen`, `Time of Need+`, `Fast Forward`, `Kindle`, `Float`, and `Mayhem`; Loaded Die, Unceasing Top, Anchor, Gremlin Horn, Ring of Serpent, Ice Cream, Red Mask, Knowing Skull. No potions remained by the final phase. The turn-3 `Purity Potion` exhausted `Nightmare Vision` for 2 Energy; `Fast Forward` drew `Time of Need+` for the missing 2 Block, preventing damage despite five Powers later in the fight.
- Boss timing: Awakened One's first form has Curiosity (+1 attack per Power), and its first three intents were 3, 5, then 2 hits of 2 before Power/Weak modifiers. Kill the two 9-HP Cultists early with `Poltergeist+` triggers and starting Soulburn. Hold Powers until there is sufficient Block; adding `Extra Crispy+` and `Lingering Shades+` on turn 4 raised the boss's single attack to 7, while `Kindle`, `Step Through+`, and `Time of Need+` supply only 6 Block. Budget one more Block or Weak, or accept 1 damage. On turn 5, a Heat-6 `Extra Crispy` Soulburn with that turn's `Heat Crush` bonus dealt 14 to finish the first form; **bank the unused 3 Energy with Ice Cream** instead of spending it against the corpse. The boss returns at the start of the next turn with 50 HP, loses Curiosity, and opens with 7 attack. On turn 6, `Step Through+` dealt 9/drew three/gained 3 Block; `Kindle`, an ordinary Defend, and `Time of Need+` brought Block to 7 while `Lingering Shades+`/Crispy dealt 12. Turn-7 Dance/Flame and `Mayhem` reduced the reborn boss to 3 HP; `Kindle` finished it.
- Lesson: count *current* attack after every Power before playing another one, but do not reject a free Power solely for Curiosity when it will provide repeatable damage for a 100-HP two-form boss. Preserve draw and cheap Block to support the engine; play Dance before Flame at Heat 6 to Retract to 5 then Advance to 6 for full `Step Through+` and Soulburn damage. `Mayhem` becomes free extra throughput only once the Curiosity form dies. Ascension is unlocked: use A1 for run 19 and continue ascending after wins until the 20-run limit.

### Run 19 — Fallen A1, Act 3 Donu and Deca

- Result: defeated Slime Boss and Collector, then died on turn 2 against Donu/Deca with Donu at 12/50 and Deca at 36/50. Downloaded the run log, explicitly recorded the result, and saw leaderboard confirmation. Chart: 285 dealt, 14 unblocked, 50 blocked. No A1 victory; run 20 remains A1.
- Deck/relic direction: 23 cards with `Poltergeist+`, `Unlimited Power+`, `Doomsday+`, `Divider+`, two `Flare Flick+`, two `Premonition+`, `Fast Forward+`, `Dramatic Entrance+`; relics included Mark of Pain, Wheel of Change, Centennial Puzzle, Gremlin Horn, Akabeko. Full 7/7 HP before boss. The shop bought Gremlin Horn (8), Akabeko (6), Clever Concoction (3). Boss potions were Clever Concoction and Transforming Brew; both spent in turn 1.
- Boss opening: Wheel of Change rolled 1 and forced two discards from `Heat Crush`, `Thermal Transfer`, `Purity`, `Poltergeist+`, `Sear`; discarded Purity and Heat Crush. `Poltergeist+` before Thermal Transfer gave 3 bonus damage. Clever Concoction drew seven after playing the three remaining opening cards, including `Fast Forward+` and `Premonition+`. With just two Energy left and 9 incoming from Deca, `Fast Forward+` to Heat 3 and `Premonition+` for 3 Block left **1 HP**; the subsequent two draws were Divider+ and Charged Barrage, no usable free defense. Transforming Brew upgraded a dead Strike into Devour Flame (cost 1) but no Energy remained. An alternative `Premonition+` at Heat 2 plus Thimble Helm would preserve 3 HP but forgo five turn-1 draws (three from `Fast Forward+`, two from `Premonition+` at Heat 3); neither line solves the 12-attack next turn without a defense engine.
- Turn 2: Donu had Strength 1 and attacked 3×4, Deca added statuses. `Unlimited Power+` raised Heat from 3 to 5 and `Kindle` to 6, for 9 `Poltergeist+` damage on Donu. Centennial Puzzle drew three and `Premonition+` drew two; the best available Block from `Premonition+`, two Defends, Kindle, and Thimble Helm was **8**, below the 12 required at 1 HP. Akabeko-enhanced `Divider+` dealt 14; a free `Dramatic Entrance+`, Flare Flick+, Sear and Heat-6 Soulburn still could not kill Donu. Playing Sword of Night with 1 Energy auto-ended the turn, and Donu's attack finished the run. A row attack targeted at either boss dealt damage to **both** bosses, confirmed by Dramatic Entrance+ and Flare Flick+.
- Lesson for the last run: **do not confuse a fast Heat/damage engine with a survivable boss deck**. Prioritize repeatable Block, Weak stacks, a defensive relic, and a healing/block potion over marginal attack amplification; consider upgrading Kindle or adding zero-cost defensive cards before Donu/Deca. On the boss turn-1 Deca 9 attack and turn-2 Donu 12 attack, budget both turns' damage before spending a draw potion or committing the final Energy to draw. Preserve `Doomsday+` until Heat 6, and use Akabeko on a high-hit `Divider+` rather than a single hit. In a boss pair, row attacks damage both; `Poltergeist+` and Soulburn must focus whichever boss is about to attack.

### Run 20 — Fallen A1, Act 1 Slime Boss split

- Result: defeated on turn 9 of the Slime Boss fight, after killing the 22-HP boss and the summoned Spike and Acid Slimes; the last Large Slime remained at 7/10. Downloaded the run log, explicitly recorded the result, and verified the Hexaghost A1 solo leaderboard (three recorded A1 runs). Chart: 78 dealt, 13 unblocked, 35 blocked. **This completes the requested 20-run limit: A0 won on run 18; A1 not won.**
- Route/build: Neow Ghost Shield and potions; Ice Cream from Ominous Forge; upgraded Ghost Shield+, then two Fast Forward+ at campfires. The floor-6 merchant bought Fast Forward, Ghost Lash, Weak Potion, and Fairy in a Bottle for 9 gold; the floor-10 encounter added another Fast Forward, and the floor-11 merchant added a second Heat Crush. Omamori allowed a free Meat on the Bone from Big Fish. Floor-10 three-gremlin combat ended unhurt. The resulting 17-card deck had excellent cycling but only four base Defends, Kindle, Bad Omen, and Ghost Shield+ for defense, with no repeatable Block power or strong boss damage payoff.
- Slime Boss: at 9/9 HP, two early Fast Forward+ plays advanced Heat to 3; turn 2 `Kindle` reached Heat 4. Turn 2 banked two unused Energy instead of playing two Strikes, but turn 3's 6-attack still dealt 4 through two Defends, leaving 3 HP. `Heat Crush`'s Soulburn bonus **did not persist from prior turns**: turn 3's Heat-4 Soulburn plus that turn's Crush dealt 5. Boss died on turn 4, spawning a 10-HP Large Slime, 5-HP Acid Slime, and 5-HP Spike Slime. Subsequent Weak and Slimed/Daze cards stalled both offense and defense; Fairy in a Bottle saved the turn-7 lethal but left 2 HP. Turn 9 drew two Slimed, Sear, Strike and a single Defend against Large Slime's 3 attack, so the final 2 HP were lost despite banking Energy.
- Correct the potion timing: **turn 4 spent Cactus Juice on only two Slimed even though Ghost Lash, Heat Crush and three Strikes already supplied the 6 damage needed to kill the boss**. Saving it until turn 5, after Fast Forward+ drew three Slimed while the three summoned slimes attacked, could have exhausted three statuses and drawn three useful cards, possibly shortening the dangerous split. Against Slime Boss, plan the **22 HP plus 20 HP of children** as one fight; killing the parent is not enough. Favor a reliable Block/Weak or row-damage engine before the boss over extra draw and redundant Heat Crush; a campfire upgrade to Kindle or Bad Omen can be worth more than the second Fast Forward+ when the deck already cycles. Save the only status-clearing draw potion for the dangerous split rather than spending it on two statuses during an already-lethal turn.

### Run 21 — Fallen A1, Act 2 Chosen and Cultist

- Result: defeated on Act 2 floor 3, turn 3, at 0/8 HP. Downloaded `slay-the-spire-run-campaign-14.json` (222 events) and explicitly recorded the campaign result. Beat Guardian at 4/8 HP and started Act 2 fully healed; the opening Centurion/Mystic encounter cost 3 HP, leaving 5/8 before the next fight.
- Build/route: `Rewind`, `Ice Cream`, `Nilry's Codex`, `Unlimited Power`, upgraded `Empowered Flame`, `Premonition`, `Sear` and `Bad Omen`, plus `Devour Flame`, `Nightmare Strike`, and `Haunting Echo`. Act 2 floor 2's Cursed Tome gave `Bright Ritual` and a `Decay` curse without immediate HP loss. Took the event-to-encounter-to-merchant route to avoid elites. The reward `Sword of Night` could exhaust Decay, but arrived alongside a Daze on turn 2.
- Failure: Chosen's once-only 1-attack/Daze then 3-attack/two-Daze into 5-attack sequence combined with Cultist's growing attack. Opening `Premonition+` blocked both turn-1 hits but drew no cards at Heat 1; turn 2's `Thermal Transfer`/`Devour Flame`/`Sword of Night` blocked only 2 of 5 and left Cultist at 3 HP. Turn 3 drew two Dazes, a conditional `Bright Ritual` below Heat 3, `Bad Omen+`, and the too-late `Empowered Flame+`: the saved Heat-2 Soulburn reduced Cultist to 1 HP, and Weak plus 3 Block could not cover the remaining 4 + 3 attacks at 2 HP. Ancient Potion could only clear player Weak/Vulnerable, neither of which applied.
- Adjustment: at 5 HP, **do not take another mandatory two-enemy encounter without immediate row damage, healing, or enough Block density and draw to cover both enemies' opening attacks**. Against Chosen/Cultist, either eliminate Cultist in the first two turns or reserve enough Block for Chosen's next 3/5 attack while Dazes pollute the draw. Evaluate the *next hand* when choosing Cursed Tome's rare reward: a Heat-3 payoff and Decay curse slow the defense engine, whereas an immediate defensive reward or shorter route to a fire is more valuable. `Empowered Flame+` only starts Advancing on the following turn; `Soulburn` at Heat 2 deals only 2 and cannot finish a 3-HP enemy.

### Run 22 — Fallen A1, Act 2 Bronze Automaton

- Result: defeated on the Act 2 floor-10 boss, turn 4, at 0/9 HP, with Bronze Automaton at 43/55 and its orb at 15/19. Extracted `slay-the-spire-run-campaign-15.json` (322 events), explicitly recorded the result, and verified Hexaghost's solo A1 leaderboard increased from four to **five runs**. Act 1 Hexaghost fell at 2/9 HP; Act 2 Shelled Parasite and Centurion/Mystic both fell, and the final campfire restored full HP before the boss.
- Route/build: avoiding optional Act 2 fights led through N'loth (traded Cultist Potion for Instant Inferno), campfire (Step Through+), Knowing Skull (lost 1 HP for Whale Ale), Blue Candle chest, Augmenter (lost 2 HP to transform two Strikes into Catch Up and Floatwork), Golden Shrine, and a full rest. The 20-card deck had Empowered Flame, Ghost Shield+, Bad Omen, Step Through+, Radiant Reverb, Instant Inferno, Living Bomb, and four basic Defends; Battle Buddies granted a fourth Energy but discarded two starting cards. At the boss, Whale Ale drew **only two cards** despite its solo draw-four text because the solo modifier was not applied in combat; this bug is now fixed. There is no five-card hand limit.
- Automaton's observed turns: Strength+1; two attacks of 2 after Strength; Strength+1 and cleanse; then a **9-damage single attack** after two Strength gains. The 19-HP orb attacked for 3 on turn 1, attacked for 2 and Weak on turns 2–3, then gave the boss 3 Block on turn 4. Boss turn 2 and orb Weak left 6/9 HP after three Block; orb turn 3 left 5/9. Kindle then Instant Inferno yielded five Soulburn at Heat 3, but delaying those charges for more Heat could not cover turn 4's 9 attack: two drawn Defends only gave two Block, and spending Soulburn damaged the boss but could not prevent lethal. Weak penalizes **each hit** of Radiant Reverb while active, not just its first hit.
- Adjustment: **plan the Bronze Automaton turn-4 nine-damage hit from the start of combat**. A full-HP rest is not enough: build reliable high-value Block, Weak timed *after* the boss's turn-3 cleanse, or enough immediate damage to kill before turn 4. Prefer a defensive potion over relying on Whale Ale to find Block; avoid trading a combat Strength potion for another three-cost Soulburn generator when the deck lacks mitigation. `Living Bomb` can hit both orb and boss, but holding Soulburn at low Heat does not solve the lethal turn. If a route avoids every optional Act 2 fight, evaluate whether the deck can already handle a 55-HP boss and its orb; consider a safe reward fight while healthy to gain stronger defenses rather than entering with twenty diffuse cards.

### Run 23 — Fallen A1, Act 2 The Collector

- Result: defeated on the Act 2 floor-10 boss, turn 7, with Collector at **33/57 HP**. Downloaded `slay-the-spire-run-campaign-16.json` (262 events), explicitly recorded the result, and beat Guardian in Act 1. Total damage 187 dealt, 15 taken, 42 blocked.
- Route/build: Calipers, Necronomicon, Wrist Blade, Sundial, Loaded Die; upgraded `Charged Barrage+`, `Sear+`, `Flare Flick+`, and `Infernal Form+`. Removed two Strikes and a Pain curse, took the safe merchant/events/campfires line in Act 2, bought `Ghost Shield` for 2 Gold. The Joust forced sacrificing Block Potion and rolled a losing 3; N'loth then exchanged a powerful Distilled Chaos for a random `Eerie Expedition` (an almost dead draw with no exhaust engine). The final event healed to full and the last fire upgraded Infernal Form.
- Collector's deterministic observed cycle: **summon two 9-HP Torch Heads**, 3-attack plus Strength+1 to all enemies, 5-attack, Weak 2 and two Slimed/Burn each, then repeat from summon. Torch Heads attack for 1 plus gained Strength every turn after appearing. `Bad Omen` Weak reduced one point per attack but did not stop the two torches. Playing three-cost Infernal Form on turn 2 instead of `Charged Barrage+` left both heads at 9 HP; turn 3's `Flare Flick+` only dealt 3 to each and one Soulburn had to kill the first. Took 4 damage turn 3, killed the second turn 4, but had dealt only 9 boss damage by then. Infernal Form's first Strength+3 did not arrive until turn 6, too late to race the 57-HP boss; the second summon and two Burns exhausted remaining HP. On turn 7 Loaded Die rolled 6 and resolved **its default +1 Energy**, not Sundial's +2, because the die relic was not selected during the start-of-turn choice phase; double-check and explicitly trigger the desired die ability *before* `Resolve start of turn`.
- Adjustment: a full-health, low-output 17-card deck with four starter Defends and `Eerie Expedition` cannot outlast Collector. Prioritize *immediate* row damage to kill both Torch Heads before the first boosted attack, or draft more multi-target attacks/mitigation before choosing the no-combat route. `Charged Barrage+` turn 2 would soften both summons by 4 and the boss by 4 while leaving Energy for an attack; weigh that against a slow 3-cost form. Keep a combat potion over a speculative random rare from N'loth, especially when the only available potion can accelerate the boss turn. At 2 HP, two Burns each consumed one Block **before** the Collector attacked; the remaining one Block could not prevent its two damage. Budget Burn damage against the **same Block pool** before calculating the enemy hit, and check the entire remaining draw pile before relying on `Premonition`.

### Run 24 — Fallen A1, Act 3 Donu/Deca

- Result: defeated on Act 3 floor 9, turn 4, with Donu at **4/50 HP** and Deca dead. Explicitly recorded the leaderboard result and downloaded `slay-the-spire-run-campaign-17.json` (397 events). Guardian and Bronze Automaton both fell; Transient's four escalating attacks were blocked entirely, preserving 9/9 HP before Donu/Deca. The damage chart reported 339 dealt, 19 unblocked damage and 99 blocked.
- Route/build: Act 2's early Chosen/Cultist reward, Omamori's curse protection and a final rest/Strike transformation produced `Living Bomb+`; the Automaton fell on turn 4, powered by Heat-6 `Doomsday`, `Phantom Fireball+`, and a three-charge `Living Bomb+` hitting both orb and boss. Act 3's safer event/merchant/event/treasure/event/merchant/campfire path removed a Defend with Bonfire Spirits, removed `Bad Omen+` with Falling instead of sacrificing essential `Thermal Transfer` or `Step Through`, removed `Bright Ritual` on Wheel of Change's lucky remove roll, purchased first-turn Strength (`Mutagen`) and zero-cost draw three (`Master of Strategy`), gained `Sundial`, and upgraded `Step Through+`. The 19-card boss deck still had **three Defends but no sustained defensive engine**; Sozu blocked all potions.
- Boss rotation observed: Donu buffs every other turn and attacks **three times** for 3 + accumulated Strength on the intervening turns; Deca attacks three times on odd turns and adds a Daze and Slimed on even turns. Each started at 50 HP. Donu's initial buff raised his turn-2 attack to three hits of 4; his second buff raised turn-4 damage to three hits of 5. Row attacks and `Living Bomb+` hit **both bosses** when targeting either one.
- Fight details: opening Loaded Die 6 copied Sundial's +2 Energy and `Catch Up+` spent four Energy to reach Heat 6, but only `Premonition`, `Ghost Shield+`, and three spent Soulburns could be played; Deca dropped to 30 but its nine-damage volley cost **4 HP**. On turn 2, manual `Self-Forming Clay`, `Step Through+` into three draws, Kindle and attacks blocked eight of Donu's twelve, leaving 1 HP. On turn 3, use Loaded Die 6 to trigger **Necronomicon's double first Attack** instead of default +1 Energy: two Heat-6 `Doomsday` copies and `Living Bomb+` killed Deca and reduced Donu to 30; `Heat Metal+`, a redrawn `Doomsday`, and `Ghost Lash` reduced him to 19. `Master of Strategy` then drew Defend/Kindle/Slimed rather than more damage. Turn 4's Sear, Phantom Fireball and two-charge `Living Bomb+` took Donu to **4 HP**, but `Premonition` drew only Defend/Ghost Shield; seven Block was insufficient against Donu's three-hit, five-damage volley.
- Adjustment: Heat 6 on turn 1 is not worth four unblocked damage if the opening hand has no row attack or engine. Assess the **boss's 100 combined HP and incoming 9, 12, 12, 15** before choosing an extra-energy relic over a sustained mitigation relic or before taking Sozu. Prioritize repeatable Block, Weak aimed at individual hits, or reliable extra draw/damage over removing all weak defenses on the safe Act 3 path. `Master of Strategy` draws three even with five or more cards already in hand; check the remaining draw and discard piles before counting on those draws. The T3 double `Doomsday` was correct, but relying on a two-card `Premonition` draw to find the last four damage is not a consistent boss plan.

### Run 25 — Fallen A1, Act 3 Donu/Deca

- Result: defeated on Act 3 floor 9, turn 2, after entering at **8/8 HP**; Donu had **34/50 HP** and Deca **41/50 HP**. Explicitly recorded the result, downloaded `slay-the-spire-run-campaign-18.json` (469 events), and verified Hexaghost's solo A1 leaderboard reached **eight runs**. Total damage was 334 dealt, 26 unblocked and 84 blocked. Guardian and Bronze Automaton were defeated.
- Route/build: `Poltergeist+` and `Empowered Flame` carried the early fights and Bronze Automaton, but the 27-card final deck had three Defends, two Strikes, two Thermal Transfers, one `Living Bomb`, and no sustained Block engine. Took Fusion Hammer and Wrist Blade, the safer Act 3 event/treasure/encounter/event/campfire route, and full health into the boss; saved Snecko Oil for its opening turn. Act 3 Writhing Mass died at full HP after `Bad Omen` applied Weak without changing its status intent, and `Ghost Lash` plus Soulburn bypassed a bad reactive turn.
- Boss lesson: opening Abacus upgraded die 1 to Black Powder's free Attack; `Thermal Transfer`, Ghost Shield, Spectral Grace and `Bad Omen` on Deca yielded six Block plus two Weak, preserving full health against Deca's three 3-damage hits. Snecko Oil drew `Empowered Flame`, but it also added two Dazes to the following hand. Turn 2 drew Kindle, Step Through and Strike alongside those Dazes; Makeshift Battery yielded two Energy, and Step Through drew `Living Bomb` and Sear, **no Block**. Three Heat-3 Living Bomb charges hit each boss for nine, but Donu's three 4-damage hits overwhelmed the single Block before the remaining Energy could help. Save an emergency draw potion for a turn with lethal incoming damage when the opening hand already has adequate defenses, or prioritize repeatable Block/draw over a larger deck of low-impact attacks. Check the *draw-pile composition*, not just unused Energy, before planning around a draw. `Living Bomb` distributes each charge to both Donu and Deca when either is targeted.

### Run 26 — Fallen A1, Act 3 Donu/Deca

- Result: defeated on Act 3 floor 9, turn 3, after entering at **9/9 HP**; Donu was **30/50 HP** and Deca **45/50 HP**. Explicitly recorded the result, downloaded `slay-the-spire-run-campaign-19.json` (473 events), and verified the solo Hexaghost A1 leaderboard reached **nine runs**. The chart reported 296 damage dealt, 42 unblocked damage and 76 blocked.
- Build/route: defeated the first two bosses, then took the safer Act 3 event/treasure/event/campfire/event/merchant/campfire route and rested before Donu/Deca. The 32-card deck included `Poltergeist`, `Volcano Visage`, `Rain of Embers+`, and `Unleash Spirits`, but still had four Defends, three Strikes, two Ghost Shields and no reliable draw or large repeatable Block. Brought Weak Potion, Liquid Void and Energy Potion to the final fight; bought `Premonition` for Block/draw at the last merchant, then spent the remaining two Gold on a second `Nightmare Strike`.
- Boss lesson: Weak Potion on Deca plus five Block limited its first three-hit attack to one lost HP. On turn 2, `Dark Shackles` and `Ghost Shield` supplied four Block; Liquid Void returned exhausted `Spectral Grace` for three more, but Donu's three four-damage hits still cut HP from eight to three. Turn 3 drew `Unleash Spirits`, `Whisper from Beyond`, `Sword of Night`, `Rain of Embers+` and a Daze, **no Block**. Makeshift Battery provided two extra Energy, Whisper added a second Weak to Deca, and Sword exhausted the Daze for Soulburn, but the end-turn three-damage row attack left Deca at 45 and Donu at 30; Deca's three attacks killed Hexaghost. An Energy Potion could not turn that hand into defense. For run 27, prioritize substantial Block/Weak and controlled draw *before* speculative expensive powers or a redundant attack, and keep the boss deck small enough to draw its defenses on consecutive turns.

### Run 27 — Fallen A1, Act 2 The Champ

- Result: defeated on Act 2 floor 10, turn 11, at 0/9 HP; The Champ's Fury form had **26/40 HP**. Explicitly recorded the result, downloaded `slay-the-spire-run-campaign-20.json` (334 events), and verified the solo Hexaghost A1 leaderboard reached **ten runs**. The damage chart reported 189 dealt, 18 taken, and 58 blocked. Act 1 Hexaghost was defeated, but no Ascension unlock followed this loss.
- Route/build: a 17-card deck reached the Champ at 9/9 HP via the safer Act 2 encounter/event/event/campfire route. The campfire Rest healed three and Straight Razor transformed a Defend into Burning Touch. The deck had `Fast Forward+`, `Flare Flick+`, `Worthy Sacrifice+`, `Devil's Dance`, `Floatwork`, and `Instant Inferno`, but no strong repeatable attack or substantial recurring Block. N'loth exchanged Nilry's Codex for Instant Inferno, and We Meet Again exchanged four gold for Ink Bottle. Weak Potion was spent on the Champ's first form.
- Boss lesson: `Instant Inferno` generated three Heat-6 Soulburns for 18 damage, but spending the full three Energy with only one Block let the Champ take three HP that turn. The first form fell on turn 8; Fury cleansed on that turn, then attacked twice for four and later twice for five after gaining Strength. Firestarter and Instant Inferno self-exhausted; `Worthy Sacrifice+` or Shield of Night exhausted Flare Flick+, Sear, Heat Crush, Burning Touch, and Strike+ over the long fight. By Fury, `Floatwork` was the **only** damage source, and `Devil's Dance` retracted Heat every turn. At 3 HP, three Block could not survive Fury's two five-damage hits. Do not exhaust the last recurring attack or Advance source merely to gain one Block: plan the **40-HP first form plus 40-HP Fury** and reserve sufficient repeatable damage and multi-hit defense for both phases. If an early `Instant Inferno` burst costs most of a dangerous turn's Block, prioritize a safer defensive line unless it immediately secures the boss fight.
