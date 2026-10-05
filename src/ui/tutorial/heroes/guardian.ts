import {
  eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowGoldTaken, neowRedRevealed, neowRedTaken,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { RunState } from '../../../game/run.ts'
import type { HeroTutorial, TutorialPlan, TutorialStep } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-guardian-197',
  neow: {
    card: 'heart_boon_09',
    red: ['guardian_fortify', 'guardian_speed_boost', 'guardian_orb_slam'],
    pick: 'guardian_speed_boost',
    option: 0,
    effectCards: ['guardian_twin_slam'],
  },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c1', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['jaw_worm_first'],
      hand: ['guardian_twin_slam', 'guardian_strike', 'guardian_curl_up', 'guardian_speed_boost', 'guardian_defend'],
      cards: ['guardian_poly_beam', 'guardian_repulsor', 'guardian_orb_support'], pick: 'guardian_poly_beam' },
    a1r1c1: { kind: 'event', event: 'big_fish', option: 'restraint', cards: ['guardian_strike'] },
    a1r2c1: { kind: 'fight', enemies: ['sneaky_gremlin', 'downfall_mad_gremlin', 'downfall_sneaky_gremlin'],
      hand: ['guardian_defend', 'guardian_twin_slam', 'guardian_poly_beam', 'guardian_defend', 'guardian_strike'],
      cards: ['guardian_hack', 'guardian_priming_shot', 'guardian_spheric_shield'], pick: 'guardian_priming_shot' },
    a1r3c1: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'guardian_charge_core' }] },
    a1r4c1: { kind: 'fight', enemies: ['mad_gremlin', 'downfall_fat_gremlin', 'downfall_sneaky_gremlin'],
      hand: ['guardian_strike', 'guardian_defend', 'guardian_defend', 'guardian_twin_slam', 'guardian_defend'],
      cards: ['guardian_overload', 'guardian_poly_beam', 'guardian_walker_claw'], pick: 'guardian_poly_beam' },
    a1r5c1: { kind: 'treasure', relic: 'blood_vial' },
    a1r6c1: { kind: 'treasure', relic: 'downfall_nilrys_codex' },
    a1r7c1: { kind: 'event', event: 'the_library', option: 'sleep' },
    a1r8c1: { kind: 'campfire' },
    a1r9c1: { kind: 'fight', enemies: ['fungi_beast', 'downfall_fungi_beast'],
      hand: ['guardian_priming_shot', 'guardian_defend', 'guardian_defend', 'guardian_twin_slam', 'guardian_strike'],
      cards: ['guardian_stasis_beam', 'guardian_strike_for_strike', 'guardian_sentry_beam'], pick: 'guardian_sentry_beam' },
    a1r10c1: { kind: 'merchant', buy: [{ section: 'relic', slot: 2, id: 'black_powder' }] },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['downfall_dark_core'],
      hand: ['guardian_poly_beam', 'guardian_twin_slam', 'guardian_priming_shot', 'guardian_defend', 'guardian_defend'] },
  },
  boss: 'downfall_dark_core',
}

// The Guardian picks a Mode at the start of every turn (combat phase 'start'),
// before cards can be played, so those moments get chapters of their own.
const turnStart = (roomId: string, turn: number) => (run: RunState) =>
  run.phase === 'combat' && run.map.position === roomId && run.combat?.phase === 'start' && run.combat.turn === turn
const startTurnOver = (run: RunState) => run.phase !== 'combat' || run.combat?.phase !== 'start'
/**
 * When relics also act at the start of the turn (Blood Vial, Loaded Die on a 6,
 * Black Powder on a 2), choosing the Mode does not end the start of the turn:
 * the game lists every start-of-turn effect and waits for "Resolve start of turn".
 */
const startOrderShown = () => Boolean(document.querySelector('.start-turn-order')) && !document.querySelector('.guardian-mode-choice')
const modeChosen = (run: RunState) => startTurnOver(run) || startOrderShown()
const vigorSpent = (run: RunState) => !run.combat || (run.combat.players[0]?.vigorSpentThisTurn ?? 0) >= 1
const hasRelic = (id: string) => (run: RunState) => run.players[0]!.relics.some((relic) => relic.defId === id)

const modeButton = (mode: 'Attack' | 'Defense') => spot(`.guardian-mode-choice__option[aria-label="Choose ${mode} Mode"]`)
const vigorButton = spot('[aria-label^="Spend 1 Vigor"]')
/** Speed Boost asks whether to Mode Shift once it is played. */
const keepMode = spot('.prompt__mode', 'Keep Mode')

/**
 * The Mode choice, then the "Resolve start of turn" button if relics also act
 * this turn. Without such relics the turn begins as soon as the Mode is chosen,
 * which ends the chapter before the second step shows.
 */
const chooseMode = (mode: 'Attack' | 'Defense', title: string, body: string): TutorialStep[] => [
  task(title, body, modeChosen, modeButton(mode)),
  task('Resolve the start of turn', 'Relics that act at the start of a turn are listed here with your Mode, in the order they resolve. The order does not matter this time. Resolve the start of turn.',
    startTurnOver, spot('.combat__end-turn', 'Resolve')),
]
const endTurn = (body: string, next: number): TutorialStep => task('End your turn', body, turnReached(next), at.endTurn)

export const GUARDIAN: HeroTutorial = {
  character: 'guardian',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with the Guardian, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'The Guardian has 9 HP. Attacks here deal 1 to 4 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relics', 'Your deck holds 4 Strikes, 4 Defends, Twin Slam and Curl Up; open it here any time. The Guardian\'s own relic puts you in Attack Mode at the start of every fight, and Loaded Die gives 1 Block on a 4 or 5; on a 6, it can give that Block or trigger another die relic ability. Hover over or long-press a relic to read it.', at.deck, at.relics),
        say("The Heart's Boon", "Downfall heroes are the Spire's villains, so the Heart offers its Boon instead of Neow's Blessing. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.", at.neowCard),
        task('Take the Gold', 'The red reward starts with 3 Gold. Gold buys cards, relics, potions and card removal from merchants. Take it.',
          neowGoldTaken, at.neowButton('Gain 3 Gold')),
        task('Reveal the Card Reward', 'The rest of the red reward is a Card Reward: 3 cards from the Guardian\'s reward deck. Reveal them.',
          neowRedRevealed, at.neowButton('Reveal Card Reward')),
        say('Fortify', 'Costs 1: gain 2 Block, and in Attack Mode also draw 2 cards.', at.offeredCard('guardian_fortify')),
        say('Speed Boost', 'Costs 0: deal 1 damage, then you may Mode Shift. It has Retain: it stays in your hand when your turn ends instead of being discarded.', at.offeredCard('guardian_speed_boost')),
        say('Orb Slam', 'Costs 1: deal 2 damage, and in Defense Mode also gain 1 Block.', at.offeredCard('guardian_orb_slam')),
        task('Take Speed Boost', 'A free attack that waits in your hand until you need it, and can switch your Mode in the middle of a turn. Take it.',
          neowRedTaken, at.offeredCard('guardian_speed_boost')),
        say('The blue options', 'Upgrade a card, Gain a Relic but lose 1 max HP, or Gain 11 Gold but lose 2 max HP. With only 9 HP, max HP is precious.', spot('.neow-options')),
        task('Upgrade a card', 'An upgrade costs nothing. Choose it.', neowBlueChosen, at.neowOption('Upgrade a card')),
        ...pickerSteps('Upgrade', 'guardian_twin_slam', 'Twin Slam deals 2, then more in Attack Mode. Upgraded, that bonus grows from 1 to 3: 5 damage for 2 Energy. Upgrades show on the card in green. Pick Twin Slam.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'The Dark Core waits at the top: 32 HP, and it summons Dark Orbs that explode. Downfall runs meet their own bosses. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, 2 treasure chests and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'start-a1r0c0-turn-1',
      when: turnStart('a1r0c0', 1),
      steps: [
        say('Your first fight', 'This Jaw Worm has 7 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('Enemy intent', 'The icon above an enemy is its intent: what it will do on its turn. The die shows a 5, so the Jaw Worm will attack for 3. Many enemies pick their move from the die rolled each round.', at.intent('e0'), at.die),
        say('The die', 'One die is rolled each round for the whole table. Loaded Die gives 1 Block on a 4 or 5. On a 6, it gives 1 Block or triggers another die relic ability.', at.die),
        say('Your hand', 'You drew Twin Slam, Curl Up, Speed Boost, a Strike and a Defend. You get 3 Energy every turn. A card\'s cost is in its top-left corner: Twin Slam and Curl Up cost 2, Speed Boost 0.', at.hand),
        say('Attack and Defense Mode', 'The Guardian is always in one of two Modes, and every fight starts in Attack Mode. A card line that begins "Attack Mode:" or "Defense Mode:" only happens in that Mode.', at.hero),
        say('Choose a Mode', 'At the start of each turn you choose the Mode for that turn. Twin Slam deals 2, plus 3 more in Attack Mode. Curl Up gives 2 Block, plus 1 Vigor in Defense Mode.', spot('.guardian-mode-choice')),
        ...chooseMode('Defense', 'Enter Defense Mode', 'The Jaw Worm will hit for 3. In Defense Mode, Curl Up and Defend block all of it and bank a Vigor for next turn. Choose Defense Mode.'),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        task('Play Curl Up', 'Curl Up costs 2: gain 2 Block, and 1 Vigor because you are in Defense Mode. It needs no target: tap it, or drag it up.',
          playedDown('guardian_curl_up'), at.handCard('guardian_curl_up'), at.hero),
        say('Block and Vigor', 'Each point of Block stops 1 damage until your next turn. Vigor waits on your hero, across turns, until you spend it. You can hold at most 4.', at.hero),
        task('Defend', 'Defend costs 1: 1 more Block. With Loaded Die\'s 1 and Curl Up\'s 2, that makes 4, enough for the Jaw Worm\'s attack.', playedDown('guardian_defend'), at.handCard('guardian_defend'), at.hero),
        say('Retain', 'You are out of Energy. Twin Slam and the Strike are discarded when the turn ends, but Speed Boost has Retain, so it stays in your hand for next turn.', at.handCard('guardian_speed_boost')),
        endTurn('Enemies act after you. End the turn and watch your Block soak up the Jaw Worm\'s attack.', 2),
      ],
    },
    {
      id: 'start-a1r0c0-turn-2',
      when: turnStart('a1r0c0', 2),
      steps: [
        say('Not a scratch', 'Your Block stopped all 3 damage, and it is gone now that your turn has come round again. Your Vigor is still banked on your hero.', at.hero),
        say('Your new hand', 'You drew 3 Strikes and 2 Defends, and Speed Boost is still here. The Jaw Worm has all 7 HP. Time to attack.', at.hand),
        ...chooseMode('Attack', 'Back to Attack Mode', 'You stay in a Mode until you shift. Choose Attack Mode: in it, Vigor adds to every hit.'),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('Spending Vigor', 'Spend Vigor from this button before your cards. For the rest of the turn, every hit deals 1 more in Attack Mode, or every Block icon gives 1 more in Defense Mode.', vigorButton),
        task('Spend your Vigor', 'Tap the Vigor button to spend your 1 Vigor.', vigorSpent, vigorButton),
        task('Speed Boost', 'Free: 1 damage, plus 1 from Vigor. When asked, choose Keep Mode, since you want to stay in Attack Mode.',
          playedDown('guardian_speed_boost'), at.handCard('guardian_speed_boost'), at.enemy('e0'), keepMode),
        task('Three Strikes', 'Each Strike deals 1, plus 1 from Vigor. Three of them finish the Jaw Worm: 2 + 2 + 2 + 2 is 8 damage against its 7 HP.',
          playedDown('guardian_strike'), at.handCard('guardian_strike'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'The fight is won without losing a single HP: Defense Mode to block, then Attack Mode to hit. Now collect the rewards.', at.hp)],
      gold: 1,
      potion: { id: 'liquid_memories', why: 'Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['guardian_poly_beam', 'Costs 1: deal 2 damage, and in Attack Mode gain 1 Energy back, so it is free.'],
        ['guardian_repulsor', 'A Power that costs 1 and stays in play: 1 extra Energy at the start of every turn. Playing it puts a Dazed, a dead card, on your draw pile.'],
        ['guardian_orb_support', 'Costs 2: in Attack Mode deal 3 and gain 1 Block; in Defense Mode deal 1 and gain 3 Block.'],
      ],
      pick: 'guardian_poly_beam',
      pickWhy: 'Poly Beam is free damage in Attack Mode, where the Guardian does its attacking. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Big Fish', 'Banana heals 2 HP, Donut upgrades a starter Strike, Box gives a Relic and a Curse, and Restraint removes a starter Strike.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. Every weak Strike you remove makes Twin Slam, Speed Boost and Poly Beam come up more often. You are at full HP, so the Banana would be wasted.'),
      task('Choose Restraint', 'Remove a Strike, the weakest card in your deck.', shown('.card-picker'), at.eventOption('restraint')),
      ...pickerSteps('Remove', 'guardian_strike', 'Pick a Strike.', roomLeft),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Gremlins ahead', 'A gang of three Gremlins waits in the next room.'),
    {
      id: 'start-a1r2c1-turn-1',
      when: turnStart('a1r2c1', 1),
      steps: [
        say('The gremlin gang', 'Two Sneaky Gremlins (2 HP) hit for 2 each. The Mad Gremlin (5 HP) hits for 1, but it is Angry: each hit that damages it without killing it gives it 1 Strength, so it hits 1 harder.', at.enemies),
        say('An attacking hand', 'Poly Beam, Twin Slam and a Strike all want Attack Mode: Poly Beam gives its Energy back, and Twin Slam deals 5.', at.hand),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'Every fight starts in Attack Mode. Keep it.'),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        task('Poly Beam a Sneaky Gremlin', 'Poly Beam deals 2, killing this Sneaky Gremlin, and Attack Mode gives the Energy back: you still have 3.',
          playedDown('guardian_poly_beam'), at.handCard('guardian_poly_beam'), at.enemy('e0')),
        task('Twin Slam the Mad Gremlin', 'Twin Slam hits for 2, then 3: exactly its 5 HP. One card kills it before Angry can make it stronger.',
          playedDown('guardian_twin_slam'), at.handCard('guardian_twin_slam'), at.enemy('e0-summon')),
        task('Defend', 'Your last Energy buys 1 Block. With Loaded Die\'s 1 Block, that stops the other Sneaky Gremlin\'s 2 damage.',
          playedDown('guardian_defend', 1), at.handCard('guardian_defend'), at.hero),
        endTurn('Loaded Die and Defend block all 2 damage from the last Sneaky Gremlin.', 2),
      ],
    },
    {
      id: 'start-a1r2c1-turn-2',
      when: turnStart('a1r2c1', 2),
      steps: [
        say('Your new hand', 'You drew Curl Up, Speed Boost, a Strike and 2 Defends. The last Sneaky Gremlin has 2 HP. Your HP stays low between fights unless you heal, so finish it before it hits again.', at.hand),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'Nothing this turn needs Defense Mode. Keep Attack Mode.'),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        task('Speed Boost', 'Free: 1 damage to the Sneaky Gremlin. Choose Keep Mode when asked.',
          playedDown('guardian_speed_boost'), at.handCard('guardian_speed_boost'), at.enemy('e0-summon-1'), keepMode),
        task('Strike', 'A Strike deals the last 1.', playedDown('guardian_strike'), at.handCard('guardian_strike'), at.enemy('e0-summon-1')),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      potion: { id: 'energy_potion', why: 'Save it for a big turn, such as your first turn against the boss.' },
      cards: [
        ['guardian_hack', 'Costs 1: draw 2 cards, then you may Mode Shift.'],
        ['guardian_priming_shot', 'Costs 1: deal 2. In Attack Mode, gain 1 Vigor and spend it at once, so every later hit this turn deals 1 more.'],
        ['guardian_spheric_shield', 'Costs 1: gain 1 Block, and in Defense Mode give 1 more Block to any player.'],
      ],
      pick: 'guardian_priming_shot',
      pickWhy: 'Priming Shot makes every attack after it stronger. Play it first in a turn. Take it.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r3c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit. It is often the best buy in the shop.', at.merchantRemoval),
      task('Buy Charge Core', 'Charge Core costs 2 of your 7 Gold. For 1 Energy it gives 1 Vigor, then it Exhausts: it is gone until the fight ends. More Vigor for your attacks.',
        deckHas('guardian_charge_core'), at.shopCard('guardian_charge_core')),
    ]),
    moveChapter('a1r3c1', 'a1r4c1', 'More gremlins', 'Another gang of Gremlins waits in the next room.'),
    {
      id: 'start-a1r4c1-turn-1',
      when: turnStart('a1r4c1', 1),
      steps: [
        say('Three more', 'A Mad Gremlin (4 HP, Angry) and a Fat Gremlin (3 HP) hit for 1 each. The Sneaky Gremlin (2 HP) hits for 2.', at.enemies),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'Twin Slam is the best card in this hand, and its bonus needs Attack Mode. Keep it.'),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        task('Twin Slam the Mad Gremlin', 'It hits for 2, then 3. The Mad Gremlin\'s 4 HP cannot survive both, so Angry never matters.',
          playedDown('guardian_twin_slam'), at.handCard('guardian_twin_slam'), at.enemy('e0')),
        task('Defend', 'Your last Energy: 1 Block. The Fat and Sneaky Gremlins will hit you for 3 in all, and 1 of it is blocked.',
          playedDown('guardian_defend', 2), at.handCard('guardian_defend'), at.hero),
        endTurn('Take the hits. Next turn the two survivors go down together.', 2),
      ],
    },
    {
      id: 'start-a1r4c1-turn-2',
      when: turnStart('a1r4c1', 2),
      steps: [
        say('Your new hand', 'You drew Charge Core, Poly Beam, Speed Boost, a Strike and a Defend. The Fat Gremlin has 3 HP and the Sneaky Gremlin 2.', at.hand),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'This turn Vigor turns two cheap attacks into two kills, and Vigor only adds damage in Attack Mode. Keep it.'),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        task('Play Charge Core', 'Costs 1: gain 1 Vigor. Then it Exhausts.', playedDown('guardian_charge_core'), at.handCard('guardian_charge_core'), at.hero),
        task('Spend the Vigor', 'Tap the Vigor button: every hit this turn deals 1 more.', vigorSpent, vigorButton),
        task('Poly Beam the Fat Gremlin', '2 damage plus 1 from Vigor kills it, and Attack Mode gives the Energy back.',
          playedDown('guardian_poly_beam'), at.handCard('guardian_poly_beam'), at.enemy('e0-summon')),
        task('Speed Boost the Sneaky Gremlin', '1 damage plus 1 from Vigor ends the fight. Choose Keep Mode when asked.',
          playedDown('guardian_speed_boost'), at.handCard('guardian_speed_boost'), at.enemy('e0-summon-1'), keepMode),
      ],
    },
    rewardChapter('a1r4c1', {
      gold: 2,
      cards: [
        ['guardian_overload', 'Costs 1: draw 4 cards, but it puts a Dazed on your draw pile.'],
        ['guardian_poly_beam', 'A second Poly Beam: more free damage in Attack Mode.'],
        ['guardian_walker_claw', 'Costs 2: hit for 1 twice. It is a Gem card: its Socket holds a Gem, and the Gem\'s effect happens every time you play it.'],
      ],
      pick: 'guardian_poly_beam',
      pickWhy: 'Taking a Gem card lets you choose 1 of 2 Gems from the Gem deck, such as Ruby (1 damage) or Sapphire (1 Block). Walker Claw is a costly start, though. Poly Beam is surer: take it.',
    }),
    moveChapter('a1r4c1', 'a1r5c1', 'Open a chest', 'Every route crosses the row of treasure chests, and this route passes two.'),
    treasureChapter('a1r5c1', 'blood_vial', 'Small, but it heals you in every fight from now on.'),
    moveChapter('a1r5c1', 'a1r6c1', 'The second chest', 'The next room is another chest.'),
    treasureChapter('a1r6c1', 'downfall_nilrys_codex', 'A die relic: it only helps when the die shows its numbers.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('The Library', 'Read gives a Card Reward where you look at 5 cards instead of 3. Sleep heals 3 HP.', at.event),
      task('Sleep', 'Your deck is in good shape, and the gremlins took HP you want back before the boss. Sleep.', roomLeft, at.eventOption('sleep')),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r8c1',
      when: atCampfire('a1r8c1'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'If you are at full HP, Smith. Upgraded Priming Shot or Poly Beam deals 3 instead of 2, and upgraded Curl Up gives 3 Block to any player. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r8c1', 'a1r9c1', 'Fungi Beasts', 'Two Fungi Beasts wait in the next fight.'),
    {
      id: 'start-a1r9c1-turn-1',
      when: turnStart('a1r9c1', 1),
      steps: [
        say('Spore Cloud', 'Fungi Beasts have Spore Cloud: when one dies, you become Vulnerable, and the next hit on you is doubled. Kill them when no big hit is coming.', at.enemies),
        say('Their moves', 'On this 6, the big Fungi Beast (6 HP) gains 2 Strength, and the small one (5 HP) hits for 1 and gains 1. Strength adds 1 damage to each of its hits.', at.intent('e0'), at.intent('e0-summon')),
        say('Loaded Die', 'The die shows a 6, so Loaded Die can give you 1 Block or trigger another die relic ability. Keep the Block here to soften the small Fungi Beast\'s hit; leave its panel alone.', spot('.relic-actions details'), at.die),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'Priming Shot only gives its Vigor in Attack Mode. Keep it.'),
      ],
    },
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        task('Priming Shot first', 'It deals 2 to the big Fungi Beast and spends a Vigor at once: every later hit this turn deals 1 more.',
          playedDown('guardian_priming_shot'), at.handCard('guardian_priming_shot'), at.enemy('e0')),
        task('Twin Slam it', '3, then 4 with Vigor: the big Fungi Beast dies before its Strength ever matters. Its Spore Cloud makes you Vulnerable.',
          playedDown('guardian_twin_slam'), at.handCard('guardian_twin_slam'), at.enemy('e0')),
        task('End your turn', 'You spent your 3 Energy. Loaded Die\'s 1 Block softens the small Fungi Beast\'s doubled hit. End your turn.',
          turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'start-a1r9c1-turn-2',
      when: turnStart('a1r9c1', 2),
      steps: [
        say('Your new hand', 'You drew Charge Core, Poly Beam, a Strike and 2 Defends. Play Charge Core and spend its Vigor: Poly Beam then deals 3 and the Strike 2, enough to kill the small Fungi Beast before it acts.', at.hand),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'Choose Attack Mode and finish the fight your way.'),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 1,
      potion: { id: 'flex_potion', why: 'Drink it before a turn of many hits: each one deals 1 more.' },
      cards: [
        ['guardian_stasis_beam', 'Costs 1: deal 2, plus 1 for each Power you have in play. You have no Powers.'],
        ['guardian_strike_for_strike', 'Costs 1: deal 1. In Attack Mode, gain Block equal to the damage dealt.'],
        ['guardian_sentry_beam', 'Costs 2: deal 3 to every enemy in a row, and to any boss. In Attack Mode, also gain 1 Vigor, but a Dazed goes on your draw pile.'],
      ],
      pick: 'guardian_sentry_beam',
      pickWhy: 'The Dark Core fights with a Dark Orb beside it, and Sentry Beam hits both at once. Take it.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'Spend your Gold before the boss.'),
    merchantChapter('a1r10c1', [
      say('A relic this time', 'You have 8 Gold, and your potion belt is full. This time the coach recommends a relic.', at.merchantRelics),
      task('Buy Black Powder', 'Black Powder costs all 8 Gold: on a 2, your next Attack that turn costs 0. The first die against the Dark Core is a 2, so it pays off at once.',
        hasRelic('black_powder'), spot('.merchant-shelf--relics .merchant-item', 'Black Powder')),
    ]),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'Rest if two or three hits could kill you. Otherwise Smith Priming Shot or Poly Beam: you play both on your first turn against the Dark Core.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Dark Core', 'The boss is waiting. Good luck.'),
    {
      id: 'start-a1r12c0-turn-1',
      when: turnStart('a1r12c0', 1),
      steps: [
        say('The Dark Core', 'The Act I boss has 32 HP. Bosses count as being in every row and always act last. Its moves come in a fixed order.', at.enemy('boss-0')),
        say('Its first move', 'This turn it hits you for 2 and summons a Dark Orb with 8 HP. Next turn it hits for 4. The Orb waits one turn, then explodes for 4 and dies.', at.intent('boss-0')),
        say('Black Powder', 'The die shows a 2, so your next Attack this turn costs 0.', at.die, at.relics),
        ...chooseMode('Attack', 'Stay in Attack Mode', 'This hand is all offense. Keep Attack Mode.'),
      ],
    },
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        task('Priming Shot', 'Free thanks to Black Powder: 2 damage, and a Vigor spent at once, so each later hit this turn deals 1 more.',
          playedDown('guardian_priming_shot'), at.handCard('guardian_priming_shot'), at.enemy('boss-0')),
        task('Poly Beam', '2 plus 1 from Vigor: 3 damage, and the Energy comes back.', playedDown('guardian_poly_beam'), at.handCard('guardian_poly_beam'), at.enemy('boss-0')),
        task('Twin Slam', '3, then 4: 7 more. That is at least 12 damage this turn, more if you upgraded these cards.',
          playedDown('guardian_twin_slam'), at.handCard('guardian_twin_slam'), at.enemy('boss-0')),
        task('Defend', 'Your last Energy: 1 Block against its 2 damage.', playedDown('guardian_defend', 1), at.handCard('guardian_defend'), at.hero),
        endTurn('The Dark Core hits you and summons its Orb.', 2),
      ],
    },
    {
      id: 'start-a1r12c0-turn-2',
      when: turnStart('a1r12c0', 2),
      steps: [
        say('The Dark Orb', 'The Orb does nothing this round, then explodes for 4 on the next enemy turn unless you kill it first. This turn the Dark Core hits for 4.', at.enemies),
        say('Your plan', 'You drew Sentry Beam, 2 Strikes and 2 Defends. Sentry Beam hits the Dark Core and the Orb together. Defense Mode is the time to Block; Attack Mode is the time to hit. The Mode is your call from here.', at.hand),
        say('Potions', `Now is the time for potions. ${potionText('energy_potion')} ${potionText('flex_potion')}`, at.combatActions),
      ],
    },
    {
      id: 'reward-a1r12c0',
      when: inReward('a1r12c0'),
      steps: [
        say('The Dark Core falls', 'Bosses drop Gold and a Rare Card Reward. Take what you like: the tutorial ends after these rewards.'),
      ],
    },
  ],
}
