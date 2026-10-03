# Watcher A0 Playbook

This is the pre-run checklist for a consistent solo Watcher win in the board-game implementation. Read the whole file immediately before every attempt, then append only lessons that change a future decision.

Current enemy rules (2026-10-03): Donu and Deca attack twice, not three times; historical ledger entries retain pre-fix observations. Hexaghost has no Buffer. Weak affects every hit in one attack action and consumes one token after that action. Use current source and live intents for new runs.

## Win condition

Build a compact, flexible deck around Watcher's reliable core: enter Wrath for a calculated burst, then leave it safely. A pure archetype is optional. Reach each boss with enough ordinary defense, consistency, and sustained damage to win when the first burst is not lethal.

## Before choosing a route

- Inspect the entire map. Keep future and currently unreachable rooms in view so the route has a destination, not just a next step.
- Prefer a route with upgrades, a useful merchant, and one early elite only when HP and the deck can support it. Preserve a safer branch.
- Know the act boss before committing. Rest before a boss or elite when the remaining HP cannot cover a bad draw; otherwise upgrade the card that most improves the next hard fight.
- Enter a merchant with enough gold to buy something meaningful. Card removal, a premium card, or a lifesaving potion is better than several marginal purchases.

## Baseline deck skeleton

Aim for all of these, without bloating the deck:

- `Eruption+` as the first high-value upgrade.
- One additional Wrath entry, preferably `Tantrum`, `Crescendo`, or `Simmering Fury`.
- At least two dependable stance exits, such as `Fear No Evil`, `Inner Peace`, `Empty Mind`, `Tranquility`, or `Meditate`.
- One or two consistency cards: `Cut Through Fate`, `Third Eye`, `Scrawl`, or other efficient draw/Scry.
- Retained or conventional defense. Watcher still needs normal block.
- Sustained boss damage that does not depend on endless stance changes.

Remove Strikes when the deck already has enough damage. Skip mediocre rewards. Every added card must improve damage, defense, consistency, or a proven engine.

## Drafting and pivots

Do not name the build after seeing one synergy card. Pivot only after finding both a payoff and at least two usable enablers.

| Direction | Commit when | Still required |
| --- | --- | --- |
| Wrath aggression | `Tantrum` or `Simmering Fury` plus efficient attacks | Two exits and retained/ordinary block |
| Stance dance | `Mental Fortress` plus repeatable entries, exits, and draw | Stop adding stance cards once reliable; add boss scaling |
| Scry | `Nirvana` plus `Foresight`, two strong Scry cards, or Scry plus `Weave` | Treat Scry as consistency until the engine is real |
| Miracles | `Brilliance` or `Deva Form` plus a payoff | Do not collect generators without payoff |
| Retain | `Establishment` or `Meditate` plus several useful retained cards | Retain only cards with a planned future turn |
| Omega control | Enough defense and energy to survive setup | Upgrade Omega quickly and keep the deck consistent |
| Blasphemy finisher | Compact deck and exact lethal-scale damage | Never play it without proven lethal |

Generally strong flexible picks: `Cut Through Fate`, `Third Eye`, `Fear No Evil`, `Crescendo`, `Empty Mind`, `Tantrum`, `Protect`, `Perseverance`, `Wallop`, and `Pray`. Useful bridges include one `Just Lucky`, `Tranquility`, `Prostrate`, `Crush Joints`, `Sash Whip`, and early `Conclude`. Premium rares include `Scrawl`, `Vault`, `Omniscience`, and safe `Wish`.

## Every-turn procedure

1. Record current HP, stance, energy, hand, draw/discard information, potions, enemy HP/block/tokens, and every enemy intent.
2. Calculate immediate lethal before defending. Include Wrath, Vulnerable, Weak, multi-hit attacks, and enemy block.
3. Calculate incoming damage and non-blockable HP loss. Decide the required block and whether an enemy can be killed or weakened first.
4. Before entering Wrath, identify the exact lethal, stance exit, or sufficient block. If none exists, stay out of Wrath.
5. Order setup before payoff: Scry/draw, Calm or exit setup, Vulnerable, Wrath, block-generating attacks such as `Wallop`, then damage.
6. Recalculate after every random effect, draw, potion, or enemy death. Do not execute a stale plan.
7. End only after checking unused energy, playable zero-cost cards, expiring retained cards, harmful statuses, and whether the intended stance is safe.

## Tactical rules that must not be forgotten

- `Conclude` is the final card of the turn. It prevents further card play. Never use it before an exit, defense, draw, potion-dependent card sequence, or other required action.
- Treat retained, exhaust-only exits as limited combat resources. Preserve the last one for a mandatory late Wrath turn unless spending it now prevents more damage than the future trap can cause.
- Do not add another Wrath entry such as `Indignation` when entries already outnumber dependable exits. Take it only after another reusable exit exists or when the deck has a proven short-fight kill plan.
- Use `Distilled Chaos` only after survival and any required stance exit are already secured, or when every possible revealed card is safe. A randomly played `Conclude` can lock the rest of the hand.
- Never retain `Burn` or another harmful status with `Runic Pyramid`. Scry or discard statuses whenever possible and budget their effects separately from enemy intent.
- A `Burn` still in hand deals 1 blockable damage at the end of the player turn, before enemy actions. It spends Block first, so include it in total incoming damage and leave enough Block for the enemy intent that follows.
- With `Runic Pyramid`, retain only a card with a specific job next turn: a safe exit, Wrath entry for a proven burst, premium defense, or engine payoff. Retaining everything creates a clogged hand.
- `Study` draws two cards only while the Watcher is in Calm. Do not leave Calm late in the turn unless the exit prevents more damage or advances lethal enough to justify losing that next-turn draw.
- Apply Vulnerable before the largest or multi-hit attack. `Wallop` gains Block only from damage that penetrates enemy Block, so do not rely on it while the target is fully shielded.
- `Eruption` deals its hit before entering Wrath; do not give its own hit the Wrath bonus.
- Do not kill a Fungi Beast while another enemy will attack unless every attacker also dies or the Vulnerable-doubled damage is survivable. `Spore Cloud` resolves before the surviving attack.
- Against paired Fungi Beasts, prefer killing the Strength-buffer first when the other enemy's immediate attack is survivable; leaving the buffer alive can make the following turn much more expensive.
- Enemy Weak persists through a non-attacking turn. One Weak token is spent only when that enemy actually performs an attack, and it affects the whole multi-hit attack action rather than one hit.
- Weak and Vulnerable cancel each other for damage modification; do not count both.
- Scry away `Burn`, `Dazed`, excess Strikes, and cards that miss the current plan. Keep all only when the full sequence is genuinely useful.
- Treat potions as HP and tempo, not trophies. Use one before a bad turn becomes a fatal turn.
- Spend an emergency potion such as `Ghost in a Jar` only when ordinary cards cannot survive the turn. Preserve it for the boss's worst known attack/status turn, not merely an expensive turn.
- A boss phase or apparent kill may produce new enemies. Do not spend every defensive resource until the encounter is actually over.

## Act checkpoints

### Act I

- Upgrade `Eruption` early.
- Add roughly one efficient attack, one defense card, and one consistency card before chasing synergies.
- Fight an elite only with adequate HP, a safe Wrath exit, and enough immediate damage or block.
- Leave the act with the baseline skeleton substantially complete.

### Later acts

- Keep normal defense relevant; do not assume stance effects alone will block.
- Add a boss-kill plan independent of the defensive engine.
- Favor upgrades/removals over speculative cards once the deck performs its core sequence reliably.
- Plan for longer fights, statuses, and turns where Wrath is unsafe.

## Boss reminders

- Against Guardian, track every phase and block-break threshold. Preserve a retained/exhaust exit for the later mandatory block-break cycle; do not spend the only guaranteed exit on optional early damage. Breaking Block is defense, so plan enough attacks to remove all of it without ending trapped in Wrath.
- Against Hexaghost, preserve HP, clear statuses, and build sustained damage. Do not retain Burns. Do not over-thin a small deck immediately before this fight: without strong Scry/discard, a 12-card deck recycles Burns too quickly. Random card play is especially dangerous when `Conclude` remains in the draw/discard pile.
- Treat a survival potion as delay, not scaling. By the second heavy Burn cycle, Hexaghost must already be in reliable kill range; draw and exits alone do not replace a boss-speed damage plan.
- Against Slime Boss, budget cards, potions, and HP for the spawned Large Slimes; the encounter is not won merely by reducing the boss to zero. Use one-shot retention to carry defense or a small-enemy kill into the split rather than accelerating an already-safe boss turn. Enter the split with at least the exact margin implied by all spawned intents; Weak may reduce only one point.
- At the final campfire before Slime Boss, default to Rest unless the current HP already covers the projected split or the upgrade creates a guaranteed spawned-slime kill. Account for the HP cap: healing from 7 to 9 adds only 2 HP and still needs another point of Block or damage reduction against 5 incoming with one Defend.
- Energy without defensive cards is not a split plan. Preserve draw, real Block, or an immediate small-slime kill; an Energy Potion cannot rescue a hand whose maximum Block is below the incoming damage.
- Against Donu and Deca, focus Donu before repeated Strength scaling makes the alternating double attacks lethal. Preserve Weak or equivalent multi-hit mitigation for Donu's attack turn, and enter with enough ordinary Block density that one bad draw does not spend the Fairy immediately.

## Attempt log

### Attempt 1 — defeat, floor 13

Defeated Slime Boss but died to the Large Slime split. Lesson: preserve enough defense and resources for spawned enemies; verify the encounter has ended before treating the boss burst as victory.

### Attempt 2 — defeat, floor 13

Reached Hexaghost with a flexible 15-card deck (`Eruption+`, two exits, `Third Eye+`, `Crescendo`, `Like Water`, `Wallop+`) and beat Lagavulin at full HP. Lost with Hexaghost at 5 HP after two avoidable sequencing errors: `Distilled Chaos` randomly played `Conclude` before `Inner Peace`, trapping the turn in Wrath, and `Runic Pyramid` retained two Burns. Lessons: secure the exit before random play, treat `Conclude` as strictly last, and never retain a harmful status.

### Attempt 3 — defeat, floor 13

Reached Guardian at full HP with `Eruption+`, `Tranquility+`, `Vigilance`, `Wallop+`, `Third Eye`, `Cut Through Fate+`, `Indignation`, and `Just Lucky`. The boss fell to 13 HP, but `Tranquility+` had been exhausted for optional damage during the first Sharp Hide cycle. A later mandatory block-break left Wrath without the retained exit; Watcher reached 2 HP, exited with `Vigilance`, could make only 4 Block against 6 damage, and died. Lessons: save the limited retained exit for the dangerous later Guardian cycle, and reject extra Wrath entries when exit density is already insufficient.

### Attempt 4 — defeat, floor 13

Reached Hexaghost at full HP with a compact 15-card deck, three exits, `Eruption+`, `Third Eye`, `Wallop`, `Talk to the Hand`, and `Cut Through Fate`. An earlier Fungi Beast kill applied Vulnerable before its ally attacked and nearly ended the run. Hexaghost fell to 22 HP; on the lethal turn, a Burn spent 1 of 3 Block before the enemy's 6 damage, leaving 4 damage to land. Lessons: resolve death triggers before surviving intents, count Burns in the lethal budget, remember that `Eruption` enters Wrath after its hit, and do not expect `Wallop` to gain Block through enemy Block.

### Attempt 5 — defeat, floor 13

Reached Hexaghost at full HP with a 12-card deck, `Eruption+`, `Empty Body`, `Crescendo`, `Wish`, retained damage, and `Ghost in a Jar`. The boss fell to 15 HP. `Ghost in a Jar` was spent on turn 4 even though Flying Sleeves plus two Defends would have survived; turn 6 then dealt exactly lethal through a 3×2 attack and two Burns. Lessons: save emergency mitigation for a turn ordinary cards cannot survive, and do not remove the last filler card before a status boss when an over-thin deck lacks enough Scry/discard to keep statuses out of the next cycle.

### Attempt 6 — defeat, floor 13

Built a strong stance core with `Tantrum`, `Flurry of Blows`, `Tranquility+`, `Empty Body`, and `Third Eye`, beat Lagavulin nearly untouched, and reduced Slime Boss to zero. Watcher entered the split at 2 HP; Weak reduced the three spawned attacks from 8 total to 7, but the hand could make only 3 Block. Lesson: preserve at least three more HP/Block or a retained small-slime kill for the split; spending Runic Pyramid to retain burst damage was less valuable than carrying defense into the real lethal phase.

### Attempt 7 — defeat, floor 13

Reached Slime Boss at 7/9 HP with a 15-card stance/Scry deck including `Eruption+`, `Empty Fist`, `Empty Mind`, `Mental Fortress`, `Nirvana`, `Protect`, and `Reach Heaven`. An earlier paired Fungi Beast fight cost critical HP after leaving the Strength-buffer alive. The boss fell, but Watcher entered the split at 1 HP and survived only its first turn; the next wave presented 16 damage while the hand could make at most 3 Block. The retained Energy Potion could not supply the missing defense. Lessons: remove a survivable Fungi Strength-buffer first, and preserve actual defense, draw, or a small-slime kill for the split rather than relying on spare Energy.

### Attempt 8 — defeat, floor 13

Reached Hexaghost at full HP with a 16-card deck containing `Eruption+`, `Flying Sleeves+`, `Cut Through Fate`, `Third Eye`, `Empty Fist`, `Crescendo`, `Tranquility`, and `Study`, plus Tungsten Rod and a Block Potion. The boss survived at 7/36 HP. The potion delayed lethal, but leaving Calm with `Empty Fist` on turn 6 disabled `Study`'s conditional draw; turn 7 began at 3 HP with two Burns and no line to deal the remaining damage or survive. Lessons: protect `Study`'s Calm condition when the extra draw matters, and put Hexaghost in kill range before the second heavy Burn cycle.

### Attempt 9 — defeat, Act 3 boss

Cleared Guardian and Bronze Automaton with `Omega+`, `Deva Form`, `Wallop`, `Meditate`, `Fear No Evil`, `Third Eye`, and a strong Miracle engine. Pandora's Box then transformed three Defends into `Empty Body`, `Weave`, and `Flurry of Blows`, reducing ordinary block density. A Secret Portal reached the final campfire at 2 HP, and the run entered Donu/Deca at only 5/9 HP. Damage was split onto Deca while Donu scaled Strength; Donu's 4×3 attack on turn 2 consumed Fairy in a Bottle and killed Watcher through the remaining hits. Lessons: do not trade away too much ordinary Block late, focus Donu, and preserve multi-hit mitigation for Donu's attack turn.

### Attempt 10 — defeat, floor 13

Reached Slime Boss at 7/9 HP with a 17-card deck containing `Inner Peace`, `Tantrum`, `Wallop+`, two `Cut Through Fate` copies, and an Explosive Potion. The boss fell, and the empty-board transition was used to enter Calm and clear a Slimed. Watcher still entered the split at 2 HP; the potion reduced the Large/Acid/Spike Slimes to 8/3/3, but their 5 incoming damage exceeded the hand's single Defend, two Strikes, and two Slimed. Resting instead of upgrading `Eruption` at the final campfire was preferable but not sufficient by itself: the extra 2 HP would still have reached exactly zero after 4 unblocked damage. Lesson: enter this split with at least one more point of HP, Block, or immediate small-slime damage beyond that rest line.

## Daily Climb — 2026-09-28

Shared seed `4178693107`, Ascension 10, `Heirloom` and `Night Terrors`. Heirloom gave `Black Blood` on the first attempt; campfires cannot Rest. Record and verify every result before retrying. Reuse known map, rewards, and boss patterns, but re-inspect after each choice because a different route or draft can change later draws.

### Daily attempt 1 — defeat, floor 13

Recorded and verified on the Daily Climb leaderboard; log `slay-the-spire-run-campaign-55.json`. Chose `Inner Peace` from the starting reward and upgraded `Eruption`. The path was floor 1 Cultist (`Rushdown`), floor 2 Bonfire Spirits (remove Strike), floor 3 Red Slaver (`Protect`), floor 4 Ominous Forge (`Omamori`), floor 5 Merchant (`Tranquility`, `Runic Pyramid`), floor 6 Gremlins (`Empty Body`, Attack Potion), floors 7 and 9 Treasures (`Oddly Smooth Stone`, `Orichalcum`), floor 8 Cultist/Louse (`Foresight`), floor 10 Living Wall (Defend → `Spirit Shield`), floor 11 Lagavulin (`Flurry of Blows`, `Incense Burner`), floor 12 Smith `Tranquility+`, floor 13 Slime Boss.

The boss added four Slimed on turns 1, 4, 7, and 10; attacked for 3 plus two Slimed on turns 2, 5, 8, and 11; and attacked for 6 on turns 3, 6, 9, and 12. It died on player turn 13 before the next four-Slimed action. The low-damage deck needed 13 turns to reach the split and entered it at 3/8 HP. The split spawned a 10-HP Large Slime, 5-HP Acid Slime, and 5-HP Spike Slime. Weak and Vulnerable left only 2 HP after the first split turn; the next hand could not block the Large and Spike attacks, ending the run on turn 15.

For the next attempt, prioritize early damage and a faster boss split over speculative setup cards. Consider `Flurry of Blows` instead of `Protect`, a damage-oriented Living Wall choice, and a damage upgrade at the final campfire. Preserve the Attack Potion for the split by avoiding Lagavulin if the alternate route remains safe. Save the one-shot `Runic Pyramid` retention for the kill/split transition, not a routine boss turn. Recalculate rather than assuming the changed draft preserves identical draws.

### Daily attempt 2 — defeat, floor 3

Recorded; log `slay-the-spire-run-campaign-56.json`. The Daily Climb leaderboard still displays the previous 13-floor personal best, because it ranks only each player's best daily attempt. Chose `Carve Reality` at Neow, `Empty Fist` over `Rushdown` at floor 1, and removed a Strike at Bonfire Spirits. At floor 3, Red Slaver was at 4/10 HP while Watcher had 7/8 HP. `Carve Reality` and `Defend` left 6/8 HP after its 2-damage attack and Vulnerable. Turn 3 then drew `Eruption+`, Strike, and three Defends with 4 Energy: a straightforward kill or safe block was available. An automated follow-up mistakenly pressed `End turn` again after the turn-2 action had already advanced the game to turn 3; Vulnerable doubled the next attack to 6 and killed Watcher. This was a play-control error, not a game-rule bug.

After **every** action that can consume the last Energy or end a turn, inspect the returned turn number and phase before issuing another `End turn`. Never chain an End-turn action merely because the control exists: the game can already have advanced to a fresh playable turn. The `Carve Reality`/`Empty Fist` start remains viable; retry it without the inadvertent skip.

### Daily attempt 3 — defeat, floor 23 (Act 2 boss)

Recorded and verified as a new 23-floor personal best on the Daily Climb leaderboard; log `slay-the-spire-run-campaign-57.json`. The `Carve Reality`/`Empty Fist` start safely beat Red Slaver. Floor 3 `Flurry of Blows` became `Flurry+` at the floor-4 Ominous Forge; the Merchant supplied `Tranquility`, `Protect`, and an Attack Potion. Floor 6 Gremlins died on turn 1 to `Eruption+` plus the two-target `Carve Reality`, and yielded another Attack Potion and `Empty Body`. The safer branch yielded Stone Calendar, `Carve Reality+`, `Tranquility+`, Oddly Smooth Stone, `Foresight`, and `Protect+`; it avoided the floor-11 elite. Both Attack Potions accelerated Slime Boss, and Stone Calendar plus `Carve Reality+` killed the Large/Spike split on turn 6. Act 2 began at full HP despite ending Act 1 at 4/8 HP.

Act 2 floor 1 Shelled Parasite/Fungi Beast cost six HP before Black Blood's two-point heal: Parasite's Vulnerable made the following Fungi hit double. Floor 2 Mausoleum gave Orichalcum but also `Regret`; floor 3 Merchant bought `Meditate`. Floor 4 Centurion/Mystic required both potions and fell with Watcher at 1 HP, then Black Blood healed to 3. Floor 5 Augmenter forced a one-HP upgrade (`Scrawl+`); the floor-6 campfire upgraded `Meditate+`. The floor-8 Woman in Blue traded the last Gold for Flex Potion rather than losing HP, and the final campfire upgraded `Nirvana+`. Champ began at only 2/8 HP. White Beast Statue supplied potions after fights, but the low-combat Act 2 route did not restore HP.

Champ had 45 HP before Anger and would re-enter Fury with another 45 HP when first defeated. Observed first-phase cycle: turn 1 attack 4; turn 2 Weak; turn 3 attack 6 plus 3 Block; turn 4 attack 4; turn 5 Weak; turn 6 attack 6 plus 3 Block. `Foresight` plus `Nirvana+` gave 2 Block at turn start, and Skill Potion doubled `Vigilance` to survive turn 4. On turn 6, Champ still had 24 first-phase HP. Watcher had 2 HP and 2 Block. The planned line assumed `Empty Fist` would leave Calm for two Energy, but the actual stance was **Neutral** after the prior turn's Eruption/Empty Fist. Strike plus Empty Fist left only one Energy, so `Protect+` could not be played; `Empty Body` raised Block only to 4 and the six-damage attack killed Watcher. Check the **actual stance from `inspect_game` before counting Calm Energy**. Do not spend a survival potion on an earlier attack without budgeting later six-damage turns.

Even without that tactical error, the deck was too slow for Champ's 90 effective HP. On the next attempt, pursue a stronger sustained-damage card at Act 2's known Merchant (`Sands of Time` is available for 3 Gold) or the floor-4 reward (`Windmill Strike` is available), rather than assuming `Nirvana+`/`Meditate+` alone can win. Avoid losing HP to Act 2 events unless the upgrade materially changes Champ survival; route for more Black Blood healing or safer encounters instead of arriving at Champ on 2 HP. Keep the Act 1 anti-Slime line unless a changed reward requires replanning.

### Daily attempt 4 — defeat, floor 23 (Act 2 boss)

Recorded and verified on the Daily Climb leaderboard as the 23-floor personal best (21-card deck); log `slay-the-spire-run-campaign-58.json`. Repeated the safe Act 1 route and six-turn Slime Boss kill, but chose Pandora's Box instead of White Beast Statue. It transformed all three remaining Strikes into `Spirit Shield`, a second `Flurry of Blows`, and `Third Eye`; took `Scrawl` as the boss card. Act 2 floor 1 Byrds and floor 4 Snake Plant both ended at full HP. Floor 2 Augmenter upgraded the second `Flurry+` for 1 HP; the floor-3 Merchant spent 3 Gold on `Panache`; floor 5 Ancient Writing removed a Defend; floor 6 Smith upgraded `Scrawl+`; floor 7 Joust bet 2 Gold and rolled 6 for 6 Gold; floor 8's event forced a Snecko fight, won at 7/8 HP; floor 9 Smith upgraded `Panache+`. Chose `Cut Through Fate`, `Crush Joints`, and `Crescendo` from Act 2 rewards. Champ began at 7/8 HP, with no potions.

Champ's first phase fell on turn 6: `Panache+` dealt the final 2 damage after the hand emptied, and Fury spent that enemy action removing its debuffs instead of attacking. Fury began turn 7 at 45 HP and intended **4 damage twice**. Watcher had 3/8 HP, no Miracle, and drew only two Defends plus `Third Eye` for 4 total Block; `Cut Through Fate` found no stronger defense. Fury dealt lethal through that Block. Log review confirms the first `Flurry+` on turn 6 dealt **zero total damage** because one Weak applied to the whole multi-hit card, then the second Flurry dealt 3. Do not count Weak as expiring after the first hit of a multi-hit card.

The Pandora route is stronger than the White Beast route through Act 2 but still needs a Fury-turn defense reserve. On the next replay, consider paying **1 Gold for the Cleric's full-HP Heal** at Act 1 floor 9 instead of the 2-Gold Prayer; `Tranquility` at cost 1 still fits the known Slime Boss turn-3 line, and the saved Gold should let the Act 2 floor-3 Merchant buy both `Panache` (3 Gold) and **Block Potion** (2 Gold). Save the potion for Fury's 4×2 turn. Re-inspect after this changed choice: it may alter draws and the event/enemy sequence. Keep a real block card or potion for Fury rather than treating the phase transition itself as victory.

### Daily attempt 5 — defeat, floor 23 (Act 2 boss)

Recorded and verified as the displayed 23-floor Daily Climb result (the deck view contains `Nirvana+`); log `slay-the-spire-run-campaign-59.json`. Repeated the Pandora route, paid the Cleric 1 Gold instead of 2, and bought both `Panache` and Block Potion. Took `Nirvana` over `Crush Joints` after Snake Plant, upgraded it at floor 6, and upgraded `Panache+` at floor 9. With only 1 Gold, the Joust bet was paid by surrendering Stone Calendar rather than the Block Potion. Champ started at 7/8 HP; the Block Potion prevented 2 damage on turn 1 while `Nirvana+` and `Foresight` were established. The first phase fell on turn 8; Fury started at 45 HP and was cut to 13 HP by turn 12, but Watcher had only 1 HP and could not block Fury's turn-13 8×2 attack. `Nirvana+` gave only 2 Block per Scry, and `Panache+` triggered too rarely to beat 90 effective HP before Fury's Strength escalation.

For the next fixed-seed replay, retain the safe Act 1/Pandora route but **replace `Panache` with more reliable damage** while keeping Block Potion. Do not assume the earlier `Windmill Strike` reward persists on this Pandora draft: floor 4 instead offered `Nirvana`, `Collect`, and `Crush Joints`. Upgrade a useful damage card rather than `Panache`. The Act 2 floor-3 merchant on this draft actually offers `Collect`, `Study`, `Empty Body`, `Mayhem` (6 Gold, unaffordable), `Thinking Ahead`, and `Panache`, **not** `Sands of Time`; the earlier Sands offer belonged to a different draft. Buying only Block Potion leaves enough Gold to bet at the Joust without sacrificing Stone Calendar. Count Fury's sequence as cleanse, 4×2, +2 Strength, 6×2, +2 Strength, 8×2; enter Fury with enough HP/Block for multiple attacks, not just its first turn. One Weak applies to an entire attack card, then is spent; a weak `Cut Through Fate` can consume it before a multi-hit `Flurry+`.

### Daily attempt 6 — defeat, floor 29 (Act 3 boss)

Recorded and verified on the Daily Climb leaderboard at 29 floors; log `slay-the-spire-run-campaign-60.json`. Replayed the Pandora line, bought only Block Potion at the Act 2 merchant, bet 2 Gold at Joust to preserve Stone Calendar, took `Nirvana`, and upgraded `Scrawl+` before Champ. Beat Champ/Fury on turn 13 with 4 HP; Black Blood healed to 6. Chose Coffee Dripper and `Omega`, entered Act 3 at full 8 HP. The floor-1 Darklings fell to `Omega` on turn 3 with 7 HP remaining. Took `Prostrate` and a Block Potion. Floor-2 Secret Portal jumped to floor-6 branch-4 Treasure for Bag of Preparation; floor-7 Mind Bloom chose safe but ineffective `[Rich]` (+5 Gold); floor-8 campfire upgraded `Omega+`. Watcher entered Donu/Deca at 7/8 HP. `Omega+` was already in the opening hand, and `Scrawl+` added support for turn-1 setup, but Deca's 3×3 cost 1 HP even after Tranquility → Empty Body, Protect+, and Block Potion. On turn 2 Donu's 4×3 cost 3 HP through Oddly Smooth Stone, Spirit Shield, Prostrate, and Third Eye. On turn 3 Deca's 4×3 was lethal against two Defends and the 2 Block relic; Omega+ struck at end of turn, leaving Donu at 26 HP. `Omega+` hits both bosses for 6 each turn but does not substitute for sustained multi-hit defense.

For the next fixed-seed attempt, keep the proven Act 1/2 and Act 3 Darkling/Portal/Bag route, but take **Mind Bloom `[War]` rather than `[Rich]`**: the 5 Gold could not be spent, while an Act 1 boss reward can add combat power before Donu. Enter Donu with a better defensive relic/card or a stronger pre-boss upgrade if offered. At Donu, prioritize the Strength-buffer boss, but calculate each Deca and Donu multi-hit separately. `Omega`'s end-turn effect requires selecting its card then a target on **every turn**; it strikes both bosses in this encounter. On Foresight's turn-3 Scry, discarding Daze alone left retained Crescendo plus Defend/Defend/Eruption/Bane/Flurry and no way to block 12; evaluate discarding low-impact Defends to cycle into higher-value protection instead.

### Daily attempt 7 — defeat, floor 29 (Act 3 boss)

Recorded and verified as the 29-floor best on the Daily Climb leaderboard (28.4 damage/fight, 85% blocked); log `slay-the-spire-run-campaign-61.json`. Replayed the proven Acts 1/2, Act 3 Darklings, Secret Portal to floor-6 branch-4 Treasure (Bag of Preparation). At floor-7 Mind Bloom, `[War]` summoned Guardian; `Omega`, `Nirvana+`, `Foresight`, and stance damage beat it on turn 5 with 7/8 HP, so Black Blood restored full HP. The card offer (`Crescendo`, `Flying Sleeves`, `Wreath of Flame`) lacked defense and was skipped; the relic was Meat on the Bone, which has no effect during Donu combat. Final campfire upgraded `Third Eye+` for 3 Block/Scry 5 instead of `Omega+`.

Watcher entered Donu/Deca at 8/8 HP with different initial draws. Turn 1 `Nirvana+` → `Scrawl+` → `Cut Through Fate` found `Spirit Shield`, yielding 11 Block; Crescendo/Flurry put 6 damage into Donu and preserved the Block Potion. Turn 2 `Third Eye+` Scry and Foresight/Vigilance plus Block Potion made 9 Block against Donu's 4×3, leaving 5 HP. Turn 3 Calm→Eruption→Flurry+→Cut Through Fate→Flurry+→Empty Body→Protect+→Defend put 16 damage into Donu and 11 Block against Deca's 4×3, leaving 4 HP. Turn 4 had `Prostrate`, `Empty Fist`, `Third Eye+`, `Vigilance`, `Carve Reality+` and only 10 available Block against Donu's 5×3; Watcher died with Donu at 26 HP. The shorter portal route provides too few block sources and too little damage despite the Nirvana/Scry setup; Foresight discarded `Omega` before it could be played against Donu/Deca. A floor-7 `[War]` reward was too late and too random to solve that.

Next attempt: use the floor-2 Secret Portal to **floor-3 branch-4 Event** instead of floor-6 Treasure, then follow floor-4 branch-4 Campfire → floor-5 branch-4 Encounter → floor-6 branch-4 Treasure → floor-7 branch-3 Event → floor-8 branch-3 Campfire. This keeps Bag of Preparation but adds an encounter/card reward, a second event, and an extra upgrade before Donu. Take defensive cards/relics or substantial multi-hit damage over marginal chip; the boss requires repeated 12–15 Block or killing Donu before its Strength stacks. `Third Eye+` Scry 5 filtered statuses but did not itself make enough Block to live through Donu's turn-4 5×3.

### Daily attempt 8 — defeat, floor 32 (Act 3 boss)

Recorded, downloaded `slay-the-spire-run-campaign-62.json`, reviewed, and verified at 32 floors on the Daily Climb leaderboard (28.9 damage/fight, 85% blocked). Replayed the proven first two acts and Darklings, then used the Secret Portal to floor-3 branch-4. Floor-3 Mind Bloom `[War]` yielded `Wreath of Flame` and Bag of Preparation after Guardian; floor-4 campfire upgraded `Third Eye+`. `Omega` cleared the floor-5 Exploder, Repulsor, and two Spikers; Black Blood restored full HP. Took `Empty Mind`, the floor-6 chest gave Meat on the Bone, and floor-7 Face Trader exchanged that dead relic for Pocketwatch. The final campfire upgraded `Empty Mind+`.

At full HP against Donu/Deca, turn-1 `Wreath of Flame` for 2 Strength, Crescendo, and two `Flurry of Blows+` dealt 24 to Donu while `Spirit Shield` and a Block Potion left 6 HP. `Nirvana+`, `Cut Through Fate`, `Tranquility`, `Empty Mind+`, and `Scrawl+` found enough Block to survive Donu's 4×3 on turn 2 at 2 HP. Turn 3 survived Deca's 4×3 at 1 HP with 11 Block from `Foresight`/`Nirvana+`, `Cut Through Fate`, `Prostrate`, `Third Eye+`, and `Defend`; `Protect+` remained in hand. Turn 4's Stone Calendar reduced Donu to 23, but even Oddly Smooth Stone, `Vigilance`, `Empty Mind+`, another Scry, and the played `Protect+` left too little Block for Donu's 5×3. Donu still had 22 HP on defeat. The longer route helped survival but not enough damage or sustained Block; Loaded Die's extra turn-3 draw included statuses, Pocketwatch never rolled 3, and `Omega` never came online.

For the next retry, test a more aggressive opener on the same fixed seed: spending 3 Energy on `Wreath of Flame` instead of playing turn-1 `Foresight` adds six immediate Donu damage across the two three-hit Flurries. Reinspect every draw because the changed power play alters later turns. Prioritize killing Donu before his turn-4 5×3 rather than relying on another marginal defensive upgrade.

### Daily attempt 9 — defeat, floor 13

Recorded and downloaded `slay-the-spire-run-campaign-63.json` (169 events); the Daily Climb leaderboard kept attempt 8's higher 32-floor result, as it shows only each player's best climb. A replay matcher chose an identically labeled but different floor-3 branch, so the route diverged at floor 4; future replay must match **floor and branch context**, not just room labels. The alternate route bought `Tranquility`, `Protect`, and an Attack Potion, upgraded `Flurry of Blows+` at floor-6 Ominous Forge and `Carve Reality+` at floor-8 Living Wall, healed at the Cleric, and took Stone Calendar, Oddly Smooth Stone, and Orichalcum. Lagavulin fell at full HP. The final campfire upgraded `Tranquility+`.

Against Slime Boss, an Attack Potion on `Carve Reality+` enabled a turn-5 split at full HP, but no potion remained for the spawned slimes. Turn 6 killed Spike Slime before Vulnerable; Large and Acid Slimes dealt four damage through `Empty Body`. Defensive cards preserved 4 HP on turn 7, but statuses and Weak prevented a kill. `Flurry of Blows+` made **zero** damage on all three hits while Weak 1 applied to the Attack; do not assume Weak is consumed per hit. Turn 8 left 1 HP, and turn 9's hand could make only 2 Block against 3 incoming. Next and final attempt should replay the proven Act 1/2 route by exact map branch, then test the more aggressive Donu opener.

### Daily attempt 10 — defeat, floor 32 (final attempt under task cap)

Recorded and downloaded `slay-the-spire-run-campaign-64.json` (478 events); log reviewed. The Daily Climb leaderboard showed CodexAgent's 32-floor Watcher result with 30.0 damage/fight, 85% blocked, and a 24-card deck. This was the tenth attempt under the user's ten-run cap, so the requested session ended without an Act 3 win. Replayed the proven Acts 1/2 and followed the exact floor/branch route from attempt 8: Portal to floor-3 branch-4 Mind Bloom `[War]`, Guardian for `Wreath of Flame` and Bag of Preparation, `Third Eye+`, the floor-5 Exploder/Repulsor/two-Spiker encounter for `Empty Mind`, Treasure, Face Trader exchanging Meat on the Bone for Pocketwatch, and `Empty Mind+` at the final campfire. Guardian and the floor-5 encounter both ended at full HP after Black Blood.

Watcher entered Donu/Deca at 8/8 HP; both bosses had 55 HP. Stone Calendar hit Donu for 4, but the opening hand had only one Flurry and no `Wreath of Flame`; `Empty Mind+`, `Spirit Shield`, Calm→`Empty Fist`, that Flurry, `Foresight`, and `Defend` made 11 Block and left Donu at 46 HP. On turn 2, `Scrawl+` found Wreath and `Crescendo`, while `Third Eye+` Scry exposed `Omega`, Ascender's Bane, `Prostrate`, and the second Flurry. Discarding the first three let `Cut Through Fate` draw Flurry; spending 1 Energy on Wreath, entering Wrath, and leaving it with `Empty Body` dealt 12 to Donu but made only 9 Block against his 4×3, leaving 5 HP. Turn 3 `Vigilance`, `Protect+`, and Nirvana/Scry made 10 Block against Deca's 4×3, leaving 3 HP and Donu at 30. Turn 4 Stone Calendar, Calm→`Eruption+`, Flurry, and `Empty Mind+` found `Omega`, but Donu still had 18 HP. `Prostrate`, `Empty Body`, and Block Potion made only 9 Block against Donu's 5×3; Omega reduced Donu to 13 and Deca to 50 before Watcher fell.

The repeatable bottleneck is not reaching the boss: the fixed-seed route consistently reaches Donu at full HP, but the 24-card deck cannot both deploy scaling and cover alternating 9/12/12/15 multi-hit attacks. Wreath's one-turn Strength burst does not replace a persistent damage engine, and playing Omega on turn 4 is too late. In a future daily with similar boss pressure, draft/remove for earlier access to sustained damage **and** enough ordinary Block or Weak to cover Donu's second attack; evaluate the boss plan before spending the last campfire upgrade on extra draw alone. A potion's 2 Block cannot bridge a six-point lethal gap.
