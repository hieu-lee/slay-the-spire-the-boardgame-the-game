// Kratos, Ghost of Sparta: the first original DLC character, playtest-only for now.
// Design and balance notes live in docs/kratos-design.md; this file is the data.
//
// Rage is a 0-5 token bank. "Unleash N" is a branch on `canUnleash` whose first
// clause pays the Rage, so an "instead" clause keeps one hit as one hit.
// "Brutal Kill" is a branch on the chosen target being dead after the hit, and
// "Godslayer +N" is a hit bonus against Elites and Bosses.
import type { Amount, CardDef, Effect } from '../cards.ts'

const unleash = (cost: number, effects: Effect[], otherwise: Effect[] = []): Effect => ({
  kind: 'branch', condition: { kind: 'canUnleash', cost }, effects: [{ kind: 'unleashSpend', cost }, ...effects], otherwise,
})
const brutalKill = (effects: Effect[]): Effect => ({ kind: 'branch', condition: { kind: 'targetDead' }, effects, otherwise: [] })
const godslayer = (base: number, plus: number): Amount => ({ base, bonus: { plus, when: { kind: 'targetEliteOrBoss' } } })
const perRage = (base: number, scale?: number): Amount => ({ base, per: 'rage', ...(scale ? { scale } : {}) })

type KratosCard = Omit<CardDef, 'owner' | 'publisherScan'>
const kratos = (def: KratosCard): CardDef => ({ ...def, owner: 'kratos', publisherScan: false })

export const KRATOS_CARD_DEFS: Record<string, CardDef> = Object.fromEntries([
  // Starter
  kratos({
    id: 'kratos_blades_of_chaos', name: 'Blades of Chaos', type: 'attack', rarity: 'starter', cost: 1, target: 'row',
    printedText: 'Deal 1 damage to a row. Gain 1 Rage.',
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'gainRage', amount: 1 }],
    upgrade: { printedText: 'Deal 2 damage to a row. Gain 1 Rage.', effects: [{ kind: 'hit', amount: 2 }, { kind: 'gainRage', amount: 1 }] },
  }),
  kratos({
    id: 'kratos_plume_of_prometheus', name: 'Plume of Prometheus', type: 'attack', rarity: 'starter', cost: 1,
    printedText: 'Deal 1 damage. Unleash 2: deal 4 damage instead.',
    effects: [unleash(2, [{ kind: 'hit', amount: 4 }], [{ kind: 'hit', amount: 1 }])],
    upgrade: {
      printedText: 'Deal 2 damage. Unleash 2: deal 5 damage instead.',
      effects: [unleash(2, [{ kind: 'hit', amount: 5 }], [{ kind: 'hit', amount: 2 }])],
    },
  }),

  // Common
  kratos({
    id: 'kratos_orions_harpoon', name: "Orion's Harpoon", type: 'attack', rarity: 'common', cost: 1,
    printedText: 'Deal 2 damage. Gain 1 Rage.',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'gainRage', amount: 1 }],
    upgrade: { printedText: 'Deal 3 damage. Gain 1 Rage.', effects: [{ kind: 'hit', amount: 3 }, { kind: 'gainRage', amount: 1 }] },
  }),
  kratos({
    id: 'kratos_cyclone_of_chaos', name: 'Cyclone of Chaos', type: 'attack', rarity: 'common', cost: 2, target: 'row',
    printedText: 'Deal 1 damage to a row 3 times. Gain 1 Rage.',
    effects: [{ kind: 'hit', amount: 1, times: 3 }, { kind: 'gainRage', amount: 1 }],
    upgrade: {
      printedText: 'Deal 1 damage to a row 4 times. Gain 1 Rage.',
      effects: [{ kind: 'hit', amount: 1, times: 4 }, { kind: 'gainRage', amount: 1 }],
    },
  }),
  kratos({
    id: 'kratos_spartan_kick', name: 'Spartan Kick', type: 'attack', rarity: 'common', cost: 0,
    printedText: 'Deal 1 damage. Unleash 1: apply 1 Weak.',
    effects: [{ kind: 'hit', amount: 1 }, unleash(1, [{ kind: 'applyWeak', amount: 1 }])],
    upgrade: {
      printedText: 'Deal 2 damage. Unleash 1: apply 1 Weak.',
      effects: [{ kind: 'hit', amount: 2 }, unleash(1, [{ kind: 'applyWeak', amount: 1 }])],
    },
  }),
  kratos({
    id: 'kratos_hyperion_charge', name: 'Hyperion Charge', type: 'attack', rarity: 'common', cost: 2,
    printedText: 'Unleash 2: apply 1 Vulnerable. Deal 3 damage.',
    effects: [unleash(2, [{ kind: 'applyVulnerable', amount: 1 }]), { kind: 'hit', amount: 3 }],
    upgrade: {
      printedText: 'Unleash 2: apply 1 Vulnerable. Deal 4 damage.',
      effects: [unleash(2, [{ kind: 'applyVulnerable', amount: 1 }]), { kind: 'hit', amount: 4 }],
    },
  }),
  kratos({
    id: 'kratos_nemesis_whip', name: 'Nemesis Whip', type: 'attack', rarity: 'common', cost: 1,
    printedText: 'Deal 1 damage 2 times. Unleash 1: 3 times instead.',
    effects: [unleash(1, [{ kind: 'hit', amount: 1, times: 3 }], [{ kind: 'hit', amount: 1, times: 2 }])],
    upgrade: {
      printedText: 'Deal 1 damage 3 times. Unleash 1: 4 times instead.',
      effects: [unleash(1, [{ kind: 'hit', amount: 1, times: 4 }], [{ kind: 'hit', amount: 1, times: 3 }])],
    },
  }),
  kratos({
    id: 'kratos_blade_of_artemis', name: 'Blade of Artemis', type: 'attack', rarity: 'common', cost: 2,
    printedText: 'Deal 3 damage. Godslayer +2.',
    effects: [{ kind: 'hit', amount: godslayer(3, 2) }],
    upgrade: { printedText: 'Deal 4 damage. Godslayer +2.', effects: [{ kind: 'hit', amount: godslayer(4, 2) }] },
  }),
  kratos({
    id: 'kratos_cyclops_eye_rip', name: 'Cyclops Eye Rip', type: 'attack', rarity: 'common', cost: 1,
    printedText: 'Deal 2 damage. Brutal Kill: gain 1 Energy and 2 Rage.',
    effects: [{ kind: 'hit', amount: 2 }, brutalKill([{ kind: 'gainEnergy', amount: 1 }, { kind: 'gainRage', amount: 2 }])],
    upgrade: {
      printedText: 'Deal 3 damage. Brutal Kill: gain 1 Energy and 2 Rage.',
      effects: [{ kind: 'hit', amount: 3 }, brutalKill([{ kind: 'gainEnergy', amount: 1 }, { kind: 'gainRage', amount: 2 }])],
    },
  }),
  kratos({
    id: 'kratos_zeus_fury', name: "Zeus' Fury", type: 'attack', rarity: 'common', cost: 1,
    printedText: 'Deal 1 damage 2 times, choosing any enemy for each hit.',
    effects: [{ kind: 'hitChoices', amount: 1, targets: 2 }],
    upgrade: {
      printedText: 'Deal 1 damage 3 times, choosing any enemy for each hit.',
      effects: [{ kind: 'hitChoices', amount: 1, targets: 3 }],
    },
  }),
  kratos({
    id: 'kratos_rage_of_the_gods', name: 'Rage of the Gods', type: 'skill', rarity: 'common', cost: 0, exhaust: true,
    printedText: 'Gain 2 Rage. Exhaust.',
    effects: [{ kind: 'gainRage', amount: 2 }],
    upgrade: { printedText: 'Gain 3 Rage. Exhaust.', effects: [{ kind: 'gainRage', amount: 3 }] },
  }),
  kratos({
    id: 'kratos_parry', name: 'Parry', type: 'skill', rarity: 'common', cost: 1,
    printedText: 'Gain 2 Block. Gain 1 Rage.',
    effects: [{ kind: 'block', amount: 2 }, { kind: 'gainRage', amount: 1 }],
    upgrade: { printedText: 'Gain 3 Block. Gain 1 Rage.', effects: [{ kind: 'block', amount: 3 }, { kind: 'gainRage', amount: 1 }] },
  }),
  kratos({
    id: 'kratos_spartan_guard', name: 'Spartan Guard', type: 'skill', rarity: 'common', cost: 1,
    printedText: 'Gain 2 Block. Unleash 2: gain 5 Block instead.',
    effects: [unleash(2, [{ kind: 'block', amount: 5 }], [{ kind: 'block', amount: 2 }])],
    upgrade: {
      printedText: 'Gain 3 Block. Unleash 2: gain 6 Block instead.',
      effects: [unleash(2, [{ kind: 'block', amount: 6 }], [{ kind: 'block', amount: 3 }])],
    },
  }),
  kratos({
    id: 'kratos_golden_fleece', name: 'Golden Fleece', type: 'skill', rarity: 'common', cost: 1,
    printedText: 'Gain 2 Block. Unleash 1: deal 1 plain damage to each enemy attacking you for each Attack icon in its intent.',
    effects: [{ kind: 'block', amount: 2 }, unleash(1, [{ kind: 'damagePerAttackIntent', amount: 1 }])],
    upgrade: {
      supportTarget: 'anyPlayer',
      printedText: '3 Block to any player. Unleash 1: deal 1 plain damage to each enemy attacking you (Kratos) for each Attack icon in its intent.',
      effects: [{ kind: 'block', amount: 3, toChosen: true }, unleash(1, [{ kind: 'damagePerAttackIntent', amount: 1 }])],
    },
  }),
  kratos({
    id: 'kratos_icarus_wings', name: 'Icarus Wings', type: 'skill', rarity: 'common', cost: 1,
    printedText: 'Gain 1 Block. Draw 2 cards.',
    effects: [{ kind: 'block', amount: 1 }, { kind: 'draw', amount: 2 }],
    upgrade: { printedText: 'Gain 2 Block. Draw 2 cards.', effects: [{ kind: 'block', amount: 2 }, { kind: 'draw', amount: 2 }] },
  }),

  kratos({
    id: 'kratos_bow_of_apollo', name: 'Bow of Apollo', type: 'attack', rarity: 'common', cost: 0,
    printedText: 'Deal 1 damage. Unleash 1: deal 3 damage instead.',
    effects: [unleash(1, [{ kind: 'hit', amount: 3 }], [{ kind: 'hit', amount: 1 }])],
    upgrade: {
      printedText: 'Deal 2 damage. Unleash 1: deal 4 damage instead.',
      effects: [unleash(1, [{ kind: 'hit', amount: 4 }], [{ kind: 'hit', amount: 2 }])],
    },
  }),
  kratos({
    id: 'kratos_hermes_rush', name: "Hermes' Rush", type: 'skill', rarity: 'common', cost: 1, supportTarget: 'anyPlayer',
    printedText: '2 Block to any player. You may switch rows with another player. Unleash 1: draw 1 card.',
    effects: [{ kind: 'block', amount: 2, toChosen: true }, { kind: 'switchRows' }, unleash(1, [{ kind: 'draw', amount: 1 }])],
    upgrade: {
      printedText: '3 Block to any player. You may switch rows with another player. Unleash 1: draw 1 card.',
      effects: [{ kind: 'block', amount: 3, toChosen: true }, { kind: 'switchRows' }, unleash(1, [{ kind: 'draw', amount: 1 }])],
    },
  }),

  // Uncommon
  kratos({
    id: 'kratos_servant_of_ares', name: 'Servant of Ares', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' },
    printedText: 'Start of turn: gain 1 Rage.',
    effects: [{ kind: 'gainRage', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_chains_of_chaos', name: 'Chains of Chaos', type: 'power', rarity: 'uncommon', cost: 1, persistent: true,
    printedText: 'Whenever you lose HP, gain 1 Rage.',
    effects: [],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_bloodlust', name: 'Bloodlust', type: 'power', rarity: 'uncommon', cost: 1, persistent: true,
    printedText: 'Whenever one of your hits kills an enemy, gain 2 Rage.',
    effects: [],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_ghost_of_sparta', name: 'Ghost of Sparta', type: 'power', rarity: 'uncommon', cost: 1, persistent: true,
    printedText: 'Whenever you spend Rage on an Unleash, gain 1 Block.',
    effects: [],
    upgrade: { printedText: 'Whenever you spend Rage on an Unleash, gain 2 Block.' },
  }),
  kratos({
    id: 'kratos_deicide', name: 'Deicide', type: 'power', rarity: 'uncommon', cost: 1, persistent: true,
    printedText: 'Your hits deal +1 damage to an enemy whose card is an Elite or a Boss. Extra copies do not add more.',
    effects: [],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_vengeance', name: 'Vengeance', type: 'attack', rarity: 'uncommon', cost: 1,
    printedText: 'Deal 1 damage, +1 for each Rage you have. Does not spend Rage.',
    effects: [{ kind: 'hit', amount: perRage(1) }],
    upgrade: { printedText: 'Deal 2 damage, +1 for each Rage you have. Does not spend Rage.', effects: [{ kind: 'hit', amount: perRage(2) }] },
  }),
  kratos({
    id: 'kratos_poseidons_rage', name: "Poseidon's Rage", type: 'attack', rarity: 'uncommon', cost: 2, target: 'row',
    printedText: 'Deal 3 damage to a row. Unleash 2: deal 5 damage instead.',
    effects: [unleash(2, [{ kind: 'hit', amount: 5 }], [{ kind: 'hit', amount: 3 }])],
    upgrade: {
      printedText: 'Deal 4 damage to a row. Unleash 2: deal 6 damage instead.',
      effects: [unleash(2, [{ kind: 'hit', amount: 6 }], [{ kind: 'hit', amount: 4 }])],
    },
  }),
  kratos({
    id: 'kratos_atlas_quake', name: 'Atlas Quake', type: 'attack', rarity: 'uncommon', cost: 2, target: 'row',
    printedText: 'Deal 2 damage to a row. Unleash 2: apply 1 Weak and 1 Vulnerable to that row.',
    effects: [{ kind: 'hit', amount: 2 }, unleash(2, [{ kind: 'applyWeak', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }])],
    upgrade: {
      printedText: 'Deal 3 damage to a row. Unleash 2: apply 1 Weak and 1 Vulnerable to that row.',
      effects: [{ kind: 'hit', amount: 3 }, unleash(2, [{ kind: 'applyWeak', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }])],
    },
  }),
  kratos({
    id: 'kratos_cronos_rage', name: "Cronos' Rage", type: 'attack', rarity: 'uncommon', cost: 2,
    printedText: 'Deal 1 damage 3 times, choosing any enemy for each hit. Gain 2 Rage.',
    effects: [{ kind: 'hitChoices', amount: 1, targets: 3 }, { kind: 'gainRage', amount: 2 }],
    upgrade: {
      printedText: 'Deal 1 damage 4 times, choosing any enemy for each hit. Gain 2 Rage.',
      effects: [{ kind: 'hitChoices', amount: 1, targets: 4 }, { kind: 'gainRage', amount: 2 }],
    },
  }),
  kratos({
    id: 'kratos_tartarus_rage', name: 'Tartarus Rage', type: 'attack', rarity: 'uncommon', cost: 1, target: 'row',
    printedText: 'Deal 1 damage to a row once for each other Attack you played this turn.',
    effects: [{ kind: 'hit', amount: 1, times: { base: 0, per: 'attacksPlayedThisTurn' } }],
    upgrade: {
      printedText: 'Deal 1 damage to a row once, plus once for each other Attack you played this turn.',
      effects: [{ kind: 'hit', amount: 1, times: { base: 1, per: 'attacksPlayedThisTurn' } }],
    },
  }),
  kratos({
    id: 'kratos_apollos_ascension', name: "Apollo's Ascension", type: 'attack', rarity: 'uncommon', cost: 1,
    printedText: 'Deal 2 damage. Unleash 1: apply 1 Vulnerable.',
    effects: [{ kind: 'hit', amount: 2 }, unleash(1, [{ kind: 'applyVulnerable', amount: 1 }])],
    upgrade: {
      printedText: 'Deal 3 damage. Unleash 1: apply 1 Vulnerable.',
      effects: [{ kind: 'hit', amount: 3 }, unleash(1, [{ kind: 'applyVulnerable', amount: 1 }])],
    },
  }),
  kratos({
    id: 'kratos_nemean_cestus', name: 'Nemean Cestus', type: 'attack', rarity: 'uncommon', cost: 2,
    printedText: "Remove all of the target's Block. Deal 3 damage. Godslayer +2.",
    effects: [{ kind: 'clearTargetBlock' }, { kind: 'hit', amount: godslayer(3, 2) }],
    upgrade: {
      printedText: "Remove all of the target's Block. Deal 4 damage. Godslayer +2.",
      effects: [{ kind: 'clearTargetBlock' }, { kind: 'hit', amount: godslayer(4, 2) }],
    },
  }),
  kratos({
    id: 'kratos_claws_of_hades', name: 'Claws of Hades', type: 'attack', rarity: 'uncommon', cost: 1,
    printedText: 'Deal 2 damage. Brutal Kill: draw 2 cards.',
    effects: [{ kind: 'hit', amount: 2 }, brutalKill([{ kind: 'draw', amount: 2 }])],
    upgrade: { printedText: 'Deal 3 damage. Brutal Kill: draw 2 cards.', effects: [{ kind: 'hit', amount: 3 }, brutalKill([{ kind: 'draw', amount: 2 }])] },
  }),
  kratos({
    id: 'kratos_nemean_roar', name: 'Nemean Roar', type: 'attack', rarity: 'uncommon', cost: 1, target: 'row',
    printedText: 'Deal 1 damage to a row. Unleash 2: apply 1 Weak to that row.',
    effects: [{ kind: 'hit', amount: 1 }, unleash(2, [{ kind: 'applyWeak', amount: 1 }])],
    upgrade: {
      printedText: 'Deal 2 damage to a row. Unleash 2: apply 1 Weak to that row.',
      effects: [{ kind: 'hit', amount: 2 }, unleash(2, [{ kind: 'applyWeak', amount: 1 }])],
    },
  }),
  kratos({
    id: 'kratos_army_of_sparta', name: 'Army of Sparta', type: 'attack', rarity: 'uncommon', cost: 2, target: 'row',
    printedText: 'Deal 2 damage to a row. Gain 3 Block.',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'block', amount: 3 }],
    upgrade: { printedText: 'Deal 2 damage to a row. Gain 4 Block.', effects: [{ kind: 'hit', amount: 2 }, { kind: 'block', amount: 4 }] },
  }),
  kratos({
    id: 'kratos_medusas_gaze', name: "Medusa's Gaze", type: 'skill', rarity: 'uncommon', cost: 1,
    printedText: 'Apply 1 Weak. If the target has 3 or fewer HP, set its HP to 0 (not a hit).',
    effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'execute', hpAtMost: 3 }],
    upgrade: {
      printedText: 'Apply 1 Weak. If the target has 4 or fewer HP, set its HP to 0 (not a hit).',
      effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'execute', hpAtMost: 4 }],
    },
  }),
  kratos({
    id: 'kratos_head_of_helios', name: 'Head of Helios', type: 'skill', rarity: 'uncommon', cost: 1, target: 'row', exhaust: true,
    printedText: 'Apply 1 Weak to a row. Draw 1 card. Exhaust.',
    effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'draw', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_rage_of_the_titans', name: 'Rage of the Titans', type: 'skill', rarity: 'uncommon', cost: 1, target: 'row',
    printedText: 'Spend all your Rage. Deal that much plain damage to a row and gain that much Block.',
    effects: [{ kind: 'damage', amount: perRage(0) }, { kind: 'block', amount: perRage(0) }, { kind: 'loseAllRage' }],
    upgrade: {
      printedText: 'Spend all your Rage. Deal that much plain damage to a row and gain that much Block +1.',
      effects: [{ kind: 'damage', amount: perRage(0) }, { kind: 'block', amount: perRage(1) }, { kind: 'loseAllRage' }],
    },
  }),
  kratos({
    id: 'kratos_spartan_resolve', name: 'Spartan Resolve', type: 'skill', rarity: 'uncommon', cost: 1,
    printedText: 'Gain Block equal to your Rage. Does not spend Rage.',
    effects: [{ kind: 'block', amount: perRage(0) }],
    upgrade: { printedText: 'Gain 2 Block, +1 for each Rage you have. Does not spend Rage.', effects: [{ kind: 'block', amount: perRage(2) }] },
  }),
  kratos({
    id: 'kratos_hubris', name: 'Hubris', type: 'skill', rarity: 'uncommon', cost: 0,
    printedText: 'Lose 1 HP. If you did, draw 2 cards.',
    effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'draw', amount: 2, when: { kind: 'lostHpToThisCard' } }],
    upgrade: {
      printedText: 'Lose 1 HP. If you did, draw 3 cards.',
      effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'draw', amount: 3, when: { kind: 'lostHpToThisCard' } }],
    },
  }),
  kratos({
    id: 'kratos_sacrifice', name: 'Sacrifice', type: 'skill', rarity: 'uncommon', cost: 0,
    printedText: 'Exhaust a card from your hand. If you did, gain 2 Rage.',
    effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'gainRage', amount: 2, when: { kind: 'exhaustedByThisCard' } }],
    upgrade: {
      printedText: 'Exhaust a card from your hand. If you did, gain 3 Rage.',
      effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'gainRage', amount: 3, when: { kind: 'exhaustedByThisCard' } }],
    },
  }),
  kratos({
    id: 'kratos_blood_oath', name: 'Blood Oath', type: 'skill', rarity: 'uncommon', cost: 0, exhaust: true,
    printedText: 'Lose 1 HP. Gain 1 Energy. Exhaust.',
    effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'gainEnergy', amount: 1 }],
    upgrade: {
      printedText: 'Lose 1 HP. Gain 2 Energy. Exhaust.',
      effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'gainEnergy', amount: 2 }],
    },
  }),
  kratos({
    id: 'kratos_athenas_blessing', name: "Athena's Blessing", type: 'skill', rarity: 'uncommon', cost: 1,
    printedText: 'Draw 2 cards. Unleash 2: draw 1 more card.',
    effects: [{ kind: 'draw', amount: 2 }, unleash(2, [{ kind: 'draw', amount: 1 }])],
    upgrade: { printedText: 'Draw 3 cards. Unleash 2: draw 1 more card.', effects: [{ kind: 'draw', amount: 3 }, unleash(2, [{ kind: 'draw', amount: 1 }])] },
  }),
  kratos({
    id: 'kratos_boots_of_hermes', name: 'Boots of Hermes', type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    printedText: 'Draw 1 card. Your next Attack this turn costs 0. Exhaust.',
    effects: [{ kind: 'draw', amount: 1 }, { kind: 'discountNextAttack' }],
    upgrade: { printedText: 'Draw 2 cards. Your next Attack this turn costs 0. Exhaust.', effects: [{ kind: 'draw', amount: 2 }, { kind: 'discountNextAttack' }] },
  }),
  kratos({
    id: 'kratos_loom_of_fate', name: 'Loom of Fate', type: 'skill', rarity: 'uncommon', cost: 1,
    printedText: 'Put a card from your discard pile into your hand. Gain 1 Rage.',
    effects: [{ kind: 'recoverDiscard', amount: 1, toHand: true }, { kind: 'gainRage', amount: 1 }],
    upgrade: {
      printedText: 'Put a card from your discard pile into your hand. Gain 2 Rage.',
      effects: [{ kind: 'recoverDiscard', amount: 1, toHand: true }, { kind: 'gainRage', amount: 2 }],
    },
  }),

  kratos({
    id: 'kratos_typhons_bane', name: "Typhon's Bane", type: 'skill', rarity: 'uncommon', cost: 1,
    printedText: 'Assign 2 separate 1 Weak tokens to any enemies (both may go on one enemy).',
    effects: [{ kind: 'weakChoices', amount: 1, targets: 2 }],
    upgrade: {
      printedText: 'Assign 3 separate 1 Weak tokens to any enemies (several may go on one enemy).',
      effects: [{ kind: 'weakChoices', amount: 1, targets: 3 }],
    },
  }),
  kratos({
    id: 'kratos_head_of_euryale', name: 'Head of Euryale', type: 'skill', rarity: 'uncommon', cost: 2, target: 'row', exhaust: true,
    printedText: 'Apply 1 Weak to a row. Set the HP of each enemy in that row with 3 or fewer HP to 0 (not a hit). Exhaust.',
    effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'execute', hpAtMost: 3 }],
    upgrade: { cost: 1 },
  }),
  kratos({
    id: 'kratos_soul_summon', name: 'Soul Summon', type: 'power', rarity: 'uncommon', cost: 1, target: 'row',
    trigger: { kind: 'endOfTurn' },
    printedText: 'End of turn: deal 1 plain damage to a row.',
    effects: [{ kind: 'damage', amount: 1 }],
    upgrade: { printedText: 'End of turn: deal 2 plain damage to a row.', effects: [{ kind: 'damage', amount: 2 }] },
  }),
  kratos({
    id: 'kratos_green_orbs', name: 'Green Orbs', type: 'power', rarity: 'uncommon', cost: 1, persistent: true,
    printedText: 'The first time one of your hits kills an enemy, heal 1 HP, then exhaust every Green Orbs you have in play.',
    effects: [],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_hercules_shoulder_guard', name: "Hercules' Shoulder Guard", type: 'skill', rarity: 'uncommon', cost: 2,
    printedText: 'Gain 3 Block. Unleash 1: gain 2 more Block.',
    effects: [{ kind: 'block', amount: 3 }, unleash(1, [{ kind: 'block', amount: 2 }])],
    upgrade: {
      printedText: 'Gain 4 Block. Unleash 1: gain 2 more Block.',
      effects: [{ kind: 'block', amount: 4 }, unleash(1, [{ kind: 'block', amount: 2 }])],
    },
  }),

  // Rare
  kratos({
    id: 'kratos_rage_of_sparta', name: 'Rage of Sparta', type: 'skill', rarity: 'rare', cost: 1, exhaust: true,
    printedText: 'Spend all your Rage. Gain that much Strength until end of turn. If you spent 5 Rage, you cannot lose more than 1 HP this round. Exhaust.',
    effects: [
      { kind: 'limitRoundHpLoss', amount: 1, when: { kind: 'rageAtLeast', amount: 5 } },
      // Only the Strength actually gained under the cap of 8 leaves at end of turn.
      { kind: 'gainTemporaryStrength', amount: perRage(0), loseGainedOnly: true },
      { kind: 'loseAllRage' },
    ],
    upgrade: {
      retain: true,
      printedText: 'Retain. Spend all your Rage. Gain that much Strength until end of turn. If you spent 5 Rage, you cannot lose more than 1 HP this round. Exhaust.',
    },
  }),
  kratos({
    id: 'kratos_blade_of_olympus', name: 'Blade of Olympus', type: 'attack', rarity: 'rare', cost: 2,
    printedText: 'Deal 2 damage, +2 for each Rage you have. Then spend all your Rage.',
    effects: [{ kind: 'hit', amount: perRage(2, 2) }, { kind: 'loseAllRage' }],
    upgrade: {
      printedText: 'Deal 4 damage, +2 for each Rage you have. Then spend all your Rage.',
      effects: [{ kind: 'hit', amount: perRage(4, 2) }, { kind: 'loseAllRage' }],
    },
  }),
  kratos({
    id: 'kratos_god_of_war', name: 'God of War', type: 'power', rarity: 'rare', cost: 3,
    trigger: { kind: 'startOfTurn' },
    printedText: 'Your Unleash costs are 1 Rage lower (minimum 0). Start of turn: gain 1 Rage. Extra copies add Rage but do not lower costs further.',
    effects: [{ kind: 'gainRage', amount: 1 }],
    upgrade: { cost: 2 },
  }),
  kratos({
    id: 'kratos_blades_of_athena', name: 'Blades of Athena', type: 'power', rarity: 'rare', cost: 2,
    trigger: { kind: 'onPlayCard', cardType: 'attack' },
    printedText: 'After you play an Attack, gain 1 Rage.',
    effects: [{ kind: 'gainRage', amount: 1 }],
    upgrade: { cost: 1 },
  }),
  kratos({
    id: 'kratos_army_of_hades', name: 'Army of Hades', type: 'power', rarity: 'rare', cost: 2, target: 'row',
    trigger: { kind: 'endOfTurn' },
    printedText: 'End of turn: deal plain damage to a row equal to the number of Attacks you played this turn.',
    effects: [{ kind: 'damage', amount: { base: 0, per: 'attacksPlayedThisTurn' } }],
    upgrade: { cost: 1 },
  }),
  kratos({
    id: 'kratos_barbarian_hammer', name: 'Barbarian Hammer', type: 'attack', rarity: 'rare', cost: 3, target: 'row',
    printedText: 'Unleash 2: apply 1 Vulnerable to a row. Deal 5 damage to that row.',
    effects: [unleash(2, [{ kind: 'applyVulnerable', amount: 1 }]), { kind: 'hit', amount: 5 }],
    upgrade: {
      printedText: 'Unleash 2: apply 1 Vulnerable to a row. Deal 6 damage to that row.',
      effects: [unleash(2, [{ kind: 'applyVulnerable', amount: 1 }]), { kind: 'hit', amount: 6 }],
    },
  }),
  kratos({
    id: 'kratos_patricide', name: 'Patricide', type: 'attack', rarity: 'rare', cost: 3,
    printedText: 'Deal 1 damage 5 times. Godslayer +1.',
    effects: [{ kind: 'hit', amount: godslayer(1, 1), times: 5 }],
    upgrade: { printedText: 'Deal 1 damage 6 times. Godslayer +1.', effects: [{ kind: 'hit', amount: godslayer(1, 1), times: 6 }] },
  }),
  kratos({
    id: 'kratos_blade_of_the_gods', name: 'Blade of the Gods', type: 'attack', rarity: 'rare', cost: 2,
    printedText: 'Deal 3 damage. Godslayer +4.',
    effects: [{ kind: 'hit', amount: godslayer(3, 4) }],
    upgrade: { printedText: 'Deal 4 damage. Godslayer +5.', effects: [{ kind: 'hit', amount: godslayer(4, 5) }] },
  }),
  kratos({
    id: 'kratos_spear_of_destiny', name: 'Spear of Destiny', type: 'attack', rarity: 'rare', cost: 2, target: 'row',
    printedText: 'Deal 3 damage to a row. Apply 1 Vulnerable to that row.',
    effects: [{ kind: 'hit', amount: 3 }, { kind: 'applyVulnerable', amount: 1 }],
    upgrade: {
      printedText: 'Deal 4 damage to a row. Apply 1 Vulnerable to that row.',
      effects: [{ kind: 'hit', amount: 4 }, { kind: 'applyVulnerable', amount: 1 }],
    },
  }),
  kratos({
    id: 'kratos_red_orbs', name: 'Red Orbs', type: 'power', rarity: 'rare', cost: 2, persistent: true,
    printedText: 'Whenever one of your hits kills an enemy, gain 1 Energy and 1 Rage.',
    effects: [],
    upgrade: { cost: 1 },
  }),
  kratos({
    id: 'kratos_pandoras_box', name: "Pandora's Box", type: 'skill', rarity: 'rare', cost: 1, exhaust: true,
    printedText: 'Lose 2 HP. Gain 5 Rage. Draw 2 cards. Exhaust.',
    effects: [{ kind: 'loseOwnHp', amount: 2 }, { kind: 'gainRage', amount: 5 }, { kind: 'draw', amount: 2 }],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_escape_from_hades', name: 'Escape from Hades', type: 'power', rarity: 'rare', cost: 2, persistent: true,
    printedText: 'The first time you would lose your last HP, keep 1 HP instead and exhaust this Power.',
    effects: [],
    upgrade: { cost: 1 },
  }),
  kratos({
    id: 'kratos_amulet_of_the_fates', name: 'Amulet of the Fates', type: 'skill', rarity: 'rare', cost: 2, target: 'allEnemies', exhaust: true,
    printedText: 'Apply 2 Weak to every enemy. Gain 4 Block. Exhaust.',
    effects: [{ kind: 'applyWeak', amount: 2 }, { kind: 'block', amount: 4 }],
    upgrade: { cost: 1 },
  }),
  kratos({
    id: 'kratos_blades_of_exile', name: 'Blades of Exile', type: 'power', rarity: 'rare', cost: 1, persistent: true,
    printedText: 'Each hit of your Attacks that target a row or every enemy deals +1 damage. Extra copies do not add more.',
    effects: [],
    upgrade: { cost: 0 },
  }),
  kratos({
    id: 'kratos_fall_of_olympus', name: 'Fall of Olympus', type: 'attack', rarity: 'rare', cost: 2, target: 'allEnemies', exhaust: true,
    printedText: 'Deal 2 damage to every enemy 3 times. Exhaust.',
    effects: [{ kind: 'hit', amount: 2, times: 3 }],
    upgrade: { printedText: 'Deal 2 damage to every enemy 4 times. Exhaust.', effects: [{ kind: 'hit', amount: 2, times: 4 }] },
  }),
].map((def) => [def.id, def]))

export const KRATOS_STARTER_DECK = [
  ...Array(4).fill('strike_kratos'), ...Array(4).fill('defend_kratos'),
  'kratos_blades_of_chaos', 'kratos_plume_of_prometheus',
] as const
