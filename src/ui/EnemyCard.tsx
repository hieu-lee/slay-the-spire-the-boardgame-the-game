import { cardDef, faceOf } from '../game/cards.ts'
import { assetPath, enemyAnimationImagePath, cardThumbPath, enemyImagePath } from '../game/assets.ts'
import { abilityText, actionsForEnemy, enemyAbilities, enemyAttackBonus, enemyDef } from '../game/enemies.ts'
import type { EnemyAction } from '../game/enemies.ts'
// Aliased: `hitDamage` is also this component's floating hit-VFX number.
import { attackerModsOfEnemy, hitDamage as swingDamage } from '../game/damage.ts'
import type { Enemy, Player } from '../game/types.ts'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, IconValue } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import { TokenRow } from './TokenRow.tsx'
import { splitAttackAnimationPending } from './combat-screen/vfx.tsx'
import { healthBand } from './board-signals.ts'
import { animationSfxRecipe } from './combat-sfx.ts'
import { playCombatSound } from './sfx.ts'
import { CardKeywordHelp, cardRuleDescription, revealDecodedImage } from './Card.tsx'
import {
  bossAttackContactLeftFor,
  bossAttackDurationFor,
  enemyArtScaleFor,
  enemyAttackAnimationFor,
  enemyAttackArrivalMsFor,
  enemyProjectileImpactPath,
  enemyProjectileOriginFor,
  bossAttackMotionFor,
  bossProjectileImagePath,
} from './combat-vfx.ts'
import { combatArtBounds, combatBodyPoint } from './combat-geometry.ts'
import enemyArtSizes from './enemy-art-size.json'
import eliteArtHeads from './elite-art-head.json'
import enemyFootAnchors from './enemy-foot-anchors.json'
import {
  CombatAnimation,
  combatArtReady,
  combatArtSize,
  onCombatArtReady,
  useSafariCombatRendering,
  useWebKitCombatRendering,
  type CombatArtElement,
} from './CombatAnimation.tsx'

type EnemyCardProps = {
  enemy: Enemy
  enemies: readonly Enemy[]
  /** The finished display name, built by the engine so the log agrees. */
  label: string
  /** The round's shared die, which decides what a die-pattern enemy will do. */
  die: number
  acting?: boolean
  animateArt?: boolean
  /** A player attack is still presenting; bosses begin only after it clears. */
  deferBossAttack?: boolean
  targeted?: boolean
  disabled?: boolean
  splitAttackEvents?: { seq: number; damage?: number; weights: readonly number[] }[]
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
  cancelPendingThrow?: boolean
  onThrowPrepared?: (enemyUid: string, arrivalWithinMs: number) => void
  onThrowStart?: (enemyUid: string) => void
  onThrowSkipped?: (enemyUid: string) => void
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
  for (const entry of enemy.slayerAttachments ?? []) {
    parts.push(`${faceOf(cardDef(entry.card.defId), entry.card.upgraded).name} attached`)
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
): string {
  if (ability.kind === 'confusion') return `Confusion: the first card played this turn costs ${ability.byRoll[die] ?? '?'} Energy`
  if (ability.kind === 'immuneOnSlots') return ability.slots.includes(enemy.actionIndex)
    ? 'HP immunity: cannot lose HP this turn'
    : 'HP immunity: inactive; cannot lose HP while the cube is on a marked action'
  if (ability.kind === 'invincible') return enemy.abilityUsed
    ? 'Invincible: removed'
    : `Invincible: cannot gain Weak or fall below ${ability.hpPerPlayer} HP per player`
  if (ability.kind === 'facing') {
    if (ability.effect === 'spear') return 'Facing: gain 2 Burn at the start of turn while facing Spire Spear'
    const penalty = enemy.actionIndex === 0 ? 'lose 1 Energy' : enemy.actionIndex === 1 ? 'cannot draw' : 'deal 0 damage'
    return `Facing: ${penalty} this turn while facing Spire Shield`
  }
  if (ability.kind === 'rebirth') {
    if (defId === 'time_eater') return enemy.abilityUsed ? 'Haste: spent'
      : `Haste: when first defeated, return with ${ability.hpPerPlayer} HP per player, gain 1 Strength, remove all Weak and Vulnerable; Poison remains`
    if (defId === 'the_champ') return `Anger: when first defeated, enter Fury with ${ability.hpPerPlayer} HP per player`
    if (defId === 'awakened_one_phase_1') return `Awaken: return at end of turn in a second form${(enemy.ascension ?? 0) >= 10 ? ' and gain Strength equal to the largest number of Powers a player has in play' : ''}`
  }
  return abilityText(ability, false, enemy)
}

export function EnemyCard({
  enemy,
  enemies,
  label,
  die,
  acting = false,
  animateArt = false,
  deferBossAttack = false,
  targeted = false,
  disabled = false,
  hitBeats = [],
  splitAttackEvents = [],
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
  cancelPendingThrow,
  onThrowPrepared,
  onThrowStart,
  onThrowSkipped,
  onClick,
}: EnemyCardProps) {
  const cardRef = useRef<HTMLButtonElement>(null)
  const [visibleEnemy, setVisibleEnemy] = useState(enemy)
  const displayTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const pendingVisuals = useRef(new Map<number, {
    eventSeq: number; enemy: Enemy; damage: number; recovery: number; impactEvents: { seq: number; weights: readonly number[] }[]; impacts: Set<string>
  }>())
  const splitHpActive = useRef(false)
  const latestEnemy = useRef(enemy)
  latestEnemy.current = enemy
  const numberTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const nextNumber = useRef(0)
  const [bulletNumbers, setBulletNumbers] = useState<{ id: number; damage: number; x: number; y: number }[]>([])
  const attackPreload = useRef<{ source: string; blob: Blob } | null>(null)
  const [attackPreloadRevision, setAttackPreloadRevision] = useState(0)
  const bossAttackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [presentedBossAttack, setPresentedBossAttack] = useState<{
    art: string
    artId: string
    source: string
  } | null>(null)
  const [awaitingNextEnemyPhase, setAwaitingNextEnemyPhase] = useState(acting)
  const displayBeat = useRef(0)
  const displayedEventSeq = useRef(visualEventSeq)
  const visualSignature = JSON.stringify(enemy)
  const priorActual = useRef({
    signature: visualSignature, eventSeq: visualEventSeq, resetKey: visualResetKey, hp: enemy.hp,
  })
  const resetVisuals = !stageVisualDamage || visualResetKey !== priorActual.current.resetKey
  // HP is the authoritative endpoint plus damage whose visual impacts are still pending.
  // Additive debt keeps overlapping attacks from restoring an older HP snapshot.
  const publishVisual = (snapshot?: Enemy, eventSeq = -1) => {
    const applySnapshot = snapshot && eventSeq >= displayedEventSeq.current
    if (applySnapshot) displayedEventSeq.current = eventSeq
    if (!splitHpActive.current) {
      if (applySnapshot) setVisibleEnemy(snapshot)
      return
    }
    const hp = Math.round(Math.max(0, Math.min(latestEnemy.current.maxHp,
      latestEnemy.current.hp + [...pendingVisuals.current.values()]
        .reduce((total, pending) => total + pending.damage - pending.recovery, 0))) * 1e9) / 1e9
    setVisibleEnemy(previous => ({ ...(applySnapshot ? snapshot : previous), hp,
      dead: hp > 0 ? false : latestEnemy.current.dead }))
    if (pendingVisuals.current.size === 0) splitHpActive.current = false
  }
  const showBulletNumber = (damage: number, x: number, y: number) => {
    if (damage <= 0) return
    const id = ++nextNumber.current
    setBulletNumbers(numbers => [...numbers, { id, damage, x, y }])
    numberTimers.current.set(id, setTimeout(() => {
      numberTimers.current.delete(id)
      setBulletNumbers(numbers => numbers.filter(number => number.id !== id))
    }, 600))
  }
  const finishVisual = (beat: number) => {
    const pending = pendingVisuals.current.get(beat)
    if (!pending) return
    clearTimeout(displayTimers.current.get(beat))
    displayTimers.current.delete(beat)
    pendingVisuals.current.delete(beat)
    publishVisual(pending.enemy, pending.eventSeq)
  }
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const impact = (event: Event) => {
      const detail = (event as CustomEvent<{ seq: number; shot: string; index: number; x: number; y: number }>).detail
      const entry = [...pendingVisuals.current.entries()].find(([, pending]) => pending.impactEvents.some(impact => impact.seq === detail.seq))
      if (!entry) return
      const [beat, pending] = entry
      const key = `${detail.seq}:${detail.index}`
      if (pending.impacts.has(key)) return
      const weights = pending.impactEvents.find(impact => impact.seq === detail.seq)!.weights
      const weight = weights[detail.index]
      if (weight === undefined) return
      const remaining = pending.impactEvents.reduce((sum, impact) => sum + impact.weights.reduce((total, value, index) =>
        total + (pending.impacts.has(`${impact.seq}:${index}`) ? 0 : value), 0), 0)
      const damage = pending.damage * weight / Math.max(weight, remaining)
      pending.impacts.add(key)
      pending.damage = Math.max(0, pending.damage - damage)
      showBulletNumber(damage, detail.x, detail.y)
      if (remaining - weight < 1e-9) finishVisual(beat)
      else publishVisual()
    }
    card.addEventListener('hermit-impact', impact)
    card.addEventListener('kratos-impact', impact)
    return () => {
      card.removeEventListener('hermit-impact', impact)
      card.removeEventListener('kratos-impact', impact)
    }
  }, [])
  useLayoutEffect(() => {
    const newSplitEvents = splitAttackEvents.filter(event => event.seq > priorActual.current.eventSeq)
    const changed = visualSignature !== priorActual.current.signature ||
      newSplitEvents.some(event => (event.damage ?? 0) > 0)
    const newEvent = visualEventSeq > priorActual.current.eventSeq
    if (!resetVisuals && changed && newEvent && visualContactMs < 0) return
    const beforeHp = priorActual.current.hp
    const damage = Math.max(0, beforeHp - enemy.hp)
    priorActual.current = {
      signature: visualSignature, eventSeq: visualEventSeq, resetKey: visualResetKey, hp: enemy.hp,
    }
    if (resetVisuals) {
      for (const timer of displayTimers.current.values()) clearTimeout(timer)
      displayTimers.current.clear()
      pendingVisuals.current.clear()
      splitHpActive.current = false
      for (const timer of numberTimers.current.values()) clearTimeout(timer)
      numberTimers.current.clear()
      setBulletNumbers(numbers => numbers.length ? [] : numbers)
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
      if (splitHpActive.current && newEvent) {
        publishVisual(enemy, visualEventSeq)
        return
      }
      const pendingBeat = [...pendingVisuals.current.keys()].at(-1)
      if (pendingBeat !== undefined) {
        const pending = pendingVisuals.current.get(pendingBeat)!
        pending.eventSeq = Math.max(pending.eventSeq, visualEventSeq)
        pending.enemy = enemy
        pending.damage += damage
        pending.recovery += Math.max(0, enemy.hp - beforeHp)
        publishVisual()
        return
      }
      displayedEventSeq.current = visualEventSeq
      setVisibleEnemy(enemy)
      return
    }
    const known = newSplitEvents.every(event => event.damage !== undefined)
    const splitDamage = known ? newSplitEvents.reduce((sum, event) => sum + event.damage!, 0) : damage
    const plans: { seq: number; weights: readonly number[] | undefined; damage: number }[] = newSplitEvents.length ? newSplitEvents.map(event => ({
      seq: event.seq, weights: event.weights,
      damage: known ? event.damage! : damage / newSplitEvents.length,
    })) : [{ seq: visualEventSeq, weights: undefined, damage }]
    if (newSplitEvents.length && damage > splitDamage) plans.push({ seq: visualEventSeq, weights: undefined, damage: damage - splitDamage })
    if (newSplitEvents.length) splitHpActive.current = true
    // A defeated phase may revive in the same authoritative update. Reveal that
    // recovery only after its final impact, instead of erasing the damage numbers.
    const recovery = Math.max(0, enemy.hp - beforeHp + plans.reduce((sum, plan) => sum + plan.damage, 0))
    for (const plan of plans) {
      const beat = ++displayBeat.current
      pendingVisuals.current.set(beat, { eventSeq: plan.seq, enemy, damage: plan.damage,
        recovery: plan.seq === newSplitEvents.at(-1)?.seq && plan.weights ? recovery : 0,
        impactEvents: plan.weights ? [{ seq: plan.seq, weights: plan.weights }] : [], impacts: new Set() })
      // Actual impacts drive split attacks. A slow replay decode shifts the CSS clock;
      // retain its damage debt while the combo runs, and settle missing art normally.
      const settle = () => {
        const pending = pendingVisuals.current.get(beat)
        if (!pending) return
        if (pending.impactEvents.some(impact => splitAttackAnimationPending(impact.seq))) {
          displayTimers.current.set(beat, setTimeout(settle, 100))
          return
        }
        finishVisual(beat)
      }
      displayTimers.current.set(beat, setTimeout(settle, delay + (plan.weights ? 2_200 : 0)))
    }
    publishVisual()
  }, [acting, enemy, resetVisuals, visualContactMs, visualEventSeq, visualResetKey, visualSignature])
  useEffect(() => () => {
    for (const timer of displayTimers.current.values()) clearTimeout(timer)
    for (const timer of numberTimers.current.values()) clearTimeout(timer)
    pendingVisuals.current.clear()
  }, [])
  const def = enemyDef(visibleEnemy.defId, visibleEnemy.ascension)
  const actualName = enemyDef(enemy.defId, enemy.ascension).name
  const visibleLabel = label.startsWith(actualName) ? `${def.name}${label.slice(actualName.length)}` : label
  const actions = actionsForEnemy(visibleEnemy, die)
  const animatedEnemy = Boolean(animateArt && !visibleEnemy.dead)
  const currentBossArtId = def.artId ?? def.id
  const sleeping = !visibleEnemy.dead && currentBossArtId === 'lagavulin' && actions.length > 0 &&
    actions.every(action => action.kind === 'idle')
  const restPose = sleeping ? 'lagavulin-sleep' : currentBossArtId
  const previousRestPose = useRef({ pose: restPose, resetKey: visualResetKey })
  const [restTransition, setRestTransition] = useState<{ src: string; source: string; previousSrc: string; key: number; ready: boolean; playing?: boolean; finished?: boolean } | null>(null)
  const [idleReadySource, setIdleReadySource] = useState<string | null>(null)
  const decodedIdleArts = useRef(new WeakSet<CombatArtElement>())
  const restTransitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timedCultist = useWebKitCombatRendering && currentBossArtId === 'cultist'
  // WebKit can retain the idle texture over a timed SVG after changing opacity.
  const retainIdle = (useSafariCombatRendering || currentBossArtId !== 'cultist' &&
    enemyAttackArrivalMsFor(currentBossArtId) !== undefined) && !timedCultist
  const bossHasAttackAction = actions.some((action) => action.kind === 'attack' || action.kind === 'attackSequence')
  const currentBossAttackArt = currentBossArtId === 'downfall_demon'
    ? assetPath('combat/rigged/downfall_demon-airborne.webp')
    : timedCultist
      ? assetPath('combat/enemies/animated/cultist-attack.svg')
      : enemyAnimationImagePath(def, 'attack', useWebKitCombatRendering)
  const currentIdleArt = sleeping ? assetPath('combat/enemies/animated/lagavulin-sleep.webp')
    : enemyAnimationImagePath(def, 'idle')
  const previousIdleArt = assetPath(`combat/enemies/animated/${previousRestPose.current.pose === 'lagavulin-sleep'
    ? 'lagavulin-sleep' : `${previousRestPose.current.pose}-idle`}.webp`)
  const restTransitionName = previousRestPose.current.pose === 'lagavulin-sleep' && restPose === 'lagavulin' ? 'lagavulin-wake'
    : previousRestPose.current.pose === 'guardian_attack' && restPose === 'guardian_defensive' ? 'guardian-close'
    : previousRestPose.current.pose === 'guardian_defensive' && restPose === 'guardian_attack' ? 'guardian-open' : null
  useLayoutEffect(() => {
    const idle = [...(cardRef.current?.querySelectorAll<CombatArtElement>('[data-animation-layer="idle"]') ?? [])]
      .find(image => image.dataset.animationAsset === currentIdleArt)
    setIdleReadySource(idle && decodedIdleArts.current.has(idle) && combatArtReady(idle) ? currentIdleArt : null)
  }, [currentIdleArt])
  const currentBossProjectileArt = bossProjectileImagePath(currentBossArtId)
  const currentProjectileImpact = enemyProjectileImpactPath(currentBossArtId)
  const bossAttackRequested = Boolean(animatedEnemy && acting && bossHasAttackAction && !cancelPendingThrow)
  const [bossAttackReady, setBossAttackReady] = useState(false)
  const [cultistCoverReady, setCultistCoverReady] = useState(false)
  const [cultistCoverFailed, setCultistCoverFailed] = useState(false)
  const [cultistPropReady, setCultistPropReady] = useState(false)
  const finishBossAttack = () => {
    if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
    bossAttackTimer.current = null
    setBossAttackReady(false)
    setPresentedBossAttack(null)
  }
  useLayoutEffect(() => {
    if (!acting) setAwaitingNextEnemyPhase(false)
  }, [acting])
  const bossAttackTriggered = bossAttackRequested && !deferBossAttack &&
    !resetVisuals && !awaitingNextEnemyPhase
  const bossAttacking = Boolean(animatedEnemy && presentedBossAttack && !cancelPendingThrow)
  const bossAttackPlaying = bossAttacking && bossAttackReady &&
    (!timedCultist || cultistCoverReady || cultistCoverFailed)
  useLayoutEffect(() => {
    if (restTransitionTimer.current) clearTimeout(restTransitionTimer.current)
    restTransitionTimer.current = null
    const previous = previousRestPose.current
    if (!animatedEnemy || previous.resetKey !== visualResetKey || cancelPendingThrow) {
      previousRestPose.current = { pose: restPose, resetKey: visualResetKey }
      setRestTransition(null)
      return
    }
    if (bossAttacking) {
      setRestTransition(current => current ? { ...current, playing: false, finished: true } : null)
      return
    }
    previousRestPose.current = { pose: restPose, resetKey: visualResetKey }
    const name = restTransitionName
    const controller = new AbortController()
    if (name) {
      const source = assetPath(`combat/enemies/animated/${name}.webp`)
      const key = performance.now()
      const previousImage = [...(cardRef.current?.querySelectorAll<CombatArtElement>('[data-animation-layer="idle"]') ?? [])]
        .find(image => image.dataset.animationAsset === previousIdleArt)
      const previousSource = restTransition && (!previousImage || !decodedIdleArts.current.has(previousImage) || !combatArtReady(previousImage))
        ? restTransition.previousSrc : previousIdleArt
      setRestTransition({ src: previousSource, source, previousSrc: previousSource, key, ready: false })
      void fetch(source, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('Animation unavailable')
        const blob = await response.blob()
        if (!controller.signal.aborted) setRestTransition({ src: URL.createObjectURL(blob), source, previousSrc: previousSource, key, ready: true })
      }).catch(() => {
        if (!controller.signal.aborted) setRestTransition(current => current ? { ...current, finished: true } : null)
      })
    } else setRestTransition(current => current?.finished && idleReadySource !== currentIdleArt ? current : null)
    return () => {
      controller.abort()
      if (restTransitionTimer.current) clearTimeout(restTransitionTimer.current)
    }
  }, [animatedEnemy, bossAttacking, cancelPendingThrow, restPose, visualResetKey])
  useEffect(() => () => {
    if (restTransition?.src.startsWith('blob:')) URL.revokeObjectURL(restTransition.src)
  }, [restTransition?.src])
  useEffect(() => {
    if (restTransition?.finished && idleReadySource === currentIdleArt) setRestTransition(null)
  }, [currentIdleArt, idleReadySource, restTransition?.finished])
  useEffect(() => {
    if (!timedCultist || !bossAttackPlaying || bossAttackTimer.current) return
    bossAttackTimer.current = setTimeout(finishBossAttack, bossAttackDurationFor(currentBossArtId))
  }, [bossAttackPlaying, currentBossArtId, timedCultist])
  useEffect(() => {
    if (enemyAttackArrivalMsFor(currentBossArtId) !== undefined && bossAttackRequested && awaitingNextEnemyPhase) onThrowSkipped?.(enemy.uid)
  }, [awaitingNextEnemyPhase, bossAttackRequested, currentBossArtId, enemy.uid, onThrowSkipped])
  useEffect(() => {
    if (!presentedBossAttack || !(cancelPendingThrow || !acting && !bossAttackReady)) return
    if (cancelPendingThrow && bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
    if (cancelPendingThrow) bossAttackTimer.current = null
    setBossAttackReady(false)
    setPresentedBossAttack(null)
  }, [acting, bossAttackReady, cancelPendingThrow, presentedBossAttack])
  useEffect(() => {
    if (!bossAttackTriggered) return
    const cached = attackPreload.current
    // The WebKit body SVG and CSS projectiles must share a start clock.
    // Decode the cover before mounting the one-shot SVG at all.
    if (timedCultist && !cultistCoverReady && !cultistCoverFailed) return
    if (currentBossArtId === 'cultist' && !cultistPropReady) return
    // A cold Cultist request may finish just before the phase deadline.
    // Mount its preloaded blob instead of starting a second image request.
    if (currentBossArtId === 'cultist' && cached?.source !== currentBossAttackArt) return
    // A fresh blob URL restarts decoded one-shots. Cold Cultist art must load
    // before its sticks leave; its idle image still visibly holds them.
    const art = cached?.source === currentBossAttackArt && cached.blob
      ? URL.createObjectURL(cached.blob)
      : (['cultist', 'lagavulin', 'gremlin_leader', 'reptomancer', 'guardian_attack', 'guardian_defensive'].includes(currentBossArtId) ||
        useWebKitCombatRendering) ? currentBossAttackArt : currentIdleArt
    if (currentBossArtId === 'cultist') onThrowPrepared?.(enemy.uid, 1800)
    else if (enemyAttackArrivalMsFor(currentBossArtId) !== undefined) onThrowPrepared?.(enemy.uid, 730)
    setPresentedBossAttack({ art, artId: currentBossArtId, source: currentBossAttackArt })
    if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
    bossAttackTimer.current = null
    setBossAttackReady(false)
  }, [attackPreloadRevision, bossAttackTriggered, cultistCoverFailed, cultistCoverReady, cultistPropReady,
    currentBossArtId, currentBossAttackArt, currentIdleArt, enemy.uid, onThrowPrepared, timedCultist])
  useEffect(() => () => {
    if (presentedBossAttack?.art.startsWith('blob:')) URL.revokeObjectURL(presentedBossAttack.art)
  }, [presentedBossAttack])
  useEffect(() => () => {
    if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
  }, [])
  const art = animatedEnemy
    ? bossAttacking ? presentedBossAttack?.art ?? currentBossAttackArt : restTransition?.src ?? currentIdleArt
    : sleeping ? assetPath('combat/enemies/animated/lagavulin-sleep-static.webp') : enemyImagePath(def)
  const bossArtId = presentedBossAttack?.artId ?? currentBossArtId
  const signatureAttack = bossArtId !== 'cultist' && enemyAttackArrivalMsFor(bossArtId) !== undefined
  const onArtError = (image: HTMLImageElement) => {
    // Keep combat usable if both bundled animation formats fail.
    if (image.dataset.fallback !== 'true') {
      image.dataset.fallback = 'true'
      image.style.scale = '1'
      if (normalSize) {
        image.style.width = `calc(var(--stage-actor-width) * ${normalSize[2]})`
        image.style.height = `calc(var(--stage-actor-width) * ${normalSize[3]})`
        image.style.left = `calc(50% - var(--stage-actor-width) * ${normalSize[2]} / 2)`
      }
      image.src = enemyImagePath(def)
    } else image.style.display = 'none'
  }
  // Hit only the painted creature and its HUD, never a neighbour's transparent
  // animation canvas. The art itself remains free to overflow during attacks.
  useLayoutEffect(() => {
    const portrait = cardRef.current?.querySelector<HTMLElement>('.enemy__portrait')
    const hit = portrait?.querySelector<HTMLElement>('.enemy__hit-area')
    const initialImage = portrait?.querySelector<CombatArtElement>(':scope > :is(img, video):not([data-inactive])')
    if (!portrait || !hit || !initialImage) return
    const measure = () => {
      const images = portrait.querySelectorAll<CombatArtElement>(':scope > .enemy__art--cutout')
      for (const image of images) {
        // Reviewed normalized X anchors: [animated resting pose, static fallback].
        // Feet/body bases belong over HP; keep this anchor throughout the attack.
        const feet = (enemyFootAnchors as Record<string, number[]>)[bossArtId]
        const { width: naturalWidth, height: naturalHeight } = combatArtSize(image)
        if (feet && naturalWidth && naturalHeight) {
          const staticArt = !animatedEnemy || image.dataset.fallback === 'true'
          const fit = Math.min(image.clientWidth / naturalWidth, image.clientHeight / naturalHeight)
          const scale = staticArt ? 1 : enemyArtScaleFor(bossArtId)
          image.style.marginLeft = `${(.5 - feet[staticArt ? 1 : 0]!) * naturalWidth * fit * scale}px`
        }
      }
      const bounds = combatArtBounds(portrait)
      const parent = portrait.getBoundingClientRect()
      Object.assign(hit.style, {
        left: `${bounds.left - parent.left}px`, top: `${bounds.top - parent.top}px`,
        width: `${bounds.width}px`, height: `${bounds.height}px`,
      })
    }
    measure()
    const removeReady = onCombatArtReady(initialImage, measure)
    const resize = new ResizeObserver(measure)
    resize.observe(portrait)
    resize.observe(initialImage)
    portrait.addEventListener('load', measure, true)
    portrait.addEventListener('loadeddata', measure, true)
    return () => {
      resize.disconnect(); removeReady()
      portrait.removeEventListener('load', measure, true)
      portrait.removeEventListener('loadeddata', measure, true)
    }
  }, [art, animatedEnemy, bossArtId, bossAttackPlaying])
  const bossAttackArt = animatedEnemy ? currentBossAttackArt : undefined
  useEffect(() => {
    if (!bossAttackArt) return
    const controller = new AbortController()
    void fetch(bossAttackArt, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return
      const blob = await response.blob()
      if (!controller.signal.aborted) {
        attackPreload.current = { source: bossAttackArt, blob }
        if (currentBossArtId === 'cultist') setAttackPreloadRevision(revision => revision + 1)
      }
    }).catch(() => undefined)
    return () => {
      controller.abort()
      attackPreload.current = null
    }
  }, [bossAttackArt, currentBossArtId])
  useEffect(() => {
    if (!animatedEnemy || currentBossArtId !== 'downfall_demon') return
    for (const path of ['combat/rigged/downfall_demon-ground-slam.webp',
      'combat/vfx/actions/downfall-demon-ground-splat.webp']) {
      const preload = new Image()
      preload.src = assetPath(path)
      void preload.decode?.().catch(() => undefined)
    }
  }, [animatedEnemy, currentBossArtId])
  useEffect(() => {
    if (!animatedEnemy || !timedCultist || cultistCoverReady || cultistCoverFailed) return
    let active = true
    const preload = new Image()
    preload.src = assetPath('combat/enemies/animated/cultist-released.webp')
    void preload.decode().then(
      () => { if (active) setCultistCoverReady(true) },
      () => { if (active) setCultistCoverFailed(true) },
    )
    return () => { active = false }
  }, [animatedEnemy, cultistCoverFailed, cultistCoverReady, timedCultist])
  useEffect(() => {
    let active = true
    for (const path of [currentBossProjectileArt, currentProjectileImpact]) {
      if (!path) continue
      const preload = new Image()
      preload.src = path
      void preload.decode().then(() => {
        if (active && currentBossArtId === 'cultist' && path === currentBossProjectileArt) setCultistPropReady(true)
      }).catch(() => undefined)
    }
    return () => { active = false }
  }, [currentBossArtId, currentBossProjectileArt, currentProjectileImpact])
  const demonAttacking = bossAttackPlaying && bossArtId === 'downfall_demon'
  const bossAttackMotion = animatedEnemy ? bossAttackMotionFor(bossArtId) : 'ranged'
  const bossAttackContactLeft = bossAttackContactLeftFor(bossArtId)
  const bossProjectileArt = bossAttackMotion === 'ranged' ? bossProjectileImagePath(bossArtId) : undefined
  const projectileImpact = enemyProjectileImpactPath(bossArtId)
  const rangedTargetKey = rangedTargetPlayerIds.join('\0')
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !bossAttacking || bossAttackMotion !== 'melee') return
    const initialBoss = card.querySelector<CombatArtElement>('.enemy__art--cutout[data-animation-layer="attack"]')
    const heroes = [...(card.closest('.board')?.querySelectorAll<HTMLElement>('.seat:not(.seat--dead) .seat__portrait') ?? [])]
    if (!initialBoss || heroes.length === 0) return
    const measure = () => {
      const boss = card.querySelector<CombatArtElement>('.enemy__art--cutout[data-animation-layer="attack"]')
      if (!boss) return
      if (!combatArtReady(boss)) return
      const { width: naturalWidth, height: naturalHeight } = combatArtSize(boss)
      // The image includes scaled transparent overscan; the stable portrait
      // lane still describes the target's physical position.
      const heroRects = heroes.map((hero) => hero.getBoundingClientRect())
      const heroRight = Math.max(...heroRects.map((rect) => rect.right))
      const bossRect = boss.getBoundingClientRect()
      const imageScale = Math.min(bossRect.width / naturalWidth, bossRect.height / naturalHeight)
      const imageInset = (bossRect.width - naturalWidth * imageScale) / 2
      const visibleBossLeft = bossRect.left + imageInset + bossAttackContactLeft * imageScale
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      card.style.setProperty('--boss-dash-x', `${Math.min(0, heroRight - visibleBossLeft) / rem}rem`)
      if (bossArtId === 'gremlin_nob') {
        // Authored 730ms skull contact is at source y=460 of the 500px canvas.
        // Step onto the hero's ground plane for the low club smash.
        const contactY = bossRect.bottom - (500-460)*imageScale
        const targetY = Math.max(...heroRects.map((rect) => rect.bottom-rect.height*.08))
        card.style.setProperty('--boss-dash-y', `${(targetY-contactY)/rem}rem`)
      }
      if (bossArtId === 'downfall_demon') {
        const boardTop = card.closest('.board')?.getBoundingClientRect().top ?? 0
        const launchY = boardTop - bossRect.bottom - rem
        // Measured from the generated launch pose: body center to dust plume center is
        // 16.2deg left of vertical, or 0.291 horizontal distance per vertical distance.
        card.style.setProperty('--boss-launch-x', `${launchY * 0.291 / rem}rem`)
        card.style.setProperty('--boss-launch-y', `${launchY / rem}rem`)
      }
    }
    // Calculate travel when the attack art is ready, before its motion starts.
    // Later intent/status image loads must not remeasure or restart the swing.
    measure()
    const removeReady = onCombatArtReady(initialBoss, measure)
    return () => {
      removeReady()
      card.style.removeProperty('--boss-dash-x')
      card.style.removeProperty('--boss-dash-y')
      card.style.removeProperty('--boss-launch-x')
      card.style.removeProperty('--boss-launch-y')
    }
  }, [art, bossArtId, bossAttacking, bossAttackContactLeft, bossAttackMotion])
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !bossAttackPlaying || !bossProjectileArt && bossArtId !== 'gremlin_leader') return
    const initialBoss = card.querySelector<CombatArtElement>('.enemy__art--cutout[data-animation-layer="attack"]')
    const board = card.closest('.board')
    if (!initialBoss || !board) return
    let cultistLaunched = false
    const measure = () => {
      if (cultistLaunched) return
      const boss = card.querySelector<CombatArtElement>('.enemy__art--cutout[data-animation-layer="attack"]')
      if (!boss) return
      if (!combatArtReady(boss)) return
      const { width: naturalWidth, height: naturalHeight } = combatArtSize(boss)
      const cardRect = card.getBoundingClientRect()
      const bossRect = boss.getBoundingClientRect()
      // Overscan enlarges transparent padding, not the body. Anchor to the
      // physical portrait before applying the original attachment fractions.
      const scale = enemyArtScaleFor(bossArtId)
      const fit = Math.min(bossRect.width / naturalWidth, bossRect.height / naturalHeight)
      const bodyWidth = naturalWidth * fit / scale
      const bodyHeight = naturalHeight * fit / scale
      const origin = enemyProjectileOriginFor(bossArtId)
      const charge = card.querySelector<HTMLElement>('.reptomancer-charge')
      if (charge && origin) {
        charge.parentElement!.style.marginLeft = boss.style.marginLeft
        const chargeFit = Math.min(boss.offsetWidth / naturalWidth, boss.offsetHeight / naturalHeight)
        charge.style.left = `${(boss.offsetWidth - naturalWidth * chargeFit) / 2 + origin[0] * chargeFit}px`
        charge.style.top = `${boss.offsetHeight - naturalHeight * chargeFit + origin[1] * chargeFit}px`
      }
      const startX = origin ? bossRect.left + (bossRect.width - naturalWidth * fit) / 2 + origin[0] * fit
        : bossRect.left + bossRect.width / 2 - bodyWidth * .16
      const startY = origin ? bossRect.bottom - naturalHeight * fit + origin[1] * fit
        : bossRect.bottom - bodyHeight * .52
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const groundImpact = projectileImpact?.endsWith('/turn-poison-impact.webp')
      for (const projectile of card.querySelectorAll<HTMLElement>('.boss-projectile, .enemy-projectile-impact')) {
        const playerId = projectile.dataset.targetPlayer
        const target = playerId
          ? board.querySelector<HTMLElement>(`.seat[data-player-id="${CSS.escape(playerId)}"] .seat__portrait`)
          : null
        if (!target) continue
        const targetRect = target.getBoundingClientRect()
        const body = combatBodyPoint(target)
        if (bossArtId === 'cultist' && projectile.classList.contains('boss-projectile')) {
          // Each stick follows its own upward arc. Its wrapper translates while
          // the image spins, so rotating the prop cannot pull it toward the floor.
          const x = body.x - startX, y = body.y - startY
          for (const [index, stick] of [...projectile.querySelectorAll<HTMLElement>(':scope > .cultist-stick')].entries()) {
            // Source-space grips are 416px apart and 33px down; the prop's
            // painted center sits 70px above its grip.
            const handX = index * 416 * fit, handY = (index * 33 - 70) * fit
            const lift = Math.min(Math.abs(x - handX) * .22, bodyHeight * .7)
            const controlY = Math.min(handY, y) - Math.abs(y - handY) / 2 - lift
            // A quadratic curve with its control point midway moves linearly in
            // x. Its height is this exact easing between hand and target. Plain
            // translation avoids iOS offset-path origins that start at the floor.
            const endY = Math.abs(y - handY) < 1 ? handY + 1 : y
            const arc = (controlY - handY) / (endY - handY)
            stick.style.setProperty('--stick-from-x', `${handX}px`)
            stick.style.setProperty('--stick-from-y', `${handY}px`)
            stick.style.setProperty('--stick-to-x', `${x}px`)
            stick.style.setProperty('--stick-to-y', `${endY}px`)
            stick.style.setProperty('--stick-arc', `cubic-bezier(${1 / 3}, ${2 * arc / 3}, ${2 / 3}, ${(2 * arc + 1) / 3})`)
          }
        }
        projectile.style.setProperty('--boss-projectile-start-x', `${(startX - cardRect.left) / rem}rem`)
        projectile.style.setProperty('--boss-projectile-start-y', `${(startY - cardRect.top) / rem}rem`)
        projectile.style.setProperty('--boss-projectile-x', `${(body.x - startX) / rem}rem`)
        projectile.style.setProperty('--boss-projectile-y', `${((groundImpact ? targetRect.bottom : body.y) - startY) / rem}rem`)
      }
    }
    measure()
    if (bossArtId === 'cultist') onThrowPrepared?.(enemy.uid, 1000)
    const onLaunch = (event: AnimationEvent) => {
      if (event.animationName === 'cultist-stick-flight') cultistLaunched = true
    }
    card.addEventListener('animationstart', onLaunch)
    // Measure this image at the target, after its portrait's capture handler
    // aligns it. Other board images can still update the projectile's target.
    const onLoad = () => measure()
    board.addEventListener('load', onLoad, true)
    board.addEventListener('loadeddata', onLoad, true)
    const removeReady = onCombatArtReady(initialBoss, measure)
    const resize = new ResizeObserver(measure)
    resize.observe(board)
    return () => {
      resize.disconnect()
      board.removeEventListener('load', onLoad, true)
      board.removeEventListener('loadeddata', onLoad, true)
      removeReady()
      card.removeEventListener('animationstart', onLaunch)
    }
  }, [art, bossArtId, bossAttackPlaying, bossProjectileArt, enemy.uid, onThrowPrepared, projectileImpact, rangedTargetKey])
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
    const text = displayedAbilityText(ability, visibleEnemy, def.id, die)
    return `${text}${visibleEnemy.abilityUsed && ability.kind === 'curlUp' ? ', spent' : ''}`
  })
  const hpFraction = visibleEnemy.maxHp === 0 ? 0 : visibleEnemy.hp / visibleEnemy.maxHp
  // Generated rest-canvas width/height for animated and static art, then body height.
  const normalSize = !visibleEnemy.isBoss && !def.elite
    ? (enemyArtSizes as Record<string, number[]>)[currentBossArtId] : undefined
  const sizeOffset = animatedEnemy ? 0 : 2
  // [aspect, top] of the resting art, so an Elite or Boss telegraph can sit on its head.
  const eliteHead = (eliteArtHeads as Record<string, number[]>)[sleeping ? 'lagavulin_sleep' : currentBossArtId]

  const className = [
    'enemy',
    visibleEnemy.dead ? 'enemy--dead' : '',
    falling && visibleEnemy.dead ? 'enemy--falling' : '',
    targeted ? 'enemy--targeted' : '',
    visibleEnemy.isBoss ? 'enemy--boss' : '',
    def.elite || (def.artId ?? def.id) === 'sentry' ? 'enemy--elite' : '',
    bossAttackPlaying ? 'enemy--acting' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const tips: { name: string, text: string }[] = []
  if (!visibleEnemy.dead) for (const label of abilityLabels) {
    const separator = label.indexOf(':')
    const name = separator < 0 ? 'Special effects' : label.slice(0, separator)
    const text = separator < 0 ? label : label.slice(separator + 1).trim()
    const existing = tips.find(tip => tip.name === name)
    if (existing) existing.text += `; ${text}`
    else tips.push({ name, text })
  }
  return (
    <CardKeywordHelp extraTips={tips} hover>{(helpProps) => (
    <button
      {...helpProps}
      ref={(element) => { cardRef.current = element; helpProps.ref?.(element) }}
      type="button"
      className={className}
      data-sfx="enemy"
      data-enemy-id={enemy.uid}
      data-enemy-def={def.id}
      data-boss-act={def.bossAct}
      data-attack-motion={bossAttackMotion}
      data-attack-choreography={enemyAttackAnimationFor(bossArtId)}
      data-boss-art={visibleEnemy.isBoss ? bossArtId : undefined}
      data-enemy-art={bossArtId}
      data-normal-size={normalSize ? true : undefined}
      data-projectile-impact={projectileImpact ? true : undefined}
      data-cultist-cover={timedCultist && bossAttackPlaying && cultistCoverReady || undefined}
      data-animation={animatedEnemy ? bossAttacking ? 'attack' : restTransition ? 'transition' : 'idle' : 'static'}
      data-sleeping={sleeping || undefined}
      data-webmcp-pending={stageVisualDamage && visualSignature !== JSON.stringify(visibleEnemy) || undefined}
      data-row={enemy.row}
      style={{
        '--stage-index': stageIndex,
        '--enemy-attack-motion': enemyAttackAnimationFor(bossArtId),
        '--boss-contact-left': bossAttackContactLeft,
        '--animation-art-scale': enemyArtScaleFor(bossArtId),
        '--normal-canvas-width': normalSize?.[sizeOffset],
        '--normal-canvas-height': normalSize?.[sizeOffset + 1],
        '--normal-body-height': normalSize?.[4],
        '--elite-art-aspect': eliteHead?.[sizeOffset],
        '--elite-art-top': eliteHead?.[sizeOffset + 1],
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
      {bossAttackPlaying && ['sentry', 'giant_head'].includes(bossArtId) ? (
        <span className="elite-attack-effect" aria-hidden="true" />
      ) : null}
      {bossAttackPlaying && bossProjectileArt ? rangedTargetPlayerIds.map((playerId) => (
        <span className="boss-projectile" data-target-player={playerId} key={playerId} aria-hidden="true"
          onAnimationStart={event => {
            if (event.animationName === 'cultist-stick-flight') onThrowStart?.(enemy.uid)
          }}>
          {bossArtId === 'cultist' ? <>
            <span className="cultist-stick"><img src={bossProjectileArt} alt="" /></span>
            <span className="cultist-stick"><img src={bossProjectileArt} alt="" /></span>
          </> : <img src={bossProjectileArt} alt="" />}
        </span>
      )) : null}

      {bossAttackPlaying && projectileImpact ? rangedTargetPlayerIds.map(playerId => (
        <span className="enemy-projectile-impact" data-target-player={playerId} key={playerId} aria-hidden="true"
          data-impact-anchor={projectileImpact.endsWith('/turn-poison-impact.webp') ? 'feet' : undefined}>
          <img src={projectileImpact} alt="" />
        </span>
      )) : null}

      {(visibleEnemy.slayerAttachments ?? []).map((entry) => (
        <span key={entry.card.uid} className="enemy__attachment" data-slayer-attachment={entry.card.defId}
          title={`${faceOf(cardDef(entry.card.defId), entry.card.upgraded).name}: ${
            cardRuleDescription(faceOf(cardDef(entry.card.defId), entry.card.upgraded))}`}>
          <img src={cardThumbPath(cardDef(entry.card.defId), entry.card.upgraded)} alt=""
            onLoad={(event) => revealDecodedImage(event.currentTarget)}
            onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
          <span>{faceOf(cardDef(entry.card.defId), entry.card.upgraded).name}</span>
        </span>
      ))}
      {visibleEnemy.corpseExplosion ? (
        <span className="enemy__attachment" title={`Corpse Explosion · ${visibleEnemy.corpseExplosion.damage} row damage on death`}>
          <img src={cardThumbPath(cardDef(visibleEnemy.corpseExplosion.card.defId), visibleEnemy.corpseExplosion.card.upgraded)} alt=""
            onLoad={(event) => revealDecodedImage(event.currentTarget)}
            onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
          <span>Corpse Explosion · {visibleEnemy.corpseExplosion.damage}</span>
        </span>
      ) : null}

      <span className="enemy__portrait" onAnimationStart={event => {
        if (!signatureAttack || !bossAttackPlaying || bossAttackTimer.current ||
          !(event.target instanceof HTMLElement) || event.target.dataset.animationLayer !== 'attack') return
        onThrowStart?.(enemy.uid)
        bossAttackTimer.current = setTimeout(finishBossAttack, bossAttackDurationFor(bossArtId))
      }}>
        <span className="enemy__hit-area" aria-hidden="true" />
        {sleeping ? <span className="enemy-sleep-zzz" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></span> : null}
        {bossAttackPlaying && bossArtId === 'gremlin_leader' ? <>
          <span className="gremlin-speed-trail" aria-hidden="true" />
          <span className="gremlin-afterimage gremlin-afterimage--first" aria-hidden="true" />
          <span className="gremlin-afterimage gremlin-afterimage--second" aria-hidden="true" />
          {rangedTargetPlayerIds.map((playerId, index) => <span className="boss-projectile gremlin-delayed-slash"
            data-target-player={playerId} key={playerId} aria-hidden="true"
            onAnimationStart={event => {
              if (index === 0 && event.animationName === 'gremlin-slash-impact') playCombatSound(animationSfxRecipe('sword-clash'))
            }}><span /></span>)}
        </> : null}
        {bossAttackPlaying && bossArtId === 'reptomancer' ?
          <span className="reptomancer-sigil" aria-hidden="true" /> : null}
        {demonAttacking ? <>
          <span className="boss-demon-ground-splat boss-demon-ground-splat--origin" aria-hidden="true" />
          <span className="boss-demon-ground-splat boss-demon-ground-splat--target" aria-hidden="true" />
        </> : null}
        {animatedEnemy ? <>
          {/* Retain the decoded idle across handoffs; Safari native video can paint blank transitions. */}
          {retainIdle ? [...new Set([currentIdleArt, ...(restTransition ? [restTransition.previousSrc] : []),
            ...(previousRestPose.current.resetKey === visualResetKey && restTransitionName ? [previousIdleArt] : [])])].map(source => <CombatAnimation
            key={source}
            className="enemy__art--cutout"
            src={source}
            forceWebp
            style={{ animation: 'none' }}
            data-animation-layer="idle"
            data-inactive={bossAttackPlaying || (restTransition ? source !== restTransition.previousSrc || restTransition.playing : false) || undefined}
            data-animation-asset={source}
            loading={visibleEnemy.isBoss || restTransition ? 'eager' : 'lazy'}
            onReady={image => {
              decodedIdleArts.current.add(image)
              if (source === currentIdleArt) setIdleReadySource(source)
            }}
            onError={onArtError}
          />) : null}
          {!retainIdle || bossAttacking || restTransition?.ready && (!restTransition.finished || restTransition.playing) ? <CombatAnimation
            key={`${bossArtId}-${bossAttacking ? 'attack' : restTransition?.key ?? restPose}`}
            className="enemy__art--cutout"
            src={art}
            data-animation-layer={bossAttacking ? 'attack' : restTransition ? 'transition' : 'idle'}
            data-inactive={retainIdle && (bossAttacking ? !bossAttackPlaying : restTransition ? !restTransition.playing : true) || undefined}
            posterSrc={!retainIdle && (!useSafariCombatRendering || timedCultist) && bossAttacking ? currentIdleArt : undefined}
            forceWebp={useSafariCombatRendering}
            loop={!bossAttacking && !restTransition}
            data-animation-asset={bossAttacking ? presentedBossAttack?.source : restTransition?.source ?? art}
            loading={visibleEnemy.isBoss || bossAttacking || restTransition ? 'eager' : 'lazy'}
            onReady={() => {
              if (!bossAttacking && restTransition?.ready && !restTransition.finished && !restTransitionTimer.current) {
                setRestTransition(current => current ? { ...current, playing: true } : null)
                restTransitionTimer.current = setTimeout(() => {
                  restTransitionTimer.current = null
                  setRestTransition(current => current ? { ...current, finished: true } : null)
                }, 800)
              }
              if (!bossAttackRequested || !bossAttacking || bossAttackTimer.current) return
              if (timedCultist) onThrowPrepared?.(enemy.uid, 1800)
              if (!timedCultist && !signatureAttack) bossAttackTimer.current = setTimeout(finishBossAttack, bossAttackDurationFor(bossArtId))
              setBossAttackReady(true)
            }}
            onError={event => {
              if (!bossAttacking && restTransition) setRestTransition(current => current ? { ...current, playing: false, finished: true } : null)
              else onArtError(event)
            }}
          /> : null}
          {bossAttackPlaying && bossArtId === 'reptomancer' ? <span className="reptomancer-channel" aria-hidden="true">
            <span className="reptomancer-charge" />
          </span> : null}
          {timedCultist && bossAttacking && !cultistCoverFailed ? <img
            className="enemy__art--cutout cultist-release-cover"
            src={assetPath('combat/enemies/animated/cultist-released.webp')}
            data-animation-layer="release-cover"
            alt=""
            aria-hidden="true"
            loading="eager"
            onError={() => setCultistCoverFailed(true)}
          /> : null}
        </> : <img
          key={`${def.artId ?? def.id}-static`}
          className="enemy__art--cutout"
          src={art}
          alt=""
          loading={visibleEnemy.isBoss ? 'eager' : 'lazy'}
          onError={(event) => { event.currentTarget.style.display = 'none' }}
        />}
        {demonAttacking ? <img
          className="boss-demon-grounded"
          src={assetPath('combat/rigged/downfall_demon-ground-slam.webp')}
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
        {bulletNumbers.map(number => (
          <span key={number.id} className="hermit-damage-number" aria-hidden="true"
            data-damage={number.damage} style={{ left: number.x, top: number.y,
              '--damage-x': `${number.id % 2 ? -1.2 : 1.2}rem` } as CSSProperties}>
            {Number(number.damage.toFixed(3))}
          </span>
        ))}
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
          {Number(visibleEnemy.hp.toFixed(3))}/{visibleEnemy.maxHp}
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
    )}</CardKeywordHelp>
  )
}
