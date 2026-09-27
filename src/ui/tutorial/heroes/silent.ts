import type { RunState } from '../../../game/run.ts'
import {
  NEOW_GOLD, NEOW_REVEAL, eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowRedTaken,
  pickerSteps, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, inFight, inNeow, inReward, playedDown, potionGone, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-silent-45',
  neow: { card: 'neow_03', red: ['deflect', 'backflip', 'deadly_poison'], pick: 'deadly_poison', option: 0, effectCards: ['neutralize'] },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c1', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['jaw_worm_first'],
      hand: ['deadly_poison', 'defend_silent', 'strike_silent', 'defend_silent', 'strike_silent', 'neutralize', 'survivor'],
      cards: ['dodge_and_roll', 'acrobatics', 'blade_dance'], pick: 'blade_dance' },
    a1r1c1: { kind: 'event', event: 'ancient_temple', option: 'go_inside' },
    a1r2c1: { kind: 'fight', enemies: ['red_slaver'],
      hand: ['defend_silent', 'strike_silent', 'defend_silent', 'blade_dance', 'neutralize', 'survivor', 'strike_silent'],
      cards: ['accuracy', 'acrobatics', 'setup'], pick: null },
    a1r3c1: { kind: 'campfire' },
    a1r4c1: { kind: 'fight', enemies: ['sneaky_gremlin', 'gremlin_wizard', 'mad_gremlin'],
      hand: ['defend_silent', 'strike_silent', 'strike_silent', 'blade_dance', 'defend_silent', 'defend_silent', 'survivor'],
      cards: ['sneaky_strike', 'footwork', 'flechettes'], pick: 'sneaky_strike' },
    a1r5c1: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'all_out_attack' }] },
    a1r6c1: { kind: 'treasure', relic: 'stone_calendar' },
    a1r7c1: { kind: 'event', event: 'living_wall', option: 'forget', cards: ['defend_silent'] },
    a1r8c1: { kind: 'campfire' },
    a1r9c1: { kind: 'fight', enemies: ['jaw_worm'],
      hand: ['defend_silent', 'strike_silent', 'blade_dance', 'deadly_poison', 'defend_silent', 'neutralize', 'strike_silent'],
      cards: ['poisoned_stab', 'bouncing_flask', 'infinite_blades'], pick: null },
    a1r10c1: { kind: 'merchant', buy: [{ section: 'potion', slot: 2, id: 'flex_potion' }] },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['guardian_attack'],
      hand: ['strike_silent', 'defend_silent', 'blade_dance', 'defend_silent', 'defend_silent', 'strike_silent', 'neutralize'] },
  },
  boss: 'guardian_attack',
}

// Silent-only checks: Shivs are tokens, not cards, so playedDown cannot see them.
const shivsLeft = (left: number) => (run: RunState) => !run.combat || (run.combat.players[0]?.shivs ?? 0) <= left
const enemyDown = (uid: string) => (run: RunState) => {
  const enemy = run.combat?.enemies.find((candidate) => candidate.uid === uid)
  return !run.combat || !enemy || enemy.dead === true || enemy.hp <= 0
}
const potionBought = (id: string) => (run: RunState) => run.players[0]!.potions.includes(id)
const useShiv = spot('[aria-label="Use Shiv"]')

export const SILENT: HeroTutorial = {
  character: 'silent',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with the Silent, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'The Silent has 9 HP. Most enemy attacks here deal 1 to 4 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relic', 'Your deck holds 5 Strikes, 5 Defends, Neutralize and Survivor. Ring of the Snake draws 2 extra cards at the start of each fight, so your first hand has 7 cards. Hover over or long-press a relic to read it.', at.deck, at.relics),
        say("Neow's Blessing", 'Every run starts with Neow. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.', at.neowCard),
        NEOW_GOLD,
        NEOW_REVEAL,
        say('Deflect', 'Costs 0: gain 1 Block, or 2 if you hold a Shiv. Cheap, but small.', at.offeredCard('deflect')),
        say('Backflip', 'Costs 1: gain 1 Block and draw 2 cards.', at.offeredCard('backflip')),
        say('Deadly Poison', 'Costs 1: apply 1 Poison. At the end of each of your turns, a poisoned enemy loses 1 HP per Poison token. Block does not stop it, and the tokens stay until the enemy dies.', at.offeredCard('deadly_poison')),
        task('Take Deadly Poison', 'Poison is the Silent\'s signature: one card that keeps dealing damage every turn. Take it.', neowRedTaken, at.offeredCard('deadly_poison')),
        say('The blue options', 'Upgrade 1 card, Gain 5 Gold, or Gain 1 Relic and 1 Curse. A Curse is a dead card that clogs your hand for the whole run.', spot('.neow-options')),
        task('Upgrade 1 card', 'An upgrade is a sure thing, and you have the perfect target. Choose it.', neowBlueChosen, at.neowOption('Upgrade 1 card')),
        ...pickerSteps('Upgrade', 'neutralize', 'Neutralize costs 0, deals 1 and applies Weak. Upgraded, it deals 2, and you will play it in nearly every fight. Upgrades show on the card in green. Pick Neutralize.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'The Guardian waits at the top: 40 HP and a thick shell of Block. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, a treasure chest and 3 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Your first fight', 'This Jaw Worm has 7 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('Enemy intent', 'The icon above an enemy is its intent: what it will do on its turn. The Jaw Worm will attack for 2 and gain 1 Block. Many enemies pick their move from the die rolled at the start of each round.', at.intent('e0'), at.die),
        say('The die', 'One die is rolled each round for the whole table. On a 6, your Loaded Die relic gives 1 extra Energy.', at.die),
        say('Seven cards', 'Ring of the Snake drew 2 extra cards: Neutralize+, Deadly Poison, Survivor, 2 Strikes and 2 Defends. From turn 2 on you draw the usual 5. Cards you do not play are discarded when your turn ends.', at.hand),
        say('Energy', 'You get 3 Energy every turn, and unspent Energy is lost. A card\'s cost is in its top-left corner: Neutralize costs 0, everything else here costs 1.', at.energy),
        task('Play Neutralize', 'Neutralize+ is free: deal 2 and apply Weak. Tap Neutralize, then tap the Jaw Worm, or drag it onto the Jaw Worm.', playedDown('neutralize'), at.handCard('neutralize'), at.enemy('e0')),
        say('Weak', 'The Jaw Worm now has a Weak token. Its next attack deals 1 less, then the token is removed, so its 2-damage attack will only deal 1. It is down to 5 HP.', at.enemy('e0')),
        task('Poison it', 'Deadly Poison puts 1 Poison on the Jaw Worm. It will lose 1 HP at the end of every one of your turns until it dies.', playedDown('deadly_poison'), at.handCard('deadly_poison'), at.enemy('e0')),
        task('Strike', 'A Strike deals 1. That leaves the Jaw Worm on 4 HP.', playedDown('strike_silent', 1), at.handCard('strike_silent'), at.enemy('e0')),
        task('Play Survivor', 'Survivor gives 2 Block, then you discard a card. Tap Survivor, then tap a Defend to discard it: you have no Energy left to play it anyway.',
          playedDown('survivor'), at.handCard('survivor'), at.handCard('defend_silent')),
        say('Why discard?', 'Some Silent cards reward discarding, such as Sneaky Strike, which refunds Energy after a discard. Block stops 1 damage per point until your next turn, so the weakened hit of 1 is fully stopped.', at.hero),
        task('End your turn', 'At the end of your turn Poison ticks first, then the enemies act. End the turn and watch.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('Poison at work', 'The Jaw Worm lost 1 HP to Poison and is on 3. Its hit was stopped by your Block. It also gained 1 Block, which it keeps until its next turn. Enemy Block does not stop Poison.', at.enemy('e0')),
        say('Your piles', 'Played and unplayed cards went to the discard pile. When the draw pile runs out, the discard pile is shuffled into it. Tap a pile to look inside.', at.piles),
        task('Strike three times', 'The first Strike only knocks off its 1 Block. The next two leave it on 1 HP.', playedDown('strike_silent'), at.handCard('strike_silent'), at.enemy('e0')),
        task('End your turn', 'Poison deals the last point at the end of your turn, before the Jaw Worm can act. Play a Defend first if you still have Energy.', turnReached(3), at.endTurn, at.handCard('defend_silent')),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'Poison finished the Jaw Worm, and you took no damage. Now collect the rewards.', at.hp)],
      gold: 1,
      potion: { id: 'swift_potion', why: 'Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['dodge_and_roll', 'Costs 1: two separate 1-Block icons for any players. Alone, that is 2 Block for you.'],
        ['acrobatics', 'Costs 1: draw 3 cards, then discard 1.'],
        ['blade_dance', 'Costs 1: gain 2 Shivs. A Shiv is a token you spend to deal 1 damage, without spending Energy.'],
      ],
      pick: 'blade_dance',
      pickWhy: 'Shivs are the Silent\'s other weapon, and Blade Dance turns 1 Energy into 2 damage. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Ancient Temple', 'Go Inside gains a relic and costs 1 HP (in a party, 1 more for each player who went in before you). Leave does nothing.', at.event),
      task('Go inside', 'A relic lasts the whole run. That is worth 1 HP. Go inside.', (run) => roomLeft(run) || shown('.event-panel--loot')(), at.eventOption('go_inside')),
      task('Take Necronomicon', 'Necronomicon: on a 1, your first Attack that turn is played twice. It is already marked Take: resolve the reward.',
        roomLeft, spot('.event-panel--loot .room-proceed'), spot('.event-loot')),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'A Red Slaver', 'The next fight is a single Red Slaver.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Red Slaver', 'The Red Slaver has 10 HP and will attack for 3 this turn.', at.enemy('e0'), at.intent('e0')),
        say('Shivs', 'Shivs are tokens, not cards; you can hold up to 5. Spend one whenever you could play a card, with "Use Shiv" in the top bar, to deal 1 damage. Each Shiv is its own hit.'),
        task('Neutralize first', 'Deal 2 and make it Weak, so its 3-damage attack deals only 2.', playedDown('neutralize'), at.handCard('neutralize'), at.enemy('e0')),
        task('Play Blade Dance', 'Blade Dance needs no target: tap it, or drag it up, to gain 2 Shivs.', playedDown('blade_dance'), at.handCard('blade_dance')),
        task('Use both Shivs', 'Tap "Use Shiv", then the Red Slaver. Do it twice: 1 damage each.', shivsLeft(0), useShiv, at.enemy('e0')),
        task('Strike', 'A Strike brings it to 5 HP.', playedDown('strike_silent', 1), at.handCard('strike_silent'), at.enemy('e0')),
        task('Play Survivor', '2 Block stops its weakened 2-damage hit. Discard a Defend.', playedDown('survivor'), at.handCard('survivor'), at.handCard('defend_silent')),
        task('End your turn', 'The Red Slaver attacks into your Block.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        say('Your turn to lead', 'From here, finish the fight yourself. Tip: Deadly Poison keeps hurting it every turn, even on turns you spend Defending. Watch its intent: it can make you Vulnerable, which doubles the next hit on you.', at.hand),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      cards: [
        ['accuracy', 'Costs 1, a Power: your Shivs deal 1 more damage for the rest of the fight. Great with many Shivs.'],
        ['acrobatics', 'Costs 1: draw 3 cards, then discard 1.'],
        ['setup', 'Costs 0: gain 1 Energy, then it Exhausts: it is gone until the fight ends.'],
      ],
      pick: null,
      pickWhy: 'None of these deal damage, and Accuracy needs more Shivs than one Blade Dance. A card that does not fit only dilutes your deck, so skipping is a real choice. Skip these.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r3c1',
      when: atCampfire('a1r3c1'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'Rest if you are low. Otherwise Smith: upgraded Blade Dance gives 3 Shivs, and upgraded Deadly Poison costs 0. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r3c1', 'a1r4c1', 'Gremlins ahead', 'A gang of Gremlins waits in the next room.'),
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('The gremlin gang', 'The Sneaky Gremlin (2 HP) hits for 2. The Gremlin Wizard (4 HP) charges this turn, then hits you for 3 every turn. The Mad Gremlin (4 HP) hits for 1, but gains 1 Strength each time an Attack damages it.', at.enemies),
        task('Blade Dance', 'Gain 2 Shivs.', playedDown('blade_dance'), at.handCard('blade_dance')),
        task('Shiv the Sneaky Gremlin', 'Two Shivs kill it. Dead enemies never act, so its 2 damage never comes.', enemyDown('e0'), useShiv, at.enemy('e0')),
        task('Strike the Wizard', 'Start on the Gremlin Wizard before its big hit comes.', playedDown('strike_silent', 1), at.handCard('strike_silent'), at.enemy('e0-summon')),
        task('Play Survivor', 'Block the Mad Gremlin\'s 1 damage. Discard a Defend.', playedDown('survivor'), at.handCard('survivor'), at.handCard('defend_silent')),
        task('End your turn', 'The Wizard only charges this turn.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        say('The Wizard is ready', 'The Gremlin Wizard will now hit you for 3. Kill it first.', at.intent('e0-summon')),
        task('Neutralize the Wizard', 'Neutralize+ deals 2 for free.', playedDown('neutralize'), at.handCard('neutralize'), at.enemy('e0-summon')),
        task('Finish the Wizard', 'A Strike deals the last point.', enemyDown('e0-summon'), at.handCard('strike_silent'), at.enemy('e0-summon')),
        say('Finish the fight', 'Only the Mad Gremlin is left. Each Attack that damages it makes it hit harder, so hit it hard or Defend. Poison is not an Attack, so it does not anger it. Win the fight your way.', at.enemy('e0-summon-1')),
      ],
    },
    rewardChapter('a1r4c1', {
      gold: 1,
      potion: { id: 'block_potion', why: 'Save it for a turn when a big hit is coming.' },
      cards: [
        ['sneaky_strike', 'Costs 2: deal 3 damage. If you discarded a card this turn, gain 2 Energy back.'],
        ['footwork', 'Costs 2, a Power: every card that gives Block gives 1 more for the rest of the fight.'],
        ['flechettes', 'Costs 1: deal 1 damage for each Skill in your hand.'],
      ],
      pick: 'sneaky_strike',
      pickWhy: 'Sneaky Strike is your hardest hit, and after Survivor\'s discard it costs nothing at all. Take it.',
    }),
    moveChapter('a1r4c1', 'a1r5c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r5c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit. It is often the best buy in the shop.', at.merchantRemoval),
      task('Buy All-Out Attack', 'All-Out Attack costs 3 of your 8 Gold: deal 2 to a whole row and to any boss, then discard a card, which also switches on Sneaky Strike.',
        deckHas('all_out_attack'), at.shopCard('all_out_attack')),
    ]),
    moveChapter('a1r5c1', 'a1r6c1', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r6c1', 'stone_calendar', 'Free damage on one roll in six.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('Living Wall', 'Forget removes a card from your deck, Change transforms one into a random card, and Grow upgrades one.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. You have 5 Defends plus Survivor, but the Guardian needs damage. Removing a Defend makes Neutralize, Blade Dance and your attacks come up more often.'),
      task('Choose Forget', 'Remove a card.', shown('.card-picker'), at.eventOption('forget')),
      ...pickerSteps('Remove', 'defend_silent', 'Pick a Defend.', roomLeft),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'Another campfire', 'A second campfire before the next fight.'),
    {
      id: 'campfire-a1r8c1',
      when: atCampfire('a1r8c1'),
      steps: [
        say('Rest or Smith', 'Rest if you are hurt; there is one more fight and another campfire before the boss. Otherwise Smith a card such as Blade Dance or Sneaky Strike.', at.campfire),
      ],
    },
    moveChapter('a1r8c1', 'a1r9c1', 'A bigger Jaw Worm', 'A full-size Jaw Worm waits in the next fight.'),
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('Stone Calendar', 'The die rolled a 4, so Stone Calendar dealt 4 damage to this Jaw Worm as the turn began. It has 6 of its 10 HP left.', at.enemy('e0'), at.die),
        say('Kill it now', 'It will attack for 4. An enemy that dies on your turn never acts, and this hand can deal 6: Neutralize+, 2 Shivs and 2 Strikes.', at.intent('e0'), at.hand),
        task('Neutralize', 'Neutralize+ deals 2 and costs nothing.', playedDown('neutralize'), at.handCard('neutralize'), at.enemy('e0')),
        task('Blade Dance', 'Gain your Shivs.', playedDown('blade_dance'), at.handCard('blade_dance')),
        task('Use your Shivs', 'Throw every Shiv at the Jaw Worm.', shivsLeft(0), useShiv, at.enemy('e0')),
        task('Strike it down', 'Your Strikes finish it.', enemyDown('e0'), at.handCard('strike_silent'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 1,
      cards: [
        ['poisoned_stab', 'Costs 1: deal 1 damage and apply 1 Poison, then it Exhausts.'],
        ['bouncing_flask', 'Costs 2: two separate Poison tokens for any enemies. Great against packs.'],
        ['infinite_blades', 'Costs 1, a Power: gain 1 Shiv at the start of each of your turns.'],
      ],
      pick: null,
      pickWhy: 'Good Silent cards, but the Guardian is the next fight and a card added now shows up in few of its turns, pushing out cards you already count on. Skip these.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'Spend your Gold before the boss.'),
    merchantChapter('a1r10c1', [
      task('Buy the Flex Potion', 'Flex Potion costs 2 of your 6 Gold: gain 1 Strength, lost at the end of the turn. Strength adds 1 to each hit, and each Shiv is its own hit. You will drink it on the Guardian.',
        potionBought('flex_potion'), spot('[data-merchant-target="potion-2"]')),
    ]),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'Rest if two or three hits could kill you. Otherwise Smith a card you want against the Guardian, such as Blade Dance or Deadly Poison.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Guardian', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('The Guardian', 'The Act I boss has 40 HP. Bosses count as being in every row and always act last.', at.enemy('boss-0')),
        say('Its shell', 'This turn it attacks for 2 and gains 5 Block, which it keeps between turns. Next turn comes Mode Shift: if it still has Block, it drops the Block and attacks for 6. If you broke all its Block, it switches to Defensive Mode instead.', at.intent('boss-0')),
        say('Defensive Mode', 'In Defensive Mode it has Sharp Hide: after each Attack on it, you take 1 damage, and every Shiv counts as an Attack. Poison is not an Attack, so it stays safe.'),
        task('Drink the Flex Potion', 'It has no Block yet, so hit hard now. Tap the Flex Potion to drink it (on a phone, tap twice): each hit this turn deals 1 more.', potionGone('flex_potion'), at.combatPotion('flex_potion')),
        task('Neutralize the Guardian', 'With Strength, Neutralize+ deals 3, and Weak cuts its 2-damage attack to 1.', playedDown('neutralize'), at.handCard('neutralize'), at.enemy('boss-0')),
        task('Blade Dance', 'Gain your Shivs.', playedDown('blade_dance'), at.handCard('blade_dance')),
        task('Throw the Shivs', 'Each Shiv is its own hit, so each gets the Strength: 2 damage apiece.', shivsLeft(0), useShiv, at.enemy('boss-0')),
        task('Strike twice', 'Your Strikes get the Strength too.', playedDown('strike_silent'), at.handCard('strike_silent'), at.enemy('boss-0')),
        task('End your turn', 'The Strength wears off now. The Guardian hits for 1 and raises its shell.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r12c0-turn-2',
      when: inFight('a1r12c0', 2),
      steps: [
        say('Break the shell', 'The Guardian has 5 Block and Mode Shifts this turn. Break all 5 to dodge the 6-damage hit. All-Out Attack hits it for 2, and if the die shows a 1, Necronomicon plays it twice. Finish the fight your way: good luck.', at.enemy('boss-0'), at.hand),
      ],
    },
    {
      id: 'reward-a1r12c0',
      when: inReward('a1r12c0'),
      steps: [
        say('The Guardian falls', 'Bosses drop Gold, a Rare Card Reward and a choice of Boss Relics. Take what you like: the tutorial ends after these rewards.'),
      ],
    },
  ],
}
