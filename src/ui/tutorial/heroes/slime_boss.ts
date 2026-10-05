import {
  eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowGoldTaken, neowRedRevealed, neowRedTaken,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
// Registers the Slime Boss cards, which the spots below look up by name.
import '../../../game/downfall/slime-boss.ts'
import type { RunState } from '../../../game/run.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-slime_boss-237',
  neow: {
    card: 'heart_boon_09',
    red: ['slime_boss_flame_tackle', 'slime_boss_nibble_and_lick', 'slime_boss_recollect'],
    pick: 'slime_boss_flame_tackle',
    option: 0,
    effectCards: ['slime_boss_slime_slap'],
  },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c0', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['small_slime', 'downfall_acid_slime_wd2'],
      hand: ['slime_boss_defend', 'slime_boss_flame_tackle', 'slime_boss_slime_slap', 'slime_boss_strike', 'slime_boss_lick'],
      cards: ['slime_boss_prepare_crush', 'slime_boss_hungry_tackle', 'slime_boss_ooze_bath'], pick: 'slime_boss_prepare_crush' },
    a1r1c1: { kind: 'event', event: 'living_wall', option: 'forget', cards: ['slime_boss_strike'] },
    a1r2c1: { kind: 'fight', enemies: ['red_slaver'],
      hand: ['slime_boss_defend', 'slime_boss_prepare_crush', 'slime_boss_defend', 'slime_boss_flame_tackle', 'slime_boss_strike'],
      cards: ['slime_boss_protect_the_boss', 'slime_boss_living_wall', 'slime_boss_spit'], pick: 'slime_boss_spit' },
    a1r3c1: { kind: 'campfire' },
    a1r4c1: { kind: 'fight', enemies: ['looter'],
      hand: ['slime_boss_strike', 'slime_boss_strike', 'slime_boss_flame_tackle', 'slime_boss_prepare_crush', 'slime_boss_defend'],
      cards: ['slime_boss_delegate', 'slime_boss_taunting_slime', 'slime_boss_opening_tackle'], pick: 'slime_boss_taunting_slime' },
    a1r5c0: { kind: 'treasure', relic: 'captains_wheel' },
    a1r6c1: { kind: 'treasure', relic: 'straight_razor' },
    a1r7c1: { kind: 'event', event: 'transmogriphier', option: 'pray', cards: ['slime_boss_strike'] },
    a1r8c1: { kind: 'merchant', buy: [{ section: 'card', slot: 2, id: 'slime_boss_pile_on' }] },
    a1r9c1: { kind: 'fight', enemies: ['cultist', 'downfall_spike_slime_v2d'],
      hand: ['slime_boss_defend', 'slime_boss_taunting_slime', 'slime_boss_strike', 'slime_boss_spit', 'slime_boss_prepare_crush'],
      cards: ['slime_boss_opening_tackle', 'slime_boss_slippery', 'slime_boss_muscle_slime'], pick: null },
    a1r10c1: { kind: 'merchant' },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['downfall_dark_core'],
      hand: ['slime_boss_strike', 'slime_boss_lick', 'slime_boss_taunting_slime', 'slime_boss_flame_tackle', 'slime_boss_pile_on'] },
  },
  boss: 'downfall_dark_core',
}

const party = spot('.slime-party')
// The coach's selector check rejects the "!" in at.shopCard's exact title match.
const pileOnInShop = spot('.merchant-cards [title^="Pile On"]')
const bruiserChoice = spot('.prompt__mode', 'Bruiser Slime')
const tauntingSlime = spot('.slime-party__actor[data-slime-def="slime_boss_taunting_slime"]')
/** The end-of-turn Command waits for a target once two or more enemies stand. */
const endTurnStarted = (run: RunState) => !run.combat || run.combat.turn >= 2 || Boolean(run.combat.endTurnProgress)

export const SLIME_BOSS: HeroTutorial = {
  character: 'slime_boss',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with Slime Boss, a Downfall hero, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'Slime Boss has 9 HP. Attacks here deal 1 to 4 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relics', 'Your deck holds 4 Strikes, 4 Defends, Slime Slap and Lick; open it here any time. Your first relic summons Bruiser Slime at the start of every fight. Hover over or long-press a relic to read it.', at.deck, at.relics),
        say("The Heart's Boon", "Downfall heroes are the Spire's villains, so the Heart offers its Boon instead of Neow's Blessing. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.", at.neowCard),
        task('Take the Gold', "The Boon's red reward starts with 3 Gold. Gold buys cards, relics, potions and card removal from merchants. Take it.",
          neowGoldTaken, at.neowButton('Gain 3 Gold')),
        task('Reveal the Card Reward', "The rest of the red reward is a Card Reward: 3 cards from Slime Boss's reward deck. Reveal them.",
          neowRedRevealed, at.neowButton('Reveal Card Reward')),
        say('Flame Tackle', 'Costs 2: deal 2 damage to ALL enemies, then Command one of your Slimes. Great against packs.', at.offeredCard('slime_boss_flame_tackle')),
        say('Nibble and Lick', 'Costs 2: Grow a Slime, then Command it. No damage of its own.', at.offeredCard('slime_boss_nibble_and_lick')),
        say('Recollect', 'Costs 1: draw 2 cards. It has Retain: it stays in your hand at the end of your turn instead of being discarded.', at.offeredCard('slime_boss_recollect')),
        task('Take Flame Tackle', 'Flame Tackle hits every enemy and makes a Slime act too. Take it.', neowRedTaken, at.offeredCard('slime_boss_flame_tackle')),
        say('The blue options', 'Upgrade a card, Gain a Relic and lose 1 max HP, or Gain 11 Gold and lose 2 max HP. With only 9 HP, losing max HP hurts in every fight.', spot('.neow-options')),
        task('Upgrade a card', 'An upgrade costs nothing. Choose it.', neowBlueChosen, at.neowOption('Upgrade a card')),
        ...pickerSteps('Upgrade', 'slime_boss_slime_slap', 'Upgraded Slime Slap deals 4 damage instead of 2 and still Grows a Slime. Upgrades show on the card in green. Pick Slime Slap.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'The party climbs from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'Downfall heroes face the Downfall bosses. The Dark Core waits at the top: 32 HP, and it summons Dark Orbs that explode. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, 2 treasure chests and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Your first fight', 'A Small Slime (3 HP) and an Acid Slime (5 HP) stand in your row, so their attacks hit you. Bring both to 0 HP to win.', at.enemies),
        say('Your Slime party', 'Bruiser Slime fights beside you. It is not a card: your relic summons it at the start of every fight, and it stays all fight. The number on it is its level. Hover over or long-press it to read it.', party),
        say('Command', 'Commanding a Slime makes it act. Bruiser Slime hits an enemy for 1 at level 1, and for 2 at level 2, its highest. It is Commanded by itself at the end of each of your turns.', party),
        say('Enemy intents', 'The icons above enemies are their intents. On this die roll of 1, the Acid Slime will make you Weak, so your hits deal 1 less, and the Small Slime will attack for 1.', at.intent('e0-summon'), at.intent('e0'), at.die),
        say('Your hand', 'You get 3 Energy every turn. Slime Slap+ and Flame Tackle cost 2; Lick, Strike and Defend cost 1. The cost is in the top-left corner. Unplayed cards are discarded when your turn ends.', at.hand, at.energy),
        task('Slime Slap the Acid Slime', 'Slime Slap+ deals 4 and Grows a Slime. Tap it, tap the Acid Slime, then choose Bruiser Slime to Grow.',
          playedDown('slime_boss_slime_slap'), at.handCard('slime_boss_slime_slap'), at.enemy('e0-summon'), bruiserChoice),
        say('Grow', 'Bruiser Slime is now level 2, so each Command hits for 2. The Acid Slime is down to 1 HP.', party),
        task('Lick', 'Lick Commands a Slime. Tap Lick, choose Bruiser Slime, then tap the Acid Slime. It dies before it can make you Weak.',
          playedDown('slime_boss_lick'), at.handCard('slime_boss_lick'), bruiserChoice, at.enemy('e0-summon')),
        say('End of turn', 'You are out of Energy. When your turn ends, Bruiser is Commanded by itself and hits the Small Slime for 2, leaving it on 1 HP. Then the Small Slime hits you for 1.', party),
        task('End your turn', 'End the turn and watch Bruiser act, then the Small Slime.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('Taking damage', 'The Small Slime hit you for 1. Slime Boss does not heal after fights, so avoid damage you do not need to take.', at.hp),
        say('Your piles', 'Played and unplayed cards went to the discard pile. When the draw pile runs out, the discard pile is shuffled into it. Tap a pile to look inside.', at.piles),
        task('Finish it', 'One Strike deals the last point of damage.', playedDown('slime_boss_strike', 2), at.handCard('slime_boss_strike'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'The fight is won. Bruiser Slime returns at level 1 in every fight. Now collect the rewards.')],
      potion: { id: 'bottle_of_nails', why: 'Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['slime_boss_prepare_crush', 'Costs 3, a Power with Retain. Once played, it deals 15 damage at the start of your next turn, then goes to your discard pile.'],
        ['slime_boss_hungry_tackle', 'Costs 1: deal 2 damage and Exhaust a card in your hand. If that card costs 2 or more, gain 2 Energy.'],
        ['slime_boss_ooze_bath', 'Costs 2: Command one Slime once for each card with Retain in your hand. Needs a deck full of Retain.'],
      ],
      pick: 'slime_boss_prepare_crush',
      pickWhy: '15 damage kills most fights outright and takes half the Dark Core\'s HP. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Living Wall', 'Forget removes a card from your deck, Change transforms one into a random card, and Grow upgrades one.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. Every weak Strike you remove makes Slime Slap, Lick and Prepare Crush come up more often.'),
      task('Choose Forget', 'Remove a Strike, the weakest card in your deck.', shown('.card-picker'), at.eventOption('forget')),
      ...pickerSteps('Remove', 'slime_boss_strike', 'Pick a Strike.', roomLeft),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'A Red Slaver', 'The next fight is a single Red Slaver.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Red Slaver', 'The Red Slaver has 10 HP. On this die roll of 5 it will attack for 3.', at.enemy('e0'), at.intent('e0')),
        say('Prepare Crush', 'Your hand holds Prepare Crush. It costs all 3 Energy this turn, but at the start of your next turn it deals 15 damage, far more than the Red Slaver\'s HP.', at.handCard('slime_boss_prepare_crush')),
        task('Play Prepare Crush', 'Tap Prepare Crush to play it. Powers stay in play instead of going to the discard pile.',
          playedDown('slime_boss_prepare_crush'), at.handCard('slime_boss_prepare_crush')),
        say('Worth the hit', 'Loaded Die blocks 1 of the Slaver\'s 3 damage, so you lose 2 HP this turn. The fight ends the moment your next turn starts. Bruiser also hits for 1 at the end of this turn.', at.hero),
        task('End your turn', 'End the turn. Prepare Crush fires as your next turn begins.', turnReached(2), at.endTurn),
      ],
    },
    rewardChapter('a1r2c1', {
      intro: [say('Crushed', 'Prepare Crush dealt 15 at the start of your turn. Then it went to your discard pile, so you will draw it again.')],
      gold: 1,
      cards: [
        ['slime_boss_protect_the_boss', 'Costs 1: gain 2 Block. Retain.'],
        ['slime_boss_living_wall', 'Costs 2: gain 2 Block, plus 1 Block for each Slime you have in play.'],
        ['slime_boss_spit', 'Costs 1: draw 1 card, then Command a Slime. It replaces itself and makes a Slime act.'],
      ],
      pick: 'slime_boss_spit',
      pickWhy: 'More Commands make every Slime you have stronger. Take Spit.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r3c1',
      when: atCampfire('a1r3c1'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'The Red Slaver\'s hit left you low, and Slime Boss has no healing relic. Rest unless you are near full HP; otherwise Smith Lick, which then Commands up to 2 different Slimes.', at.hp),
      ],
    },
    moveChapter('a1r3c1', 'a1r4c1', 'A Looter', 'A Looter waits in the next room.'),
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('The Looter', 'The Looter has 9 HP and attacks for 2 now. On its third turn it steals 2 Gold and runs away, so kill it within 2 turns.', at.enemy('e0'), at.intent('e0')),
        task('Flame Tackle', 'Flame Tackle deals 2 to every enemy, then Commands a Slime. Tap it, then choose Bruiser Slime and the Looter.',
          playedDown('slime_boss_flame_tackle'), at.handCard('slime_boss_flame_tackle'), at.enemy('e0'), bruiserChoice),
        task('Defend', 'Defend gives 1 Block: each point stops 1 damage until your next turn.', playedDown('slime_boss_defend'), at.handCard('slime_boss_defend')),
        say('Retain', 'Prepare Crush has Retain, so it stays in your hand when the turn ends. You will have it next turn, when there is Energy to play it.', at.handCard('slime_boss_prepare_crush')),
        task('End your turn', 'Bruiser hits the Looter for 1, leaving it on 5 HP, and the Looter hits you for 2, 1 of it blocked.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        say('Loaded Die', 'The die rolled a 6, so your Loaded Die relic gave you 1 Block. You have the usual 3 Energy.', at.die, at.energy),
        say('No need to Crush', 'Prepare Crush would win next turn. Slime Slap+ and Spit win this turn, before the Looter hits again.', at.hand),
        task('Slime Slap the Looter', 'Slime Slap+ deals 4 and Grows Bruiser Slime to level 2. Choose Bruiser Slime to Grow.',
          playedDown('slime_boss_slime_slap'), at.handCard('slime_boss_slime_slap'), at.enemy('e0'), bruiserChoice),
        task('Spit', 'Spit draws a card and Commands Bruiser, now level 2, to finish the Looter.',
          playedDown('slime_boss_spit'), at.handCard('slime_boss_spit'), bruiserChoice, at.enemy('e0')),
      ],
    },
    rewardChapter('a1r4c1', {
      potion: { id: 'energy_drink', why: 'Pair it with Prepare Crush to play it for free.' },
      cards: [
        ['slime_boss_delegate', 'Costs 2: gain 3 Block and Command a Slime, then it Exhausts.'],
        ['slime_boss_taunting_slime', 'A Slime card. Costs 2: when played, gain 3 Block, then it joins your party. Commanded, it gives 1 Block at level 1, up to 3 at level 3.'],
        ['slime_boss_opening_tackle', 'Costs 1: deal 1 damage and Command a Slime.'],
      ],
      pick: 'slime_boss_taunting_slime',
      pickWhy: 'A second Slime means more to Command, and its Block keeps your 9 HP safe. Take Taunting Slime.',
    }),
    moveChapter('a1r4c1', 'a1r5c0', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r5c0', 'captains_wheel', 'A free Defend whenever the die shows 3.'),
    moveChapter('a1r5c0', 'a1r6c1', 'Another chest', 'This route opens two chests in a row.'),
    treasureChapter('a1r6c1', 'straight_razor', 'Resting can now also swap a weak card for a random new one. It is always optional.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('Transmogriphier', 'Pray transforms a card into a random card from your reward deck. Sacrifice transforms 2 cards but adds a Curse, a dead card that clogs your hand.', at.event),
      task('Choose Pray', 'Transform one card and take no Curse.', shown('.card-picker'), at.eventOption('pray')),
      ...pickerSteps('Transform', 'slime_boss_strike', 'A Strike is your weakest card. Pick one: it becomes Divide & Conquer, which Commands X different Slimes for X Energy.', roomLeft),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r8c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit. It is often the best buy in the shop.', at.merchantRemoval),
      task('Buy Pile On!', 'Pile On! costs 3 of your 6 Gold. For 1 Energy it deals 1 damage for each Slime you have in play: 2 once Taunting Slime joins Bruiser.',
        deckHas('slime_boss_pile_on'), pileOnInShop),
    ]),
    moveChapter('a1r8c1', 'a1r9c1', 'Cultist and slime', 'A Cultist and a Spike Slime wait in the next fight.'),
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('Two enemies', 'The Cultist (9 HP) attacks for 1, then gains 1 Strength: each turn it hits 1 harder. The Spike Slime (5 HP) will hit for 1 and make you Vulnerable, doubling the next hit on you. It acts last.', at.enemies),
        task('Play Taunting Slime', 'Slime cards are played like other cards. Taunting Slime gives you 3 Block, enough for both attacks, then joins your party.',
          playedDown('slime_boss_taunting_slime'), at.handCard('slime_boss_taunting_slime')),
        say('A bigger party', 'Taunting Slime joined your party at level 1. Commanded, it gives you 1 Block. Unlike Bruiser, it acts only when a card Commands it.', tauntingSlime),
        task('Spit', 'Spit draws a card and Commands one Slime. Choose Bruiser Slime and hit the Spike Slime for 1.',
          playedDown('slime_boss_spit'), at.handCard('slime_boss_spit'), bruiserChoice, at.enemy('e0-summon')),
        task('End your turn', 'With two enemies standing, Bruiser\'s end-of-turn Command needs a target. End the turn.', endTurnStarted, at.endTurn),
        task('Aim Bruiser', 'Drag Bruiser Slime onto the Spike Slime, or tap it and then the Spike Slime. That leaves the Spike Slime on 3 HP.',
          turnReached(2), spot('.end-turn-effect'), at.enemy('e0-summon')),
      ],
    },
    {
      id: 'fight-a1r9c1-turn-2',
      when: inFight('a1r9c1', 2),
      steps: [
        say('Captain\'s Wheel', 'The die shows 3, so Captain\'s Wheel gave you 3 Block. Your Block stopped both hits, but the Spike Slime still made you Vulnerable.', at.hero),
        say('Finish it your way', 'A tip: Flame Tackle hits both for 2 and its Command can finish the Spike Slime. Then Pile On! deals 2, 1 for each Slime. Play the rest of this fight yourself.', at.hand),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 1,
      potion: { id: 'transforming_brew', why: 'Use it on a Strike or Defend in hand to fish for something better.' },
      cards: [
        ['slime_boss_opening_tackle', 'Costs 1: deal 1 damage and Command a Slime.'],
        ['slime_boss_slippery', 'Costs 2: gain 2 Block. Costs 0 if you already spent 2 Energy on one card this turn.'],
        ['slime_boss_muscle_slime', 'A Slime card. Costs 2. Once per turn, when it gains Strength, it is Commanded: 2 damage at level 1. You have no way to give it Strength yet.'],
      ],
      pick: null,
      pickWhy: 'Every extra card makes Prepare Crush and Taunting Slime come up less often. Skipping is a real choice: skip these.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'Spend what Gold you have left before the boss.'),
    merchantChapter('a1r10c1', [
      say('Shop on your own', 'Buy what you like. Good buys before the boss: a Block Potion if you have a free potion slot, or removing a Strike for 3 Gold. When you are done, leave the shop and proceed.', at.merchantPotions, at.merchantRemoval),
    ], false),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'Rest unless you are at full HP; Straight Razor then also offers a transform, which you may skip. At full HP, Smith Prepare Crush (20 damage) or Taunting Slime.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Dark Core', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('The Dark Core', 'The Downfall Act I boss has 32 HP. This turn it attacks you for 2 and summons a Dark Orb.', at.enemy('boss-0'), at.intent('boss-0')),
        say('Dark Orbs', 'A Dark Orb has 8 HP. It does nothing on its first turn, then explodes for 4 and is gone. Next turn the Dark Core itself attacks for 4. Kill the Orb or have Block ready.', at.enemies),
        say('The plan', 'Play Taunting Slime early: its 3 Block covers this attack and it adds a Slime for Pile On!. Play Prepare Crush as soon as you draw it: 15 damage is almost half the boss.', at.hand),
        say('Potions', `Now is the time for potions. ${potionText('bottle_of_nails')}`, at.combatActions),
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
