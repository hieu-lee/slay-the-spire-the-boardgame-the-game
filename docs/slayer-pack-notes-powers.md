# Slayer Pack — the powers group notes (Powers & reactions)

Eleven Powers: Brutality, Infernal Blade (Ironclad); Caltrops, Eviscerate, Phantasmal Killer
(Silent); Fasting (Watcher); Bandage Up, Chrysalis, Companion, Metamorphosis, Panic Button
(Colorless). Every scan in the pack's published card scans (see `docs/slayer-pack.md`) was read; none contradicts
`docs/slayer-pack.md`. Each face carries its scan text as `printedText` so the Power row and
accessible descriptions read the printed card.

New vocabulary is grouped under `// Slayer Pack` comments in `src/game/cards.ts` (conditions
`lostHpLastRound`, `hasStatusOrCurseInHand`, `hasActivePower`; effects `damagePerDiscard`,
`gainVulnerable`, `exhaustSelf`, `loseMiracleOrDiscardSelf`, `mayExhaustSelfFor`, and the
persistent markers `preventAllHpLoss`, `reduceHpLoss`, `cardIconBonus`, `shivRowDamage`;
`CardDef.activationCondition`). Optional state fields: `Player.lostHpLastRound`,
`CardInstance.xPaid`, `CardInstance.metamorphosis`, `PendingTrigger.count`,
`TriggerEvent.count`, `PlayContext.triggerCount/optionalSelfExhaust/metamorphosisPowerUid`.

Verification: `scripts/verify-slayer-powers.mjs` (engine, both faces, edge cases, online room
server) and `scripts/verify-slayer-powers-browser.mjs` (Metamorphosis attach choice, Infernal
Blade activation gating, Companion self-Exhaust toggle; desktop mouse/keyboard and
horizontal-phone touch).

## Per card

**Brutality** (`slayer/ironclad.ts`). `resolvesOnPlay` draw 1; an `additionalTriggers`
Start-of-Turn `applyVulnerable 1` gated by `when: lostHpLastRound`; base `target: 'enemy'`,
upgraded `target: 'row'` (AoE icon = a chosen row plus the boss). "Last round" is captured in
the Reset step (`start-turn.ts`): `lostHpLastRound = true` when `hpLostThisRound > 0`,
otherwise the field is deleted, so states without HP loss serialise exactly as before. The
owner directs the target through the existing Start-of-Turn choice flow (Noxious Fumes path);
when nothing was lost the equivalence collapse asks no question. The flag is published by the
room server (`redactPlayer`). HP prevented by Panic Button/Buffer is not "lost".

**Infernal Blade**. `activeAbility` + `oncePerTurn`, `applyWeak 1` on a chosen enemy, with
`activationCondition: hasStatusOrCurseInHand` (any card of type `status` — Daze/Burn/Slimed —
or `curse`). `activatePower` refuses it (same state) when the condition fails; the UI button is
disabled and does not count as a legal action. Upgrade: cost 0.

**Caltrops**. `endOfTurn` trigger reusing Flame Barrier's `damagePerAttackIntent` (1 / 2 per
icon). "Intends to attack you" is read by `attackIconsAgainst` (queries.ts) exactly as the Enemy
Turn aims: AoE hits everyone, a Facing attack only its facing players, anything else the players
in its row (bosses reach every row; Last Stand redirects an empty row). Flame Barrier and
Guardian's Spiker Protocol share it, so they gained the same Facing / Last Stand fix. Plain
damage, absorbed by enemy Block.

**Eviscerate**. `onDiscard` trigger, `target: 'enemy'`, `damagePerDiscard` (1 / 2 x cards).
`resolveDiscardReactions` now fires `{ kind: 'onDiscard', count }`; the count rides on queued
`PendingTrigger.count` and reaches the effect as `PlayContext.triggerCount` (direct, queued,
end-turn and Start-of-Turn private-discard paths). One damage instance of N x amount on one
chosen enemy (a pending trigger choice when 2+ enemies live). The end-of-turn hand discard is
not a card effect and does not trigger; neither does a card falling off a dead enemy
(Nightmare, Corpse Explosion, bounties): the event's `count` only counts cards from hand or draw
pile and the trigger is `{ kind: 'onDiscard', fromHandOrDraw: true }` (After Image unchanged). A Power discarding itself from play (Fasting) is not a
discard from hand either (follows the existing Charge Up / Prepare Crush precedent).

**Phantasmal Killer**. `resolvesOnPlay gainShiv 1 / 2` (overflow Shivs use the existing choice).
Persistent `shivRowDamage 1`, applied at the end of `resolveShivAttack`, i.e. after every Shiv
attack — spent Shivs, overflow Shivs thrown by cards/abilities/potions, Start-of-Turn overflow.
"The target's row" = AoE row of the Shiv's target (`resolveEnemyTargets('row')`: that row plus
the boss), even when the Shiv killed the target; a boss target uses the boss's own row. It
resolves right after that Shiv's own reaction window (a Shiv is its own attack), not deferred
to the end of a card that threw it. Each copy in play deals its own damage.

**Fasting**. Persistent `cardIconBonus 1` (summed over copies in play) added to every swing of
a `hit` and to every Block icon (alongside Footwork's `cardBlockBonus`) when the resolving source
is the owner's Attack or Skill card (copies and forced plays included). Not Shivs (tokens, not
cards — the rules say "Not cards"), not Power/relic/potion/Orb effects, not Slime Commands or
Gem Power damage, not plain `damage` effects (no hit icon). Added before Vulnerable doubling.
The damage preview uses the real engine, and its baseline strips Fasting like Strength.
Start of turn `loseMiracleOrDiscardSelf`: spend a Miracle, else the Power goes to the discard
pile and its bonus ends.

**Chrysalis**. `onPlayCard` Skill trigger with `oncePerTurn` (draw 2 on the first Skill each
turn; per-copy key; reset at Start of Turn).

**Bandage Up**. `resolvesOnPlay` draw 1; persistent `reduceHpLoss 1` then Exhaust (base) or
discard (+). Single reduction point: `losePlayerHp` (every enemy hit via `damagePlayer`, Wrath,
Burn/Slimed/curses at end of turn, `loseOwnHp`, Thorns etc.). Order: round limit
(Wraith/Apparition) → Panic Button → Buffer (prevents the whole instance, Bandage stays) →
Bandage Up → HP cap → Escape from Hades. It answers only a loss of ≥1 HP that would really
happen; the 1 comes off the uncapped amount (`damagePlayer` now passes the unblocked damage
before the HP cap — behaviour-identical for existing code), so 2 HP taking 3 still dies. With
several copies each answers in turn while any loss remains, then all leave play together.

**Panic Button** (Retain). Persistent `preventAllHpLoss`: `losePlayerHp` returns 0 for any
source (Block is still spent by damage). Start of turn: `gainVulnerable 2 / 1` (player, cap 3,
respects `preventDebuffs`) then `exhaustSelf`.

**Companion**. Egg: unplayable, no effects (refused by `playCard`); `upgrade` defines the
dragon, so `canUpgradeCard` and every upgrade path (Smith, Neow upgrades, events, Tiny House /
Astrolabe) hatch it; the board-game eggs only touch Attacks/Skills. Dragon: cost 1,
`endOfTurn` trigger, `target: 'enemy'`: `damage 4` then `mayExhaustSelfFor [block 3]`. The
end-turn ability offers every enemy twice: `e1` and `exhaust:e1`
(`selfExhaustEndTurnTarget`); the prefixed choice also Exhausts it for 3 Block. Even with one
enemy the owner is asked. A disconnected online owner gets the first target (no Exhaust). UI:
an "Also Exhaust for Block" toggle beside the drag-to-enemy source.

**Metamorphosis** (X). Play context names `metamorphosisPowerUid` (one of the owner's Powers
in play; `playCondition: hasActivePower`). X must equal the copied Power's printed cost (+1 on
the base face); an X-cost Power (Conjure Blade, another Metamorphosis) costs what it was played
for (FAQ) — stored as `CardInstance.xPaid` when an X Power enters play. Cost overrides (free,
Snecko) replace the payment like any card. In play the physical card keeps its uid but takes
the copied Power's `defId`/`upgraded` plus `metamorphosis: { upgraded, sourceUid }`, so every
trigger, persistent rule, hard-coded Power check and once-per-turn key treats it as a second,
independent copy (own counters, own once-per-turn use, own active ability). Copying a Power
whose whole printed effect is a lasting modifier applied when played (Accuracy, Inflame,
Footwork...) applies that modifier again (`LASTING_PLAY_EFFECTS`); one-shot "When played" lines
are never copied (Brutality's and Bandage Up's draw, Phantasmal Killer's Shivs, Electrodynamics'
Channel, Last Stand's Block). A fixed cost (play window, free or forced play) is the X the card is
played for, so it may only attach to a Power whose X equals it. A copy of a copy of an X-cost
Power reproduces the original X (`metamorphosis.copiedX`). Leaving play:
`exhaustCards` and `discardPowerFromPlay` take attached copies (and chains) along with the
original, and every pile entry is restored to the Metamorphosis card; `settle()` sweeps any
other removal path. A Start-of-Turn ability whose Power was taken out of play earlier in the
same order is skipped (previously such a missing source rolled the turn back). A forced free
play without a chosen Power finds nothing to attach to and is discarded. UI: the X step is
replaced by "attach to <Power> (X=n)" buttons.

## Simplifications / known gaps

- Removing a copied static modifier (e.g. a copied Accuracy leaving play) does not take its
  bonus back — the same as the originals, which never leave play.
- PowerRow shows a Metamorphosis copy with the copied Power's glyph and zoom, labelled
  "Metamorphosis copying ...".
