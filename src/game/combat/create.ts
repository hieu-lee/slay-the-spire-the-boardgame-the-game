// Setting up a fight: the players, the enemies they are facing, and the shared
// supplies both sides draw from.
import { clone } from './board.ts'
import type { CombatState } from './types.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import type { SummonSupply } from '../enemies.ts'
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
): CombatState {
  return {
    combatId,
    lastStand,
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
      freeCardsThisTurn: 0,
      freeAttacksThisTurn: 0,
      cardPlayLocked: false,
      doubledAttacksThisTurn: 0,
      tripledAttacksThisTurn: 0,
      doubledCardsThisTurn: 0,
      doubledSkillsThisTurn: 0,
      retainCardsThisTurn: 0,
      cardsPlayedThisTurn: 0,
      powerPlayedThisTurn: false,
      attacksPlayedThisTurn: 0,
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
      const tracked = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .find((ability) => ability.kind === 'thorns' || ability.kind === 'beatOfDeath')
      return tracked?.kind === 'thorns' || tracked?.kind === 'beatOfDeath'
        ? { ...enemy, abilityCubes: enemy.abilityCubes ?? tracked.startingCubes }
        : enemy
    }),
    summonSupply: clone(summonSupply),
    pendingSummons: [],
    potionDeck: [...potionDeck],
    potionLimit,
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    powerTriggersUsedThisTurn: [],
    pendingTriggers: [],
    nextTriggerId: 0,
    playedCardsThisTurn: [],
    presentationEvents: [],
    log: [],
  }
}
