import {
  NEOW_GOLD, NEOW_REVEAL, eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowRedTaken,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-ironclad-97',
  neow: { card: 'neow_02', red: ['clothesline', 'combust', 'seeing_red'], pick: 'clothesline', option: 0, effectCards: ['bash'] },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c0', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['jaw_worm_first'], hand: ['clothesline', 'bash', 'strike_ironclad', 'defend_ironclad', 'strike_ironclad'],
      cards: ['carnage', 'warcry', 'warcry'], pick: 'carnage' },
    a1r1c1: { kind: 'event', event: 'living_wall', option: 'forget', cards: ['strike_ironclad'] },
    a1r2c1: { kind: 'fight', enemies: ['small_slime', 'acid_slime_daw', 'spike_slime'],
      hand: ['defend_ironclad', 'strike_ironclad', 'strike_ironclad', 'strike_ironclad', 'carnage'],
      cards: ['twin_strike', 'true_grit', 'clash'], pick: 'twin_strike' },
    a1r3c1: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'headbutt' }] },
    a1r4c1: { kind: 'fight', enemies: ['sneaky_gremlin', 'fat_gremlin', 'sneaky_gremlin'],
      hand: ['strike_ironclad', 'bash', 'carnage', 'strike_ironclad', 'headbutt'],
      cards: ['anger', 'disarm', 'pommel_strike'], pick: 'pommel_strike' },
    a1r5c0: { kind: 'campfire' },
    a1r6c1: { kind: 'treasure', relic: 'meat_on_the_bone' },
    a1r7c1: { kind: 'event', event: 'the_cleric', option: 'prayer', cards: ['clothesline'] },
    a1r8c1: { kind: 'treasure', relic: 'mummified_hand' },
    a1r9c1: { kind: 'fight', enemies: ['fungi_beast', 'fungi_beast_summon'],
      hand: ['strike_ironclad', 'defend_ironclad', 'bash', 'strike_ironclad', 'twin_strike'],
      cards: ['twin_strike', 'cleave', 'shrug_it_off'], pick: null },
    a1r10c1: { kind: 'merchant' },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['guardian_attack'], hand: ['carnage', 'strike_ironclad', 'defend_ironclad', 'strike_ironclad', 'headbutt'] },
  },
  boss: 'guardian_attack',
}

export const IRONCLAD: HeroTutorial = {
  character: 'ironclad',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with the Ironclad, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'The Ironclad has 10 HP, the most of any hero. Attacks here deal 1 to 3 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relic', 'Your deck holds 5 Strikes, 4 Defends and Bash; open it here any time. Your relic, Burning Blood, heals 1 HP at the end of every fight. Hover over or long-press a relic to read it.', at.deck, at.relics),
        say("Neow's Blessing", 'Every run starts with Neow. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.', at.neowCard),
        NEOW_GOLD,
        NEOW_REVEAL,
        say('Clothesline', 'Costs 2 Energy: deal 3 damage and apply Weak. A Weak enemy deals 1 less with each hit.', at.offeredCard('clothesline')),
        say('Combust', 'A Power that stays in play all fight and deals 1 damage to a row every turn. Slow for a short fight.', at.offeredCard('combust')),
        say('Seeing Red', 'Gain 2 Energy for 1, then it Exhausts: it is gone until the fight ends. Useful only with expensive cards to spend that Energy on.', at.offeredCard('seeing_red')),
        task('Take Clothesline', 'Clothesline hits harder than a Strike and softens the enemy\'s attacks. Take it.', neowRedTaken, at.offeredCard('clothesline')),
        say('The blue options', 'Upgrade 1 card, Gain 1 random Rare card, or Gain 10 Gold and 1 Curse. A Curse is a dead card that clogs your hand. A random Rare may not suit your deck.', spot('.neow-options')),
        task('Upgrade 1 card', 'An upgrade is a sure thing. Choose it.', neowBlueChosen, at.neowOption('Upgrade 1 card')),
        ...pickerSteps('Upgrade', 'bash', 'Upgraded Bash deals 4 damage instead of 2 and still applies Vulnerable. Upgrades show on the card in green. Pick Bash.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'The Guardian waits at the top: 40 HP and a thick shell of Block. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, 2 treasure chests and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Your first fight', 'This Jaw Worm has 7 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('Enemy intent', 'The icon above an enemy is its intent: what it will do on its turn. The Jaw Worm will attack for 3. Many enemies pick their move from the die rolled at the start of each round.', at.intent('e0'), at.die),
        say('The die', 'One die is rolled each round for the whole table. On a 6, your Loaded Die relic gives 1 extra Energy.', at.die),
        say('Your hand', 'You drew 5 cards: Bash, Clothesline, 2 Strikes and a Defend. Cards you do not play are discarded when your turn ends.', at.hand),
        say('Energy', 'You get 3 Energy every turn, and unspent Energy is lost. A card\'s cost is in its top-left corner: Bash and Clothesline cost 2, Strike and Defend cost 1.', at.energy),
        task('Play Bash', 'Bash deals 4 and applies Vulnerable. Tap Bash, then tap the Jaw Worm, or drag Bash onto it.', playedDown('bash'), at.handCard('bash'), at.enemy('e0')),
        say('Vulnerable', 'The Jaw Worm now carries a Vulnerable token. The next hit on it is doubled, then one token is removed. It is down to 3 HP.', at.enemy('e0')),
        task('Strike', 'A Strike deals 1, doubled to 2 by Vulnerable. That leaves the Jaw Worm on 1 HP.', playedDown('strike_ironclad', 1), at.handCard('strike_ironclad'), at.enemy('e0')),
        say('Block', 'You are out of Energy, so Defend waits. Defend gives 1 Block: each point stops 1 damage until your next turn, up to 20. Taking 3 now is fine.', at.hero),
        task('End your turn', 'Enemies act after you. End the turn and watch the Jaw Worm attack.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('Taking damage', 'The Jaw Worm hit you for 3. Your HP stays low between fights unless you heal, so avoid damage you do not need to take.', at.hp),
        say('Your piles', 'Played and unplayed cards went to the discard pile. When the draw pile runs out, the discard pile is shuffled into it. Tap a pile to look inside.', at.piles),
        task('Finish it', 'One Strike deals the last point of damage.', playedDown('strike_ironclad', 2), at.handCard('strike_ironclad'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'The fight is won, and Burning Blood healed 1 HP. Now collect the rewards.', at.hp)],
      gold: 1,
      potion: { id: 'liquid_memories', why: 'Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['carnage', 'Costs 2: deal 4 damage, your hardest single hit. It is Ethereal: if it is still in your hand at the end of your turn, it Exhausts for the rest of the fight.'],
        ['warcry', 'Costs 0: draw 2 cards, then put a card from your hand on top of your draw pile. It Exhausts.'],
      ],
      pick: 'carnage',
      pickWhy: 'Carnage wins fights faster. Just play it the turn you draw it. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Living Wall', 'Forget removes a card from your deck, Change transforms one into a random card, and Grow upgrades one.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. Every weak Strike you remove makes Bash, Clothesline and Carnage come up more often.'),
      task('Choose Forget', 'Remove a Strike, the weakest card in your deck.', shown('.card-picker'), at.eventOption('forget')),
      ...pickerSteps('Remove', 'strike_ironclad', 'Pick a Strike.', roomLeft),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Into the slimes', 'The next fight is a pack of three slimes.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Three slimes', 'A Small Slime (3 HP), an Acid Slime (5 HP) and a Spike Slime (5 HP), all in your row. They all act on this die roll.', at.enemies),
        say('Daze', 'The Acid Slime will attack for 2 and add a Daze to the top of your draw pile. Daze cannot be played, so it steals a slot in your next hand, then leaves at the end of that turn.', at.intent('e0-summon')),
        say('Acts last', 'The Spike Slime will hit for 1 and make you Vulnerable, doubling the next hit on you. "Acts last" means it goes after every other enemy.', at.intent('e0-summon-1')),
        task('Carnage the Acid Slime', 'Carnage deals 4. Playing it now also saves it from Ethereal.', playedDown('carnage'), at.handCard('carnage'), at.enemy('e0-summon')),
        task('Finish the Acid Slime', 'A Strike deals the last 1. An enemy that dies before its turn never acts, so there is no Daze.', playedDown('strike_ironclad', 2), at.handCard('strike_ironclad'), at.enemy('e0-summon')),
        task('End your turn', 'The Small Slime and the Spike Slime will hit you for 1 each.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        say('Your turn to lead', 'You are Vulnerable until the next hit lands on you. From here, finish the fight yourself. Tip: kill whatever will hurt you most before it acts, and Defend when you cannot.', at.hero),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      cards: [
        ['twin_strike', 'Costs 1: hit twice for 1. Vulnerable doubles each hit and Strength adds to each, but only one token is removed afterwards.'],
        ['true_grit', 'Costs 1: gain 1 Block and Exhaust a card from your hand, such as a Daze or a Strike.'],
        ['clash', 'Costs 0: deal 3 damage, but only when every card in your hand is an Attack.'],
      ],
      pick: 'twin_strike',
      pickWhy: 'Twin Strike turns Bash\'s Vulnerable into 4 damage for 1 Energy. Take it.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r3c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit. It is often the best buy in the shop.', at.merchantRemoval),
      task('Buy Headbutt', 'Headbutt costs 3 of your 7 Gold: deal 2 damage, then put a card from your discard pile on top of your draw pile, so you draw your best card again.',
        deckHas('headbutt'), at.shopCard('headbutt')),
    ]),
    moveChapter('a1r3c1', 'a1r4c1', 'Gremlins ahead', 'A gang of Gremlins waits in the next room.'),
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('The gremlin gang', 'Two Sneaky Gremlins (2 HP) each hit for 2. The Fat Gremlin (3 HP) hits every row for 1. Many weak enemies: kill the hardest hitters first.', at.enemies),
        task('Carnage a Sneaky Gremlin', 'Carnage is overkill here, but it is Ethereal, so use it rather than lose it.', playedDown('carnage'), at.handCard('carnage'), at.enemy('e0')),
        task('Headbutt the other one', 'Tap Headbutt, pick Carnage from your discard pile, then tap the other Sneaky Gremlin. Headbutt kills it, and Carnage goes on top of your draw pile for next turn.',
          playedDown('headbutt'), at.handCard('headbutt'), at.enemy('e0-summon-1')),
        say('Finish the fight', 'Only the Fat Gremlin is left. End your turn when you are ready, and win the fight your way.', at.endTurn),
      ],
    },
    rewardChapter('a1r4c1', {
      gold: 1,
      potion: { id: 'ancient_potion', why: 'Keep it for when an enemy has made you Weak or Vulnerable.' },
      cards: [
        ['anger', 'Costs 0: deal 1 damage.'],
        ['disarm', 'Costs 1: apply 2 Weak, then it Exhausts.'],
        ['pommel_strike', 'Costs 1: deal 2 damage and draw a card, so it replaces itself.'],
      ],
      pick: 'pommel_strike',
      pickWhy: 'Pommel Strike is a better Strike that also draws. Take it.',
    }),
    moveChapter('a1r4c1', 'a1r5c0', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r5c0',
      when: atCampfire('a1r5c0'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'Rest if the next fights could kill you. Otherwise Smith: upgraded Carnage deals 6, and upgraded Clothesline deals 4. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r5c0', 'a1r6c1', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r6c1', 'meat_on_the_bone', 'A safety net: it can save a run that ends a fight nearly dead.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('The Cleric', 'Pay 1 Gold to heal 3 HP, 2 Gold to upgrade a card, or 3 Gold to remove one.', at.event),
      task('Heal or pray', 'Heal if you are below 7 HP; otherwise pray to upgrade a card, such as Carnage or Clothesline.',
        (run) => roomLeft(run) || Boolean(document.querySelector('.card-picker')), at.eventOption('heal'), at.eventOption('prayer')),
      task('Choose a card', 'Pick a card to upgrade and confirm.', roomLeft, spot('.card-picker')),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'One more chest', 'This route passes a second chest.'),
    treasureChapter('a1r8c1', 'mummified_hand', 'You have no Powers yet, so it waits for one, such as Combust.'),
    moveChapter('a1r8c1', 'a1r9c1', 'Fungi Beasts', 'Two Fungi Beasts wait in the next fight.'),
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('Spore Cloud', 'Fungi Beasts have Spore Cloud: when one dies, everyone in its row becomes Vulnerable. Kill them on the same turn, or kill one when no big hit is coming.', at.enemies),
        say('Strength', 'Enemies can gain Strength too: each point adds 1 damage to every hit they deal. A Fungi Beast that grows stronger should die first.', at.intent('e0')),
        say('Your fight', 'Play this one yourself. Bash, then Twin Strike, kills a Fungi Beast in one turn, but think about the Vulnerable its Spore Cloud leaves on you first.', at.hand),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 1,
      potion: { id: 'vulnerable_potion', why: 'Drink it before your biggest attacks, just like Bash.' },
      cards: [
        ['twin_strike', 'A second Twin Strike.'],
        ['cleave', 'Costs 1: deal 2 damage to every enemy in a row and to any boss. Great against packs.'],
        ['shrug_it_off', 'Costs 1: gain 2 Block and draw a card.'],
      ],
      pick: null,
      pickWhy: 'A card that does not beat the Guardian only dilutes your deck. Skipping is a real choice: skip these.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'Spend what Gold you have left before the boss.'),
    merchantChapter('a1r10c1', [
      say('Shop on your own', 'Buy what you like. Good buys before the boss: a potion, or removing a Strike for 3 Gold. When you are done, leave the shop and proceed.', at.merchantPotions, at.merchantRemoval),
    ], false),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'Rest if two or three hits could kill you. Otherwise Smith a card you want to see against the Guardian, such as Bash or Carnage.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Guardian', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('The Guardian', 'The Act I boss has 40 HP. Bosses count as being in every row and always act last.', at.enemy('boss-0')),
        say('Its shell', 'This turn it attacks for 2 and gains 5 Block, which it keeps between turns. Next turn comes Mode Shift: if it still has Block, it drops the Block and attacks for 6. If you broke all its Block, it switches to Defensive Mode instead.', at.intent('boss-0')),
        say('The plan', 'It has no Block yet, so hit hard now: Carnage, then Headbutt to put Carnage back on top of your draw pile. Next turn, break all 5 Block to avoid the 6-damage hit.', at.hand),
        say('Potions', `Now is the time for potions. ${potionText('vulnerable_potion')}`, spot('.combat__actions')),
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

