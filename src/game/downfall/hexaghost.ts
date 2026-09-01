// Official Downfall TTS public-v1.47 Hexaghost card faces.
// These are board-game transcriptions; no PC-mod values or behavior are used.
const heat = (amount: number) => ({ kind: 'heatAtLeast' as const, amount })
const exhausted = { kind: 'cardsInExhaustAtLeast' as const, amount: 2 }
const advance = { kind: 'advance' as const }
const retract = { kind: 'retract' as const }

const card = <T>(def: T): T => def

export const HEXAGHOST_CARDS = {
  strike_hexaghost: card({
    id: 'strike_hexaghost', name: 'Strike', owner: 'hexaghost', type: 'attack', rarity: 'starter', cost: 1,
    effects: [{ kind: 'hit', amount: 1 }], upgrade: { effects: [{ kind: 'hit', amount: 2 }] },
  }),
  defend_hexaghost: card({
    id: 'defend_hexaghost', name: 'Defend', owner: 'hexaghost', type: 'skill', rarity: 'starter', cost: 1,
    effects: [{ kind: 'block', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 2, toChosen: true }], supportTarget: 'anyPlayer' },
  }),
  kindle: card({
    id: 'kindle', name: 'Kindle', owner: 'hexaghost', type: 'skill', rarity: 'starter', cost: 1,
    effects: [{ kind: 'block', amount: 1 }, advance],
    upgrade: { effects: [{ kind: 'block', amount: 2 }, advance] },
  }),
  sear: card({
    id: 'sear', name: 'Sear', owner: 'hexaghost', type: 'attack', rarity: 'starter', cost: 0,
    effects: [{ kind: 'hit', amount: { base: 1, bonus: { plus: 1, when: heat(2) } } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 1, when: heat(2) } } }] },
  }),

  advancing_guard: card({
    id: 'advancing_guard', name: 'Advancing Guard', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 2,
    supportTarget: 'anyPlayer', effects: [{ kind: 'block', amount: 2, toChosen: true }, advance],
    upgrade: { effects: [{ kind: 'block', amount: 3, toChosen: true }, advance] },
  }),
  burning_touch: card({
    id: 'burning_touch', name: 'Burning Touch', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 2,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'gainSoulburn', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'gainSoulburn', amount: 1 }] },
  }),
  firestarter: card({
    id: 'firestarter', name: 'Firestarter', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 1, exhaust: true,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'draw', amount: 2 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'draw', amount: 3 }] },
  }),
  flare_flick: card({
    id: 'flare_flick', name: 'Flare Flick', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 1,
    target: 'row', effects: [{
      kind: 'hit', amount: 1, times: { base: 1, bonus: { plus: 1, when: heat(2) } },
    }],
    upgrade: { effects: [{
      kind: 'hit', amount: 1, times: { base: 1, bonus: { plus: 2, when: heat(2) } },
    }] },
  }),
  fleeting_flash: card({
    id: 'fleeting_flash', name: 'Fleeting Flash', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 1,
    exhaust: true, effects: [{ kind: 'gainSoulburn', amount: 1 }], upgrade: { cost: 0 },
  }),
  ghost_lash: card({
    id: 'ghost_lash', name: 'Ghost Lash', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 0,
    effects: [{ kind: 'hit', amount: 1, times: { base: 1, bonus: { plus: 1, when: exhausted } } }],
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: { base: 1, bonus: { plus: 2, when: exhausted } } }] },
  }),
  premonition: card({
    id: 'premonition', name: 'Premonition', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'block', amount: 2 }, { kind: 'draw', amount: 2, when: heat(3) }],
    upgrade: { effects: [{ kind: 'block', amount: 3 }, { kind: 'draw', amount: 2, when: heat(3) }] },
  }),
  shield_of_night: card({
    id: 'shield_of_night', name: 'Shield of Night', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 2,
    effects: [{ kind: 'block', amount: 3 }, { kind: 'exhaustFromHand', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 4 }, { kind: 'exhaustFromHand', amount: 1 }] },
  }),
  sword_of_night: card({
    id: 'sword_of_night', name: 'Sword of Night', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'exhaustFromHand', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'exhaustFromHand', amount: 1 }] },
  }),
  thermal_transfer: card({
    id: 'thermal_transfer', name: 'Thermal Transfer', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 1 }, advance],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }, advance] },
  }),
  ghost_shield: card({
    id: 'ghost_shield', name: 'Ghost Shield', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 0,
    effects: [{ kind: 'block', amount: { base: 1, bonus: { plus: 1, when: exhausted } } }],
    upgrade: { effects: [{ kind: 'block', amount: { base: 2, bonus: { plus: 1, when: exhausted } } }] },
  }),
  floatwork: card({
    id: 'floatwork', name: 'Floatwork', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 2,
    effects: [{ kind: 'block', amount: 2 }, { kind: 'gainSoulburn', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 3 }, { kind: 'gainSoulburn', amount: 1 }] },
  }),
  nightmare_strike: card({
    id: 'nightmare_strike', name: 'Nightmare Strike', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }], exhaustReaction: { effects: [{ kind: 'gainStrength', amount: 1 }] },
    upgrade: { effects: [{ kind: 'hit', amount: 3 }] },
  }),
  heat_crush: card({
    id: 'heat_crush', name: 'Heat Crush', owner: 'hexaghost', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'nextSoulburnDamageBonus', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }, { kind: 'nextSoulburnDamageBonus', amount: 3 }] },
  }),
  fast_forward: card({
    id: 'fast_forward', name: 'Fast Forward', owner: 'hexaghost', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'draw', amount: 2 }, advance],
    upgrade: { effects: [{ kind: 'draw', amount: 3 }, advance] },
  }),

  float: card({
    id: 'float', name: 'Float', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [{ kind: 'gainEnergy', amount: { base: 2, bonus: { plus: 1, when: heat(4) } } }],
    upgrade: { effects: [{ kind: 'gainEnergy', amount: { base: 3, bonus: { plus: 1, when: heat(4) } } }] },
  }),
  heat_metal: card({
    id: 'heat_metal', name: 'Heat Metal', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'draw', amount: 2, when: { kind: 'soulburnUsedThisTurn' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'draw', amount: 2, when: { kind: 'soulburnUsedThisTurn' } }] },
  }),
  whisper_from_beyond: card({
    id: 'whisper_from_beyond', name: 'Whisper from Beyond', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 1, times: 2 }, { kind: 'applyWeak', amount: 1, when: exhausted }],
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: 3 }, { kind: 'applyWeak', amount: 1, when: exhausted }] },
  }),
  heat_shield: card({
    id: 'heat_shield', name: 'Heat Shield', owner: 'hexaghost', type: 'power', rarity: 'uncommon', cost: 2,
    trigger: { kind: 'onUseSoulburn' }, oncePerTurn: true, effects: [{ kind: 'block', amount: 2 }],
    upgrade: { effects: [{ kind: 'block', amount: 3 }] },
  }),
  flames_from_beyond: card({
    id: 'flames_from_beyond', name: 'Flames from Beyond', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 2,
    target: 'row', effects: [{ kind: 'hit', amount: { base: 2, per: 'cardsInExhaust' } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 3, per: 'cardsInExhaust' } }] },
  }),
  devour_flame: card({
    id: 'devour_flame', name: 'Devour Flame', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'block', amount: 2 }, { kind: 'exhaustNextCard' }],
    upgrade: { effects: [{ kind: 'block', amount: 3 }, { kind: 'exhaustNextCard' }] },
  }),
  hexaguard: card({
    id: 'hexaguard', name: 'Hexaguard', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [{ kind: 'block', amount: { base: 0, per: 'heat' } }], upgrade: { exhaust: false },
  }),
  bad_omen: card({
    id: 'bad_omen', name: 'Bad Omen', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'block', amount: 2 }, { kind: 'applyWeak', amount: 2, when: heat(2) }, retract],
    upgrade: { effects: [{ kind: 'block', amount: 3 }, { kind: 'applyWeak', amount: 2, when: heat(2) }, retract] },
  }),
  catch_up: card({
    id: 'catch_up', name: 'Catch Up', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 'X', exhaust: true,
    effects: [{ kind: 'advance', times: { base: 0, per: 'energySpent' } }],
    upgrade: { effects: [{ kind: 'advance', times: { base: 1, per: 'energySpent' } }] },
  }),
  charged_barrage: card({
    id: 'charged_barrage', name: 'Charged Barrage', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 2,
    target: 'row', effects: [{ kind: 'hit', amount: { base: 3, bonus: { plus: 2, when: heat(4) } } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 4, bonus: { plus: 2, when: heat(4) } } }] },
  }),
  divider: card({
    id: 'divider', name: 'Divider', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: 1, times: { base: 0, per: 'heat' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: { base: 1, per: 'heat' } }] },
  }),
  empowered_flame: card({
    id: 'empowered_flame', name: 'Empowered Flame', owner: 'hexaghost', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' }, effects: [advance], upgrade: { cost: 0 },
  }),
  haunted_hand: card({
    id: 'haunted_hand', name: 'Haunted Hand', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [{ kind: 'sequence', when: heat(2), effects: [{ kind: 'gainStrength', amount: 1 }, retract] }],
    upgrade: { exhaust: false },
  }),
  haunting_echo: card({
    id: 'haunting_echo', name: 'Haunting Echo', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'copyLastAttack', when: heat(5) }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'copyLastAttack', when: heat(5) }] },
  }),
  lingering_shades: card({
    id: 'lingering_shades', name: 'Lingering Shades', owner: 'hexaghost', type: 'power', rarity: 'uncommon', cost: 2,
    activeAbility: true, oncePerTurn: true,
    effects: [{ kind: 'spendEnergy', amount: 1 }, { kind: 'gainSoulburn', amount: 1 }], upgrade: { cost: 1 },
  }),
  living_bomb: card({
    id: 'living_bomb', name: 'Living Bomb', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'gainSoulburn', amount: 1 }, { kind: 'useAllSoulburn', target: 'row' }], upgrade: { cost: 1 },
  }),
  nightmare_guise: card({
    id: 'nightmare_guise', name: 'Nightmare Guise', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'block', amount: 2 }], exhaustReaction: { effects: [{ kind: 'advance', times: 2 }] },
    upgrade: { effects: [{ kind: 'block', amount: 3 }] },
  }),
  nightmare_vision: card({
    id: 'nightmare_vision', name: 'Nightmare Vision', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'draw', amount: 2 }], exhaustReaction: { effects: [{ kind: 'gainEnergy', amount: 2 }] },
    upgrade: { effects: [{ kind: 'draw', amount: 3 }] },
  }),
  phantom_fireball: card({
    id: 'phantom_fireball', name: 'Phantom Fireball', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'gainSoulburn', amount: 1, when: heat(4) }],
    upgrade: { effects: [{ kind: 'hit', amount: 1 }, { kind: 'gainSoulburn', amount: 1, when: heat(2) }] },
  }),
  rain_of_embers: card({
    id: 'rain_of_embers', name: 'Rain of Embers', owner: 'hexaghost', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'onExhaust' }, oncePerTurn: true, effects: [{ kind: 'gainSoulburn', amount: 1 }], upgrade: { cost: 0 },
  }),
  rewind: card({
    id: 'rewind', name: 'Rewind', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'draw', amount: 3 }, retract],
    upgrade: { effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'draw', amount: 4 }, retract] },
  }),
  searing_wound: card({
    id: 'searing_wound', name: 'Searing Wound', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'applyVulnerable', amount: 1 }, retract],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'applyVulnerable', amount: 1 }, retract] },
  }),
  seventh_eye: card({
    id: 'seventh_eye', name: 'Seventh Eye', owner: 'hexaghost', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [
      { kind: 'hit', amount: 2 }, { kind: 'block', amount: 2 },
      { kind: 'applyWeak', amount: 1, when: heat(5) }, { kind: 'applyVulnerable', amount: 1, when: heat(5) },
    ], upgrade: { effects: [
      { kind: 'hit', amount: 2 }, { kind: 'block', amount: 2 },
      { kind: 'applyWeak', amount: 1, when: heat(4) }, { kind: 'applyVulnerable', amount: 1, when: heat(4) },
    ] },
  }),
  spectral_grace: card({
    id: 'spectral_grace', name: 'Spectral Grace', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer', exhaust: true, effects: [{ kind: 'block', amount: 3, toChosen: true }],
    upgrade: { effects: [{ kind: 'block', amount: 4, toChosen: true }] },
  }),
  stoke_the_fire: card({
    id: 'stoke_the_fire', name: 'Stoke the Fire', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 4,
    exhaustCostReduction: 1, exhaust: true, effects: [{ kind: 'gainStrength', amount: 1 }], upgrade: { exhaust: false },
  }),
  turn_it_up: card({
    id: 'turn_it_up', name: 'Turn It Up', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [advance, { kind: 'gainStrength', amount: 1, when: heat(5) }],
    upgrade: { effects: [advance, { kind: 'gainStrength', amount: 1, when: heat(4) }] },
  }),
  volcano_visage: card({
    id: 'volcano_visage', name: 'Volcano Visage', owner: 'hexaghost', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'onAdvance' }, effects: [{ kind: 'block', amount: 1 }], upgrade: { cost: 0 },
  }),
  worthy_sacrifice: card({
    id: 'worthy_sacrifice', name: 'Worthy Sacrifice', owner: 'hexaghost', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'block', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  time_of_need: card({
    id: 'time_of_need', name: 'Time of Need', owner: 'hexaghost', type: 'skill', rarity: 'uncommon', cost: 0, retain: true,
    effects: [{ kind: 'block', amount: 1 }, { kind: 'exhaustFromHand', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 2 }, { kind: 'exhaustFromHand', amount: 1 }] },
  }),

  devils_dance: card({
    id: 'devils_dance', name: "Devil's Dance", owner: 'hexaghost', type: 'power', rarity: 'rare', cost: 2,
    trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }, { kind: 'draw', amount: 1 }, retract],
    upgrade: { cost: 1 },
  }),
  bright_ritual: card({
    id: 'bright_ritual', name: 'Bright Ritual', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 1,
    effects: [
      { kind: 'weakChoices', amount: 1, targets: 2, when: heat(3) },
      { kind: 'vulnerableChoices', amount: 1, targets: 2, when: heat(3) },
      { kind: 'retract', times: 2 },
    ], upgrade: { effects: [
      { kind: 'weakChoices', amount: 1, targets: 3, when: heat(3) },
      { kind: 'vulnerableChoices', amount: 1, targets: 3, when: heat(3) },
      { kind: 'retract', times: 2 },
    ] },
  }),
  incineration: card({
    id: 'incineration', name: 'Incineration', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 2, exhaust: true,
    effects: [{ kind: 'useAllSoulburn', target: 'enemy', regain: true }], upgrade: { cost: 1 },
  }),
  infernal_form: card({
    id: 'infernal_form', name: 'Infernal Form', owner: 'hexaghost', type: 'power', rarity: 'rare', cost: 3,
    trigger: { kind: 'startOfTurn' }, effects: [{
      kind: 'branch', condition: heat(6),
      effects: [{ kind: 'retract', times: 6 }, { kind: 'gainStrength', amount: 2 }],
      otherwise: [{ kind: 'advance', times: 2 }],
    }], upgrade: { effects: [{
      kind: 'branch', condition: heat(6),
      effects: [{ kind: 'retract', times: 6 }, { kind: 'gainStrength', amount: 3 }],
      otherwise: [{ kind: 'advance', times: 2 }],
    }] },
  }),
  poltergeist: card({
    id: 'poltergeist', name: 'Poltergeist', owner: 'hexaghost', type: 'power', rarity: 'rare', cost: 1,
    trigger: { kind: 'onAdvance' }, effects: [{ kind: 'damage', amount: 2 }],
    additionalTriggers: [{ trigger: { kind: 'onRetract' }, effects: [{ kind: 'damage', amount: 2 }] }],
    upgrade: { effects: [{ kind: 'damage', amount: 3 }], additionalTriggers: [{ trigger: { kind: 'onRetract' }, effects: [{ kind: 'damage', amount: 3 }] }] },
  }),
  doomsday: card({
    id: 'doomsday', name: 'Doomsday', owner: 'hexaghost', type: 'attack', rarity: 'rare', cost: 0, target: 'row',
    effects: [{ kind: 'hit', amount: 6, when: heat(6) }], upgrade: { effects: [{ kind: 'hit', amount: 9, when: heat(6) }] },
  }),
  forked_flame: card({
    id: 'forked_flame', name: 'Forked Flame', owner: 'hexaghost', type: 'attack', rarity: 'rare', cost: 2,
    effects: [], modes: [
      { label: 'Three hits', effects: [{ kind: 'hitChoices', amount: 1, targets: 3 }] },
      { label: 'Hit and Advance', effects: [{ kind: 'hit', amount: 2 }, advance] },
      { label: 'Row hit', effects: [{ kind: 'rowHit', amount: 3 }] },
    ], upgrade: { modes: [
      { label: 'Three hits', effects: [{ kind: 'hitChoices', amount: 2, targets: 3 }] },
      { label: 'Hit and Advance', effects: [{ kind: 'hit', amount: 3 }, advance] },
      { label: 'Row hit', effects: [{ kind: 'rowHit', amount: 4 }] },
    ] },
  }),
  power_from_beyond: card({
    id: 'power_from_beyond', name: 'Power from Beyond', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 2,
    exhaust: true, effects: [{ kind: 'gainStrength', amount: { base: 0, per: 'attacksInExhaust' } }], upgrade: { cost: 1 },
  }),
  step_through: card({
    id: 'step_through', name: 'Step Through', owner: 'hexaghost', type: 'attack', rarity: 'rare', cost: 1,
    effects: [
      { kind: 'hit', amount: { base: 2, bonus: { plus: 4, when: heat(6) } } },
      { kind: 'draw', amount: 2, when: heat(2) }, { kind: 'block', amount: 2, when: heat(4) },
    ], upgrade: { effects: [
      { kind: 'hit', amount: { base: 3, bonus: { plus: 6, when: heat(6) } } },
      { kind: 'draw', amount: 3, when: heat(2) }, { kind: 'block', amount: 3, when: heat(4) },
    ] },
  }),
  unleash_spirits: card({
    id: 'unleash_spirits', name: 'Unleash Spirits', owner: 'hexaghost', type: 'power', rarity: 'rare', cost: 3,
    trigger: { kind: 'endOfTurn' }, target: 'row', effects: [{ kind: 'damage', amount: { base: 0, per: 'cardsInExhaust' } }],
    upgrade: { cost: 2 },
  }),
  unlimited_power: card({
    id: 'unlimited_power', name: 'Unlimited Power', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 0,
    exhaust: true, effects: [{ kind: 'gainEnergy', amount: 2 }, advance],
    upgrade: { effects: [{ kind: 'gainEnergy', amount: 2 }, { kind: 'advance', times: 2 }] },
  }),
  extra_crispy: card({
    id: 'extra_crispy', name: 'Extra Crispy', owner: 'hexaghost', type: 'power', rarity: 'rare', cost: 1,
    effects: [], persistent: true, oncePerTurn: true, upgrade: { cost: 0 },
  }),
  instant_inferno: card({
    id: 'instant_inferno', name: 'Instant Inferno', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 3,
    exhaust: true, effects: [{ kind: 'gainSoulburn', amount: 3 }],
    upgrade: { effects: [{ kind: 'gainSoulburn', amount: 4 }] },
  }),
  incorporeal: card({
    id: 'incorporeal', name: 'Incorporeal', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 6,
    exhaustCostReduction: 0, heatCostReduction: 1, supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 4, toChosen: true }],
    upgrade: { effects: [{ kind: 'block', amount: 6, toChosen: true }] },
  }),
  radiant_reverb: card({
    id: 'radiant_reverb', name: 'Radiant Reverb', owner: 'hexaghost', type: 'attack', rarity: 'rare', cost: 3,
    effects: [{ kind: 'hit', amount: 4, times: 2 }, { kind: 'exhaustHand' }],
    upgrade: { effects: [{ kind: 'hit', amount: 6, times: 2 }, { kind: 'exhaustHand' }] },
  }),
  eerie_expedition: card({
    id: 'eerie_expedition', name: 'Eerie Expedition', owner: 'hexaghost', type: 'skill', rarity: 'rare', cost: 1,
    exhaust: true, effects: [{ kind: 'recoverExhaustToDraw', amount: 2 }],
    upgrade: { effects: [{ kind: 'recoverExhaustToDraw', amount: 3 }] },
  }),
}
