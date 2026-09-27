import type { RunState } from '../../../game/run.ts'
import {
  eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowGoldTaken, neowRedRevealed, neowRedTaken,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-hexaghost-581',
  neow: { card: 'heart_boon_10', red: ['nightmare_vision', 'burning_touch', 'haunted_hand'], pick: 'burning_touch', option: 1, effectCards: ['sear'] },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c1', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['jaw_worm_first'], hand: ['sear', 'strike_hexaghost', 'strike_hexaghost', 'kindle', 'strike_hexaghost'],
      cards: ['spectral_grace', 'shield_of_night', 'heat_crush'], pick: 'heat_crush' },
    a1r1c1: { kind: 'event', event: 'big_fish', option: 'restraint', cards: ['strike_hexaghost'] },
    a1r2c1: { kind: 'fight', enemies: ['fungi_beast', 'downfall_fungi_beast'],
      hand: ['kindle', 'defend_hexaghost', 'defend_hexaghost', 'heat_crush', 'defend_hexaghost'],
      cards: ['bad_omen', 'worthy_sacrifice', 'float'], pick: null },
    a1r3c1: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'lingering_shades' }] },
    a1r4c1: { kind: 'fight', enemies: ['looter'], hand: ['defend_hexaghost', 'defend_hexaghost', 'kindle', 'burning_touch', 'defend_hexaghost'],
      cards: ['charged_barrage', 'flare_flick', 'power_from_beyond'], pick: null },
    a1r5c1: { kind: 'campfire' },
    a1r6c1: { kind: 'treasure', relic: 'bird_faced_urn' },
    a1r7c1: { kind: 'event', event: 'transmogriphier', option: 'pray', cards: ['defend_hexaghost'] },
    a1r8c1: { kind: 'treasure', relic: 'runic_pyramid' },
    a1r9c1: { kind: 'fight', enemies: ['small_slime', 'downfall_acid_slime_wd2', 'downfall_spike_slime_vd2'],
      hand: ['strike_hexaghost', 'sword_of_night', 'burning_touch', 'heat_crush', 'strike_hexaghost'],
      cards: ['burning_touch', 'seventh_eye', 'premonition'], pick: null },
    a1r10c1: { kind: 'merchant' },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['downfall_dark_core'],
      hand: ['defend_hexaghost', 'lingering_shades', 'strike_hexaghost', 'kindle', 'strike_hexaghost'] },
  },
  boss: 'downfall_dark_core',
}

// Hexaghost's own controls: the Soulburn button and Lingering Shades' button
// both sit in the combat actions bar (see CombatScreen.tsx).
const soulburnButton = spot('[aria-label^="Spend Soulburn"]')
const shadesButton = spot('[aria-label="Use Lingering Shades"]')
const soulburn = (run: RunState) => run.combat?.players[0]?.soulburn ?? 0
const soulburnLeft = (left: number) => (run: RunState) => !run.combat || soulburn(run) <= left
const soulburnAtLeast = (count: number) => (run: RunState) => !run.combat || soulburn(run) >= count
/** The Dark Orb the boss summons at the start of turn 2. */
const DARK_ORB = 'boss-0-summon-2-0-0'

export const HEXAGHOST: HeroTutorial = {
  character: 'hexaghost',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with Hexaghost, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'Hexaghost has 9 HP. Attacks here deal 1 to 4 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relic', 'Your deck holds 4 Strikes, 4 Defends, Kindle and Sear; open it here any time. Your relic gives you 1 Soulburn at the start of every fight. Soulburn is Hexaghost\'s fire: the coach shows it in your first fight.', at.deck, at.relics),
        say("The Heart's Boon", 'Downfall heroes start with the Heart\'s Boon instead of Neow\'s Blessing. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.', at.neowCard),
        task('Take the Gold', 'The Heart\'s red reward starts with 3 Gold. Gold buys cards, relics, potions and card removal from merchants. Take it.',
          neowGoldTaken, at.neowButton('Gain 3 Gold')),
        task('Reveal the Card Reward', 'The rest of the red reward is a Card Reward: 3 cards from Hexaghost\'s reward deck. Reveal them.',
          neowRedRevealed, at.neowButton('Reveal Card Reward')),
        say('Nightmare Vision', 'Costs 1: draw 2 cards. If it is ever Exhausted, you gain 2 Energy. You have no way to Exhaust it yet.', at.offeredCard('nightmare_vision')),
        say('Burning Touch', 'Costs 2: deal 2 damage and gain 1 Soulburn. Each Soulburn is extra damage you can spend later.', at.offeredCard('burning_touch')),
        say('Haunted Hand', 'Costs 1: if you have at least 2 Heat, gain 1 Strength, then Retract. It Exhausts: once per fight.', at.offeredCard('haunted_hand')),
        task('Take Burning Touch', 'Burning Touch hits and feeds your Soulburn, Hexaghost\'s best damage. Take it.', neowRedTaken, at.offeredCard('burning_touch')),
        say('The blue options', 'Remove 2 starter Defends, Upgrade a card, or Transform a card, then upgrade it, for 1 max HP. Max HP is precious with only 9.', spot('.neow-options')),
        task('Upgrade a card', 'An upgrade is a sure thing, and it makes your first fight a clean win. Choose it.', neowBlueChosen, at.neowOption('Upgrade a card')),
        ...pickerSteps('Upgrade', 'sear', 'Sear costs 0. Upgraded, it deals 2, or 3 once you have at least 2 Heat. Upgrades show on the card in green. Pick Sear.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'The Dark Core waits at the top: 32 HP, hits that land on you every turn, and Dark Orbs that explode. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, 2 treasure chests and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Your first fight', 'This Jaw Worm has 7 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('Enemy intent', 'The icon above an enemy is its intent. The Jaw Worm rolled a 3: it will attack for 2 and gain 1 Block. Many enemies pick their move from the die rolled each round. This one will not get to act.', at.intent('e0'), at.die),
        say('Your hand', 'You drew Kindle, Sear+ and 3 Strikes. You get 3 Energy a turn: Kindle and Strike cost 1, Sear costs 0. A card\'s cost is in its top-left corner.', at.hand, at.energy),
        say('The Heat track', 'The flames around Hexaghost are its Heat, from 1 to 6. Every fight starts at 1. Advance adds 1 Heat, Retract removes 1, and Heat stays for the whole fight. Many of your cards grow stronger at higher Heat.', at.hero),
        task('Play Kindle', 'Kindle gives 1 Block and Advances: Heat goes to 2. Tap Kindle to play it.', playedDown('kindle'), at.handCard('kindle'), at.hero),
        task('Sear the Jaw Worm', 'With 2 Heat, Sear+ deals 3 instead of 2, for 0 Energy. Tap Sear, then tap the Jaw Worm, or drag Sear onto it.', playedDown('sear'), at.handCard('sear'), at.enemy('e0')),
        task('Strike', 'A Strike deals 1. The Jaw Worm is on 4 HP.', playedDown('strike_hexaghost', 2), at.handCard('strike_hexaghost'), at.enemy('e0')),
        task('Strike again', 'One more Strike leaves it on 2 HP, and your Energy is spent.', playedDown('strike_hexaghost', 1), at.handCard('strike_hexaghost'), at.enemy('e0')),
        say('Soulburn', 'Soulburn is not a card. You gain 1 at the start of every fight, can hold up to 6, and can spend it any time you could play a card, for no Energy. It deals damage equal to your Heat: 2 right now.', soulburnButton),
        task('Spend Soulburn', 'Tap the Soulburn button, then tap the Jaw Worm. 2 damage finishes it.', soulburnLeft(0), soulburnButton, at.enemy('e0')),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'A clean win: Advance first, then every card and your Soulburn hit harder. Now collect the rewards.')],
      gold: 1,
      potion: { id: 'bottle_of_nails', why: 'Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['spectral_grace', 'Costs 1: gain 3 Block, then it Exhausts: it is gone until the fight ends.'],
        ['shield_of_night', 'Costs 2: gain 3 Block and Exhaust a card from your hand, such as a Strike or a Burn.'],
        ['heat_crush', 'Costs 1: deal 2 damage, and your next Soulburn this turn deals 1 more.'],
      ],
      pick: 'heat_crush',
      pickWhy: 'Heat Crush makes your Soulburn hit harder. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Big Fish', 'Banana heals 2 HP, Donut upgrades a Strike, Box gives a relic and a Curse, and Restraint removes a Strike.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. Every Strike you remove makes Kindle, Sear and Heat Crush come up more often. Your HP is full, so the Banana is wasted.'),
      task('Choose Restraint', 'Remove a Strike, the weakest card in your deck.', shown('.card-picker'), at.eventOption('restraint')),
      ...pickerSteps('Remove', 'strike_hexaghost', 'Pick a Strike.', roomLeft),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Fungi Beasts', 'Two Fungi Beasts wait in the next room.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Two Fungi Beasts', 'The Fungi Beast with 6 HP will attack for 2. The one with 5 HP will gain 2 Strength: every hit it deals later does 2 more. Stop it before it grows.', at.intent('e0'), at.intent('e0-summon')),
        say('Spore Cloud', 'When a Fungi Beast dies, everyone in its row becomes Vulnerable: the next hit on you is doubled. You will take that, because killing the Strength one now is worth it.', at.enemies),
        task('Play Kindle', 'Advance to 2 Heat first, so your Soulburn deals 2, and gain 1 Block.', playedDown('kindle'), at.handCard('kindle'), at.hero),
        task('Heat Crush', 'Deal 2 to the Fungi Beast with 5 HP. Your next Soulburn this turn deals 1 more.', playedDown('heat_crush'), at.handCard('heat_crush'), at.enemy('e0-summon')),
        task('Soulburn it', 'Your Heat plus Heat Crush\'s bonus: 3 damage finishes it.', soulburnLeft(0), soulburnButton, at.enemy('e0-summon')),
        task('Defend', 'You are Vulnerable now, so the 2-damage attack becomes 4. Defend adds 1 Block to Kindle\'s 1.', playedDown('defend_hexaghost', 2), at.handCard('defend_hexaghost'), at.hero),
        task('End your turn', 'Your 2 Block stops half of the 4 damage. End the turn.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        say('Your turn to lead', 'Heat is still 2, but your Soulburn is spent. Burning Touch deals 2 and gives you a new Soulburn to spend at once. Finish the last Fungi Beast your way.', at.hand),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      potion: { id: 'block_potion', why: 'Drink it before a big hit lands.' },
      cards: [
        ['bad_omen', 'Costs 1: gain 2 Block, apply 2 Weak if you have at least 2 Heat, then Retract.'],
        ['worthy_sacrifice', 'A Power: at the start of each turn, Exhaust a card from your hand and gain 1 Block.'],
        ['float', 'Costs 1: gain 2 Energy, or 3 at 4 Heat or more. It Exhausts.'],
      ],
      pick: null,
      pickWhy: 'None of these helps much yet, and every extra card makes Kindle and Heat Crush rarer. Skipping is a real choice: skip these.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r3c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit.', at.merchantRemoval),
      task('Buy Lingering Shades', 'A Power costing 2 that stays in play all fight. Once per turn, pay 1 Energy for 1 Soulburn: at 2 Heat, better than a Strike. It costs 3 of your 7 Gold.',
        deckHas('lingering_shades'), at.shopCard('lingering_shades')),
    ]),
    moveChapter('a1r3c1', 'a1r4c1', 'A Looter', 'A thief waits in the next room.'),
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('The Looter', 'It has 9 HP and moves along a fixed track: attack for 2, then attack for 3 and gain 1 Block, then steal 2 Gold and flee. Kill it within 2 turns.', at.enemy('e0'), at.intent('e0')),
        task('Play Kindle', 'Advance to 2 Heat and gain 1 Block.', playedDown('kindle'), at.handCard('kindle'), at.hero),
        task('Burning Touch', 'Deal 2 and gain 1 Soulburn. You now hold 2.', playedDown('burning_touch'), at.handCard('burning_touch'), at.enemy('e0')),
        task('Spend both Soulburns', 'Each deals 2, your Heat. Spend one, then the other. The Looter drops to 3 HP.', soulburnLeft(0), soulburnButton, at.enemy('e0')),
        task('End your turn', 'The Defends cost Energy you no longer have. The Looter hits for 2, and Kindle\'s Block stops 1.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        task('Sear it', 'Your Heat is still 2, so Sear+ deals 3: exactly what the Looter has left.', playedDown('sear'), at.handCard('sear'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r4c1', {
      potion: { id: 'cactus_juice', why: 'Some enemies shuffle Daze or Burn into your deck. A Burn in your hand at the end of your turn deals you 1 damage. This clears them.' },
      cards: [
        ['charged_barrage', 'Costs 2: deal 3 damage to a whole row and any boss, or 5 at 4 Heat or more.'],
        ['flare_flick', 'Costs 1: hit a whole row and any boss for 1, twice at 2 Heat or more.'],
        ['power_from_beyond', 'Costs 2: gain 1 Strength per Attack in your Exhaust pile. It Exhausts.'],
      ],
      pick: null,
      pickWhy: 'Charged Barrage is strong once you reach 4 Heat, but this deck rarely does. Keep the deck lean for the boss: skip these.',
    }),
    moveChapter('a1r4c1', 'a1r5c1', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r5c1',
      when: atCampfire('a1r5c1'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'Rest if you are below 7 HP. Otherwise Smith: upgraded Lingering Shades costs 1, and upgraded Heat Crush adds 3 to your next Soulburn. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r5c1', 'a1r6c1', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r6c1', 'bird_faced_urn', 'Lingering Shades is a Power, so playing it now also gives 1 Block.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('Transmogriphier', 'Pray transforms one card into a random card from your reward deck. Sacrifice transforms two, but adds a Curse.', at.event),
      task('Choose Pray', 'You still have 4 Defends, more than you need. Turn one into something new.', shown('.card-picker'), at.eventOption('pray')),
      ...pickerSteps('Transform', 'defend_hexaghost', 'Pick a Defend.', roomLeft),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'One more chest', 'This route passes a second chest.', [
      say('Sword of Night', 'The Defend became Sword of Night. Costs 1: deal 2 damage and Exhaust a card from your hand. Exhausted cards are gone until the fight ends: a good home for Burns and Daze.', at.deck),
    ]),
    treasureChapter('a1r8c1', 'runic_pyramid', 'Use it on a turn when you want to keep good cards for the next one.'),
    moveChapter('a1r8c1', 'a1r9c1', 'Into the slimes', 'The last fight before the boss is a pack of three slimes.'),
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('Three slimes', 'A Small Slime (3 HP) attacks for 1, the Acid Slime (5 HP) for 2 and the Spike Slime (5 HP) for 1. The Acid and Spike Slimes each put a Daze on top of your draw pile: a card you cannot play.', at.intent('e0'), at.intent('e0-summon'), at.intent('e0-summon-1')),
        say('Your fight', 'No Kindle this time, so Heat is 1. Try: Sword of Night on the Acid Slime, Exhausting a Strike in the window that opens, then Heat Crush and Soulburn it (1 + 1 damage). A Strike on the Small Slime uses your last Energy.', at.hand),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 1,
      cards: [
        ['burning_touch', 'A second Burning Touch.'],
        ['seventh_eye', 'Costs 2: deal 2 damage and gain 2 Block. At 5 Heat it also applies Weak and Vulnerable.'],
        ['premonition', 'Costs 1: gain 2 Block, and draw 2 cards at 3 Heat or more.'],
      ],
      pick: null,
      pickWhy: 'The coach has planned your boss fight around the deck you have now. Skip these.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'One more shop before the boss.'),
    merchantChapter('a1r10c1', [
      task('Potions only', 'A new card or a removal would change the boss fight the coach has planned. Buy a potion if your belt has room (Explosive Potion hits a whole row and the boss), then leave the shop.',
        shown('.merchant-arrival'), at.merchantPotions, at.merchantLeave),
      task('Move on', 'Proceed to return to the map.', roomLeft, at.merchantProceed),
    ], false),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'The Dark Core deals a lot of damage. Rest unless you are at full HP; then Smith Lingering Shades or Kindle.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Dark Core', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('The Dark Core', 'The boss has 32 HP. Bosses count as being in every row and always act last. Its moves follow a fixed track, so the coach can tell you what comes next.', at.enemy('boss-0')),
        say('This turn', 'It will attack you for 2 and summon a Dark Orb. Next turn it attacks for 4. Later: two hits of 1, then 3 damage and 3 Block, then 1 Strength and another Orb.', at.intent('boss-0')),
        task('Play Lingering Shades', 'Your Power costs 2 and stays all fight. Bird-Faced Urn gives 1 Block as you play it.', playedDown('lingering_shades'), at.handCard('lingering_shades'), at.hero),
        task('Play Kindle', 'Advance to 2 Heat. Its 1 Block and the Urn\'s 1 stop the whole 2-damage attack.', playedDown('kindle'), at.handCard('kindle'), at.hero),
        task('Soulburn the boss', 'Your free Soulburn deals 2.', soulburnLeft(0), soulburnButton, at.enemy('boss-0')),
        task('End your turn', 'Your Energy is spent. End the turn.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r12c0-turn-2',
      when: inFight('a1r12c0', 2),
      steps: [
        say('The Dark Orb', 'The Orb has 8 HP. It does nothing this turn, then hits you for 4 and breaks. The boss hits for 4 this turn too. Break the Orb now.', at.enemy(DARK_ORB), at.intent('boss-0')),
        task('Heat Crush the Orb', 'Deal 2. Your next Soulburn this turn deals 1 more.', playedDown('heat_crush'), at.handCard('heat_crush'), at.enemy(DARK_ORB)),
        task('Use Lingering Shades', 'Pay 1 Energy for 1 Soulburn, once per turn.', soulburnAtLeast(1), shadesButton),
        task('Soulburn the Orb', '2 Heat plus 1 from Heat Crush: 3 damage.', soulburnLeft(0), soulburnButton, at.enemy(DARK_ORB)),
        task('Sear the Orb', 'Sear+ deals 3 and breaks the last 3 HP.', playedDown('sear'), at.handCard('sear'), at.enemy(DARK_ORB)),
        say('Finish it yourself', `Defend with your last Energy, and end your turn when you are ready. From here the fight is yours: build Heat, keep Soulburn coming, and drink any potions you kept. ${potionText('block_potion')}`, at.hand, at.combatActions),
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
