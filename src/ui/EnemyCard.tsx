import { assetPath, enemyAnimationImagePath, enemyImagePath } from '../game/assets.ts'
import { useCardSkins } from './skin-context.tsx'
import { actionsForEnemy, enemyAbilities, enemyAttackBonus, enemyDef } from '../game/enemies.ts'
// Aliased: `hitDamage` is also this component's floating hit-VFX number.
import { attackerModsOfEnemy, hitDamage as swingDamage } from '../game/damage.ts'
import type { Enemy, Player } from '../game/types.ts'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from './Icon.tsx'
import { TokenRow } from './TokenRow.tsx'
import { healthBand } from './board-signals.ts'
import { bossHeavySfxRecipe } from './combat-sfx.ts'
import { playCombatSound } from './sfx.ts'
import { CardKeywordHelp } from './Card.tsx'
import {
  bossAttackContactLeftFor,
  bossAttackDurationFor,
  BOSS_CONTACT_MS,
  BOSS_HEAVY_HIT_GAP_MS,
  bossHeavyArtFor,
  bossHeavyAttackFor,
  enemyArtScaleFor,
  enemyAttackAnimationFor,
  enemyAttackArrivalMsFor,
  enemyProjectileImpactPath,
  bossAttackMotionFor,
  bossProjectileImagePath,
} from './combat-vfx.ts'
import enemyArtSizes from './enemy-art-size.json'
import eliteArtHeads from './elite-art-head.json'
import {
  CombatAnimation,
  combatArtReady,
  useSafariCombatRendering,
  useWebKitCombatRendering,
  type CombatArtElement,
} from './CombatAnimation.tsx'
import {
  describeEnemy,
  displayedAbilityText,
  enemyAbilityTips,
  intentParts,
  withTargets,
} from './enemy-card/intent.ts'
import { EnemyIntentStrip } from './enemy-card/EnemyIntentStrip.tsx'
import { CorpseExplosionAttachment, SlayerAttachments } from './enemy-card/EnemyAttachments.tsx'
import { BossHeavyTargets, EnemyAttackEffects, EnemyPortraitEffects } from './enemy-card/EnemyAttackOverlays.tsx'
import { useEnemyVisuals } from './enemy-card/useEnemyVisuals.ts'
import { useEnemyGeometry } from './enemy-card/useEnemyGeometry.ts'

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
  const skins = useCardSkins()
  const cardRef = useRef<HTMLButtonElement>(null)
  const attackPreload = useRef<{ source: string; blob: Blob } | null>(null)
  const [attackPreloadRevision, setAttackPreloadRevision] = useState(0)
  const bossAttackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [presentedBossAttack, setPresentedBossAttack] = useState<{
    art: string
    artId: string
    source: string
    /** Captured with the swing: resolution advances the rotation and empties the live target list. */
    heavy?: NonNullable<ReturnType<typeof bossHeavyAttackFor>> & { targets: readonly string[] }
  } | null>(null)
  const [awaitingNextEnemyPhase, setAwaitingNextEnemyPhase] = useState(acting)
  const { visibleEnemy, bulletNumbers, visualSignature, resetVisuals } = useEnemyVisuals({
    cardRef,
    enemy,
    acting,
    splitAttackEvents,
    visualContactMs,
    visualEventSeq,
    visualResetKey,
    stageVisualDamage,
    onReset: () => {
      if (bossAttackTimer.current) clearTimeout(bossAttackTimer.current)
      bossAttackTimer.current = null
      setPresentedBossAttack(null)
      setAwaitingNextEnemyPhase(acting)
    },
  })
  const def = enemyDef(visibleEnemy.defId, visibleEnemy.ascension)
  const actualName = enemyDef(enemy.defId, enemy.ascension).name
  const visibleLabel = label.startsWith(actualName) ? `${def.name}${label.slice(actualName.length)}` : label
  const actions = actionsForEnemy(visibleEnemy, die)
  const animatedEnemy = Boolean(animateArt && !visibleEnemy.dead)
  const currentBossArtId = def.artId ?? def.id
  const sleeping = !visibleEnemy.dead && currentBossArtId === 'lagavulin' && actions.length > 0 &&
    actions.every((action) => action.kind === 'idle')
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
      .find((image) => image.dataset.animationAsset === currentIdleArt)
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
      setRestTransition((current) => current ? { ...current, playing: false, finished: true } : null)
      return
    }
    previousRestPose.current = { pose: restPose, resetKey: visualResetKey }
    const name = restTransitionName
    const controller = new AbortController()
    if (name) {
      const source = assetPath(`combat/enemies/animated/${name}.webp`)
      const key = performance.now()
      const previousImage = [...(cardRef.current?.querySelectorAll<CombatArtElement>('[data-animation-layer="idle"]') ?? [])]
        .find((image) => image.dataset.animationAsset === previousIdleArt)
      const previousSource = restTransition && (!previousImage || !decodedIdleArts.current.has(previousImage) || !combatArtReady(previousImage))
        ? restTransition.previousSrc : previousIdleArt
      setRestTransition({ src: previousSource, source, previousSrc: previousSource, key, ready: false })
      void fetch(source, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error('Animation unavailable')
        const blob = await response.blob()
        if (!controller.signal.aborted) setRestTransition({ src: URL.createObjectURL(blob), source, previousSrc: previousSource, key, ready: true })
      }).catch(() => {
        if (!controller.signal.aborted) setRestTransition((current) => current ? { ...current, finished: true } : null)
      })
    } else setRestTransition((current) => current?.finished && idleReadySource !== currentIdleArt ? current : null)
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
    setPresentedBossAttack({ art, artId: currentBossArtId, source: currentBossAttackArt,
      heavy: visibleEnemy.isBoss ? withTargets(bossHeavyAttackFor(def.id, actions), rangedTargetPlayerIds) : undefined })
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
  // Generated rest-canvas width/height for animated and static art, then body height.
  const normalSize = !visibleEnemy.isBoss && !def.elite
    ? (enemyArtSizes as Record<string, number[]>)[currentBossArtId] : undefined
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
  const bossAttackArt = animatedEnemy ? currentBossAttackArt : undefined
  useEffect(() => {
    if (!bossAttackArt) return
    const controller = new AbortController()
    void fetch(bossAttackArt, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return
      const blob = await response.blob()
      if (!controller.signal.aborted) {
        attackPreload.current = { source: bossAttackArt, blob }
        if (currentBossArtId === 'cultist') setAttackPreloadRevision((revision) => revision + 1)
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
  useEffect(() => {
    if (!animatedEnemy || !visibleEnemy.isBoss) return
    for (const path of bossHeavyArtFor(def.id)) {
      const preload = new Image()
      preload.src = path
      void preload.decode().catch(() => undefined)
    }
  }, [animatedEnemy, def.id, visibleEnemy.isBoss])
  const demonAttacking = bossAttackPlaying && bossArtId === 'downfall_demon'
  // A Boss that dies in its own swing (Divinity) still finishes the blow it landed.
  const heavy = animateArt && bossAttackReady && !cancelPendingThrow ? presentedBossAttack?.heavy : undefined
  useEffect(() => {
    if (!heavy) return
    return playCombatSound(bossHeavySfxRecipe(heavy.kind, heavy.hits))
  }, [heavy?.kind, heavy?.hits])
  const bossAttackMotion = animatedEnemy ? bossAttackMotionFor(bossArtId) : 'ranged'
  const bossAttackContactLeft = bossAttackContactLeftFor(bossArtId)
  const bossProjectileArt = bossAttackMotion === 'ranged' ? bossProjectileImagePath(bossArtId) : undefined
  const projectileImpact = enemyProjectileImpactPath(bossArtId)
  const rangedTargetKey = rangedTargetPlayerIds.join('\0')
  useEnemyGeometry({
    cardRef,
    art,
    animatedEnemy,
    bossArtId,
    bossAttacking,
    bossAttackPlaying,
    bossAttackMotion,
    bossAttackContactLeft,
    bossProjectileArt,
    projectileImpact,
    heavyKind: heavy?.kind,
    enemyUid: enemy.uid,
    rangedTargetKey,
    onThrowPrepared,
  })
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

  const tips = enemyAbilityTips(visibleEnemy.dead, abilityLabels)
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
      data-heavy-attack={heavy?.kind}
      data-heavy-hits={heavy?.hits}
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
        '--heavy-contact': `${BOSS_CONTACT_MS}ms`,
        '--heavy-gap': `${BOSS_HEAVY_HIT_GAP_MS}ms`,
      } as CSSProperties}
      disabled={enemy.dead || disabled}
      onClick={() => { if (!enemy.dead) onClick?.(enemy) }}
      aria-label={describeEnemy(visibleEnemy, visibleLabel, intent, abilityLabels, rowLabel)}
    >
      <EnemyIntentStrip dead={visibleEnemy.dead} intent={intent} />
      <EnemyAttackEffects
        bossAttackPlaying={bossAttackPlaying}
        bossArtId={bossArtId}
        bossProjectileArt={bossProjectileArt}
        projectileImpact={projectileImpact}
        rangedTargetPlayerIds={rangedTargetPlayerIds}
        enemyUid={enemy.uid}
        onThrowStart={onThrowStart}
      />
      <SlayerAttachments enemy={visibleEnemy} skins={skins} />
      <BossHeavyTargets targets={heavy?.targets} />
      <CorpseExplosionAttachment enemy={visibleEnemy} skins={skins} />

      <span className="enemy__portrait" onAnimationStart={(event) => {
        if (!signatureAttack || !bossAttackPlaying || bossAttackTimer.current ||
          !(event.target instanceof HTMLElement) || event.target.dataset.animationLayer !== 'attack') return
        onThrowStart?.(enemy.uid)
        bossAttackTimer.current = setTimeout(finishBossAttack, bossAttackDurationFor(bossArtId))
      }}>
        <span className="enemy__hit-area" aria-hidden="true" />
        <EnemyPortraitEffects
          sleeping={sleeping}
          bossAttackPlaying={bossAttackPlaying}
          bossArtId={bossArtId}
          rangedTargetPlayerIds={rangedTargetPlayerIds}
          hasHeavy={Boolean(heavy)}
          animatedEnemy={animatedEnemy}
          demonAttacking={demonAttacking}
        />
        {animatedEnemy ? <>
          {/* Retain the decoded idle across handoffs; Safari native video can paint blank transitions. */}
          {retainIdle ? [...new Set([currentIdleArt, ...(restTransition ? [restTransition.previousSrc] : []),
            ...(previousRestPose.current.resetKey === visualResetKey && restTransitionName ? [previousIdleArt] : [])])].map((source) => <CombatAnimation
            key={source}
            className="enemy__art--cutout"
            src={source}
            forceWebp={useSafariCombatRendering}
            style={{ animation: 'none' }}
            data-animation-layer="idle"
            data-inactive={bossAttackPlaying || (restTransition ? source !== restTransition.previousSrc || restTransition.playing : false) || undefined}
            data-animation-asset={source}
            loading={visibleEnemy.isBoss || restTransition ? 'eager' : 'lazy'}
            onReady={(image) => {
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
                setRestTransition((current) => current ? { ...current, playing: true } : null)
                restTransitionTimer.current = setTimeout(() => {
                  restTransitionTimer.current = null
                  setRestTransition((current) => current ? { ...current, finished: true } : null)
                }, 800)
              }
              if (!bossAttackRequested || !bossAttacking || bossAttackTimer.current) return
              if (timedCultist) onThrowPrepared?.(enemy.uid, 1800)
              if (!timedCultist && !signatureAttack) bossAttackTimer.current = setTimeout(finishBossAttack, bossAttackDurationFor(bossArtId))
              setBossAttackReady(true)
            }}
            onError={(event) => {
              if (!bossAttacking && restTransition) setRestTransition((current) => current ? { ...current, playing: false, finished: true } : null)
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
          <span className="enemy__name">{visibleLabel}</span>
        </span>
        {bulletNumbers.map((number) => (
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
