// The Defect Slayer Pack. Transcribed from the pack's scans; the contract for
// every card is docs/slayer-pack.md.
import type { CardDef } from '../cards.ts'

type PackCard = Omit<CardDef, 'owner' | 'pack'>
const defect = (def: PackCard): CardDef => ({ upgrade: {}, ...def, owner: 'defect', pack: 'slayer_defect' })

export const SLAYER_DEFECT_CARD_DEFS: Record<string, CardDef> = Object.fromEntries([
  defect({ id: 'slayer_aggregate', name: 'Aggregate', type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [{ kind: 'evokeAll', times: 2 }], upgrade: { exhaust: false } }),
  // Slayer Pack: The Daze icon puts a Daze on top of the draw pile (rules §4).
  defect({ id: 'slayer_auto_shields', name: 'Auto-Shields', type: 'skill', rarity: 'uncommon', cost: 0, playOnDraw: true,
    effects: [{ kind: 'block', amount: 3 }, { kind: 'addDaze', amount: 1, pile: 'draw' }],
    upgrade: { effects: [{ kind: 'block', amount: 4 }, { kind: 'addDaze', amount: 1, pile: 'draw' }] } }),
  // Both modifiers are read where Orbs resolve; an end-of-turn effect never drops below 0.
  defect({ id: 'slayer_biased_cognition', name: 'Biased Cognition', type: 'power', rarity: 'rare', cost: 2,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainOrbEndTurnBonus', amount: -1 }, { kind: 'gainOrbEvokeBonus', amount: 3 }],
    upgrade: { cost: 1 } }),
  defect({ id: 'slayer_creative_ai', name: 'Creative AI', type: 'power', rarity: 'uncommon', cost: 1,
    activeAbility: true, oncePerTurn: true,
    effects: [{ kind: 'removeOrbsForDiscardTop', anyNumber: false }],
    upgrade: { effects: [{ kind: 'removeOrbsForDiscardTop', anyNumber: true }] } }),
  defect({ id: 'slayer_hello_world', name: 'Hello World', type: 'power', rarity: 'uncommon', cost: 2,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'channelDieOrb' }],
    upgrade: { cost: 1 } }),
  defect({ id: 'slayer_reboot', name: 'Reboot', type: 'skill', rarity: 'rare', cost: 0, exhaust: true,
    effects: [{ kind: 'discardWholeHand' }, { kind: 'shuffleDiscardIntoDraw' }, { kind: 'draw', amount: 5 }],
    upgrade: { retain: true } }),
  defect({ id: 'slayer_rebound', name: 'Rebound', type: 'attack', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'returnDiscardTop', amount: 1, to: 'drawTop', toChosen: true }],
    upgrade: { cost: 0 } }),

].map((def) => [def.id, def]))
