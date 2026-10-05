import type { RunState } from '../../../game/run.ts'
import {
  eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowRedTaken, NEOW_GOLD, NEOW_REVEAL,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, handCount, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-watcher-14',
  neow: { card: 'neow_08', red: ['consecrate', 'cut_through_fate', 'wish'], pick: 'cut_through_fate', option: 0, effectCards: ['eruption'] },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c2', 'a1r4c2', 'a1r5c1', 'a1r6c0', 'a1r7c0', 'a1r8c0', 'a1r9c0', 'a1r10c0', 'a1r11c0', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['jaw_worm_first'], hand: ['vigilance', 'strike_watcher', 'strike_watcher', 'eruption', 'strike_watcher'],
      cards: ['signature_move', 'consecrate', 'crush_joints'], pick: 'crush_joints' },
    a1r1c1: { kind: 'event', event: 'the_library', option: 'read', pick: null },
    a1r2c1: { kind: 'fight', enemies: ['blue_slaver'], hand: ['strike_watcher', 'crush_joints', 'defend_watcher', 'strike_watcher', 'eruption'],
      cards: ['halt', 'empty_body', 'empty_mind'], pick: 'empty_body' },
    a1r3c2: { kind: 'event', event: 'ominous_forge', option: 'forge', cards: ['vigilance'] },
    a1r4c2: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'flying_sleeves' }] },
    a1r5c1: { kind: 'fight', enemies: ['large_slime'], hand: ['cut_through_fate', 'strike_watcher', 'vigilance', 'strike_watcher', 'strike_watcher'],
      cards: ['talk_to_the_hand', 'halt', 'protect'], pick: null },
    a1r6c0: { kind: 'treasure', relic: 'necronomicon' },
    a1r7c0: { kind: 'fight', enemies: ['jaw_worm'], hand: ['defend_watcher', 'strike_watcher', 'defend_watcher', 'defend_watcher', 'flying_sleeves'],
      cards: ['protect', 'fear_no_evil', 'inner_peace'], pick: null },
    a1r8c0: { kind: 'campfire' },
    a1r9c0: { kind: 'fight', enemies: ['mad_gremlin', 'sneaky_gremlin', 'mad_gremlin'],
      hand: ['defend_watcher', 'eruption', 'crush_joints', 'strike_watcher', 'defend_watcher'],
      cards: ['battle_hymn', 'reach_heaven', 'collect'], pick: null },
    a1r10c0: { kind: 'event', event: 'the_cleric', option: 'heal' },
    a1r11c0: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['hexaghost'], hand: ['defend_watcher', 'strike_watcher', 'empty_body', 'vigilance', 'eruption'] },
  },
  boss: 'hexaghost',
}

// Watcher-only screen spots and checks.
const miracleButton = spot('[aria-label^="Use Miracle"]')
const miracleToken = spot('.seat--viewer .token--miracles')
const miraclesLeft = (left: number) => (run: RunState) => !run.combat || (run.combat.players[0]?.miracles ?? 0) <= left
/** Eruption has left the hand and a Necronomicon copy (if any) has resolved. */
const eruptionResolved = (run: RunState) => !run.combat || (handCount(run, 'eruption') === 0 && run.combat.phase !== 'copy')

export const WATCHER: HeroTutorial = {
  character: 'watcher',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with the Watcher, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'The Watcher has 9 HP. Attacks here deal 1 to 4 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relics', 'Your deck holds 4 Strikes, 4 Defends, Eruption and Vigilance. Your relic, Pure Water, gives you 1 Miracle at the start of every fight. Loaded Die is the solo relic. Hover over or long-press a relic to read it.', at.deck, at.relics),
        say('Stances', 'The Watcher fights in Stances. She starts every fight in Neutral. Eruption enters Wrath, Vigilance enters Calm. The whole tutorial is about switching between them at the right time.'),
        say("Neow's Blessing", 'Every run starts with Neow. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.', at.neowCard),
        NEOW_GOLD,
        NEOW_REVEAL,
        say('Consecrate', 'Costs 0: deal 1 damage to every enemy in a row. Good against packs, weak against one big enemy.', at.offeredCard('consecrate')),
        say('Cut Through Fate', 'Costs 1: deal 1 damage, Scry 2, then draw a card. Scry shows the top cards of your draw pile and lets you discard any of them, so you can dig for the card you need.', at.offeredCard('cut_through_fate')),
        say('Wish', 'Costs 3, then it Exhausts: choose 1 Strength, 10 Block or 4 Miracles. Powerful, but it eats a whole turn of Energy.', at.offeredCard('wish')),
        task('Take Cut Through Fate', 'It attacks, replaces itself, and Scry helps you find Eruption and Vigilance. Take it.', neowRedTaken, at.offeredCard('cut_through_fate')),
        say('The blue options', 'Upgrade 1 card, Gain 3 Potions, or Upgrade 2 random cards and lose 2 HP. Random upgrades may miss the cards you care about, and 2 HP is a lot out of 9.', spot('.neow-options')),
        task('Upgrade 1 card', 'You choose which card gets better. Choose it.', neowBlueChosen, at.neowOption('Upgrade 1 card')),
        ...pickerSteps('Upgrade', 'eruption', 'Upgraded Eruption costs 1 Energy instead of 2 and still deals 2 damage and enters Wrath. Upgrades show on the card in green. Pick Eruption.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'Hexaghost waits at the top: 36 HP, and it fills your deck with Burns. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 5 fights, 3 events, a merchant, a treasure chest and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Your first fight', 'This Jaw Worm has 7 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('Enemy intent', 'The icon above an enemy is its intent: what it will do on its turn. The Jaw Worm will attack for 2 and gain 1 Block. Many enemies pick their move from the die rolled at the start of each round.', at.intent('e0'), at.die),
        say('The die', 'One die is rolled each round for the whole table. Loaded Die gives 1 Block on a 4 or 5. On a 6, it gives 1 Block or triggers another die relic ability.', at.die),
        say('Your hand', 'You drew Vigilance, Eruption and 3 Strikes. Cards you do not play are discarded when your turn ends.', at.hand),
        say('Energy', 'You get 3 Energy every turn, and unspent Energy is lost. Vigilance costs 2, your upgraded Eruption 1, and Strike 1. That looks like 2 cards, but Stances will buy you more.', at.energy),
        task('Play Vigilance', 'Vigilance gives 2 Block and enters Calm. Tap Vigilance, then tap your hero if it asks who gets the Block.', playedDown('vigilance'), at.handCard('vigilance'), at.hero),
        say('Calm', 'You are in Calm now, shown around the Watcher. Calm does nothing while you stay in it, but the moment you leave it you gain 2 Energy. You have 1 Energy left.', at.hero, at.energy),
        task('Play Eruption', 'Eruption deals 2 damage and enters Wrath. Leaving Calm pays you 2 Energy, so Eruption is better than free. Tap Eruption, then the Jaw Worm.', playedDown('eruption'), at.handCard('eruption'), at.enemy('e0')),
        say('Wrath', 'In Wrath every hit you deal does 1 more damage. The price: if you end your turn in Wrath, you take 1 damage (Block can stop it). You have 2 Energy again.', at.hero, at.energy),
        task('Strike', 'A Strike deals 1, plus 1 for Wrath. The Jaw Worm drops to 3 HP.', playedDown('strike_watcher', 2), at.handCard('strike_watcher'), at.enemy('e0')),
        task('Strike again', 'Another 2 damage leaves it on 1 HP.', playedDown('strike_watcher', 1), at.handCard('strike_watcher'), at.enemy('e0')),
        say('Miracles', 'Out of Energy, one Strike short. Pure Water gave you 1 Miracle, shown beside your HP. You can hold up to 5 and spend one at any time for 1 Energy.', miracleToken, at.hero),
        task('Use a Miracle', 'Press the Miracle button to turn it into 1 Energy.', miraclesLeft(0), miracleButton),
        task('Finish it', 'The last Strike wins the fight before the Jaw Worm ever acts.', playedDown('strike_watcher', 0), at.handCard('strike_watcher'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'Calm, then Wrath, then a Miracle: 5 cards from a 3-Energy turn. That is the Watcher. Now collect the rewards.')],
      gold: 1,
      potion: { id: 'vulnerable_potion', why: 'Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['signature_move', 'Costs 2: deal 6 damage, but only when it is the only Attack in your hand. Hard to set up in a deck full of Strikes.'],
        ['consecrate', 'The row attack you saw at Neow: 0 cost, 1 damage to every enemy in a row.'],
        ['crush_joints', 'Costs 1: deal 1 damage. If you are in Wrath, it also applies Vulnerable, so the next hit on that enemy is doubled.'],
      ],
      pick: 'crush_joints',
      pickWhy: 'Crush Joints turns every Wrath turn into a bigger one. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('The Library', 'Read shows a Card Reward of 5 cards instead of 3. Sleep heals 3 HP, but you are at full HP.', at.event),
      task('Choose Read', 'Reading costs nothing. Look at the 5 cards.', shown('.reward-screen--card-choice'), at.eventOption('read')),
      say('Five cards', 'Simmering Fury adds Wrath damage, Swivel gives Block and a free Attack, Sands of Time and Windmill Strike grow while Retained, and Conclude hits a row twice but ends your plays.', spot('.reward-screen__cards')),
      task('Skip them', 'Every card you add makes Eruption and Vigilance show up less often, and none of these beats them. Skipping is a real choice: skip.', roomLeft, spot('.reward-screen--card-choice .reward-screen__skip')),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Fight a Blue Slaver', 'The next fight is a single Blue Slaver.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Blue Slaver', 'It has 10 HP and will attack for 2 and make you Weak. Weak makes each of your hits deal 1 less. An enemy that dies before its turn never acts.', at.enemy('e0'), at.intent('e0')),
        say('No Calm this time', 'Your hand holds Eruption, Crush Joints, 2 Strikes and a Defend, but no Vigilance. Eruption still enters Wrath, just without the 2 Energy from leaving Calm.', at.hand),
        task('Eruption', 'Deal 2 and enter Wrath. The Slaver drops to 8.', playedDown('eruption'), at.handCard('eruption'), at.enemy('e0')),
        task('Crush Joints', 'In Wrath it deals 1 + 1 = 2 and applies Vulnerable. The Slaver drops to 6.', playedDown('crush_joints'), at.handCard('crush_joints'), at.enemy('e0')),
        task('Strike the Vulnerable Slaver', 'Wrath makes the Strike 2, and Vulnerable doubles it to 4. Then the token is removed. It drops to 2.', playedDown('strike_watcher', 1), at.handCard('strike_watcher'), at.enemy('e0')),
        task('Use your Miracle', 'Every fight starts with a fresh Miracle from Pure Water. Spend it for the Energy you need.', miraclesLeft(0), miracleButton),
        task('Finish it', 'A 2-damage Strike wins before the Slaver can make you Weak.', playedDown('strike_watcher', 0), at.handCard('strike_watcher'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 2,
      cards: [
        ['halt', 'Costs 0: gain 1 Block, or 2 while in Wrath.'],
        ['empty_body', 'Costs 1: gain 2 Block and return to Neutral. Leaving Wrath stops its end-of-turn damage, and leaving Calm pays 2 Energy.'],
        ['empty_mind', 'Costs 1: draw 2 cards and return to Neutral.'],
      ],
      pick: 'empty_body',
      pickWhy: 'Empty Body is your way out of Wrath before the turn ends, with Block on top. Take it.',
    }),
    moveChapter('a1r2c1', 'a1r3c2', 'Another event', 'This "?" room is on the way to the merchant.'),
    eventChapter('a1r3c2', [
      say('Ominous Forge', 'Rummage gives a relic, but a die roll of 1 to 3 also adds a Curse to your deck. Forge upgrades a card for 2 HP.', at.event),
      task('Choose Forge', 'A sure upgrade beats a coin flip for a Curse, and a campfire lies ahead. Forge.', shown('.card-picker'), at.eventOption('forge')),
      ...pickerSteps('Upgrade', 'vigilance', 'Upgraded Vigilance gives 3 Block instead of 2. Pick Vigilance.', roomLeft),
    ]),
    moveChapter('a1r3c2', 'a1r4c2', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r4c2', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit.', at.merchantRemoval),
      task('Buy Flying Sleeves', 'Flying Sleeves costs 2 of your 8 Gold: 1 Energy for 2 hits of 1, and Wrath adds 1 to each hit. It has Retain: it stays in your hand at the end of your turn.',
        deckHas('flying_sleeves'), at.shopCard('flying_sleeves')),
    ]),
    moveChapter('a1r4c2', 'a1r5c1', 'A Large Slime', 'A Large Slime waits in the next room.'),
    {
      id: 'fight-a1r5c1-turn-1',
      when: inFight('a1r5c1', 1),
      steps: [
        say('Large Slime', 'It has 8 HP. It acts in a fixed order: this turn it hits every row for 1, next turn it attacks for 4 and adds a Daze.', at.enemy('e0'), at.intent('e0')),
        say('No Eruption', 'Your hand has Vigilance and Cut Through Fate, but no Eruption. The top of your draw pile is Empty Body, then Eruption. Scry can reach it.', at.hand),
        task('Vigilance', 'Gain 3 Block and enter Calm.', playedDown('vigilance'), at.handCard('vigilance'), at.hero),
        task('Cut Through Fate', 'Deal 1, then a window shows your top 2 cards: discard Empty Body and keep Eruption. The draw then gives you Eruption.', playedDown('cut_through_fate'), at.handCard('cut_through_fate'), at.enemy('e0')),
        task('Use your Miracle', 'You are out of Energy. The Miracle pays for Eruption.', miraclesLeft(0), miracleButton),
        task('Eruption', 'Deal 2 and enter Wrath. Leaving Calm pays 2 Energy. The Slime drops to 5.', playedDown('eruption'), at.handCard('eruption'), at.enemy('e0')),
        task('Strike twice', 'Each Strike deals 2 in Wrath. Play two of them: the Slime drops to 1.', playedDown('strike_watcher', 1), at.handCard('strike_watcher'), at.enemy('e0')),
        say('Ending in Wrath', 'You are out of Energy and still in Wrath, so ending the turn costs you 1 damage. Your 3 Block stops it, and what is left stops the Slime\'s 1.', at.hero),
        task('End your turn', 'End the turn and watch Block absorb both hits.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r5c1-turn-2',
      when: inFight('a1r5c1', 2),
      steps: [
        say('Still in Wrath', 'Stances last until something changes them, so you are still in Wrath. Block is gone at the start of your turn. The Slime means to hit for 4.', at.hero, at.intent('e0')),
        task('Finish it', 'A 2-damage Strike ends the fight before that 4 lands.', playedDown('strike_watcher'), at.handCard('strike_watcher'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r5c1', {
      gold: 1,
      potion: { id: 'distilled_chaos', why: 'It plays your next 3 cards for free, in a card window. Save it for the boss.' },
      cards: [
        ['talk_to_the_hand', 'Costs 1: deal 2 damage and gain 1 Block per Miracle you hold.'],
        ['halt', 'Costs 0: 1 Block, or 2 in Wrath.'],
        ['protect', 'Costs 2: gain 3 Block. It has Retain.'],
      ],
      pick: null,
      pickWhy: 'Your deck already does what these do. Keep it lean so Eruption and Vigilance come up often: skip these.',
    }),
    moveChapter('a1r5c1', 'a1r6c0', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r6c0', 'necronomicon', 'Your first Attack on a turn the die shows 1 hits twice. You will see it soon.'),
    moveChapter('a1r6c0', 'a1r7c0', 'A bigger Jaw Worm', 'This Jaw Worm is tougher than the first.'),
    {
      id: 'fight-a1r7c0-turn-1',
      when: inFight('a1r7c0', 1),
      steps: [
        say('Jaw Worm', 'It has 10 HP and will attack for 4. Your hand is 3 Defends, a Strike and Flying Sleeves: no Stance cards this turn.', at.enemy('e0'), at.intent('e0')),
        say('Retain', 'Flying Sleeves has Retain: it stays in your hand when the turn ends. Save it for next turn, when Wrath adds 1 to each of its 2 hits.', at.handCard('flying_sleeves')),
        task('Play the Defends', 'Play all 3 Defends for 3 Block. A bad hand is a turn to defend.', playedDown('defend_watcher'), at.handCard('defend_watcher'), at.hero),
        task('Use your Miracle', 'Spend the Miracle for 1 Energy.', miraclesLeft(0), miracleButton),
        task('Strike', 'Chip 1 damage off the Jaw Worm: 9 HP left.', playedDown('strike_watcher'), at.handCard('strike_watcher'), at.enemy('e0')),
        task('End your turn', 'Flying Sleeves stays in your hand. Loaded Die added 1 Block to your Defends\' 3, so all 4 damage from the Jaw Worm is blocked.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r7c0-turn-2',
      when: inFight('a1r7c0', 2),
      steps: [
        say('The die shows 1', 'Necronomicon: your first Attack this turn is played twice. You drew Vigilance and Eruption, and Flying Sleeves waited for you. The Jaw Worm means to attack for 3.', at.die, at.hand),
        task('Vigilance', 'Gain 3 Block and enter Calm.', playedDown('vigilance'), at.handCard('vigilance'), at.hero),
        task('Eruption, twice', 'Play Eruption on the Jaw Worm, then tap it again for the second play. The first hits 2 and leaves Calm (+2 Energy); the second hits 3 in Wrath. It drops to 4.',
          eruptionResolved, at.handCard('eruption'), at.enemy('e0')),
        task('Flying Sleeves', 'Two hits of 1 + 1 for Wrath: exactly 4. This is why you Retained it.', playedDown('flying_sleeves'), at.handCard('flying_sleeves'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r7c0', {
      gold: 1,
      cards: [
        ['protect', 'Costs 2: 3 Block, with Retain.'],
        ['fear_no_evil', 'Costs 1: deal 2 damage, and if you are in Wrath, switch to Calm.'],
        ['inner_peace', 'Costs 1: enter Calm, or if already in Calm, draw 3 cards.'],
      ],
      pick: null,
      pickWhy: 'Fear No Evil is good, but the boss is close: you want Vigilance and Eruption in your first hand against it, and a new card makes that less likely. Skip.',
    }),
    moveChapter('a1r7c0', 'a1r8c0', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r8c0',
      when: atCampfire('a1r8c0'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'You paid 2 HP at the Forge, so Rest is a fine choice. If you feel safe, Smith Crush Joints (2 damage) or Empty Body (3 Block). This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r8c0', 'a1r9c0', 'Gremlins ahead', 'A gang of Gremlins waits in the next room.'),
    {
      id: 'fight-a1r9c0-turn-1',
      when: inFight('a1r9c0', 1),
      steps: [
        say('The gremlin gang', 'Two Mad Gremlins (4 HP) hit for 1, and the Sneaky Gremlin (2 HP) between them hits for 2. Mad Gremlins are Angry: each time an Attack damages one, it gains 1 Strength.', at.enemies),
        task('Eruption the Sneaky Gremlin', 'Eruption\'s 2 damage kills it and puts you in Wrath.', playedDown('eruption'), at.handCard('eruption'), at.enemy('e0-summon')),
        task('Crush Joints a Mad Gremlin', 'In Wrath: 2 damage and Vulnerable. It gets Angry, so finish it right away.', playedDown('crush_joints'), at.handCard('crush_joints'), at.enemy('e0')),
        task('Strike it', 'Wrath and Vulnerable make the Strike 4: the Angry Gremlin dies before it can use its Strength.', playedDown('strike_watcher'), at.handCard('strike_watcher'), at.enemy('e0')),
        say('Finish the fight', 'Spend your Miracle on a Defend: its Block stops the Wrath damage when you end the turn. Then beat the last Mad Gremlin your way.', miracleButton, at.hand),
      ],
    },
    rewardChapter('a1r9c0', {
      gold: 2,
      cards: [
        ['battle_hymn', 'A Power: once per turn, deal 1 damage, or 2 in Wrath.'],
        ['reach_heaven', 'Costs 1: deal 2 damage per Miracle you hold.'],
        ['collect', 'Costs 1: gain 2 Miracles, then it Exhausts.'],
      ],
      pick: null,
      pickWhy: 'A card added now barely gets drawn against the boss, and it pushes Vigilance and Eruption out of your first hand. Skip these.',
    }),
    moveChapter('a1r9c0', 'a1r10c0', 'One more event', 'The last "?" room before the boss.'),
    eventChapter('a1r10c0', [
      say('The Cleric', 'Pay 1 Gold to heal 3 HP, 2 Gold to upgrade a card, or 3 Gold to remove one.', at.event),
      task('Heal or pray', 'Heal if you are below 7 HP; otherwise pray to upgrade a card, such as Crush Joints or Empty Body.',
        (run) => roomLeft(run) || Boolean(document.querySelector('.card-picker')), at.eventOption('heal'), at.eventOption('prayer')),
      task('Choose a card', 'Pick a card to upgrade and confirm.', roomLeft, spot('.card-picker')),
    ]),
    moveChapter('a1r10c0', 'a1r11c0', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c0',
      when: atCampfire('a1r11c0'),
      steps: [
        say('Before the boss', 'Rest if you are not at full HP: Hexaghost hits several times. Otherwise Smith a card, such as Empty Body or Crush Joints.', at.campfire),
      ],
    },
    moveChapter('a1r11c0', 'a1r12c0', 'Face Hexaghost', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('Hexaghost', 'The Act I boss has 36 HP. Bosses count as being in every row and always act last. Its Buffer stops the first damage it would take.', at.enemy('boss-0')),
        say('Burns', 'This turn it attacks for 1 and gives you a Burn. A Burn cannot be played, and if it is in your hand when your turn ends, it deals 1 damage to you. Its later attacks hit much harder.', at.intent('boss-0')),
        say('A full Watcher turn', 'Your hand is perfect: Strike, Vigilance, Eruption, Empty Body and Defend. Calm, then Wrath, then back to Neutral, with Block to spare.', at.hand),
        task('Strike first', 'A 1-damage Strike uses up its Buffer, so your bigger hit lands.', playedDown('strike_watcher'), at.handCard('strike_watcher'), at.enemy('boss-0')),
        task('Vigilance', 'Gain 3 Block and enter Calm.', playedDown('vigilance'), at.handCard('vigilance'), at.hero),
        task('Use your Miracle', 'The Miracle pays for Eruption.', miraclesLeft(0), miracleButton),
        task('Eruption', 'Deal 2, leave Calm for 2 Energy, and enter Wrath.', playedDown('eruption'), at.handCard('eruption'), at.enemy('boss-0')),
        task('Empty Body', 'Gain 2 Block and return to Neutral: no Wrath damage at the end of this turn.', playedDown('empty_body'), at.handCard('empty_body'), at.hero),
        task('Defend', 'Your last Energy buys 1 more Block: 6 in all against its 1-damage attack.', playedDown('defend_watcher'), at.handCard('defend_watcher'), at.hero),
        task('End your turn', 'From here the fight is yours.', turnReached(2), at.endTurn),
        say('Your potions', `${potionText('vulnerable_potion')} Drink it before a Wrath turn. ${potionText('distilled_chaos')}`, at.combatActions),
      ],
    },
    {
      id: 'reward-a1r12c0',
      when: inReward('a1r12c0'),
      steps: [
        say('Hexaghost falls', 'Bosses drop Gold, a Rare Card Reward and a choice of Boss Relics. Take what you like: the tutorial ends after these rewards.'),
      ],
    },
  ],
}
