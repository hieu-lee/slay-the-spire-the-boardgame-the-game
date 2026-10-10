// The Watcher Slayer Pack. Transcribed from the pack's scans; the contract for
// every card is docs/slayer-pack.md.
import type { CardDef } from '../cards.ts'

type PackCard = Omit<CardDef, 'owner' | 'pack'>
const watcher = (def: PackCard): CardDef => ({ upgrade: {}, ...def, owner: 'watcher', pack: 'slayer_watcher' })

export const SLAYER_WATCHER_CARD_DEFS: Record<string, CardDef> = Object.fromEntries([
  // The second clause prints "damage", not the hit icon: plain damage (docs/rules.md).
  watcher({ id: 'slayer_bowling_bash', name: 'Bowling Bash', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'damageAdjacent', amount: 2, targets: 2 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'damageAdjacent', amount: 3, targets: 2 }] } }),
  // Slayer Pack: The revealed card is played through a one-card 0-Energy window after the Scry.
  watcher({ id: 'slayer_deceive_reality', name: 'Deceive Reality', type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'block', amount: 1 }, { kind: 'scryAndPlay', amount: 3 }],
    upgrade: { effects: [{ kind: 'block', amount: 1 }, { kind: 'scryAndPlay', amount: 5 }] } }),
  // "On your Attacks and Skills, each [hit] deals +1 damage, each [Block] gains +1 block.
  // Start of turn: Lose a [Miracle]. If unable, discard this card."
  watcher({ id: 'slayer_fasting', name: 'Fasting',
    printedText: 'On your Attacks and Skills, each hit deals +1 damage, each [Block] icon gains +1 Block. Start of turn: Lose a Miracle. If unable, discard this card.',
    type: 'power', rarity: 'uncommon', cost: 2,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'loseMiracleOrDiscardSelf' }],
    persistentEffects: [{ kind: 'cardIconBonus', amount: 1 }],
    upgrade: { cost: 1 } }),
  watcher({ id: 'slayer_master_reality', name: 'Master Reality', type: 'power', rarity: 'rare', cost: 1,
    activeAbility: true, oncePerTurn: true,
    effects: [{ kind: 'returnDiscardTop', amount: 1, to: 'hand' }],
    upgrade: { effects: [{ kind: 'returnDiscardTop', amount: 1, to: 'hand', mayRetain: true }] } }),
  watcher({ id: 'slayer_pressure_points', name: 'Pressure Points', type: 'skill', rarity: 'rare', cost: 1,
    bossTargetCost: 2,
    effects: [{ kind: 'attachToTarget' }],
    attached: { damageWhen: 'skill', amount: 1, onHostDeath: 'discard' },
    upgrade: { attached: { damageWhen: 'skill', amount: 2, onHostDeath: 'discard' } } }),
  // "Enter any Stance": Calm or Wrath. Neutral is where a Watcher starts, not a
  // Stance a card enters; choosing the current Stance is legal and ignored.
  // The upgraded face's bare Weak goes to an enemy (author FAQ).
  watcher({ id: 'slayer_wave_of_the_hand', name: 'Wave of the Hand', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [],
    modes: [
      { label: 'Miracle, enter Calm', effects: [{ kind: 'gainMiracle', amount: 1 }, { kind: 'enterStance', stance: 'calm' }] },
      { label: 'Miracle, enter Wrath', effects: [{ kind: 'gainMiracle', amount: 1 }, { kind: 'enterStance', stance: 'wrath' }] },
    ],
    upgrade: { modes: [
      { label: 'Miracle, Weak, enter Calm', effects: [
        { kind: 'gainMiracle', amount: 1 }, { kind: 'applyWeak', amount: 1 }, { kind: 'enterStance', stance: 'calm' },
      ] },
      { label: 'Miracle, Weak, enter Wrath', effects: [
        { kind: 'gainMiracle', amount: 1 }, { kind: 'applyWeak', amount: 1 }, { kind: 'enterStance', stance: 'wrath' },
      ] },
    ] } }),
  watcher({ id: 'slayer_wheel_kick', name: 'Wheel Kick', type: 'attack', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'draw', amount: 2, toChosen: true }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'draw', amount: 2, toChosen: true }] } }),

].map((def) => [def.id, def]))
