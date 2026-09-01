// The Enemy Turn: each living enemy acts once, in the order the board sets, and
// the round ends.
//
// An enemy resolves its own printed action, never a card's, so the card
// resolver is not what drives this phase. It is still what an action's
// consequences run through: damage to a player, a death, and settling the
// fight once every enemy has acted.
import { clone, combatIsOver, enemyLabel, playersInRowOf } from './board.ts'
import { damagePlayer, settle, triggerEnemyDeath } from './effects.ts'
import { addDaze, addStatus, playerCanGainDebuffs, reviveAll } from './pieces.ts'
import type { CombatState } from './types.ts'
import { attackerModsOfEnemy, gainBlock, gainStrength, gainVulnerable, gainWeak, hitDamage } from '../damage.ts'
import { actionsForEnemy, advanceCube, enemyAbilities, enemyAttackBonus, enemyDef, startingHp } from '../enemies.ts'
import type { EnemyAction } from '../enemies.ts'
import { CARDS } from '../cards.ts'
import { shuffle } from '../rng.ts'
import type { Enemy, Player } from '../types.ts'
import { mandatoryChoicePending } from './queries.ts'

const CURSE_CARDS = Object.values(CARDS)
  .filter((card) => card.owner === 'curse' && card.id !== 'ascenders_bane')
  .flatMap((card) => Array(['clumsy', 'injury', 'parasite', 'regret'].includes(card.id) ? 2 : 1).fill(card.id))

/**
 * The Enemy Turn (p.13): clear enemy Block, act from the highest row downward
 * (left to right within a row, bosses last), then advance every cube.
 *
 * Enemies hit the player in their own row; an area-of-effect action hits every
 * player. Block and Strength always land on the enemy itself, never on a player.
 */
export function enemyTurn(state: CombatState): CombatState {
  if (state.phase !== 'enemy' || (state.pendingTriggers?.length ?? 0) > 0 || mandatoryChoicePending(state)) return state
  const next = clone(state)

  // Enemy Block is cleared at the start of the ENEMY turn, unlike player Block.
  for (const enemy of next.enemies) {
    if (!enemyDef(enemy.defId, enemy.ascension).retainsBlock) enemy.block = 0
  }

  for (const enemy of enemyActingOrder(next)) {
    if (enemy.dead) continue
    // p.13 normally ends combat immediately when one player dies, so enemies
    // still queued behind the killing blow do not act. The Last Stand's Boss
    // exception keeps this loop going while any player survives.
    if (combatIsOver(next)) break
    for (const action of actionsForEnemy(enemy, next.die)) {
      applyEnemyAction(next, enemy, action)
      if (combatIsOver(next)) break
    }
    const grant = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
      .find((ability) => ability.kind === 'grantAllyBuffer')
    if (grant?.kind === 'grantAllyBuffer' && !enemy.dead) {
      const target = next.enemies.find((candidate) => !candidate.dead && candidate.defId === grant.defId)
      const buffer = target && enemyAbilities(enemyDef(target.defId, target.ascension))
        .find((ability) => ability.kind === 'buffer')
      if (target && buffer?.kind === 'buffer') {
        target.abilityCubes = Math.min(buffer.max, (target.abilityCubes ?? 0) + grant.amount)
      }
    }
  }

  for (const enemy of next.enemies) {
    if (enemy.dead) continue
    const def = enemyDef(enemy.defId, enemy.ascension)
    const rally = enemyAbilities(def).find((ability) => ability.kind === 'rally')
    const noSummons = rally?.kind === 'rally' && !next.enemies.some((candidate) => !candidate.dead &&
      (candidate.defId === rally.summonDefId || candidate.defId.startsWith(`${rally.summonDefId}_`)))
    if (def.pattern.kind === 'cube' && def.pattern.slots[enemy.actionIndex]?.once) {
      enemy.spentOnceSlots = [...new Set([...(enemy.spentOnceSlots ?? []), enemy.actionIndex])]
    }
    let nextIndex = noSummons && enemy.actionIndex === 1 ? 0 : advanceCube(def, enemy.actionIndex)
    if (def.pattern.kind === 'cube') for (let skipped = 0; skipped < def.pattern.slots.length; skipped++) {
      if (!def.pattern.slots[nextIndex]?.once || !enemy.spentOnceSlots?.includes(nextIndex)) break
      nextIndex = advanceCube(def, nextIndex)
    }
    enemy.actionIndex = nextIndex
  }

  // The round is over. The next Start of Turn is its own step (p.12) rather
  // than something that happens invisibly: with three or four players, the
  // board must hold still long enough to read what the enemies just did before
  // every hand is swept up and redealt.
  next.phase = 'roundEnd'
  return settle(next)
}

/** Highest row first, then left to right, with bosses and "acts last" at the end. */
export function enemyActingOrder(state: CombatState): Enemy[] {
  const order = state.enemies.filter((enemy) => !enemy.dead)
  const isLast = (enemy: Enemy) => enemy.isBoss ||
    enemy.actsLast === true ||
    enemyDef(enemy.defId, enemy.ascension).actsLast === true ||
    actionsForEnemy(enemy, state.die).some((action) => action.kind === 'actsLast')
  return [...order].sort((a, b) => {
    if (isLast(a) !== isLast(b)) return isLast(a) ? 1 : -1
    if (a.row !== b.row) return b.row - a.row
    return state.enemies.indexOf(a) - state.enemies.indexOf(b)
  })
}

export function applyEnemyAction(state: CombatState, enemy: Enemy, action: EnemyAction): void {
  const living = state.players.filter((player) => !player.dead)
  const name = enemyLabel(state.enemies, enemy)

  switch (action.kind) {
    case 'attack':
    case 'attackSequence': {
      const mods = attackerModsOfEnemy(enemy)
      const hits = action.kind === 'attackSequence'
        ? action.hits
        : Array.from({ length: action.times ?? 1 }, () => ({ amount: action.amount, aoe: action.aoe }))
      const snapshots = new Map<Player, {
        hp: number
        block: number
        vulnerable: number
        lost: number
        attempted: number
      }>()
      let attacked = false
      attack: for (const hit of hits) {
        const targets = hit.aoe ? living
          : action.kind === 'attack' && action.facing
            ? living.filter((player) => player.facingEnemyUid === enemy.uid)
            : playersInRowOf(state, enemy)
        attacked ||= targets.length > 0
        for (const target of targets) {
          if (target.dead) continue
          const before = snapshots.get(target) ?? {
            hp: target.hp, block: target.block, vulnerable: target.vulnerable, lost: 0, attempted: 0,
          }
          snapshots.set(target, before)
          const amount = hitDamage(
            hit.amount + enemyAttackBonus(state.enemies, enemy, action, target),
            mods, { vulnerable: before.vulnerable },
          )
          before.attempted += amount
          before.lost += damagePlayer(state, target, amount).hpLost
          if (target.dead && combatIsOver(state)) break attack
        }
      }
      for (const [target, before] of snapshots) {
        const terror = state.enemies.some((candidate) => !candidate.dead &&
          enemyAbilities(enemyDef(candidate.defId, candidate.ascension))
            .some((ability) => ability.kind === 'retainPlayerVulnerable'))
        if (before.vulnerable > 0 && !terror) {
          target.vulnerable = before.vulnerable - 1
          state.log = [...state.log, `${target.name} spends a Vulnerable`]
        }
        const blocked = before.block - target.block
        state.log = [
          ...state.log,
          before.lost > 0
            ? `${name} hit ${target.name} for ${before.lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
            : blocked >= before.attempted && before.attempted > 0
              ? `${target.name} blocked ${name} completely (${blocked} spent)`
              : `${name} did no damage to ${target.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`,
        ]
        if (target.dead) {
          state.log = [...state.log, `${target.name} has fallen`]
          // Ordinarily the rest of the sweep never lands. The Last Stand is
          // the exception: surviving targets still finish this same action.
          if (combatIsOver(state)) break
        }
        const painful = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
          .find((ability) => ability.kind === 'painfulStabs')
        if (before.lost > 0 && painful?.kind === 'painfulStabs') {
          const gained = addDaze(state, target, painful.daze, 'draw', enemy.uid)
          if (gained > 0) state.log = [...state.log, `${name}'s Painful Stabs gave ${target.name} ${gained} Daze`]
        }
      }
      const wrathful = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .some((ability) => ability.kind === 'blockFromUnblockedDamage')
      if (wrathful) {
        const dealt = [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.lost, 0)
        const before = enemy.block
        enemy.block = gainBlock(enemy.block, dealt)
        if (enemy.block > before) state.log = [...state.log,
          `${name} gains ${enemy.block - before} Block from unblocked damage`]
      }
      // One Weak token comes off after the whole action, not per hit — and only
      // if the action actually attacked something. An enemy swinging at an
      // empty row has not attacked (p.24), same rule as the player side.
      if (attacked && enemy.weak > 0) {
        enemy.weak -= 1
        state.log = [...state.log, `${name} spends a Weak`]
      }
      return
    }
    case 'block': {
      // The amount actually gained, not the amount printed: at the cap the
      // enemy gains nothing and the log should not claim otherwise.
      const before = enemy.block
      enemy.block = gainBlock(enemy.block, action.amount * (action.perPlayer ? state.players.length : 1))
      if (enemy.block > before) {
        state.log = [...state.log, `${name} gained ${enemy.block - before} Block`]
      }
      return
    }
    case 'blockAllEnemies': {
      let changed = false
      for (const target of state.enemies) if (!target.dead) {
        const before = target.block
        target.block = gainBlock(target.block, action.amount)
        changed ||= target.block > before
      }
      if (changed) state.log = [...state.log, `${name} bolstered all enemies`]
      return
    }
    case 'strengthenAllEnemies': {
      let changed = false
      for (const target of state.enemies) if (!target.dead) {
        const before = target.strength
        target.strength = gainStrength(target.strength, action.amount)
        changed ||= target.strength > before
      }
      if (changed) state.log = [...state.log, `${name} strengthened all enemies`]
      return
    }
    case 'healAllEnemies': {
      let changed = false
      for (const target of state.enemies) if (!target.dead) {
        const before = target.hp
        target.hp = Math.min(target.maxHp, target.hp + action.amount)
        changed ||= target.hp > before
      }
      if (changed) state.log = [...state.log, `${name} healed all enemies`]
      return
    }
    case 'healSelf': {
      const before = enemy.hp
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + action.amount)
      if (enemy.hp > before) state.log = [...state.log, `${name} healed ${enemy.hp - before} HP`]
      return
    }
    case 'blockNamed': {
      const target = state.enemies.find((candidate) => !candidate.dead &&
        (candidate.row === enemy.row || candidate.isBoss) &&
        (candidate.defId === action.defId || candidate.defId.startsWith(`${action.defId}_`)))
      if (target) {
        const before = target.block
        target.block = gainBlock(target.block, action.amount)
        if (target.block > before) state.log = [...state.log,
          `${name} gave ${enemyLabel(state.enemies, target)} ${target.block - before} Block`]
      }
      return
    }
    case 'clearSelfDebuffs':
      enemy.weak = enemy.vulnerable = 0
      state.log = [...state.log, `${name} removed its debuffs`]
      return
    case 'reviveAll': {
      const count = reviveAll(state, action.group)
      state.log = [...state.log, `${name} revived ${count} ${action.group}${count === 1 ? '' : 's'}`]
      return
    }
    case 'gainStrength': {
      const before = enemy.strength
      enemy.strength = gainStrength(enemy.strength, action.amount)
      if (enemy.strength > before) {
        state.log = [...state.log, `${name} gained ${enemy.strength - before} Strength`]
      }
      return
    }
    case 'applyWeak': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        if (!playerCanGainDebuffs(target)) continue
        const before = target.weak
        target.weak = gainWeak(target.weak, action.amount)
        if (target.weak > before) state.log = [...state.log, `${name} weakened ${target.name}`]
      }
      return
    }
    case 'applyVulnerable': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        if (!playerCanGainDebuffs(target)) continue
        const before = target.vulnerable
        target.vulnerable = gainVulnerable(target.vulnerable, action.amount)
        if (target.vulnerable > before) {
          state.log = [...state.log, `${name} left ${target.name} vulnerable`]
        }
      }
      return
    }
    case 'daze': {
      // Daze goes on TOP of the draw pile, so it is the very next card drawn.
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const gained = addDaze(state, target, action.amount, 'draw', enemy.uid)
        if (gained > 0) {
          state.log = [...state.log, `${name} slipped ${gained === 1 ? 'a Daze' : `${gained} Daze`} into ${target.name}'s deck`]
        }
      }
      return
    }
    case 'status':
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const gained = addStatus(state, target, action.card, action.amount, enemy.uid)
        if (gained > 0) state.log = [...state.log, `${name} gave ${target.name} ${gained} ${action.card}`]
      }
      return
    case 'loseGold':
      for (const target of playersInRowOf(state, enemy)) {
        const lost = Math.min(target.gold, action.amount)
        target.gold -= lost
        state.log = [...state.log, `${target.name} lost ${lost} gold to ${name}`]
      }
      return
    case 'leave':
      enemy.dead = true
      state.log = [...state.log, `${name} left combat`]
      return
    case 'die':
      enemy.hp = 0
      enemy.dead = true
      state.log = [...state.log, `${name} died`]
      triggerEnemyDeath(state, enemy)
      return
    case 'addAbilityCube': {
      const tracked = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .find((ability) => ability.kind === 'thorns' || ability.kind === 'beatOfDeath' || ability.kind === 'buffer')
      if (tracked?.kind !== 'thorns' && tracked?.kind !== 'beatOfDeath' && tracked?.kind !== 'buffer') return
      const before = enemy.abilityCubes ?? 0
      const max = tracked.kind === 'buffer' ? tracked.max : tracked.maxCubes
      enemy.abilityCubes = Math.min(max, before + action.amount * (action.perPlayer ? state.players.length : 1))
      if (enemy.abilityCubes > before) state.log = [...state.log,
        `${name} added ${enemy.abilityCubes - before} ability cube`]
      return
    }
    case 'transform':
      enemy.defId = action.defId
      enemy.actionIndex = -1
      state.log = [...state.log, `${name} transforms`]
      return
    case 'guardianModeShift':
      if (enemy.block > 0) {
        enemy.block = 0
        applyEnemyAction(state, enemy, { kind: 'attack', amount: action.amount })
      } else {
        enemy.pendingDefId = 'guardian_defensive'
        state.log = [...state.log, `${name} will enter Defensive Mode at the start of the next turn`]
      }
      return
    case 'removeInvincible':
      enemy.abilityUsed = true
      state.log = [...state.log, `${name}'s Invincible is removed`]
      return
    case 'shuffleStatus':
      for (const target of living) {
        const gained = addStatus(state, target, action.card, action.amount, enemy.uid, 'draw')
        if (gained === 0) continue
        target.draw = shuffle(state.rng, target.draw)
        state.log = [...state.log, `${name} shuffled ${gained} ${action.card} into ${target.name}'s draw pile`]
      }
      return
    case 'summon':
      state.pendingSummons.push({
        sourceUid: enemy.uid, row: enemy.row, defIds: action.defIds, turn: state.turn + 1,
      })
      state.log = [...state.log, `${name} will summon ${action.defIds.map((id) => enemyDef(id).name).join(', ')}`]
      return
    case 'summonUntil': {
      let count = 0
      for (const row of new Set(state.players.filter((player) => !player.dead).map((player) => player.row))) {
        const present = state.enemies.filter((candidate) => !candidate.dead && candidate.row === row &&
          (candidate.defId === action.defId || candidate.defId.startsWith(`${action.defId}_`))).length
        const queued = state.pendingSummons.filter((summon) => summon.row === row).reduce((total, summon) =>
          total + summon.defIds.filter((id) => id === action.defId).length, 0)
        const needed = Math.max(0, action.perPlayer - present - queued)
        if (needed === 0) continue
        state.pendingSummons.push({
          sourceUid: enemy.uid, row, defIds: Array(needed).fill(action.defId), turn: state.turn + 1,
        })
        count += needed
      }
      state.log = [...state.log, `${name} will summon ${count} ${enemyDef(action.defId).name}${count === 1 ? '' : 's'}`]
      return
    }
    case 'shuffleCurse': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const ids = shuffle(state.rng, [...CURSE_CARDS]).slice(0, action.amount)
        const cards = ids.map((defId, index) => ({
          uid: `curse-${state.turn}-${enemy.uid}-${target.id}-${state.log.length}-${index}`,
          defId,
          upgraded: false,
        }))
        target.draw = shuffle(state.rng, [...target.draw, ...cards])
        state.log = [...state.log, `${name} shuffled ${cards.length} Curses into ${target.name}'s draw pile`]
      }
      return
    }
    case 'reviveMatching': {
      const revived: Enemy[] = []
      const rows = new Set<number>()
      for (const target of state.enemies) {
        if (!target.dead || !action.defIds.includes(target.defId) ||
          (action.onePerRow && rows.has(target.row))) continue
        target.dead = false
        target.hp = startingHp(enemyDef(target.defId, target.ascension), state.players.length)
        target.block = target.strength = target.vulnerable = target.weak = target.poison = 0
        target.actionIndex = 0
        target.abilityUsed = false
        rows.add(target.row)
        revived.push(target)
      }
      state.log = [...state.log, `${name} revived ${revived.length} summon${revived.length === 1 ? '' : 's'}`]
      return
    }
    case 'doubleNamedHp': {
      const target = state.enemies.find((candidate) => !candidate.dead && candidate.defId === action.defId)
      if (target) {
        target.hp *= 2
        target.maxHp = Math.max(target.maxHp, target.hp)
        state.log = [...state.log, `${enemyLabel(state.enemies, target)} doubles to ${target.hp} HP`]
      }
      return
    }
    case 'healMatching': {
      for (const target of state.enemies.filter((candidate) => !candidate.dead && action.defIds.includes(candidate.defId))) {
        const before = target.hp
        target.hp = Math.min(target.maxHp, target.hp + action.amount)
        if (target.hp > before) state.log = [...state.log,
          `${name} heals ${enemyLabel(state.enemies, target)} for ${target.hp - before}`]
      }
      return
    }
    case 'gainSelfVulnerable': {
      const before = enemy.vulnerable
      enemy.vulnerable = gainVulnerable(enemy.vulnerable, action.amount)
      if (enemy.vulnerable > before) state.log = [...state.log,
        `${name} gains ${enemy.vulnerable - before} Vulnerable`]
      return
    }
    case 'actsLast':
    case 'idle':
      return
  }
}
