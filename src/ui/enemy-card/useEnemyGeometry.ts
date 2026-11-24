import { useLayoutEffect, type RefObject } from 'react'
import { combatArtBounds, combatBodyPoint } from '../combat-geometry.ts'
import { enemyArtScaleFor, enemyProjectileOriginFor } from '../combat-vfx.ts'
import {
  combatArtReady,
  combatArtSize,
  onCombatArtReady,
  type CombatArtElement,
} from '../CombatAnimation.tsx'
import enemyFootAnchors from '../enemy-foot-anchors.json'

export function useEnemyGeometry({
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
  heavyKind,
  enemyUid,
  rangedTargetKey,
  onThrowPrepared,
}: {
  cardRef: RefObject<HTMLButtonElement | null>
  art: string
  animatedEnemy: boolean
  bossArtId: string
  bossAttacking: boolean
  bossAttackPlaying: boolean
  bossAttackMotion: 'melee' | 'ranged'
  bossAttackContactLeft: number
  bossProjectileArt?: string
  projectileImpact?: string
  heavyKind?: string
  enemyUid: string
  rangedTargetKey: string
  onThrowPrepared?: (enemyUid: string, arrivalWithinMs: number) => void
}) {
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
        const contactY = bossRect.bottom - (500 - 460) * imageScale
        const targetY = Math.max(...heroRects.map((rect) => rect.bottom - rect.height * .08))
        card.style.setProperty('--boss-dash-y', `${(targetY - contactY) / rem}rem`)
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
    if (!card || !bossAttackPlaying || !bossProjectileArt && !heavyKind && bossArtId !== 'gremlin_leader') return
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
      // Charge effects wrap the painted body at rest; later measures would include the dash.
      const portrait = card.querySelector<HTMLElement>('.enemy__portrait')
      const heavyCharge = portrait?.querySelector<HTMLElement>('.boss-heavy-charge')
      if (portrait && heavyCharge && !heavyCharge.dataset.anchored) {
        const painted = combatArtBounds(portrait)
        const frame = portrait.getBoundingClientRect()
        for (const [name, value] of Object.entries({
          left: painted.left - frame.left, top: painted.top - frame.top, width: painted.width, height: painted.height,
        })) heavyCharge.style.setProperty(`--body-${name}`, `${value / rem}rem`)
        heavyCharge.dataset.anchored = 'true'
      }
      for (const projectile of card.querySelectorAll<HTMLElement>('.boss-projectile, .enemy-projectile-impact, .boss-heavy-target')) {
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
        projectile.style.setProperty('--boss-heavy-length', `${Math.hypot(body.x - startX, body.y - startY) / rem}rem`)
        projectile.style.setProperty('--boss-heavy-angle', `${Math.atan2(body.y - startY, body.x - startX)}rad`)
      }
    }
    measure()
    if (bossArtId === 'cultist') onThrowPrepared?.(enemyUid, 1000)
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
  }, [art, bossArtId, bossAttackPlaying, bossProjectileArt, enemyUid, heavyKind, onThrowPrepared, projectileImpact, rangedTargetKey])
}
