import {
  NEOW_GOLD, NEOW_REVEAL, eventChapter, merchantChapter, moveChapter, neowBlueChosen, neowDone, neowRedTaken,
  neowRewardRevealed, neowRewardsLeft, pickerSteps, potionText, relicText, rewardChapter, say, shown, task, treasureChapter,
} from '../common.ts'
import {
  at, atCampfire, inFight, inNeow, inReward, playedDown, potionGone, roomLeft, spot, turnReached,
} from '../helpers.ts'
import type { RunState } from '../../../game/run.ts'
import type { HeroTutorial, TutorialPlan } from '../types.ts'

const plan: TutorialPlan = {
  seed: 'tutorial-defect-22',
  neow: {
    card: 'neow_08', red: ['cold_snap', 'sweeping_beam', 'ball_lightning'], pick: 'cold_snap', option: 1,
    potions: ['skill_potion', 'energy_potion', 'weak_potion'],
  },
  route: ['a1r0c0', 'a1r1c1', 'a1r2c1', 'a1r3c1', 'a1r4c1', 'a1r5c0', 'a1r6c1', 'a1r7c1', 'a1r8c1', 'a1r9c1', 'a1r10c1', 'a1r11c1', 'a1r12c0'],
  rooms: {
    a1r0c0: { kind: 'fight', enemies: ['cultist'], hand: ['zap', 'defend_defect', 'dual_cast', 'strike_defect', 'defend_defect'],
      cards: ['glacier', 'capacitor', 'streamline'], pick: 'glacier' },
    a1r1c1: { kind: 'event', event: 'ominous_forge', option: 'forge', cards: ['dual_cast'] },
    a1r2c1: { kind: 'fight', enemies: ['large_slime'], hand: ['cold_snap', 'defend_defect', 'strike_defect', 'dual_cast', 'defend_defect'],
      cards: ['claw_claw_pack', 'barrage', 'darkness'], pick: 'darkness' },
    a1r3c1: { kind: 'merchant', buy: [{ section: 'relic', slot: 0, id: 'orichalcum' }] },
    a1r4c1: { kind: 'fight', enemies: ['jaw_worm'], hand: ['strike_defect', 'defend_defect', 'glacier', 'defend_defect', 'defend_defect'],
      cards: ['skim', 'claw_claw_pack', 'charge_battery'], pick: null },
    a1r5c0: { kind: 'treasure', relic: 'ninja_scroll' },
    a1r6c1: { kind: 'treasure', relic: 'oddly_smooth_stone' },
    a1r7c1: { kind: 'event', event: 'big_fish', option: 'banana' },
    a1r8c1: { kind: 'campfire' },
    a1r9c1: { kind: 'fight', enemies: ['blue_slaver'], hand: ['defend_defect', 'glacier', 'strike_defect', 'defend_defect', 'defend_defect'],
      cards: ['barrage', 'beam_cell', 'coolheaded'], pick: 'barrage' },
    a1r10c1: { kind: 'merchant' },
    a1r11c1: { kind: 'campfire' },
    a1r12c0: { kind: 'fight', enemies: ['guardian_attack'], hand: ['cold_snap', 'defend_defect', 'defend_defect', 'defend_defect', 'glacier'] },
  },
  boss: 'guardian_attack',
}

/** The Defect's Orb row, and the Orbs in it once a card asks which one to Evoke. */
const orbs = spot('.orbs')
const hasRelic = (id: string) => (run: RunState) => run.players[0]!.relics.some((relic) => relic.defId === id)

export const DEFECT: HeroTutorial = {
  character: 'defect',
  plan,
  chapters: [
    {
      id: 'neow',
      when: inNeow,
      steps: [
        say('Welcome to the Spire', 'This tutorial walks one planned Act I run with the Defect, so every card, enemy and room can be explained. When the coach asks for a move, only the ringed controls respond. Hide tips at any time to play freely.'),
        say('Your health', 'The Defect has 9 HP. Most attacks here deal 1 to 4 damage, so every point matters. At 0 HP the run is over.', at.hp),
        say('Deck and relics', 'Your deck holds 4 Strikes, 4 Defends, Zap and Dual Cast; open it here any time. Cracked Core Channels a Lightning Orb at the start of every fight. Loaded Die gives 1 Energy when the die shows 6. Hover over or long-press a relic to read it.', at.deck, at.relics),
        say("Neow's Blessing", 'Every run starts with Neow. The red reward is always 3 Gold and a Card Reward. Then you choose one of three blue options.', at.neowCard),
        NEOW_GOLD,
        NEOW_REVEAL,
        say('Cold Snap', 'Costs 2: deal 2 damage and Channel a Frost Orb. A Frost Orb gives you 1 Block at the end of each of your turns.', at.offeredCard('cold_snap')),
        say('Sweeping Beam', 'Costs 1: deal 1 damage to every enemy in a row, then draw a card.', at.offeredCard('sweeping_beam')),
        say('Ball Lightning', 'Costs 1: deal 1 damage and Channel a Lightning Orb.', at.offeredCard('ball_lightning')),
        task('Take Cold Snap', 'Cracked Core and Zap already make Lightning. Cold Snap adds Frost, and Frost\'s Block is what keeps a 9 HP hero standing. Take it.',
          neowRedTaken, at.offeredCard('cold_snap')),
        say('The blue options', 'Upgrade 1 card, Gain 3 Potions, or Upgrade 2 random cards and lose 2 HP. Random upgrades may miss your best cards, and 2 HP is a lot.', spot('.neow-options')),
        task('Gain 3 Potions', 'Potions are used once, from the potion bar, and you can carry 3. Three of them can swing a hard fight. Choose them.',
          neowBlueChosen, at.neowOption('Gain 3 Potions')),
        task('Reveal a potion', 'Each potion is dealt face down. Reveal the first one.', neowRewardRevealed(2), at.neowButton('Reveal Potion')),
        task('Take the Skill Potion', `${potionText('skill_potion')} With Dual Cast, that is two Orbs Evoked twice each.`,
          neowRewardsLeft(2), at.loot('Skill Potion')),
        task('Reveal the next one', 'Two to go.', neowRewardRevealed(1), at.neowButton('Reveal Potion')),
        task('Take the Energy Potion', `${potionText('energy_potion')} More Energy means more cards played in one turn.`,
          neowRewardsLeft(1), at.loot('Energy Potion')),
        task('Reveal the last one', 'The last potion.', neowRewardRevealed(0), at.neowButton('Reveal Potion')),
        task('Take the Weak Potion', `${potionText('weak_potion')} A Weak enemy deals 1 less with each hit.`,
          neowDone, at.loot('Weak Potion')),
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
        say('Your first fight', 'This Cultist has 9 HP. Bring it to 0 to win. It stands in your row, so its attacks hit you.', at.enemy('e0')),
        say('Enemy intent', 'The icon above an enemy is its intent: what it will do on its turn. The Cultist attacks for 1 and gains 1 Strength every turn. Each point of Strength adds 1 to its hits, so it grows more dangerous the longer it lives.', at.intent('e0')),
        say('Cracked Core', 'Your relic Channeled a Lightning Orb as the fight began. Orbs sit in your 3 Orb slots and keep working every turn.', orbs),
        say('Orbs', 'Lightning deals 1 damage at the end of your turn, or 2 when Evoked. Frost gives 1 Block at the end of your turn, or 1 when Evoked. Dark does nothing each turn, but deals 3 plus 1 per Power you have in play when Evoked. There is no Focus in the board game.', orbs),
        say('Your hand', 'You drew 5 cards: Zap, Dual Cast, a Strike and 2 Defends. You get 3 Energy every turn, and each of these costs 1. Cards you do not play are discarded when your turn ends.', at.hand, at.energy),
        task('Play Zap', 'Zap Channels a Lightning Orb: it goes into an empty slot. Tap Zap to play it.', playedDown('zap'), at.handCard('zap')),
        task('Dual Cast', 'Dual Cast Evokes one Orb twice. Evoking removes the Orb and fires its Evoke effect. Tap Dual Cast, pick a Lightning Orb, then tap the Cultist once for each Evoke: 2 + 2 = 4 damage.',
          playedDown('dual_cast'), at.handCard('dual_cast'), orbs, at.enemy('e0')),
        say('Evoked', 'The Cultist is down to 5 HP, and one Lightning Orb is still in its slot. It will deal 1 damage when your turn ends.', at.enemy('e0'), orbs),
        task('Defend', 'Defend gives 1 Block: each point stops 1 damage until your next turn. That covers the Cultist\'s whole attack.', playedDown('defend_defect', 1), at.handCard('defend_defect')),
        task('End your turn', 'Your Lightning fires first, then the Cultist acts. End the turn.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r0c0-turn-2',
      when: inFight('a1r0c0', 2),
      steps: [
        say('Passive damage', 'Your Lightning hit the Cultist for 1, and your Block stopped its attack. It is on 4 HP and now has 1 Strength, so its next hit deals 2.', at.enemy('e0')),
        task('Cold Snap', 'Cold Snap deals 2 damage and Channels a Frost Orb into the empty slot. Tap it, then tap the Cultist.', playedDown('cold_snap'), at.handCard('cold_snap'), at.enemy('e0')),
        say('Frost', 'Frost gives you 1 Block at the end of each of your turns, so it defends even when you draw no Defends.', orbs),
        task('Strike', 'A Strike deals 1. That leaves the Cultist on 1 HP.', playedDown('strike_defect', 1), at.handCard('strike_defect'), at.enemy('e0')),
        task('End your turn', 'Your Orbs act before the enemy: Frost gives 1 Block and Lightning deals the last point of damage, so the Cultist never swings.', turnReached(3), at.endTurn),
      ],
    },
    rewardChapter('a1r0c0', {
      intro: [say('Victory', 'The fight is won without losing any HP. Orbs are removed at the end of every fight, and Cracked Core makes a new Lightning in the next one. Now collect the rewards.', at.hp)],
      gold: 1,
      cards: [
        ['glacier', 'Costs 2: gain 2 Block and Channel a Frost Orb. Block now and Block every turn after.'],
        ['capacitor', 'Costs 1: a Power that gives you 2 more Orb slots. Slow, and no help in short fights.'],
        ['streamline', 'Costs 2: deal 3 damage.'],
      ],
      pick: 'glacier',
      pickWhy: 'Glacier keeps you alive while your Orbs do the damage. Take it.',
    }),
    moveChapter('a1r0c0', 'a1r1c1', 'Go to the event', '"?" rooms hold events: a card with a few options, some good, some risky.'),
    eventChapter('a1r1c1', [
      say('Ominous Forge', 'Rummage gives a relic, but then the die is rolled and a 1 to 3 adds a Curse, a dead card that clogs your hand. Forge upgrades a card for 2 HP.', at.event),
      say('Why pay HP?', 'An upgraded Dual Cast costs 0, so it fits into every turn for free. The Big Fish later on this route can heal those 2 HP back.', at.hp),
      task('Choose Forge', 'Choose Forge.', shown('.card-picker'), at.eventOption('forge')),
      ...pickerSteps('Upgrade', 'dual_cast', 'Pick Dual Cast. Upgrades show on the card in green.', roomLeft),
    ]),
    moveChapter('a1r1c1', 'a1r2c1', 'Into the slime', 'A Large Slime waits in the next room.'),
    {
      id: 'fight-a1r2c1-turn-1',
      when: inFight('a1r2c1', 1),
      steps: [
        say('Large Slime', 'It has 8 HP and repeats three moves in order: 1 damage to every row, then 4 damage and a Daze, then it summons an Acid Slime. Kill it before the 4 lands.', at.enemy('e0'), at.intent('e0')),
        say('A full belt', 'Your belt holds 3 potions and it is full, but this fight drops a Block Potion. Using a potion now makes room for it.', spot('.combat__actions')),
        task('Use the Weak Potion', 'Tap the Weak Potion, then the slime. Weak takes 1 off each of its next 2 hits, so this turn\'s attack does nothing.',
          potionGone('weak_potion'), at.combatPotion('weak_potion'), at.enemy('e0')),
        task('Cold Snap', 'Deal 2 damage and Channel Frost next to your Lightning.', playedDown('cold_snap'), at.handCard('cold_snap'), at.enemy('e0')),
        task('Dual Cast+', 'Your upgraded Dual Cast costs 0. Tap it, pick the Lightning Orb, and tap the slime for each Evoke: 4 more damage.',
          playedDown('dual_cast'), at.handCard('dual_cast'), orbs, at.enemy('e0')),
        task('Strike', 'That leaves the slime on 1 HP.', playedDown('strike_defect'), at.handCard('strike_defect'), at.enemy('e0')),
        task('End your turn', 'Frost gives you 1 Block, and the Weak slime\'s attack deals nothing.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r2c1-turn-2',
      when: inFight('a1r2c1', 2),
      steps: [
        task('Finish it', 'Next comes the slime\'s big hit and a Daze. A Strike ends the fight first: an enemy that dies before its turn never acts.',
          playedDown('strike_defect', 1), at.handCard('strike_defect'), at.enemy('e0')),
      ],
    },
    rewardChapter('a1r2c1', {
      gold: 1,
      potion: { id: 'block_potion', why: 'That is the slot the Weak Potion freed.' },
      cards: [
        ['claw_claw_pack', 'Costs 0: gain a Claw cube, then deal 1 damage per Claw cube gained this fight. It starts at 1.'],
        ['barrage', 'Costs 1: deal 1 damage once for every Orb you have.'],
        ['darkness', 'Costs 1: Channel a Dark Orb. Dark does nothing each turn, but deals 3 damage when Evoked, plus 1 for each Power you have in play.'],
      ],
      pick: 'darkness',
      pickWhy: 'A Dark Orb Evoked by Dual Cast deals 3 twice: 6 damage from 2 cards. Take Darkness.',
    }),
    moveChapter('a1r2c1', 'a1r3c1', 'Visit the merchant', 'Merchants sell cards, relics and potions, and remove cards.'),
    merchantChapter('a1r3c1', [
      say('Cards', 'Cards come from your own reward deck and cost 2 Gold (common), 3 (uncommon) or 6 (rare).', at.merchantCards),
      say('Potions and removal', 'Your belt is full, so potions must wait. For 3 Gold the merchant removes one card from your deck, once per visit.', at.merchantPotions, at.merchantRemoval),
      task('Buy Orichalcum', `${relicText('orichalcum')} The first relic is on sale for 1 less: 4 of your 7 Gold. It protects you on every turn you spend attacking.`,
        hasRelic('orichalcum'), spot('.merchant-shelf--relics [data-merchant-target="relic-0"]')),
    ]),
    moveChapter('a1r3c1', 'a1r4c1', 'The Jaw Worm', 'A Jaw Worm waits in the next fight.'),
    {
      id: 'fight-a1r4c1-turn-1',
      when: inFight('a1r4c1', 1),
      steps: [
        say('Jaw Worm', 'It has 10 HP and will attack for 4. You drew a Strike, 3 Defends and Glacier: a turn to defend, not to race.', at.enemy('e0'), at.intent('e0')),
        task('Glacier', 'Gain 2 Block and Channel Frost.', playedDown('glacier'), at.handCard('glacier')),
        task('Defend', 'One more Block makes 3. Frost adds 1 at the end of your turn: 4 Block against 4 damage.', playedDown('defend_defect', 2), at.handCard('defend_defect')),
        say('Orichalcum', 'Orichalcum only helps on a turn you end with no Block, so it rests this turn.', at.relics),
        task('End your turn', 'Lightning deals 1, Frost gives 1 Block, and the Jaw Worm hits a wall.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r4c1-turn-2',
      when: inFight('a1r4c1', 2),
      steps: [
        say('Your turn to lead', 'Finish this fight yourself. You hold Zap, Dual Cast+, a Defend and 2 Strikes. Zap fills your third Orb slot; Dual Cast+ on a Lightning Orb deals 4 for free. Watch the intent, and Defend when a big hit is coming.', at.hand),
      ],
    },
    rewardChapter('a1r4c1', {
      gold: 1,
      cards: [
        ['skim', 'Costs 1: draw 3 cards.'],
        ['claw_claw_pack', 'The same Claw as before.'],
        ['charge_battery', 'Costs 1: gain 2 Block, plus 1 Energy if you have 3 Orbs.'],
      ],
      pick: null,
      pickWhy: 'None of these beat the Guardian, and every extra card makes Dual Cast and Glacier come up less often. Skipping is a real choice: skip these.',
    }),
    moveChapter('a1r4c1', 'a1r5c0', 'Open a chest', 'Every route crosses the row of treasure chests. This one crosses two.'),
    treasureChapter('a1r5c0', 'ninja_scroll', 'Tap it in a fight for 2 Shivs. Each Shiv can be spent any time you could play a card to deal 1 damage.'),
    moveChapter('a1r5c0', 'a1r6c1', 'Another chest', 'A second chest right after the first.'),
    treasureChapter('a1r6c1', 'oddly_smooth_stone', 'Free Block whenever the die rolls a 4.'),
    moveChapter('a1r6c1', 'a1r7c1', 'Another event', 'Another "?" room.'),
    eventChapter('a1r7c1', [
      say('Big Fish', 'Banana heals 2 HP, Donut upgrades a starter Strike, Box gives a relic and a Curse, and Restraint removes a starter Strike.', at.event),
      task('Eat the Banana', 'The Forge cost you 2 HP. Take them back.', roomLeft, at.eventOption('banana')),
    ]),
    moveChapter('a1r7c1', 'a1r8c1', 'Rest at the campfire', 'Campfires let you heal or improve a card.'),
    {
      id: 'campfire-a1r8c1',
      when: atCampfire('a1r8c1'),
      steps: [
        say('Campfire', 'Rest to heal 3 HP, or Smith to upgrade one card for the rest of the run. Choose one.', at.campfire),
        say('Which one?', 'Rest if the next fight could kill you. Otherwise Smith: Zap+ costs 0, Cold Snap+ deals 3, Glacier+ gives 3 Block. This choice is yours.', at.hp),
      ],
    },
    moveChapter('a1r8c1', 'a1r9c1', 'The Blue Slaver', 'One more fight before the second merchant.'),
    {
      id: 'fight-a1r9c1-turn-1',
      when: inFight('a1r9c1', 1),
      steps: [
        say('Blue Slaver', 'It has 10 HP and will attack for 3. The die shows 4, so Oddly Smooth Stone already gave you 2 Block.', at.enemy('e0'), at.die),
        task('Glacier', 'Glacier adds its Block to the Stone\'s 2, and Frost adds 1 more at the end of your turn. That is more than enough.', playedDown('glacier'), at.handCard('glacier')),
        task('Strike', 'With the attack covered, spend the last Energy on damage.', playedDown('strike_defect'), at.handCard('strike_defect'), at.enemy('e0')),
        task('End your turn', 'Lightning deals 1, and your Block soaks the attack.', turnReached(2), at.endTurn),
      ],
    },
    {
      id: 'fight-a1r9c1-turn-2',
      when: inFight('a1r9c1', 2),
      steps: [
        task('Darkness', 'Darkness Channels a Dark Orb into your last empty slot. Now all 3 slots are full: Lightning, Frost and Dark.', playedDown('darkness'), at.handCard('darkness')),
        say('A full row', 'A board-game rule: Orbs never rotate or slide along. If you Channel with every slot full, you first Evoke any one Orb of your choice, and the new Orb takes its slot.', orbs),
        task('Zap into a full row', 'Tap Zap, then choose the Orb to Evoke. Pick the Lightning and tap the Slaver: 2 damage. Keep the Dark Orb: Dual Cast on it later deals 3 twice.',
          playedDown('zap'), at.handCard('zap'), orbs, at.enemy('e0')),
        say('Finish the fight', 'Two Lightning Orbs now deal 1 each at the end of every turn. Play the rest of this fight your way.', at.hand),
      ],
    },
    rewardChapter('a1r9c1', {
      gold: 2,
      cards: [
        ['barrage', 'Costs 1: deal 1 damage once for every Orb you have. With a full row, that is 3 hits.'],
        ['beam_cell', 'Costs 1: deal 1 damage, and apply Vulnerable if the die shows 1 to 3.'],
        ['coolheaded', 'Costs 1: Channel a Frost Orb.'],
      ],
      pick: 'barrage',
      pickWhy: 'Your Orbs stay in their slots for the whole fight, so Barrage turns them into damage. The Guardian needs lots of it. Take Barrage.',
    }),
    moveChapter('a1r9c1', 'a1r10c1', 'A second merchant', 'Spend what Gold you have left before the boss.'),
    merchantChapter('a1r10c1', [
      say('Shop on your own', 'Buy what you like. Good buys before the boss: a potion if your belt has room, or removing a Strike for 3 Gold. When you are done, leave the shop and proceed.', at.merchantPotions, at.merchantRemoval),
    ], false),
    moveChapter('a1r10c1', 'a1r11c1', 'The last campfire', 'Every route passes a campfire before the boss.'),
    {
      id: 'campfire-a1r11c1',
      when: atCampfire('a1r11c1'),
      steps: [
        say('Before the boss', 'Rest if two or three hits could kill you. Otherwise Smith a card you want to see against the Guardian, such as Zap or Cold Snap.', at.campfire),
      ],
    },
    moveChapter('a1r11c1', 'a1r12c0', 'Face the Guardian', 'The boss is waiting. Good luck.'),
    {
      id: 'fight-a1r12c0-turn-1',
      when: inFight('a1r12c0', 1),
      steps: [
        say('The Guardian', 'The Act I boss has 40 HP. Bosses count as being in every row and always act last.', at.enemy('boss-0')),
        say('Its shell', 'This turn it attacks for 2 and gains 5 Block, which it keeps between turns. Next turn comes Mode Shift: if it still has Block, it drops the Block and attacks for 6. If you broke all its Block, it switches to Defensive Mode instead.', at.intent('boss-0')),
        say('The plan', 'This is a long fight, and Orbs win long fights: every Lightning hits each turn and Frost blocks each turn. Keep your slots full, and when the 6-damage hit comes, have Block ready or break its shell first.', orbs),
        say('Potions', 'Now is the time for potions. Skill Potion makes your next Dual Cast happen twice: Evoke a Dark Orb twice (6 damage), then another Orb twice. Energy Potion pays for two more cards.', spot('.combat__actions')),
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
