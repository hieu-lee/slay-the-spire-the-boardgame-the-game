// Character attack poses, Guardian stance portrait, slime sprite fallbacks, and flying cards.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { assetPath } from '../../game/assets.ts'
import type { CombatPresentationEvent } from '../../game/combat.ts'
import type { VisualId } from '../../game/skins.ts'
import { Card } from '../Card.tsx'
import { CombatAnimation, useSafariCombatVideo } from '../CombatAnimation.tsx'
import { animateCardFlight } from './card-flight.ts'
import type { StagedAttackSpec } from './staged-attacks.ts'
import type { ActiveCombatVfx, CardFlight } from './types.ts'
import { HermitBullets, stagedIdleAsset, stagedPoseAsset } from './vfx.tsx'

export const isMonogatariVisual = (visual: string | undefined) =>
  visual === 'monogatari_ironclad' || visual === 'monogatari_defect'

export const monogatariPoseAsset = (visual: string, pose: string) =>
  assetPath(`combat/characters/${visual}-${pose}.webp`)

export const slimeAssetSlug = (defId: string): string => defId
  .replace(/^slime_boss_/, '')
  .replace(/_slime$/, '')
  .replace(/_/g, '-')

export const slimeFallbackAsset = (defId: string): string => {
  if (defId.includes('spike')) return 'combat/enemies/spike_slime.webp'
  if (defId.includes('massive') || defId.includes('armored') || defId.includes('royal')) {
    return 'combat/enemies/large_slime.webp'
  }
  if (defId.includes('leeching') || defId.includes('sticky') || defId.includes('spreading')) {
    return 'combat/enemies/acid_slime.webp'
  }
  return 'combat/enemies/small_slime.webp'
}

export const CharacterAttackPose = memo(function CharacterAttackPose({ asset, assetPath: sourceAsset, fallbackAsset, attackSeq, hermitEvent, firing = true }: {
  asset?: Blob | true
  assetPath: string
  fallbackAsset: string
  attackSeq: number
  hermitEvent?: ActiveCombatVfx['event']
  firing?: boolean
}) {
  const [replayAsset] = useState(asset)
  const sourceFallback = useSafariCombatVideo && !replayAsset
  const [src, setSrc] = useState<string | undefined>(() => replayAsset === true || sourceFallback
    ? sourceAsset : replayAsset ? undefined : fallbackAsset)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!(replayAsset instanceof Blob)) return
    const url = URL.createObjectURL(replayAsset)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [replayAsset])
  if (!src) return null
  const logicalSrc = replayAsset ? sourceAsset : fallbackAsset
  return (
    <span
      className={['character-attack__pose', 'character-attack__pose--rig',
        replayAsset || sourceFallback ? '' : 'is-fallback', loaded ? 'is-loaded' : ''].filter(Boolean).join(' ')}
      data-attack-asset={sourceAsset}
      data-attack-seq={attackSeq}
    >
      <CombatAnimation
        src={sourceFallback ? sourceAsset : logicalSrc}
        mediaSrc={replayAsset instanceof Blob ? src : undefined}
        forceWebp={sourceFallback}
        loop={!replayAsset}
        hidden={!firing}
        onReady={() => setLoaded(true)}
      />
      {loaded && (replayAsset || sourceFallback) && hermitEvent ? <HermitBullets event={hermitEvent} /> : null}
    </span>
  )
})

// Complete registered drawings share the travel/impact clock, including WebKit.
export const StagedAttackPose = memo(function StagedAttackPose({ visual, spec, ready }: { visual: VisualId; spec: StagedAttackSpec; ready: boolean }) {
  return ready ? <>{spec.poses.map(pose => (
    <span key={pose} className={`character-attack__pose character-attack__pose--rig is-loaded character-attack__pose--${visual}-${pose}`}>
      <img src={stagedPoseAsset(visual, pose)} alt="" />
    </span>
  ))}</> : <span className="character-attack__pose character-attack__pose--rig is-loaded is-fallback">
    <CombatAnimation src={stagedIdleAsset(visual)} />
  </span>
})

export const MonogatariAttackPose = memo(function MonogatariAttackPose({ visual, ready }: { visual: string; ready: boolean }) {
  const poses = visual === 'monogatari_ironclad' ? ['ready', 'impact'] : ['charge', 'release']
  return <>
    <span className={`character-attack__pose character-attack__pose--rig is-loaded ${ready ? 'monogatari-pose--idle' : 'is-fallback'}`}>
      <img src={ready ? monogatariPoseAsset(visual, 'hero') : assetPath(`combat/characters/animated/${visual}-idle.webp`)} alt="" />
    </span>
    {ready ? poses.map(pose => <span key={pose} className={`character-attack__pose character-attack__pose--rig is-loaded monogatari-pose--${pose}`}>
      <img src={monogatariPoseAsset(visual, pose)} alt="" />
    </span>) : null}
  </>
})

export const MonogatariEvokePose = memo(function MonogatariEvokePose({ event, holdCast }: {
  event: Extract<CombatPresentationEvent, { kind: 'orb' }>
  holdCast: boolean
}) {
  const root = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)
  const [settled, setSettled] = useState(false)
  const checkMountedImages = () => {
    // These assets are already predecoded, but newly mounted DOM images can
    // still need a load event before acquiring their intrinsic dimensions.
    const images = root.current?.querySelectorAll('img')
    if (images?.length && [...images].every(image => image.complete && image.naturalWidth > 0)) setReady(true)
  }
  useLayoutEffect(checkMountedImages, [])
  if (settled) return null
  return <span ref={root} onLoadCapture={checkMountedImages}
    className={`monogatari-evoke${ready ? ' is-loaded' : ''}${holdCast ? ' monogatari-evoke--holding-cast' : ''}`}
    data-evoke-pose-seq={event.seq} data-evoke-hold-cast={holdCast} aria-hidden="true">
    {(['focus', 'cast', 'recover'] as const).map(phase => <span key={phase}
      onAnimationEnd={phase === 'recover' ? () => setSettled(true) : undefined}
      className={`character-attack__pose monogatari-evoke__pose--${phase}`} data-evoke-phase={phase}>
      <img src={monogatariPoseAsset('monogatari_defect', phase === 'cast' || phase === 'focus' && holdCast ? 'release' : 'hero')} alt="" />
    </span>)}
    {(['focus', 'cast'] as const).map(phase => <img key={phase}
      className={`monogatari-evoke__orb monogatari-evoke__orb--${phase}`}
      data-evoke-orb={event.orb} data-evoke-orb-phase={phase}
      src={assetPath(`combat/vfx/actions/${event.orb}-channel.webp`)} alt="" />)}
  </span>
})

export const GuardianPortrait = memo(function GuardianPortrait({ mode, animate, restartKey }: {
  mode: 'attack' | 'defense'
  animate: boolean
  restartKey: number | string
}) {
  const previousMode = useRef(mode)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [transition, setTransition] = useState<'to-attack' | 'to-defense' | null>(null)
  useEffect(() => {
    for (const direction of ['attack', 'defense']) {
      const image = new Image()
      image.src = assetPath(`combat/characters/guardian-to-${direction}.webp`)
    }
    return () => {
      if (transitionTimer.current) clearTimeout(transitionTimer.current)
    }
  }, [])
  useLayoutEffect(() => {
    if (transitionTimer.current) clearTimeout(transitionTimer.current)
    const previous = previousMode.current
    previousMode.current = mode
    if (!animate || previous === mode) {
      setTransition(null)
      return
    }
    setTransition(mode === 'defense' ? 'to-defense' : 'to-attack')
  }, [animate, mode])
  const file = transition
    ? `guardian-${transition}.webp`
    : mode === 'defense' ? 'guardian-defense.webp' : 'guardian-hero.webp'
  const data = {
    'data-guardian-mode': mode,
    'data-guardian-transition': transition ?? undefined,
    'data-vfx-seq': typeof restartKey === 'number' ? restartKey : undefined,
  } as const
  return animate && !transition
    ? <CombatAnimation
        {...data}
        key={mode}
        src={assetPath(`combat/rigged/hero-${mode === 'defense' ? 'guardian-defense' : 'guardian'}-idle.webp`)}
        onError={(image) => { image.style.display = 'none' }}
      />
    : <img
        {...data}
        key={transition ?? mode}
        src={assetPath(`combat/characters/${file}`)}
        alt=""
        onLoad={() => {
          if (!transition) return
          transitionTimer.current = setTimeout(() => setTransition(null), 600)
        }}
        onError={(event) => { event.currentTarget.style.display = 'none' }}
      />
})

export const FlyingCard = memo(function FlyingCard({ flight, character }: { flight: CardFlight; character: string }) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!element.current) return undefined
    const animation = animateCardFlight(element.current, flight.motionFrames)
    return () => animation.cancel()
  }, [flight.beat, flight.motionFrames])
  return <div ref={element}
    className={`card-flight card-flight--${flight.destination} card-flight--${character}`}
  >
    <Card card={flight.card} playable={false} immediateArt />
  </div>
})
