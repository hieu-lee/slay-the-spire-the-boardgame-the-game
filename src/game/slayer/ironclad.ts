// The Ironclad Slayer Pack. Transcribed from the pack's scans; the contract for
// every card is docs/slayer-pack.md.
import type { CardDef } from '../cards.ts'

type PackCard = Omit<CardDef, 'owner' | 'pack'>
const ironclad = (def: PackCard): CardDef => ({ upgrade: {}, ...def, owner: 'ironclad', pack: 'slayer_ironclad' })

export const SLAYER_IRONCLAD_CARD_DEFS: Record<string, CardDef> = Object.fromEntries([
  // Retain happens in this turn's discard step; Block is paid per card actually kept there.
  ironclad({ id: 'slayer_armaments', name: 'Armaments', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'retainForBlock', amount: 2 }, { kind: 'preventCardPlay' }],
    upgrade: { effects: [{ kind: 'retainForBlock', amount: 3 }, { kind: 'preventCardPlay' }] } }),
  // "When played, draw 1 card. Start of turn: If you lost HP last round, [Vulnerable] (to an enemy)."
  // The upgraded face prints the AoE icon: the Vulnerable lands on a chosen row, plus the boss.
  ironclad({ id: 'slayer_brutality', name: 'Brutality',
    printedText: 'When played, draw 1 card. Start of turn: If you lost HP last round, 1 [Vulnerable] to an enemy.',
    type: 'power', rarity: 'rare', cost: 0,
    resolvesOnPlay: true, target: 'enemy',
    effects: [{ kind: 'draw', amount: 1 }],
    additionalTriggers: [{ trigger: { kind: 'startOfTurn' },
      effects: [{ kind: 'applyVulnerable', amount: 1, when: { kind: 'lostHpLastRound' } }] }],
    upgrade: { printedText: 'When played, draw 1 card. Start of turn: If you lost HP last round, 1 [Vulnerable] to an enemy row and any boss.', target: 'row' } }),
  // "The bonus damage is added to the hit and the combined damage is scaled by
  // vulnerable" (author FAQ): a per-target bonus inside the hit's amount.
  ironclad({ id: 'slayer_dropkick', name: 'Dropkick', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 2, when: { kind: 'targetVulnerable' } } } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 3, bonus: { plus: 3, when: { kind: 'targetVulnerable' } } } }] } }),
  ironclad({ id: 'slayer_dual_wield', name: 'Dual Wield', type: 'skill', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'returnDiscardTop', amount: 1, to: 'hand', toChosen: true }],
    upgrade: { cost: 0 } }),
  // "Once per turn: If you have [Daze], [Burn], [Slimed] or a Curse in your hand: [Weak]" -- an
  // ability its owner activates during the Player Turn while the condition holds.
  ironclad({ id: 'slayer_infernal_blade', name: 'Infernal Blade',
    printedText: 'Once per turn: If you have a Daze, Burn, Slimed or a Curse in your hand: 1 [Weak] to an enemy.',
    type: 'power', rarity: 'uncommon', cost: 1,
    activeAbility: true, oncePerTurn: true, activationCondition: { kind: 'hasStatusOrCurseInHand' },
    effects: [{ kind: 'applyWeak', amount: 1 }],
    upgrade: { cost: 0 } }),
  // The Block is the HP the burst took from every enemy it struck, boss included.
  ironclad({ id: 'slayer_reaper', name: 'Reaper', type: 'attack', rarity: 'rare', cost: 2, target: 'row',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'gainBlockFromLastHit', allTargets: true }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'gainBlockFromLastHit', allTargets: true }] } }),
  // One count serves both faces: it never includes the played card, which is
  // the upgraded face's "every OTHER upgraded card" (author FAQ) and changes
  // nothing for the unupgraded base face.
  ironclad({ id: 'slayer_searing_blow', name: 'Searing Blow', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: { base: 3, per: 'upgradedCardsInHand', scale: 2 } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 3, per: 'upgradedCardsInHand', scale: 3 } }] } }),

].map((def) => [def.id, def]))
