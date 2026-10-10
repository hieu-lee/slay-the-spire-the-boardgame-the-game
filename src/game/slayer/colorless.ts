// The Colorless Slayer Pack. Transcribed from the pack's scans; the contract for
// every card is docs/slayer-pack.md. Several names collide with Downfall Colorless
// cards, which is why every id here carries the `slayer_` prefix.
import type { CardDef } from '../cards.ts'

type PackCard = Omit<CardDef, 'owner' | 'pack'>
const colorless = (def: PackCard): CardDef => ({ upgrade: {}, ...def, owner: 'colorless', pack: 'slayer_colorless' })

export const SLAYER_COLORLESS_CARD_DEFS: Record<string, CardDef> = Object.fromEntries([
  // "When played, draw 1 card. When you lose HP, lose 1 HP less and Exhaust (+: discard) this card."
  colorless({ id: 'slayer_bandage_up', name: 'Bandage Up',
    printedText: 'When played, draw 1 card. When you lose HP, lose 1 HP less and Exhaust this card.',
    type: 'power', rarity: 'uncommon', cost: 0,
    resolvesOnPlay: true, persistent: true,
    effects: [{ kind: 'draw', amount: 1 }],
    persistentEffects: [{ kind: 'reduceHpLoss', amount: 1, then: 'exhaust' }],
    upgrade: { printedText: 'When played, draw 1 card. When you lose HP, lose 1 HP less and discard this card.', persistentEffects: [{ kind: 'reduceHpLoss', amount: 1, then: 'discard' }] } }),
  colorless({ id: 'slayer_bite', name: 'Bite', type: 'attack', rarity: 'uncommon', cost: 1, retain: true, exhaust: true,
    effects: [{ kind: 'hit', amount: 2, onKill: [{ kind: 'heal', amount: 1 }] }],
    upgrade: { effects: [{ kind: 'hit', amount: 3, onKill: [{ kind: 'heal', amount: 1 }] }] } }),
  // "Once per turn: When you play a Skill, draw 2 cards."
  colorless({ id: 'slayer_chrysalis', name: 'Chrysalis',
    printedText: 'Once per turn: When you play a Skill, draw 2 cards.',
    type: 'power', rarity: 'rare', cost: 2,
    trigger: { kind: 'onPlayCard', cardType: 'skill' }, oncePerTurn: true,
    effects: [{ kind: 'draw', amount: 2 }],
    upgrade: { cost: 1 } }),
  // The egg is the unplayable base face; Upgrading it hatches the playable dragon.
  // The dragon: "End of turn: Deal 4 damage. You may also Exhaust this to gain 3 [Block]."
  colorless({ id: 'slayer_companion', name: 'Companion',
    printedText: 'Unplayable.',
    type: 'power', rarity: 'rare', cost: 0, unplayable: true,
    effects: [], upgrade: { printedText: 'End of turn: Deal 4 damage. You may also Exhaust this to gain 3 [Block].', unplayable: false, cost: 1, trigger: { kind: 'endOfTurn' }, target: 'enemy',
      effects: [{ kind: 'damage', amount: 4 }, { kind: 'mayExhaustSelfFor', effects: [{ kind: 'block', amount: 3 }] }] } }),
  // Slayer Pack: Deep Breath has already left the hand, so "other" is every Skill still in it.
  colorless({ id: 'slayer_deep_breath', name: 'Deep Breath', type: 'skill', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'draw', amount: 2, when: { kind: 'hasNoSkillsInHand' } }],
    upgrade: { effects: [{ kind: 'draw', amount: 3, when: { kind: 'hasNoSkillsInHand' } }] } }),
  // The card play is mandatory ("Play one of these"); the drawn cards it does not play are discarded.
  colorless({ id: 'slayer_discovery', name: 'Discovery', type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [
      { kind: 'draw', amount: 3 },
      { kind: 'openPlayWindow', cards: 'drawn', cost: 0, plays: 1, optional: false, discardRest: true },
    ], upgrade: { exhaust: false } }),
  // "Any number" includes none; the offer is the hand as it stands after the draw.
  colorless({ id: 'slayer_enlightenment', name: 'Enlightenment', type: 'skill', rarity: 'uncommon', cost: 0, exhaust: true,
    effects: [
      { kind: 'draw', amount: 1 },
      { kind: 'openPlayWindow', cards: 'hand', cost: 1, plays: null, optional: true },
    ], upgrade: { exhaust: false } }),
  colorless({ id: 'slayer_forethought', name: 'Forethought', type: 'skill', rarity: 'uncommon', cost: 0, exhaust: true,
    effects: [{ kind: 'bottomdeck', amount: 1 }, { kind: 'draw', amount: 1 }],
    upgrade: { effects: [{ kind: 'bottomdeck', amount: 'any' }, { kind: 'draw', amount: 1 }] } }),
  // "The die" is this round's shared die. The upgraded 5-6 row is one branch: its Strength, then its hit.
  colorless({ id: 'slayer_jack_of_all_trades', name: 'Jack of All Trades', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true, effects: [
      { kind: 'block', amount: 2, when: { kind: 'dieShows', faces: [1, 2] } },
      { kind: 'gainEnergy', amount: 1, when: { kind: 'dieShows', faces: [3, 4] } },
      { kind: 'gainStrength', amount: 1, when: { kind: 'dieShows', faces: [5, 6] } },
    ], upgrade: { effects: [
      { kind: 'block', amount: 3, when: { kind: 'dieShows', faces: [1, 2] } },
      { kind: 'gainEnergy', amount: 2, when: { kind: 'dieShows', faces: [3, 4] } },
      { kind: 'branch', condition: { kind: 'dieShows', faces: [5, 6] },
        effects: [{ kind: 'gainStrength', amount: 1 }, { kind: 'hit', amount: 1 }], otherwise: [] },
    ] } }),
  colorless({ id: 'slayer_magnetism', name: 'Magnetism', type: 'power', rarity: 'rare', cost: 1,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'mayReturnDiscardTop', upTo: 1 }],
    upgrade: { effects: [{ kind: 'mayReturnDiscardTop', upTo: 2 }] } }),
  // "Attach to one of your active Powers. Copy its effect to this card. X is the copied Power's
  // Energy cost +1 (+: no +1)." The attachment is chosen with the play (`metamorphosisPowerUid`);
  // in play the card becomes a second copy of that Power (see combat/effects.ts).
  colorless({ id: 'slayer_metamorphosis', name: 'Metamorphosis',
    printedText: "Attach to one of your active Powers. Copy its effect to this card. X is the copied Power's Energy cost +1. If the copied Power is Exhausted or discarded, this card is as well.",
    type: 'power', rarity: 'rare', cost: 'X',
    persistent: true, playCondition: { kind: 'hasActivePower' }, effects: [],
    upgrade: { printedText: "Attach to one of your active Powers. Copy its effect to this card. X is the copied Power's Energy cost. If the copied Power is Exhausted or discarded, this card is as well." } }),
  // "Retain. You can't lose HP. Start of turn: Gain 2 (+: 1) [Vulnerable], Exhaust."
  colorless({ id: 'slayer_panic_button', name: 'Panic Button',
    printedText: "Retain. You can't lose HP. Start of turn: Gain 2 [Vulnerable], Exhaust.",
    type: 'power', rarity: 'uncommon', cost: 0, retain: true,
    trigger: { kind: 'startOfTurn' }, persistent: true,
    effects: [{ kind: 'gainVulnerable', amount: 2 }, { kind: 'exhaustSelf' }],
    persistentEffects: [{ kind: 'preventAllHpLoss' }],
    upgrade: { printedText: "Retain. You can't lose HP. Start of turn: Gain 1 [Vulnerable], Exhaust.", effects: [{ kind: 'gainVulnerable', amount: 1 }, { kind: 'exhaustSelf' }] } }),
  // The kill's reward is permanent: the deck card is upgraded, or (upgraded
  // face) its owner privately sees their top rare reward and may Replace the
  // dagger with it (author FAQ).
  colorless({ id: 'slayer_ritual_dagger', name: 'Ritual Dagger', type: 'attack', rarity: 'uncommon', cost: 1, retain: true,
    exhaust: true, effects: [{ kind: 'hit', amount: 2, onKill: [{ kind: 'upgradeThisCard' }] }],
    upgrade: { effects: [{ kind: 'hit', amount: 3, onKill: [{ kind: 'revealRareReward' }] }] } }),
  colorless({ id: 'slayer_secret_technique', name: 'Secret Technique', type: 'skill', rarity: 'rare', cost: 1, exhaust: true,
    combatSetupOnTop: true, effects: [{ kind: 'searchDraw', amount: 1 }], upgrade: { cost: 0 } }),
  // Author FAQ: the self-damage can be blocked, and X is read after it.
  colorless({ id: 'slayer_smite', name: 'Smite', type: 'attack', rarity: 'rare', cost: 1,
    effects: [{ kind: 'takeDamage', amount: 2 }, { kind: 'hit', amount: { base: 0, per: 'currentHp' } }],
    upgrade: { effects: [{ kind: 'takeDamage', amount: 1 }, { kind: 'hit', amount: { base: 0, per: 'currentHp' } }] } }),
  colorless({ id: 'slayer_transmutation', name: 'Transmutation', type: 'skill', rarity: 'rare', cost: 'X', exhaust: true,
    effects: [
      { kind: 'draw', amount: { base: 0, per: 'energySpent' } },
      { kind: 'openPlayWindow', cards: 'drawn', cost: 0, plays: null, optional: true },
    ], upgrade: { effects: [
      { kind: 'draw', amount: { base: 1, per: 'energySpent' } },
      { kind: 'openPlayWindow', cards: 'drawn', cost: 0, plays: null, optional: true },
    ] } }),
  // "Immediately play all Attacks": every Attack in hand as it resolves, in the order and at the targets chosen.
  colorless({ id: 'slayer_violence', name: 'Violence', type: 'skill', rarity: 'rare', cost: 2, exhaust: true,
    effects: [{ kind: 'openPlayWindow', cards: 'attacksInHand', cost: 0, plays: null, optional: false }],
    upgrade: { exhaust: false } }),

].map((def) => [def.id, def]))
