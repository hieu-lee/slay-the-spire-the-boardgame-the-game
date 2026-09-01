// Setting up a fight: the players, the enemies they are facing, and the shared
// supplies both sides draw from.
import { clone } from './board.ts'
import { addStatus } from './pieces.ts'
import type { CombatState } from './types.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import type { SummonSupply } from '../enemies.ts'
import type { RuleSet } from '../meta.ts'
import { healingCapFor } from '../acquisition.ts'
import { shuffle } from '../rng.ts'
import type { RngState } from '../rng.ts'
import type { Enemy, Player } from '../types.ts'

export function createCombat(
  rng: RngState,
  players: Player[],
  enemies: Enemy[],
  combatId = `${rng.seed}:${rng.calls}`,
  potionDeck: string[] = [],
  potionLimit: 2 | 3 = 3,
  summonSupply: SummonSupply = {},
  lastStand = false,
  ruleset: RuleSet = 'base',
): CombatState {
  const state: CombatState = {
    combatId,
    lastStand,
    ruleset,
    rng,
    turn: 0,
    die: 1,
    phase: 'player',
    players: players.map((player) => ({
      ...player,
      lostHpThisCombat: false,
      shuffledThisCombat: false,
      hpLostThisRound: 0,
      hpLossLimitThisRound: undefined,
      nextAttackStrength: 0,
      freeCardsThisTurn: 0,
      freeAttacksThisTurn: 0,
      freeGemCardsThisTurn: 0,
      freePowersThisTurn: 0,
      cardPlayLocked: false,
      doubledAttacksThisTurn: 0,
      tripledAttacksThisTurn: 0,
      doubledCardsThisTurn: 0,
      doubledSkillsThisTurn: 0,
      retainCardsThisTurn: 0,
      cardsPlayedThisTurn: 0,
      energySpentThisTurn: 0,
      nextPowerOrSlimeDiscount: undefined,
      nextAttackRapidFire: 0,
      chamber: player.chamber ?? [],
      chamberSlots: player.chamberSlots ?? (player.character === 'hermit' ? 2 : 0),
      powerPlayedThisTurn: false,
      attacksPlayedThisTurn: 0,
      guardianMode: player.character === 'guardian' ? 'attack' : player.guardianMode,
      vigorSpentThisTurn: 0,
      guardianModeLocked: false,
      slimes: (player.slimes ?? []).map((slime) => ({ ...slime, card: { ...slime.card }, commandsThisTurn: 0, vigorTriggerUsedThisTurn: false, vigorLossAtEndOfTurn: 0 })),
      soulburnUsedThisTurn: false,
      nextSoulburnDamageBonus: 0,
      exhaustNextCardAfterUid: undefined,
      wrathAttackDamageBonus: 0,
      shivDamageBonus: 0,
      cardBlockBonus: 0,
      hitPoison: 0,
      starterStrikeDamageBonus: player.relics.some((relic) => relic.defId === 'strike_dummy') ? 1 : 0,
      clawCubesGainedThisCombat: 0,
      starterDefendBlockBonus: 0,
      akabekoAttacks: 0,
      darkOrbEvokeBonus: 0,
      lightningEndTurnBonus: 0,
    })),
    enemies: enemies.map((enemy) => {
      const abilities = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
      const tracked = abilities
        .find((ability) => ability.kind === 'thorns' || ability.kind === 'beatOfDeath')
      const buffer = abilities.find((ability) => ability.kind === 'buffer')
      return tracked?.kind === 'thorns' || tracked?.kind === 'beatOfDeath'
        ? { ...enemy, abilityCubes: enemy.abilityCubes ?? tracked.startingCubes }
        : buffer?.kind === 'buffer'
          ? { ...enemy, abilityCubes: enemy.abilityCubes ?? Math.min(buffer.max, buffer.initialPerPlayer * players.length) }
          : { ...enemy }
    }),
    summonSupply: clone(summonSupply),
    pendingSummons: [],
    pendingHermitChamberPlays: [],
    pendingHermitStrengthRewards: [],
    pendingHermitSetupLoads: [],
    pendingDieRelicChoices: [],
    potionDeck: [...potionDeck],
    potionLimit,
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    powerTriggersUsedThisTurn: [],
    pendingTriggers: [],
    nextTriggerId: 0,
    playedCardsThisTurn: [],
    partyAttackDiscount: false,
    presentationEvents: [],
    log: [],
  }

  for (const player of state.players.filter((candidate) => candidate.character === 'hermit' && !candidate.dead)) {
    const card = player.draw.shift()
    if (!card) continue
    player.hand.push(card)
    state.pendingHermitSetupLoads!.push({ playerId: player.id })
    state.log = [...state.log, `${player.name} draws 1 card for the Hermit board ability`]
  }

  if (state.enemies.some((enemy) => enemy.isBoss)) for (const player of state.players.filter((candidate) =>
    !candidate.dead && candidate.relics.some((relic) => relic.defId === 'pantograph'))) {
    const before = player.hp
    player.hp = Math.min(healingCapFor(player, ruleset), player.hp + 4)
    if (player.hp > before) state.log = [...state.log, `${player.name}'s Pantograph heals ${player.hp - before} HP`]
  }

  for (const source of state.enemies.filter((enemy) => !enemy.dead)) {
    for (const ability of enemyAbilities(enemyDef(source.defId, source.ascension))) {
      if (ability.kind === 'startCombatStatus') for (const player of state.players.filter((candidate) => !candidate.dead)) {
        const gained = addStatus(state, player, ability.card, ability.amount, source.uid)
        if (gained === 0) continue
        player.draw = shuffle(state.rng, [...player.draw, ...player.discard])
        player.discard = []
        state.log = [...state.log, `${enemyDef(source.defId).name} shuffled ${gained} ${ability.card} into ${player.name}'s deck`]
      }
    }
  }
  return state
}
