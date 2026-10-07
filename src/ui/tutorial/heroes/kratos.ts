import {
  NEOW_GOLD, NEOW_REVEAL, eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowRedTaken,
  pickerSteps, potionText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, deckHas, inFight, inNeow, inReward, playedDown, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-kratos-19',
  neow: { card: 'neow_03', red: ['kratos_rage_of_the_gods', 'kratos_spartan_guard', 'kratos_icarus_wings'], pick: 'kratos_rage_of_the_gods',
    option: 0, effectCards: ['kratos_plume_of_prometheus'] },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c0', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['red_louse_first', 'green_louse_21w'],
      hand: ['strike_kratos', 'kratos_rage_of_the_gods', 'defend_kratos', 'strike_kratos', 'defend_kratos'],
      cards: ['kratos_spartan_guard', 'kratos_icarus_wings', 'kratos_bow_of_apollo'], pick: 'kratos_bow_of_apollo' },
    a1r1c1: { kind: 'event', event: 'the_library', option: 'read', pick: 'kratos_servant_of_ares' },
    a1r2c1: { kind: 'fight', enemies: ['jaw_worm'],
      hand: ['kratos_bow_of_apollo', 'defend_kratos', 'strike_kratos', 'defend_kratos', 'strike_kratos'],
      cards: ['kratos_atlas_quake', 'kratos_hermes_rush', 'kratos_loom_of_fate'], pick: 'kratos_atlas_quake' },
    a1r3c1: { kind: 'merchant', buy: [{ section: 'card', slot: 1, id: 'kratos_ghost_of_sparta' }] },
    a1r4c1: { kind: 'fight', enemies: ['red_louse', 'green_louse', 'red_louse_summon'],
      hand: ['defend_kratos', 'defend_kratos', 'defend_kratos', 'kratos_blades_of_chaos', 'strike_kratos'],
      cards: ['kratos_poseidons_rage', 'kratos_orions_harpoon', 'kratos_typhons_bane'], pick: 'kratos_orions_harpoon' },
    a1r5c0: { kind: 'campfire' },
    a1r6c1: { kind: 'treasure', relic: 'necronomicon' },
    a1r7c1: { kind: 'event', event: 'big_fish', option: 'restraint', cards: ['strike_kratos'] },
    a1r8c1: { kind: 'treasure', relic: 'lantern' },
    a1r9c1: { kind: 'fight', enemies: ['large_slime'],
      hand: ['kratos_orions_harpoon', 'kratos_bow_of_apollo', 'defend_kratos', 'strike_kratos', 'defend_kratos'],
      cards: ['kratos_sacrifice', 'kratos_rage_of_the_gods', 'kratos_hermes_rush'], pick: null },
    a1r10c1: { kind: 'merchant' },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['guardian_attack'],
      hand: ['kratos_blades_of_chaos', 'kratos_bow_of_apollo', 'kratos_servant_of_ares', 'kratos_orions_harpoon', 'kratos_plume_of_prometheus'] },
  },
  boss: 'guardian_attack',
}

const RAGE = spot('.rage-meter')

export const KRATOS: HeroTutorial = {
  character: 'kratos',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with Kratos, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'Kratos has 10 HP. Attacks here deal 1 to 4 damage, so every point matters. Every time you lose HP, you also gain Rage, and you heal 1 HP after each fight. At 0 HP the run is over.', at.hp),
        say('Deck and relics', 'Your deck holds 4 Strikes, 4 Defends, Blades of Chaos and Plume of Prometheus; open it here any time. Ashes of Sparta feeds your Rage and heals you after each fight. Loaded Die gives 1 Block on a 4 or 5; on a 6, it can give that Block or trigger another die relic ability.', at.deck, at.relics),
        say("Neow's Blessing", 'Every run starts with Neow. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.', at.neowCard),
        NEOW_GOLD,
        NEOW_REVEAL,
        say('Rage of the Gods', 'Costs 0: gain 2 Rage, then it Exhausts: it is gone until the fight ends. Rage is Kratos\'s own resource, and you will see it work in the first fight.', at.offeredCard('kratos_rage_of_the_gods')),
        say('Spartan Guard', 'Costs 1: gain 2 Block, or 6 Block if you can Unleash 2: spend 2 Rage. Good, but that Rage is then gone for your attacks.', at.offeredCard('kratos_spartan_guard')),
        say('Icarus Wings', 'Costs 1: gain 1 Block and draw 2 cards. A plain card that replaces itself.', at.offeredCard('kratos_icarus_wings')),
        task('Take Rage of the Gods', 'Free Rage powers Plume of Prometheus and every Unleash card you will find later. Take it.', neowRedTaken, at.offeredCard('kratos_rage_of_the_gods')),
        say('The blue options', 'Upgrade 1 card, Gain 5 Gold, or Gain 1 Relic and 1 Curse. A Curse is a dead card that clogs your hand.', spot('.neow-options')),
        task('Upgrade 1 card', 'An upgrade is a sure thing. Choose it.', neowBlueChosen, at.neowOption('Upgrade 1 card')),
        ...pickerSteps('Upgrade', 'kratos_plume_of_prometheus', 'Plume of Prometheus+ deals 2 damage, or 6 with Unleash 2, instead of 1 or 5. Upgrades show on the card in green. Pick Plume of Prometheus.', neowDone),
      ],
    },
    moveChapter(null, 'a1r0c0', 'Enter the first fight', 'Tap the glowing room to walk in. Every tutorial fight is the same each time, so the coach knows what you will draw.', [
      say('The map', 'You climb from the bottom row to the boss at the top. Each step you pick a room connected to the one you stand in, and reachable rooms glow.'),
      say('Room types', 'Skulls are fights, horned skulls are Elites (hard fights that drop a relic), "?" rooms are events, and there are merchants, campfires and treasure chests.', at.legend),
      say('The boss', 'The Guardian waits at the top: 40 HP and a thick shell of Block. Everything on this route prepares you for it.', at.boss),
      say('Your route', 'The coach will lead you through 4 fights, 2 events, 2 merchants, 2 treasure chests and 2 campfires, and around the Elites.'),
    ]),
    {
      id: 'fight-a1r0c0-turn-1',
      when: inFight('a1r0c0', 1),
      steps: [
        say('Your first fight', 'Two lice with 3 HP each. They stand in your row, so their attacks hit you. Curl Up: the first time a louse loses HP, it gains 2 Block.', at.enemies),
        say('Enemy intent', 'The icon above an enemy is its intent. The Red Louse will attack for 1, and the Green Louse will make you Weak: your next hit deals 1 less. Many enemies pick their move from the die rolled each round.', at.intent('e0'), at.intent('e0-summon'), at.die),
        say('Rage', 'Ashes of Sparta gave you 2 Rage at the start of the fight. Rage fills this meter, up to 5, and is kept between turns. You gain 1 more each time you lose HP. Unleash cards spend it.', RAGE),
        say('Your hand', 'You drew 2 Strikes, 2 Defends and Rage of the Gods. You get 3 Energy every turn, and unspent Energy is lost. A card\'s cost is in its top-left corner.', at.hand, at.energy),
        task('Rage of the Gods', 'It costs 0: gain 2 Rage, then it Exhausts. You now hold 4 Rage. Tap the card to play it.', playedDown('kratos_rage_of_the_gods'), at.handCard('kratos_rage_of_the_gods')),
        task('Strike', 'A Strike deals 1. The louse curls up and gains 2 Block, which soaks up your next hit.', playedDown('strike_kratos', 1), at.handCard('strike_kratos'), at.enemy('e0')),
        task('Strike again', 'Your last Strike hits the Block: the Red Louse stays on 2 HP. Enemy Block wears off before your next turn.', playedDown('strike_kratos'), at.handCard('strike_kratos'), at.enemy('e0')),
        task('End your turn', 'Your 4 Rage waits for next turn. Loaded Die\'s 1 Block covers the Red Louse\'s attack, and the Green Louse will make you Weak. Enemies act after you.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('Weak', 'The Green Louse made you Weak: your next hit deals 1 less, then the token is removed. The Red Louse has 2 HP, the Green Louse still has 3, and you kept your 4 Rage.', at.hero, at.enemies),
        say('Unleash', 'Plume of Prometheus+ deals 2. Unleash 2: if you have 2 Rage, spend it to deal 6 damage instead. Weak takes 1 off, so it deals 5: plenty for the Green Louse.', at.handCard('kratos_plume_of_prometheus')),
        task('Plume of Prometheus', 'Tap Plume of Prometheus, then tap the Green Louse. It spends 2 Rage and kills it.', playedDown('kratos_plume_of_prometheus'), at.handCard('kratos_plume_of_prometheus'), at.enemy('e0-summon')),
        task('Blades of Chaos', 'Blades of Chaos deals 1 damage to a whole row and gains 1 Rage. The Red Louse drops to 1 HP.', playedDown('kratos_blades_of_chaos'), at.handCard('kratos_blades_of_chaos'), at.enemy('e0')),
        task('Strike', 'Finish the Red Louse. Rage is lost when a fight ends, so spending it is never a waste.', playedDown('strike_kratos'), at.handCard('strike_kratos'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r0c0', {
      gold: 1,
      cards: [
        ['kratos_spartan_guard', 'Costs 1: gain 2 Block, or 6 with Unleash 2. Block you can plan around.'],
        ['kratos_icarus_wings', 'Costs 1: gain 1 Block and draw 2 cards. It replaces itself, but does nothing for Rage.'],
        ['kratos_bow_of_apollo', 'Costs 0: deal 1 damage, or 3 with Unleash 1. Cheap damage that turns 1 Rage into 2 extra damage.'],
      ],
      pick: 'kratos_bow_of_apollo',
      pickWhy: 'Bow of Apollo costs no Energy and only needs 1 Rage to Unleash. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('The Library', 'Read shows a Card Reward of 5 cards instead of 3. Sleep heals 3 HP, but you are at full HP.', at.event),
      task('Choose Read', 'Reading costs nothing. Look at the 5 cards.', shown('.reward-screen--card-choice'), at.eventOption('read')),
      say('Five cards', 'Nemean Roar hits a row, Blade of Artemis hits Elites and Bosses harder, Rage of the Titans spends all your Rage, and Hyperion Charge deals 3 for 2 Energy.', spot('.reward-screen__cards')),
      task('Take Servant of Ares', 'A Power stays in play for the whole fight. Servant of Ares gives you 1 Rage at the start of every turn, so you always have something to Unleash. Take it.', roomLeft, at.offeredCard('kratos_servant_of_ares')),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Face a Jaw Worm', 'A Jaw Worm waits in the next room.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('The Jaw Worm', 'It has 10 HP and will attack for 3 and gain 1 Block. Enemy Block stops your hits until its next turn.', at.enemy('e0'), at.intent('e0')),
        say('Bow of Apollo', 'Costs 0: deal 1 damage. Unleash 1: spend 1 Rage to deal 3 instead. Ashes of Sparta gave you 2 Rage.', at.handCard('kratos_bow_of_apollo'), RAGE),
        say('Hold Rage', 'To skip an Unleash and keep your Rage for a bigger card, tap the Rage meter first: it Holds Rage until you tap it again. Not now: you want this Unleash.', RAGE),
        task('Unleash Bow of Apollo', 'Tap Bow of Apollo, then tap the Jaw Worm. It spends 1 Rage and deals 3: the Jaw Worm drops to 7 HP.', playedDown('kratos_bow_of_apollo'), at.handCard('kratos_bow_of_apollo'), at.enemy('e0')),
        task('Strike', 'A Strike deals 1.', playedDown('strike_kratos', 1), at.handCard('strike_kratos'), at.enemy('e0')),
        task('Strike', 'Another Strike. The Jaw Worm is on 5 HP.', playedDown('strike_kratos'), at.handCard('strike_kratos'), at.enemy('e0')),
        say('Pain into Rage', 'You skip Defend this once to see the Rage: with no Block, the Jaw Worm\'s attack will cost you 3 HP. However much HP you lose in one hit, Ashes of Sparta gives you 1 Rage for it.', at.hero),
        task('End your turn', 'End the turn and take the hit.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        say('Pain, then Rage', 'You are on 7 HP and have 2 Rage again. The Jaw Worm gained 1 Block, so your first Strike will only break it.', at.hero, RAGE),
        task('Servant of Ares', 'Costs 1. This Power stays in play: you gain 1 Rage at the start of every turn from now on.', playedDown('kratos_servant_of_ares'), at.handCard('kratos_servant_of_ares')),
        say('Your fight', 'The Jaw Worm has 5 HP and 1 Block, so this takes more than one turn: your first Strike only breaks its Block. Defend when its attack would hurt: you have 7 HP left.', at.hand),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      cards: [
        ['kratos_atlas_quake', 'Costs 2: deal 2 damage to a row. Unleash 2: also apply 1 Weak and 1 Vulnerable to that row.'],
        ['kratos_hermes_rush', 'Costs 1: gain 2 Block (to any player), and Unleash 1 draws a card. Built for co-op.'],
        ['kratos_loom_of_fate', 'Costs 1: put a card from your discard pile into your hand and gain 1 Rage.'],
      ],
      pick: 'kratos_atlas_quake',
      pickWhy: 'Atlas Quake sweeps a whole row and spends spare Rage on Weak and Vulnerable. Take it.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r3c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Relics and potions', 'Relics and potions show their prices. Read any of them by hovering over or long-pressing it.', at.merchantRelics, at.merchantPotions),
      say('Card removal', 'For 3 Gold the merchant removes one card from your deck, once per visit.', at.merchantRemoval),
      task('Buy Ghost of Sparta', 'Ghost of Sparta costs 3 of your 7 Gold. A Power: whenever you spend Rage on an Unleash, gain 1 Block, so every Unleash also protects you.',
        deckHas('kratos_ghost_of_sparta'), at.shopCard('kratos_ghost_of_sparta')),
    ]),
    moveChapter('a1r3c1', 'a1r4c1', 'Three lice', 'Three lice wait in the next room.'),
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('A row of lice', 'A Red Louse with 4 HP, a Green Louse with 3 and another Red Louse with 3. They all stand in one row, so one row attack reaches every one of them.', at.enemies),
        task('Blades of Chaos', 'Deal 1 damage to the whole row and gain 1 Rage. All three lice drop a point and curl up with 2 Block each.', playedDown('kratos_blades_of_chaos'), at.handCard('kratos_blades_of_chaos'), at.enemy('e0')),
        task('Defend', 'Defend twice. Your Block stops the lice\'s small attacks, and what gets through feeds your Rage.', playedDown('defend_kratos', 1), at.handCard('defend_kratos')),
        task('End your turn', 'The lice act after you.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        say('Rage 4', 'You lost 1 HP and gained 1 Rage: you hold 4. Their Block wore off before they acted, and they have 3, 2 and 2 HP left.', at.hero, RAGE),
        task('Atlas Quake', 'Costs 2: 2 damage to the row, and Unleash 2 also makes it Weak and Vulnerable. Tap Atlas Quake, then a louse. Two lice die, the third is left on 1 HP.', playedDown('kratos_atlas_quake'), at.handCard('kratos_atlas_quake'), at.enemy('e0')),
        task('Strike', 'A Strike finishes the last louse.', playedDown('strike_kratos', 2), at.handCard('strike_kratos'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r4c1', {
      gold: 1,
      cards: [
        ['kratos_poseidons_rage', 'Costs 2: deal 3 damage to a row, or 5 with Unleash 2. Big, but you already have Atlas Quake.'],
        ['kratos_orions_harpoon', 'Costs 1: deal 2 damage and gain 1 Rage. It attacks and makes the Rage you spend.'],
        ['kratos_typhons_bane', 'Costs 1: assign 2 Weak tokens to any enemies. Useful against big hitters.'],
      ],
      pick: 'kratos_orions_harpoon',
      pickWhy: 'Orion\'s Harpoon is a better Strike that refills your Rage for Plume of Prometheus and Atlas Quake. Take it.',
    }),
    moveChapter('a1r4c1', 'a1r5c0', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r5c0',
      when: atCampfire('a1r5c0'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'Rest if you are below 6 HP: Kratos cannot take many hits. Otherwise Smith a card you play every fight, such as Blades of Chaos, Atlas Quake or Servant of Ares. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r5c0', 'a1r6c1', 'Open a chest', 'Every route crosses the row of treasure chests.'),
    treasureChapter('a1r6c1', 'necronomicon', 'A doubled Orion\'s Harpoon or Blades of Chaos gains its Rage twice, and a doubled Bow of Apollo can Unleash twice if you have the Rage.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('Big Fish', 'Banana heals 2 HP, Donut upgrades a Strike, Box gives a relic and a Curse, and Restraint removes a Strike.', at.event),
      say('Why remove a card?', 'You draw 5 cards a turn. Every Strike you remove makes Plume of Prometheus, Blades of Chaos and your new cards come up more often. The Banana only heals 2 HP.'),
      task('Choose Restraint', 'Remove a Strike, the weakest card in your deck.', shown('.card-picker'), at.eventOption('restraint')),
      ...pickerSteps('Remove', 'strike_kratos', 'Pick a Strike.', roomLeft),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'One more chest', 'This route passes a second chest.'),
    treasureChapter('a1r8c1', 'lantern', 'You start every fight with 4 Energy, so turn 1 can hold a whole combo.'),
    moveChapter('a1r8c1', 'a1r9c1', 'A Large Slime', 'A Large Slime waits in the next fight.'),
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('The Large Slime', 'It has 8 HP. This turn it hits every row for 1. Next turn it attacks for 4 and adds a Daze to your deck: kill it before then if you can.', at.enemy('e0'), at.intent('e0')),
        say('A 1 on the die', 'Necronomicon: your first Attack this turn is played twice. Lantern gave you a 4th Energy. Orion\'s Harpoon is your first Attack, so it hits twice and makes 2 Rage.', at.die, at.energy),
        task('Orion\'s Harpoon', 'Tap Orion\'s Harpoon, then the Slime: 2 damage and 1 Rage. Then tap the Slime again for the extra copy: 2 more damage and 1 more Rage.', playedDown('kratos_orions_harpoon'), at.handCard('kratos_orions_harpoon'), at.enemy('e0')),
        task('Bow of Apollo', 'You hold 4 Rage. Unleash 1 turns Bow of Apollo into 3 damage: the Slime is left on 1 HP.', playedDown('kratos_bow_of_apollo'), at.handCard('kratos_bow_of_apollo'), at.enemy('e0')),
        task('Strike', 'A Strike finishes the Slime before it ever acts.', playedDown('strike_kratos'), at.handCard('strike_kratos'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 1,
      potion: { id: 'snecko_oil', why: 'The Daze cards cannot be played, so keep it for a turn that needs the extra cards. Potions are used once, from the potion bar, and you can carry 3.' },
      cards: [
        ['kratos_sacrifice', 'Costs 0: Exhaust a card from your hand, and if you did, gain 2 Rage. It thins your deck for the fight and feeds Unleash.'],
        ['kratos_rage_of_the_gods', 'A second copy: 2 free Rage again, but it Exhausts and gives nothing else.'],
        ['kratos_hermes_rush', 'Costs 1: gain 2 Block (to any player), and Unleash 1 draws a card.'],
      ],
      pick: null,
      pickWhy: 'You already make plenty of Rage, and a card that does not beat the Guardian only dilutes your deck. Skipping is a real choice: skip these.',
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
        say('Before the boss', 'Rest if you are below 6 HP. Otherwise Smith a card you want against the Guardian, such as Orion\'s Harpoon, Servant of Ares or Atlas Quake.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Guardian', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('The Guardian', 'The Act I boss has 40 HP. Bosses count as being in every row and always act last.', at.enemy('boss-0')),
        say('Its shell', 'This turn it attacks for 2 and gains 5 Block, which it keeps between turns. Next turn comes Mode Shift: if it still has Block, it drops the Block and attacks for 6. If you broke all its Block, it switches to Defensive Mode instead.', at.intent('boss-0')),
        say('Your hand', 'You drew a hand full of Rage cards: Servant of Ares, Orion\'s Harpoon, Bow of Apollo, Blades of Chaos and Plume of Prometheus. The die shows 1, so Necronomicon doubles your first Attack, and you have 4 Energy.', at.hand, at.energy),
        task('Servant of Ares', 'Play the Power first: from next turn you gain 1 Rage at the start of every turn.', playedDown('kratos_servant_of_ares'), at.handCard('kratos_servant_of_ares')),
        task('Orion\'s Harpoon', 'Tap the Guardian, then tap it again for the Necronomicon copy: 2 hits and 2 Rage.', playedDown('kratos_orions_harpoon'), at.handCard('kratos_orions_harpoon'), at.enemy('boss-0')),
        say('Spend your Rage', 'You hold 4 Rage. Plume of Prometheus, then Bow of Apollo, each Unleash, and finish with Blades of Chaos while the Guardian has no Block yet. Next turn it will have 5, so Defend if you cannot break it.', at.hand, RAGE),
        say('Potions', `Use potions when they help. ${potionText('snecko_oil')}`, spot('.combat__actions')),
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
