import { cardDef } from '../game/cards.ts'
import { assetPath, bossAnimationImagePath, cardThumbPath, enemyImagePath } from '../game/assets.ts'
import { abilityText, actionsForEnemy, enemyAbilities, enemyAttackBonus, enemyDef } from '../game/enemies.ts'
import type { EnemyAction } from '../game/enemies.ts'
// Aliased: `hitDamage` is also this component's floating hit-VFX number.
import { attackerModsOfEnemy, hitDamage as swingDamage } from '../game/damage.ts'
import type { Enemy, Player } from '../game/types.ts'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, IconValue } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import { TokenRow } from './TokenRow.tsx'
import { healthBand } from './board-signals.ts'
import { revealDecodedImage } from './Card.tsx'
import {
  bossAttackContactLeftFor,
  bossAttackDurationFor,
  bossAttackMotionFor,
  bossAttackScaleFor,
  bossProjectileImagePath,
} from './combat-vfx.ts'

type EnemyCardProps = {
  enemy: Enemy
  enemies: readonly Enemy[]
  /** The finished display name, built by the engine so the log agrees. */
  label: string
  /** The round's shared die, which decides what a die-pattern enemy will do. */
  die: number
  acting?: boolean
  animateBoss?: boolean
  /** A player attack is still presenting; bosses begin only after it clears. */
  deferBossAttack?: boolean
  targeted?: boolean
  disabled?: boolean
  hitBeats?: { beat: number; damage: number; delayMs: number }[]
  /** Just crossed from alive to dead: play the one-shot defeat animation. */
  falling?: boolean
  /** Delay public HP/death presentation until the authoritative weapon arrives. */
  visualContactMs?: number
  visualEventSeq?: number
  visualResetKey?: string
  stageVisualDamage?: boolean
  /** Decorative, authoritative action effects aimed at this enemy. */
  vfx?: ReactNode
  /** Living player seats a ranged boss projectile must visibly reach. */
  rangedTargetPlayerIds?: readonly string[]
  stageIndex?: number
  /** Player whose row this enemy occupies; bosses affect the whole party. */
  rowLabel?: string
  /**
   * The player this enemy will swing at, so the intent can show the damage that
   * will land rather than the number printed on the enemy card. Their Vulnerable
   * and Power count both change it. An AoE hits every row, but the occupant of
   * this row is the reading that matters to whoever owns it.
   */
  defender?: Pick<Player, 'row' | 'vulnerable' | 'powers'>
  onClick?: (enemy: Enemy) => void
}

type IntentPart = {
  icon: IconName
  value?: number | string
  prefix?: string
  aoe?: boolean
  /**
   * How many times this attack lands, when it is more than once.
   *
   * The symbol is REPEATED on screen, matching the printed card. Spoken, that
   * became "attack, attack, attack" with nothing to say it is one attack of
   * three — so only the first part carries the count, and only it is spoken.
   */
  times?: number
  /** Silent to a screen reader: a later copy of a repeated symbol. */
  echo?: boolean
  label?: string
  visibleLabel?: string
}

/**
 * An enemy's telegraphed intent, in the game's own symbols.
 *
 * `swing` turns a PRINTED attack number into the damage it will actually deal.
 * Without it the intent showed the number off the enemy card and the blow landed
 * for something else entirely: a Weakened enemy printing 1 deals 0 (Weak is a
 * flat -1 and nothing clamps a hit up to 1), and the board still promised 1.
 * Reading "will this kill me" off the board is the whole point of an intent.
 */
function intentParts(action: EnemyAction, swing: (printed: number) => number): IntentPart[] {
  switch (action.kind) {
    case 'attack': {
      // Repeated symbols, not a formula. Twin Strike prints two swords side by
      // side rather than "1x2", and the enemy cards do the same — the board
      // game's own notation, and more symbol than text besides.
      const times = action.times && action.times > 1 ? action.times : 1
      return Array.from({ length: times }, (_unused, index) => ({
        icon: 'attack' as const,
        value: swing(action.amount),
        aoe: action.aoe,
        times: index === 0 && times > 1 ? times : undefined,
        echo: index > 0,
      }))
    }
    case 'attackSequence':
      return action.hits.map((hit) => ({ icon: 'attack', value: swing(hit.amount), aoe: hit.aoe }))
    case 'block':
      return [{ icon: 'block', value: action.perPlayer ? `${action.amount}/player` : action.amount }]
    case 'gainStrength':
      return [{ icon: 'strength', value: action.amount, prefix: '+' }]
    case 'blockAllEnemies':
      return [{ icon: 'block', value: action.amount, label: 'Block to all enemies' }]
    case 'strengthenAllEnemies':
      return [{ icon: 'strength', value: action.amount, prefix: '+', label: 'Strength to all enemies' }]
    case 'healAllEnemies':
      return [{ icon: 'monster', value: action.amount, label: 'heal all enemies', visibleLabel: 'Heal' }]
    case 'healSelf':
      return [{ icon: 'monster', value: action.amount, label: 'heals itself', visibleLabel: 'Heal' }]
    case 'blockNamed':
      return [{ icon: 'block', value: action.amount, label: `Block to ${action.defId.replaceAll('_', ' ')}` }]
    case 'clearSelfDebuffs':
      return [{ icon: 'monster', label: 'removes Weak and Vulnerable', visibleLabel: 'Cleanse' }]
    case 'reviveAll':
      return [{ icon: 'monster', label: `revives all dead ${action.group}s`, visibleLabel: 'Revive' }]
    case 'applyWeak':
      return [{ icon: 'weak', value: action.amount, aoe: action.aoe }]
    case 'applyVulnerable':
      return [{ icon: 'vulnerable', value: action.amount, aoe: action.aoe }]
    case 'daze':
      return [{ icon: 'daze', value: action.amount, aoe: action.aoe }]
    case 'status':
      return [{
        icon: action.card === 'burn' ? 'burn' : 'monster',
        value: action.amount,
        aoe: action.aoe,
        label: action.card,
        visibleLabel: action.card === 'slimed' ? 'Slimed' : undefined,
      }]
    case 'loseGold':
      return [{ icon: 'gold', value: action.amount, prefix: '-', label: 'gold' }]
    case 'summon':
      return [{ icon: 'monster', value: action.defIds.length, label: 'summons', visibleLabel: 'Summon' }]
    case 'summonUntil':
      return [{ icon: 'monster', value: action.perPlayer, label: 'summons per player', visibleLabel: 'Summon per player' }]
    case 'shuffleCurse':
      return [{ icon: 'monster', value: action.amount, aoe: action.aoe, label: 'Curses shuffled into each deck', visibleLabel: 'Curse' }]
    case 'reviveMatching':
      return [{ icon: 'monster', label: 'revives defeated summons', visibleLabel: 'Revive' }]
    case 'doubleNamedHp':
      return [{ icon: 'monster', label: `doubles ${action.defId.replaceAll('_', ' ')} HP`, visibleLabel: 'Double HP' }]
    case 'healMatching':
      return [{ icon: 'monster', value: action.amount, label: 'heals matching summons', visibleLabel: 'Heal' }]
    case 'gainSelfVulnerable':
      return [{ icon: 'vulnerable', value: action.amount, label: 'Vulnerable to self' }]
    case 'leave':
      return [{ icon: 'monster', label: 'leaves combat', visibleLabel: 'Leaves' }]
    case 'die':
      return [{ icon: 'monster', label: 'dies', visibleLabel: 'Dies' }]
    case 'addAbilityCube':
      return [{ icon: 'monster', value: action.amount, label: 'ability cube', visibleLabel: 'Cube' }]
    case 'transform':
      return [{ icon: 'monster', label: `enters ${action.defId.replaceAll('_', ' ')}`, visibleLabel: 'Mode' }]
    case 'guardianModeShift':
      return [{ icon: 'attack', value: swing(action.amount), label: 'if Block remains; otherwise enters Defensive Mode' }]
    case 'removeInvincible':
      return [{ icon: 'monster', label: 'removes Invincible', visibleLabel: 'Invincible off' }]
    case 'shuffleStatus':
      return [{ icon: action.card === 'burn' ? 'burn' : 'monster', value: action.amount, label: `shuffle ${action.card} into every draw pile`, visibleLabel: action.card }]
    case 'actsLast':
      return [{ icon: 'monster', label: 'acts last', visibleLabel: 'Acts last' }]
    case 'idle':
      return []
  }
}

/**
 * The enemy button's accessible name.
 *
 * `aria-label` replaces the element's contents wholesale, so anything left out
 * is unreachable however it is marked up — the same trap `describeSeat` avoids
 * for players. The intent especially: it is the one thing choosing a target
 * depends on, and it was not being announced at all.
 */
function describeEnemy(
  enemy: Enemy,
  label: string,
  intent: IntentPart[],
  abilities: string[],
  rowLabel?: string,
): string {
  // The label is built by the engine and is the SAME string the log prints --
  // "Cultist (row 1, #2)" when two of them share a row. Two identically named
  // buttons would leave a screen-reader user unable to match log to board, and
  // rebuilding the name here is what let the two drift apart before.
  const parts = [label]
  if (rowLabel) parts.push(`facing ${rowLabel}`)
  if (enemy.dead) {
    parts.push('defeated')
    return parts.join(', ')
  }
  parts.push(`${enemy.hp} of ${enemy.maxHp} hit points`)

  const said = intent
    .filter((part) => !part.echo)
    .map((part) => {
      const value = part.value === undefined || part.value === '' ? '' : `${part.value} `
      const repeat = part.times ? `, ${part.times} times` : ''
      return `${part.aoe ? 'all rows, ' : ''}to ${part.prefix === '-' ? 'lose' : 'apply'} ${value}${part.label ?? part.icon}${repeat}`
    })
    .join(', ')
  // "intends to apply 1 Vulnerable" rather than "vulnerable 1": the tokens the
  // enemy CARRIES are announced below in the same shape, and case alone is not
  // something a screen reader conveys.
  parts.push(said ? `intends ${said}` : 'no intent')
  parts.push(...abilities)
  if (enemy.corpseExplosion) {
    parts.push(`Corpse Explosion attached, ${enemy.corpseExplosion.damage} row damage when defeated`)
  }

  const tokens: [string, number][] = [
    ['Block', enemy.block],
    ['Strength', enemy.strength],
    ['Vulnerable', enemy.vulnerable],
    ['Weak', enemy.weak],
    ['Poison', enemy.poison],
  ]
  for (const [token, value] of tokens) if (value > 0) parts.push(`has ${token} ${value}`)
  return parts.join(', ')
}

function displayedAbilityText(
  ability: ReturnType<typeof enemyAbilities>[number],
  enemy: Enemy,
  defId: string,
  die: number,
  compact: boolean,
): string {
  if (ability.kind === 'confusion') return compact
    ? `Confusion · first card costs ${ability.byRoll[die] ?? '?'}`
    : `Confusion: the first card played this turn costs ${ability.byRoll[die] ?? '?'} Energy`
  if (ability.kind === 'thorns') return compact
    ? `Thorns · ${enemy.abilityCubes ?? 0} cubes`
    : `Thorns: ${enemy.abilityCubes ?? 0} cubes; after an Attack, ${ability.damagePerCube} damage per cube`
  if (ability.kind === 'beatOfDeath') return compact
    ? `Beat of Death · ${enemy.abilityCubes ?? 0} cubes`
    : `Beat of Death: ${enemy.abilityCubes ?? 0} cubes; deals that much damage to every player at end of turn`
  if (ability.kind === 'immuneOnSlots') return ability.slots.includes(enemy.actionIndex)
    ? 'Cannot lose HP this turn'
    : compact ? 'HP immunity · inactive' : 'Cannot lose HP while the cube is on a marked action'
  if (ability.kind === 'invincible') return enemy.abilityUsed
    ? compact ? 'Invincible · removed' : 'Invincible: removed'
    : compact
      ? `Invincible · no Weak · floor ${ability.hpPerPlayer}/player`
      : `Invincible: cannot gain Weak or fall below ${ability.hpPerPlayer} HP per player`
  if (ability.kind === 'facing') {
    if (ability.effect === 'spear') return compact
      ? 'Facing · start: gain 2 Burn'
      : 'Facing: gain 2 Burn at the start of turn while facing Spire Spear'
    const penalty = enemy.actionIndex === 0 ? 'lose 1 Energy' : enemy.actionIndex === 1 ? 'cannot draw' : 'deal 0 damage'
    return compact ? `Facing · ${penalty}` : `Facing: ${penalty} this turn while facing Spire Shield`
  }
  if (ability.kind === 'rebirth') {
    if (defId === 'time_eater') {
      if (enemy.abilityUsed) return compact ? 'Haste · spent' : 'Haste: spent'
      return compact
        ? `Haste · ${ability.hpPerPlayer} HP/player · +1 Strength · clear Weak/Vulnerable · Poison remains`
        : `Haste: when first defeated, return with ${ability.hpPerPlayer} HP per player, gain 1 Strength, remove all Weak and Vulnerable; Poison remains`
    }
    if (defId === 'the_champ') return compact
      ? `Anger · Fury at ${ability.hpPerPlayer}/player`
      : `Anger: when first defeated, enter Fury with ${ability.hpPerPlayer} HP per player`
    if (defId === 'awakened_one_phase_1') return compact
      ? `Awaken · return at end of turn${(enemy.ascension ?? 0) >= 10 ? ' · Strength from largest Power count' : ''}`
      : `Awaken: return at end of turn in a second form${(enemy.ascension ?? 0) >= 10 ? ' and gain Strength equal to the largest number of Powers a player has in play' : ''}`
  }
  return abilityText(ability, compact)
}

export function EnemyCard({
  enemy,
  enemies,
  label,
  die,
  acting = false,
  animateBoss = false,
  deferBossAttack = false,
  targeted = false,
  disabled = false,
  hitBeats = [],
  falling = false,
  visualContactMs = 0,
  visualEventSeq = -1,
  visualResetKey = '',
  stageVisualDamage = true,
  vfx,
  rangedTargetPlayerIds = [],
  stageIndex = 0,
  rowLabel,
  defender,
  onClick,
}: EnemyCardProps) {
  const cardRef = useRef<HTMLButtonElement>(null)
  const [visibleEnemy, setVisibleEnemy] = useState(enemy)
  const displayTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const pendingVisuals = useRef(new Map<number, { eventSeq: number; enemy: Enemy }>())
  const attackPreload = useRef<HTMLImageElement | null>(null)
  const bossAttackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [presentedBossAttack, setPresentedBossAttack] = useState<{
    art: string
    artId: string
  } | null>(null)
  const [awaitingNextEnemyPhase, setAwaitingNextEnemyPhase] = useState(acting)
  const displayBeat = useRef(0)
  const displayedEventSeq = useRef(visualEventSeq)
  const visualSignature = JSON.stringify(enemy)
  const priorActual = useRef({
    signature: visualSignature, eventSeq: visualEventSeq, resetKey: visualResetKey,
  })
  const resetVisuals = !stageVisualDamage || visualResetKey !== priorActual.current.resetKey
  useEffect(() => {
    const changed = visualSignature !== priorActual.current.signature
    const newEvent = visualEventSeq > priorActual.current.eventSeq
    if (!resetVisuals && changed && newEvent && visualContactMs < 0) return
    priorActual.current = {
      signature: visualSignature, eventSeq: visualEventSeq, resetKey: visualResetKey,
    }
    if (resetVisuals) {
      for (const timer of displayTimers.current.values()) clearTimeout(timer)
      displayTimers.current.clear()
      pendingVisuals.current.clear()
      if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
      bossAttackTimer.current = null
      setPresentedBossAttack(null)
      setAwaitingNextEnemyPhase(acting)
      displayedEventSeq.current = visualEventSeq
      setVisibleEnemy(enemy)
      return
    }
    if (!changed) return
    const delay = newEvent ? visualContactMs : 0
    if (delay <= 0) {
      const pendingBeat = [...pendingVisuals.current.keys()].at(-1)
      if (pendingBeat !== undefined) {
        const pending = pendingVisuals.current.get(pendingBeat)!
        pendingVisuals.current.set(pendingBeat, {
          eventSeq: Math.max(pending.eventSeq, visualEventSeq),
          enemy,
        })
        return
      }
      for (const timer of displayTimers.current.values()) clearTimeout(timer)
      displayTimers.current.clear()
      pendingVisuals.current.clear()
      displayedEventSeq.current = visualEventSeq
      setVisibleEnemy(enemy)
      return
    }
    const beat = ++displayBeat.current
    pendingVisuals.current.set(beat, { eventSeq: visualEventSeq, enemy })
    displayTimers.current.set(beat, setTimeout(() => {
      displayTimers.current.delete(beat)
      const pending = pendingVisuals.current.get(beat)
      pendingVisuals.current.delete(beat)
      if (!pending || pending.eventSeq < displayedEventSeq.current) return
      displayedEventSeq.current = pending.eventSeq
      setVisibleEnemy(pending.enemy)
    }, delay))
  }, [acting, enemy, resetVisuals, visualContactMs, visualEventSeq, visualResetKey, visualSignature])
  useEffect(() => () => {
    for (const timer of displayTimers.current.values()) clearTimeout(timer)
    pendingVisuals.current.clear()
  }, [])
  const def = enemyDef(visibleEnemy.defId, visibleEnemy.ascension)
  const actualName = enemyDef(enemy.defId, enemy.ascension).name
  const visibleLabel = label.startsWith(actualName) ? `${def.name}${label.slice(actualName.length)}` : label
  const actions = actionsForEnemy(visibleEnemy, die)
  const animatedBoss = Boolean(visibleEnemy.isBoss && animateBoss && !visibleEnemy.dead)
  const currentBossArtId = def.artId ?? def.id
  const bossHasAttackAction = actions.some((action) => action.kind === 'attack' || action.kind === 'attackSequence')
  const currentBossAttackArt = currentBossArtId === 'downfall_demon'
    ? assetPath('combat/enemies/animations/downfall_demon-airborne.webp')
    : bossAnimationImagePath(def, 'attack')
  const currentBossProjectileArt = bossProjectileImagePath(currentBossArtId)
  const bossAttackRequested = Boolean(animatedBoss && acting && bossHasAttackAction)
  useLayoutEffect(() => {
    if (!acting) setAwaitingNextEnemyPhase(false)
  }, [acting])
  const bossAttackTriggered = bossAttackRequested && !deferBossAttack &&
    !resetVisuals && !awaitingNextEnemyPhase
  const bossAttacking = Boolean(animatedBoss && presentedBossAttack)
  useEffect(() => {
    if (!bossAttackTriggered) return
    setPresentedBossAttack({ art: currentBossAttackArt, artId: currentBossArtId })
    if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
    bossAttackTimer.current = setTimeout(() => {
      setPresentedBossAttack(null)
      bossAttackTimer.current = null
    }, bossAttackDurationFor(currentBossArtId))
  }, [bossAttackTriggered, currentBossArtId, currentBossAttackArt])
  useEffect(() => () => {
    if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
  }, [])
  const art = animatedBoss
    ? bossAttacking ? presentedBossAttack?.art ?? currentBossAttackArt : bossAnimationImagePath(def, 'idle')
    : enemyImagePath(def)
  const bossAttackArt = animatedBoss && bossHasAttackAction ? currentBossAttackArt : undefined
  useEffect(() => {
    if (!bossAttackArt) return
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'image'
    link.href = bossAttackArt
    link.dataset.bossAttackPreload = def.artId ?? def.id
    document.head.append(link)
    const preload = new Image()
    attackPreload.current = preload
    preload.src = bossAttackArt
    void preload.decode?.().catch(() => undefined)
    return () => {
      link.remove()
      if (attackPreload.current === preload) attackPreload.current = null
    }
  }, [bossAttackArt, def.artId, def.id])
  useEffect(() => {
    if (!animatedBoss || currentBossArtId !== 'downfall_demon') return
    for (const src of [
      assetPath('combat/enemies/animations/downfall_demon-ground-slam.webp'),
      assetPath('combat/vfx/actions/downfall-demon-ground-splat.webp'),
    ]) {
      const preload = new Image()
      preload.src = src
      void preload.decode?.().catch(() => undefined)
    }
  }, [animatedBoss, currentBossArtId])
  useEffect(() => {
    if (!currentBossProjectileArt) return
    const preload = new Image()
    preload.src = currentBossProjectileArt
    void preload.decode?.().catch(() => undefined)
  }, [currentBossProjectileArt])
  const bossArtId = presentedBossAttack?.artId ?? currentBossArtId
  const demonAttacking = bossAttacking && bossArtId === 'downfall_demon'
  const displayedArt = demonAttacking
    ? assetPath('combat/enemies/animations/downfall_demon-airborne.webp')
    : art
  const bossAttackMotion = animatedBoss ? bossAttackMotionFor(bossArtId) : 'ranged'
  const bossAttackScale = bossAttackScaleFor(bossArtId)
  const bossAttackContactLeft = bossAttackContactLeftFor(bossArtId)
  const bossProjectileArt = bossAttackMotion === 'ranged' ? bossProjectileImagePath(bossArtId) : undefined
  const rangedTargetKey = rangedTargetPlayerIds.join('\0')
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !bossAttacking || bossAttackMotion !== 'melee') return
    const boss = card.querySelector<HTMLImageElement>('.enemy__art--cutout')
    const heroes = [...(card.closest('.board')?.querySelectorAll<HTMLElement>('.seat:not(.seat--dead) .seat__portrait > img') ?? [])]
    if (!boss || heroes.length === 0) return
    const measure = () => {
      if (boss.naturalHeight === 0) return
      const heroAnimations = heroes.map((hero) => hero.style.animation)
      for (const hero of heroes) hero.style.animation = 'none'
      const heroRight = Math.max(...heroes.map((hero) => hero.getBoundingClientRect().right))
      heroes.forEach((hero, index) => { hero.style.animation = heroAnimations[index] ?? '' })
      const animation = boss.style.animation
      boss.style.animation = 'none'
      const bossRect = boss.getBoundingClientRect()
      const visibleBossLeft = bossRect.left + bossAttackContactLeft / boss.naturalHeight * bossRect.height
      boss.style.animation = animation
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      card.style.setProperty('--boss-dash-x', `${Math.min(0, heroRight - visibleBossLeft) / rem}rem`)
      if (bossArtId === 'downfall_demon') {
        const boardTop = card.closest('.board')?.getBoundingClientRect().top ?? 0
        const launchY = boardTop - bossRect.bottom - rem
        // Measured from the generated launch pose: body center to dust plume center is
        // 16.2deg left of vertical, or 0.291 horizontal distance per vertical distance.
        card.style.setProperty('--boss-launch-x', `${launchY * 0.291 / rem}rem`)
        card.style.setProperty('--boss-launch-y', `${launchY / rem}rem`)
      }
    }
    if (boss.complete && boss.naturalHeight > 0) measure()
    else boss.addEventListener('load', measure, { once: true })
    return () => {
      boss.removeEventListener('load', measure)
      card.style.removeProperty('--boss-dash-x')
      card.style.removeProperty('--boss-launch-x')
      card.style.removeProperty('--boss-launch-y')
    }
  }, [art, bossArtId, bossAttacking, bossAttackContactLeft, bossAttackMotion])
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !bossAttacking || !bossProjectileArt) return
    const boss = card.querySelector<HTMLImageElement>('.enemy__art--cutout')
    const board = card.closest('.board')
    if (!boss || !board) return
    const measure = () => {
      const cardRect = card.getBoundingClientRect()
      const bossRect = boss.getBoundingClientRect()
      const startX = bossRect.left + bossRect.width * 0.34
      const startY = bossRect.top + bossRect.height * 0.48
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      for (const projectile of card.querySelectorAll<HTMLElement>('.boss-projectile')) {
        const playerId = projectile.dataset.targetPlayer
        const target = playerId
          ? board.querySelector<HTMLElement>(`.seat[data-player-id="${CSS.escape(playerId)}"] .seat__portrait`)
          : null
        if (!target) continue
        const targetRect = target.getBoundingClientRect()
        projectile.style.setProperty('--boss-projectile-start-x', `${(startX - cardRect.left) / rem}rem`)
        projectile.style.setProperty('--boss-projectile-start-y', `${(startY - cardRect.top) / rem}rem`)
        projectile.style.setProperty('--boss-projectile-x', `${(targetRect.left + targetRect.width / 2 - startX) / rem}rem`)
        projectile.style.setProperty('--boss-projectile-y', `${(targetRect.top + targetRect.height / 2 - startY) / rem}rem`)
      }
    }
    if (boss.complete && boss.naturalHeight > 0) measure()
    else boss.addEventListener('load', measure, { once: true })
    return () => boss.removeEventListener('load', measure)
  }, [art, bossAttacking, bossProjectileArt, rangedTargetKey])
  const abilities = enemyAbilities(def)
  const mods = attackerModsOfEnemy(visibleEnemy)
  const intent = actions.flatMap((action) => intentParts(action, (printed) => swingDamage(
    printed + (defender ? enemyAttackBonus(enemies, visibleEnemy, action, defender) : 0),
    mods, { vulnerable: defender?.vulnerable ?? 0 },
  )))
  const swing = (printed: number) => swingDamage(printed, mods,
    { vulnerable: defender?.vulnerable ?? 0 })
  if ((visibleEnemy.actsLast || def.actsLast) && !actions.some((action) => action.kind === 'actsLast')) {
    intent.push(...intentParts({ kind: 'actsLast' }, swing))
  }
  const abilityLabels = abilities.map((ability) => {
    const text = displayedAbilityText(ability, visibleEnemy, def.id, die, false)
    return `${text}${visibleEnemy.abilityUsed && ability.kind === 'curlUp' ? ', spent' : ''}`
  })
  const hpFraction = visibleEnemy.maxHp === 0 ? 0 : visibleEnemy.hp / visibleEnemy.maxHp

  const className = [
    'enemy',
    visibleEnemy.dead ? 'enemy--dead' : '',
    falling && visibleEnemy.dead ? 'enemy--falling' : '',
    targeted ? 'enemy--targeted' : '',
    visibleEnemy.isBoss ? 'enemy--boss' : '',
    bossAttacking ? 'enemy--acting' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={cardRef}
      type="button"
      className={className}
      data-sfx="enemy"
      data-enemy-id={enemy.uid}
      data-enemy-def={def.id}
      data-boss-act={def.bossAct}
      data-attack-motion={bossAttackMotion}
      data-boss-art={visibleEnemy.isBoss ? bossArtId : undefined}
      data-animation={animatedBoss ? bossAttacking ? 'attack' : 'idle' : 'static'}
      data-row={enemy.row}
      style={{
        '--stage-index': stageIndex,
        '--boss-attack-scale': bossAttackScale,
        '--boss-contact-left': bossAttackContactLeft,
        '--boss-attack-duration': `${bossAttackDurationFor(bossArtId)}ms`,
      } as CSSProperties}
      disabled={enemy.dead || disabled}
      onClick={() => { if (!enemy.dead) onClick?.(enemy) }}
      aria-label={describeEnemy(visibleEnemy, visibleLabel, intent, abilityLabels, rowLabel)}
    >
      {/* A corpse telegraphing an attack it will never make is worse than no
          intent at all — it is read as a threat while choosing a target.
          p.13: the dead are flipped over until the end of combat. */}
      <span className="enemy__intent">
        {visibleEnemy.dead ? (
          // Not the `monster` icon: that same glyph badges LIVING enemies two
          // lines above, so a corpse wearing it still reads as a threat.
          <span className="enemy__defeated" aria-hidden="true">
            ✕
          </span>
        ) : intent.length === 0 ? (
          <span className="enemy__asleep">…</span>
        ) : (
          intent.map((part, i) => (
            <span className="intent" key={`${part.icon}-${i}`}>
              {part.aoe ? <Icon name="aoe" size={20} /> : null}
              <IconValue name={part.icon} value={part.value ?? ''} prefix={part.prefix} size={28} />
              {part.visibleLabel ? <span className="intent__label">{part.visibleLabel}</span> : null}
            </span>
          ))
        )}
      </span>
      {abilities.length > 0 ? (
        <span
          className="enemy__ability"
          title={abilityLabels.join('\n')}
          onClick={(event) => event.stopPropagation()}
        >
          {abilities.map((ability, index) => {
            const spent = visibleEnemy.abilityUsed && (ability.kind === 'curlUp' ||
              (ability.kind === 'rebirth' && def.id === 'time_eater'))
            return (
              <span className={spent ? 'enemy__ability--spent' : undefined} key={`${ability.kind}-${index}`}>
                {spent && ability.kind === 'curlUp'
                  ? 'Curl Up · spent'
                  : displayedAbilityText(ability, visibleEnemy, def.id, die, true)}
              </span>
            )
          })}
        </span>
      ) : null}

      {bossAttacking && bossProjectileArt ? rangedTargetPlayerIds.map((playerId) => (
        <span className="boss-projectile" data-target-player={playerId} key={playerId} aria-hidden="true">
          <img src={bossProjectileArt} alt="" />
        </span>
      )) : null}

      {visibleEnemy.corpseExplosion ? (
        <span className="enemy__attachment" title={`Corpse Explosion · ${visibleEnemy.corpseExplosion.damage} row damage on death`}>
          <img src={cardThumbPath(cardDef(visibleEnemy.corpseExplosion.card.defId), visibleEnemy.corpseExplosion.card.upgraded)} alt=""
            onLoad={(event) => revealDecodedImage(event.currentTarget)}
            onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
          <span>Corpse Explosion · {visibleEnemy.corpseExplosion.damage}</span>
        </span>
      ) : null}

      <span className="enemy__portrait">
        {demonAttacking ? <>
          <span className="boss-demon-ground-splat boss-demon-ground-splat--origin" aria-hidden="true" />
          <span className="boss-demon-ground-splat boss-demon-ground-splat--target" aria-hidden="true" />
        </> : null}
        <img
          key={`${def.artId ?? def.id}-${bossAttacking ? 'attack' : 'idle'}`}
          className="enemy__art--cutout"
          src={displayedArt}
          alt=""
          loading={visibleEnemy.isBoss ? 'eager' : 'lazy'}
          onError={(event) => {
            // Keep combat usable if a bundled image fails to load.
            event.currentTarget.style.display = 'none'
          }}
        />
        {demonAttacking ? <img
          className="boss-demon-grounded"
          src={assetPath('combat/enemies/animations/downfall_demon-ground-slam.webp')}
          alt=""
          aria-hidden="true"
        /> : null}
        {vfx}
        {rowLabel ? (
          <span className="enemy__row" title={`Row ${enemy.row + 1} · ${rowLabel}`} aria-hidden="true">
            <span className="enemy__row-long">{rowLabel}</span>
            <span className="enemy__row-short">P{enemy.row + 1}</span>
          </span>
        ) : null}
        <span className="enemy__head">
          <Icon name={visibleEnemy.isBoss ? 'boss' : 'monster'} size={16} />
          <span className="enemy__name">{def.name}</span>
        </span>
        {hitBeats.map((hit) => (
          <span
            className="hit-vfx"
            key={hit.beat}
            aria-hidden="true"
            style={{ '--hit-delay': `${hit.delayMs}ms` } as CSSProperties}
          >
            <strong>{hit.damage}</strong>
          </span>
        ))}
      </span>

      <span className="bar" aria-hidden="true">
        <span
          className="bar__fill"
          data-health={healthBand(visibleEnemy.hp, visibleEnemy.maxHp)}
          style={{ width: `${Math.round(hpFraction * 100)}%` }}
        />
        <span className="bar__label">
          {visibleEnemy.hp}/{visibleEnemy.maxHp}
        </span>
      </span>

      {/* A defeated enemy is flipped over (p.13), and its tokens go with it —
          a corpse still announcing "Poison 3" reads as a live threat. */}
      {visibleEnemy.dead ? null : (
      <TokenRow
        block={visibleEnemy.block}
        strength={visibleEnemy.strength}
        vulnerable={visibleEnemy.vulnerable}
        weak={visibleEnemy.weak}
        poison={visibleEnemy.poison}
      />
      )}
    </button>
  )
}
