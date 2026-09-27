import type { RunState } from '../../../game/run.ts'
import {
  eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowGoldTaken, neowRedRevealed, neowRedTaken,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, beforeFirstTurn, deckHas, handCount, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { HeroTutorial, TutorialPlan, TutorialStep } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-hermit-178',
  neow: { card: 'heart_boon_12', red: ['hermit_dive', 'hermit_feint', 'hermit_high_caliber'], pick: 'hermit_high_caliber', option: 0,
    effectCards: ['hermit_snapshot'] },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c1', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    // A Hermit fight opens with the 5-card hand plus the board ability's extra
    // card; one of those 6 must be Loaded before the die rolls. `hand` is all 6.
    a1r0c0: { kind: 'fight', enemies: ['cultist'],
      hand: ['hermit_snapshot', 'hermit_covet', 'hermit_defend', 'hermit_strike', 'hermit_strike', 'hermit_strike'],
      cards: ['hermit_low_profile', 'hermit_itchy_trigger', 'hermit_cursed_weapon'], pick: 'hermit_itchy_trigger' },
    a1r1c1: { kind: 'event', event: 'living_wall', option: 'forget', cards: ['hermit_strike'] },
    a1r2c1: { kind: 'fight', enemies: ['red_slaver'],
      hand: ['hermit_defend', 'hermit_covet', 'hermit_high_caliber', 'hermit_strike', 'hermit_defend', 'hermit_snapshot'],
      cards: ['hermit_quickdraw', 'hermit_body_armor', 'hermit_called_shot'], pick: 'hermit_body_armor' },
    a1r3c1: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'hermit_tracking_shots' }] },
    a1r4c1: { kind: 'fight', enemies: ['large_slime'],
      hand: ['hermit_defend', 'hermit_strike', 'hermit_tracking_shots', 'hermit_strike', 'hermit_body_armor', 'hermit_high_caliber'],
      cards: ['hermit_scorn', 'hermit_determination', 'hermit_deadeye'], pick: 'hermit_deadeye' },
    a1r5c1: { kind: 'campfire' },
    a1r6c1: { kind: 'treasure', relic: 'meat_on_the_bone' },
    a1r7c1: { kind: 'event', event: 'wing_statue', option: 'gather_gold' },
    a1r8c1: { kind: 'treasure', relic: 'teleportation_stone' },
    a1r9c1: { kind: 'fight', enemies: ['blue_slaver'],
      hand: ['hermit_tracking_shots', 'hermit_deadeye', 'hermit_defend', 'hermit_strike', 'hermit_strike', 'hermit_defend'],
      cards: ['hermit_showdown', 'hermit_low_profile', 'hermit_malice'], pick: null },
    a1r10c1: { kind: 'merchant' },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['downfall_dark_core'],
      hand: ['hermit_defend', 'hermit_defend', 'hermit_body_armor', 'hermit_covet', 'hermit_tracking_shots', 'hermit_deadeye'] },
  },
  boss: 'downfall_dark_core',
}

// The Chamber: a Loaded card waits there, out of the hand, until it is played.
const chamber = (run: RunState) => run.combat?.players[0]?.chamber ?? []
const inChamber = (defId: string) => (run: RunState) => chamber(run).some((card) => card.defId === defId)
/** The card is in the Chamber (or the fight is over). */
const loaded = (defId: string) => (run: RunState) => !run.combat || inChamber(defId)(run)
/** The card has left the Chamber, i.e. it was played from there (or the fight is over). */
const fired = (defId: string) => (run: RunState) => !run.combat || !inChamber(defId)(run)
/**
 * Covet's Load choice is a modal window the coach cannot force, so its task
 * finishes once Covet has resolved, whichever card was picked; the tasks that
 * follow skip themselves when the planned card did not reach the Chamber.
 */
const covetPlayed = (run: RunState) => !run.combat || handCount(run, 'hermit_covet') === 0
/** Played down, or no Energy left to do it with (e.g. the die did not roll the 6 the script expects). */
const spent = (defId: string, left = 0) => (run: RunState) =>
  playedDown(defId, left)(run) || (run.combat?.players[0]?.energy ?? 0) === 0
const CHAMBER = spot('.hermit-chamber-trigger')
const PROMPT = spot('.prompt')

const openChamber = (defId: string, why: string): TutorialStep =>
  task('Open the Chamber', `${why} Tap the Chamber button: its cards join your hand, marked as Chamber cards. Tap it again to put them back.`,
    (run) => !inChamber(defId)(run) || shown('.hand .card--chamber-drawn')(), CHAMBER)

const setupLoad = (defId: string, title: string, body: string): TutorialStep =>
  task(title, body, loaded(defId), at.handCard(defId))

export const HERMIT: HeroTutorial = {
  character: 'hermit',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with the Hermit, a Downfall hero, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'The Hermit has 9 HP. Enemy attacks here deal 1 to 4 damage, so Block and killing enemies before they act matter a lot. At 0 HP the run is over.', at.hp),
        say('Deck and relics', 'Your deck holds Covet, Snapshot, 5 Strikes and 4 Defends; open it here any time. Hermit Strikes deal 1 and Defends give 1 Block. Loaded Die gives 1 extra Energy when the die rolls a 6.', at.deck, at.relics),
        say("The Heart's Boon", "Downfall heroes start with the Heart's Boon instead of Neow's Blessing. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.", at.neowCard),
        task('Take the Gold', 'The red reward starts with 3 Gold. Gold buys cards, relics, potions and card removal from merchants. Take it.',
          neowGoldTaken, at.neowButton('Gain 3 Gold')),
        task('Reveal the Card Reward', 'The rest of the red reward is a Card Reward: 3 cards from the Hermit\'s reward deck. Reveal them.',
          neowRedRevealed, at.neowButton('Reveal Card Reward')),
        say('Dive', 'Costs 1: gain 2 Block, or 3 while a Curse sits in your Chamber. A plain Defend for now.', at.offeredCard('hermit_dive')),
        say('Feint', 'Costs 1: draw 2 cards, then Load 1 card from your hand into the Chamber. You will learn Loading in the first fight.', at.offeredCard('hermit_feint')),
        say('High-Caliber', 'Costs 2: deal 1 damage and gain 1 Block. Rapid Fire: the card is played one extra time, so it really deals 2 and gives 2 Block.', at.offeredCard('hermit_high_caliber')),
        task('Take High-Caliber', 'High-Caliber attacks and blocks at once, which a hero with 9 HP needs. Take it.', neowRedTaken, at.offeredCard('hermit_high_caliber')),
        say('The blue options', 'Upgrade a card, Add a random rare card, or Look at 3 Relics and take one but gain a Curse. A random rare may not suit your deck, and a Curse is a dead card.', spot('.neow-options')),
        task('Upgrade a card', 'An upgrade is a sure thing. Choose it.', neowBlueChosen, at.neowOption('Upgrade a card')),
        ...pickerSteps('Upgrade', 'hermit_snapshot', 'Snapshot+ deals 3 damage instead of 2. Its Dead On bonus gives Block equal to the damage dealt, so it grows too. Pick Snapshot.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'The Dark Core waits at the top: 32 HP, and it summons Dark Orbs that explode for 4. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, 2 treasure chests and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-setup',
      when: beforeFirstTurn('a1r0c0'),
      steps: [
        say('Your first fight', 'This Cultist has 9 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('The Chamber', 'The Hermit keeps cards in a Chamber with 2 slots, shown here. Putting a card there is called Loading. A Loaded card waits outside your hand until you play it, even across turns.', CHAMBER),
        say('Start of combat', 'Every fight, after you draw your 5 cards, the Hermit board draws 1 more card, and you must Load one of those 6 into the Chamber.', at.hand),
        setupLoad('hermit_snapshot', 'Load Snapshot', 'Snapshot+ is the best card to Load here: from the Chamber it also gives Block. Tap it to Load it, then turn 1 begins.'),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Enemy intent', 'The icon above an enemy is its intent: what it will do on its turn. The Cultist attacks for 1, then gains 1 Strength. Each Strength adds 1 damage to its hits, so it grows every turn.', at.intent('e0')),
        say('Your hand', 'Your hand holds Covet, a Defend and 3 Strikes, and Snapshot+ waits in the Chamber. You get 3 Energy a turn; a card\'s cost is in its top-left corner.', at.hand, at.energy),
        openChamber('hermit_snapshot', 'Cards in the Chamber are played from there.'),
        say('Dead On', 'A card played from the Chamber triggers its Dead On bonus. You still pay its cost. Snapshot+ deals 3, and Dead On adds Block equal to the damage dealt: 3 Block.', at.handCard('hermit_snapshot')),
        task('Fire Snapshot+', 'Play Snapshot+ from the Chamber: tap it, then tap the Cultist, or drag it there.',
          fired('hermit_snapshot'), at.handCard('hermit_snapshot'), at.enemy('e0')),
        task('Strike', 'Your last Energy: a Strike deals 1. The Cultist drops to 5 HP.', spent('hermit_strike', 2), at.handCard('hermit_strike'), at.enemy('e0')),
        say('Covet', 'Covet costs 0 and Loads a card from your hand. It has Retain: it stays in your hand when the turn ends. Keep it until Snapshot comes back, then Load Snapshot for another Dead On.', at.handCard('hermit_covet')),
        say('Block', 'Your 3 Block stops the Cultist\'s 1 damage. Block lasts until your next turn.', at.hero),
        task('End your turn', 'Enemies act after you. End the turn.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('A 6', 'The die rolled a 6, so Loaded Die gave you 1 extra Energy: 4 this turn. Covet is still in your hand thanks to Retain.', at.die, at.energy),
        say('Strength', 'The Cultist now has 1 Strength, so its attack deals 2.', at.intent('e0')),
        task('Rapid Fire', 'Play High-Caliber on the Cultist. It deals 1 and gives 1 Block, then Rapid Fire plays it again: 2 damage and 2 Block, enough to stop the attack.',
          playedDown('hermit_high_caliber'), at.handCard('hermit_high_caliber'), at.enemy('e0')),
        task('Strike twice', 'Spend your last 2 Energy on both Strikes. The Cultist is left on 1 HP.', spent('hermit_strike'), at.handCard('hermit_strike'), at.enemy('e0')),
        task('End your turn', 'Your 2 Block covers its 2 damage.', turnReached(3), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-3',
      when: inFight('a1r0c0', 3),
      steps: [
        say('Finish it', 'The Cultist has 1 HP left. Any Attack finishes it. Your draw pile ran out, so your discard pile was shuffled back in to draw from.', at.hand),
      ],
    },
    rewardChapter('a1r0c0', {
      gold: 1,
      cards: [
        ['hermit_low_profile', 'Costs 0: gain 1 Block and Load a card, then it Exhausts: it is gone until the fight ends.'],
        ['hermit_itchy_trigger', 'Costs 1: deal 1 damage with Rapid Fire, so 2 damage for 1 Energy, twice what a Strike does.'],
        ['hermit_cursed_weapon', 'Costs 2: deal 2 damage, plus 3 for each Curse in your hand and Chamber. You have no Curses.'],
      ],
      pick: 'hermit_itchy_trigger',
      pickWhy: 'Itchy Trigger is a better Strike. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Living Wall', 'Forget removes a card from your deck, Change transforms one into a random card, and Grow upgrades one.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. Every Strike you remove makes Snapshot, Covet and your new cards come up more often.'),
      task('Choose Forget', 'Remove a Strike, the weakest card in your deck.', shown('.card-picker'), at.eventOption('forget')),
      ...pickerSteps('Remove', 'hermit_strike', 'Pick a Strike.', roomLeft),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Face the Red Slaver', 'The next fight is a Red Slaver.'),
    {
      id: 'fight-a1r2c1-setup',
      when: beforeFirstTurn('a1r2c1'),
      steps: [
        say('Red Slaver', 'The Red Slaver has 10 HP. What it does depends on the die rolled each round.', at.enemy('e0')),
        setupLoad('hermit_defend', 'Load the Defend', 'This time Load a Defend and keep Snapshot+ in hand: it is Covet\'s turn to shine. The Defend waits in the Chamber for a turn you need Block.'),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Daze', 'The Red Slaver will attack for 2 and add a Daze to your draw pile. Daze cannot be played, so it takes a slot in your next hand.', at.intent('e0')),
        say('Snapshot is back', 'Snapshot+ is in your hand, not the Chamber. Played from the hand, it gets no Dead On. Covet fixes that: it Loads Snapshot into your free Chamber slot for 0 Energy.', at.handCard('hermit_snapshot'), CHAMBER),
        task('Covet Snapshot', 'Play Covet. A window opens: pick Snapshot+ there as the card to Load, then confirm.',
          covetPlayed, at.handCard('hermit_covet'), at.handCard('hermit_snapshot'), PROMPT),
        say('A full Chamber', 'Both slots are now full: the Defend and Snapshot+. Loading into a full Chamber would make you discard a card already in it.', CHAMBER),
        openChamber('hermit_snapshot', 'Now fire Snapshot+ from the Chamber.'),
        task('Fire Snapshot+', 'Dead On again: 3 damage and 3 Block, which covers the 2 damage coming.', fired('hermit_snapshot'), at.handCard('hermit_snapshot'), at.enemy('e0')),
        task('Strike', 'A Strike with your last Energy. The Red Slaver drops to 6 HP.', spent('hermit_strike'), at.handCard('hermit_strike'), at.enemy('e0')),
        task('End your turn', 'High-Caliber waits for a turn with Energy to spare. The Defend stays in the Chamber.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        say('The Daze', 'There is the Daze. It leaves at the end of this turn. The Red Slaver attacks for 2 again.', at.hand, at.intent('e0')),
        task('Itchy Trigger', 'Rapid Fire: 1 damage, played twice, for 1 Energy. The Red Slaver drops to 4 HP.', playedDown('hermit_itchy_trigger'), at.handCard('hermit_itchy_trigger'), at.enemy('e0')),
        say('Your turn to lead', 'Finish the fight yourself. You have 2 Energy: Strike to push damage, or the Defends (one is in the Chamber) to block. Tip: with 9 HP, block when you cannot kill.', at.hand),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      cards: [
        ['hermit_quickdraw', 'Costs 1: deal 1 damage, draw a card, then Load a card.'],
        ['hermit_body_armor', 'Costs 1: gain 2 Block. Dead On: it costs 0. Load it and your Block is free.'],
        ['hermit_called_shot', 'A Power: at the start of each turn, one card in your Chamber costs 0 that turn.'],
      ],
      pick: 'hermit_body_armor',
      pickWhy: 'Body Armor is the Block this 9 HP hero needs, and free from the Chamber. Take it.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r3c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit.', at.merchantRemoval),
      task('Buy Tracking Shots', 'Tracking Shots costs 2 of your 7 Gold: deal 3 damage, and when played from your hand you may Load it, so it is ready to fire again next turn.',
        deckHas('hermit_tracking_shots'), at.shopCard('hermit_tracking_shots')),
    ]),
    moveChapter('a1r3c1', 'a1r4c1', 'A Large Slime', 'A Large Slime waits in the next room.'),
    {
      id: 'fight-a1r4c1-setup',
      when: beforeFirstTurn('a1r4c1'),
      steps: [
        setupLoad('hermit_body_armor', 'Load Body Armor', 'The Large Slime has 8 HP. Load Body Armor: from the Chamber it costs 0. Tracking Shots can Load itself into your other slot.'),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('The Large Slime', 'This turn it hits every row for 1. Next turn it attacks for 4 and adds a Daze: kill it before then if you can.', at.intent('e0')),
        openChamber('hermit_body_armor', 'Body Armor is Loaded.'),
        task('Body Armor', 'Dead On: from the Chamber it costs 0. 2 Block, enough for the 1 damage coming. Tap it, then tap your hero if asked.',
          fired('hermit_body_armor'), at.handCard('hermit_body_armor'), at.hero),
        task('Tracking Shots', 'Tap Tracking Shots, choose "Load this card" so it goes to your free Chamber slot after it is played, then tap the Slime for 3 damage.',
          playedDown('hermit_tracking_shots'), at.handCard('hermit_tracking_shots'), at.enemy('e0'), spot('.prompt__mode', 'Load this card')),
        task('Strike', 'Your last Energy: a Strike deals 1.', spent('hermit_strike', 1), at.handCard('hermit_strike'), at.enemy('e0')),
        task('End your turn', 'The Slime is on 4 HP, and Tracking Shots is Loaded for next turn.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        say('Another 6', 'Loaded Die gave you 4 Energy again, more than enough to kill the Slime before its 4-damage attack.', at.die, at.energy),
        openChamber('hermit_tracking_shots', 'Tracking Shots is in the Chamber.'),
        task('Fire Tracking Shots', 'It has no Dead On, but the Chamber kept it ready: 3 damage, leaving the Slime on 1. If asked to Load it again, choose Do Not Load.',
          fired('hermit_tracking_shots'), at.handCard('hermit_tracking_shots'), at.enemy('e0'), spot('.prompt__mode', 'ot Load')),
        task('Strike', 'A Strike deals the last 1 damage. An enemy that dies before its turn never acts.', spent('hermit_strike'), at.handCard('hermit_strike'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r4c1', {
      gold: 1,
      potion: { id: 'liquid_void', why: 'Few of your cards Exhaust, so keep it for later. Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['hermit_scorn', 'A Curse: unplayable, but gain 3 Block when you Load it. Some Hermit cards reward Curses in the Chamber.'],
        ['hermit_determination', 'A Power: once per turn, when you Load a Curse, gain 1 Strength. You have no Curses.'],
        ['hermit_deadeye', 'Costs 2: deal 2 damage. Dead On: gain 1 Strength for the rest of the fight, adding 1 damage to every hit, Rapid Fire hits included.'],
      ],
      pick: 'hermit_deadeye',
      pickWhy: 'Deadeye plus Covet makes every Attack stronger. Take it.',
    }),
    moveChapter('a1r4c1', 'a1r5c1', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r5c1',
      when: atCampfire('a1r5c1'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'Rest if you are below 6 HP: the Hermit cannot take many hits. Otherwise Smith: Deadeye+ deals 4, and Covet+ Loads up to 2 cards. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r5c1', 'a1r6c1', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r6c1', 'meat_on_the_bone', 'A safety net for a hero with 9 HP.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('Wing Statue', 'Pray removes a card but costs 2 HP. Gather Gold gives 2 Gold.', at.event),
      task('Gather Gold', 'With 9 HP, 2 HP is too high a price. Take the Gold.', roomLeft, at.eventOption('gather_gold')),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'One more chest', 'This route passes a second chest.'),
    treasureChapter('a1r8c1', 'teleportation_stone', 'It rides on the shared die, like Loaded Die, so more rolls help you.'),
    moveChapter('a1r8c1', 'a1r9c1', 'The Blue Slaver', 'A Blue Slaver waits in the next fight.'),
    {
      id: 'fight-a1r9c1-setup',
      when: beforeFirstTurn('a1r9c1'),
      steps: [
        setupLoad('hermit_tracking_shots', 'Load Tracking Shots', 'The Blue Slaver has 10 HP. Load Tracking Shots: it fires from the Chamber whenever you have 2 Energy to spare.'),
      ],
    },
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('A 2', 'The die rolled a 2, so Teleportation Stone drew you a sixth card: Covet. The Blue Slaver will attack for 2 and make you Weak: your hits deal 1 less.', at.die, at.intent('e0')),
        task('Covet Deadeye', 'Play Covet. In the window that opens, pick Deadeye to Load it into your last free slot, then confirm.',
          covetPlayed, at.handCard('hermit_covet'), at.handCard('hermit_deadeye'), PROMPT),
        openChamber('hermit_deadeye', 'Deadeye is Loaded.'),
        task('Fire Deadeye', 'Dead On: after its damage you gain 1 Strength for the rest of this fight. Strength adds 1 damage to every hit you deal.',
          fired('hermit_deadeye'), at.handCard('hermit_deadeye'), at.enemy('e0')),
        task('Strike', 'Your Strike now deals 2.', spent('hermit_strike', 1), at.handCard('hermit_strike'), at.enemy('e0')),
        say('Your fight', 'End your turn and win this one yourself. Tracking Shots is still Loaded, and Strength makes your Rapid Fire cards hit harder with each hit.', at.endTurn),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 2,
      cards: [
        ['hermit_showdown', 'A Power: Rapid Fire Attacks deal 1 more damage on each hit.'],
        ['hermit_low_profile', 'The 0-cost Block-and-Load card again.'],
        ['hermit_malice', 'A Curse: when you Load it, deal 2 damage to a row.'],
      ],
      pick: null,
      pickWhy: 'You own only two Rapid Fire cards, so Showdown would often be a dead draw. A card that does not beat the boss only dilutes your deck. Skip these.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'Spend what Gold you have left before the boss.'),
    merchantChapter('a1r10c1', [
      say('Shop on your own', 'Buy what you like. Good buys before the boss: a potion, or a relic you can afford. When you are done, leave the shop and proceed.', at.merchantPotions, at.merchantRelics),
    ], false),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'Rest if you are below 6 HP. Otherwise Smith a card you want against the Dark Core, such as Deadeye, Covet or Body Armor.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Dark Core', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-setup',
      when: beforeFirstTurn('a1r12c0'),
      steps: [
        say('The Dark Core', 'The Act I boss has 32 HP. Bosses count as being in every row and always act last.', at.enemy('boss-0')),
        setupLoad('hermit_deadeye', 'Load Deadeye', 'Load Deadeye: fired from the Chamber, its Dead On gives you Strength for the whole fight.'),
      ],
    },
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('Dark Orbs', 'This turn it hits every row for 2 and summons a Dark Orb with 8 HP. An Orb waits one turn, then attacks for 4 and is destroyed. Kill it or have Block ready.', at.intent('boss-0')),
        say('The plan', 'Fire Deadeye from the Chamber for Strength all fight. Then Covet Loads Body Armor, which blocks the 2 for free from the Chamber. Next turn the Dark Core hits every row for 4, so keep Block coming.', at.hand, CHAMBER),
        say('Potions', `Use potions when they help. ${potionText('liquid_void')}`, spot('.combat__actions')),
      ],
    },
    {
      id: 'reward-a1r12c0',
      when: inReward('a1r12c0'),
      steps: [
        say('The Dark Core falls', 'Bosses drop Gold, a Rare Card Reward and a choice of Boss Relics. Take what you like: the tutorial ends after these rewards.'),
      ],
    },
  ],
}
