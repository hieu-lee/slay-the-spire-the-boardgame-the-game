// The Silent Slayer Pack. Transcribed from the pack's scans; the contract for
// every card is docs/slayer-pack.md.
import type { CardDef } from '../cards.ts'

type PackCard = Omit<CardDef, 'owner' | 'pack'>
const silent = (def: PackCard): CardDef => ({ upgrade: {}, ...def, owner: 'silent', pack: 'slayer_silent' })

export const SLAYER_SILENT_CARD_DEFS: Record<string, CardDef> = Object.fromEntries([
  // "End of turn: Deal 1 damage to every enemy that intends to attack you for each [hit] in their attack."
  silent({ id: 'slayer_caltrops', name: 'Caltrops',
    printedText: 'End of turn: Deal 1 damage to every enemy that intends to attack you for each hit in their attack.',
    type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'endOfTurn' },
    effects: [{ kind: 'damagePerAttackIntent', amount: 1 }],
    upgrade: { printedText: 'End of turn: Deal 2 damage to every enemy that intends to attack you for each hit in their attack.', effects: [{ kind: 'damagePerAttackIntent', amount: 2 }] } }),
  // "+1 damage for each [Weak]/[Vulnerable] you have": the player's OWN tokens.
  silent({ id: 'slayer_endless_agony', name: 'Endless Agony', type: 'attack', rarity: 'uncommon', cost: 1, ethereal: true,
    toDrawTop: true,
    effects: [{ kind: 'hit', amount: { base: 3, per: 'ownWeakAndVulnerable' } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 4, per: 'ownWeakAndVulnerable' } }] } }),
  // "Whenever a card's effect makes you discard cards, deal 1 damage for each discarded card."
  silent({ id: 'slayer_eviscerate', name: 'Eviscerate',
    printedText: "Whenever a card's effect makes you discard cards, deal 1 damage for each discarded card.",
    type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'onDiscard', fromHandOrDraw: true }, target: 'enemy',
    effects: [{ kind: 'damagePerDiscard', amount: 1 }],
    upgrade: { printedText: "Whenever a card's effect makes you discard cards, deal 2 damage for each discarded card.", effects: [{ kind: 'damagePerDiscard', amount: 2 }] } }),
  silent({ id: 'slayer_glass_knife', name: 'Glass Knife', type: 'attack', rarity: 'uncommon', cost: 2, retain: true,
    effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 3, when: { kind: 'notRetainedLastTurn' } } } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 5, when: { kind: 'notRetainedLastTurn' } } } }] } }),
  // The chosen player answers the draw-or-discard choice from their own hand after the card resolves.
  silent({ id: 'slayer_heel_hook', name: 'Heel Hook', type: 'attack', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'gainEnergy', amount: 1, when: { kind: 'targetWeak' } },
      { kind: 'drawOrDiscardChoice', toChosen: true, when: { kind: 'targetWeak' } },
    ],
    upgrade: { effects: [
      { kind: 'hit', amount: 3 },
      { kind: 'gainEnergy', amount: 1, when: { kind: 'targetWeak' } },
      { kind: 'drawOrDiscardChoice', toChosen: true, when: { kind: 'targetWeak' } },
    ] } }),
  // Stays on its enemy: each Attack (a Shiv included) its owner strikes that
  // enemy with deals 1 more damage. The upgraded face moves on when it dies.
  silent({ id: 'slayer_nightmare', name: 'Nightmare', type: 'skill', rarity: 'rare', cost: 1,
    effects: [{ kind: 'attachToTarget' }],
    attached: { damageWhen: 'attackAgainstHost', amount: 1, onHostDeath: 'discard' },
    upgrade: { attached: { damageWhen: 'attackAgainstHost', amount: 1, onHostDeath: 'reattach' } } }),
  // "When played: [Shiv]. Whenever you play a [Shiv], deal 1 damage to the target's row."
  silent({ id: 'slayer_phantasmal_killer', name: 'Phantasmal Killer',
    printedText: "When played: gain 1 Shiv. Whenever you play a Shiv, deal 1 damage to the target's row.",
    type: 'power', rarity: 'rare', cost: 1,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainShiv', amount: 1 }],
    persistentEffects: [{ kind: 'shivRowDamage', amount: 1 }],
    upgrade: { printedText: "When played: gain 2 Shivs. Whenever you play a Shiv, deal 1 damage to the target's row.", effects: [{ kind: 'gainShiv', amount: 2 }] } }),

].map((def) => [def.id, def]))
