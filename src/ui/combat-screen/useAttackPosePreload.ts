import { useEffect, useRef, useState } from 'react'
import { assetPath } from '../../game/assets.ts'
import type { CombatPresentationEvent, CombatState } from '../../game/combat.ts'
import { playerVisualId, type VisualId } from '../../game/skins.ts'
import type { Player } from '../../game/types.ts'
import { combatVideoPath, preloadCombatVideo, useSafariCombatVideo } from '../CombatAnimation.tsx'
import { isMonogatariVisual, monogatariPoseAsset } from './portraits.tsx'
import type { StagedAttackSpec } from './staged-attacks.ts'
import type { ActiveCombatVfx } from './types.ts'
import { isStagedAttackAsset, stagedAttackAssets, stagedAttackOf, stagedPoseAsset } from './vfx.tsx'

export type MonogatariEvokeLatch = {
  ready: boolean
  bornAt: number
  holdCast: boolean
  actorId: string
}

export function useAttackPosePreload({
  combatId,
  players,
  prefersReducedMotion,
  activeVfx,
}: {
  combatId: CombatState['combatId']
  players: readonly Player[]
  prefersReducedMotion: boolean
  activeVfx: readonly ActiveCombatVfx[]
}) {
  const [characterAttackBlobs, setCharacterAttackBlobs] = useState<Map<string, Blob | true>>(() => new Map())

  // Each staged attack decides once whether its registered drawings were decoded in time.
  // The pose layer and the travel share that answer, so the idle fallback never parks at blade reach.
  // Presentation seqs restart each combat, so the combat id is part of the key.
  const stagedPosesReadyByAttack = useRef(new Map<string, boolean>())
  const stagedPosesReady = (visual: VisualId, spec: StagedAttackSpec, seq: number) => {
    const key = `${combatId}:${seq}`
    const latched = stagedPosesReadyByAttack.current.get(key)
    if (latched !== undefined) return latched
    const ready = spec.poses.every(pose => characterAttackBlobs.has(stagedPoseAsset(visual, pose)))
    stagedPosesReadyByAttack.current.set(key, ready)
    return ready
  }

  const stagedAssetsOf = (player: Player) => {
    const spec = stagedAttackOf(playerVisualId(player))
    return spec && stagedAttackAssets(playerVisualId(player), spec)
  }

  // Pose and cast origin share a latch: late artwork never re-aims a cold projectile.
  const monogatariPosesReadyByAttack = useRef(new Map<string, boolean>())
  const monogatariPosesReady = (visual: string, seq: number) => {
    const key = `${combatId}:${seq}`
    const latched = monogatariPosesReadyByAttack.current.get(key)
    if (latched !== undefined) return latched
    const poses = visual === 'monogatari_ironclad' ? ['hero', 'ready', 'impact'] : ['hero', 'charge', 'release']
    const ready = poses.every(pose => characterAttackBlobs.has(monogatariPoseAsset(visual, pose)))
    monogatariPosesReadyByAttack.current.set(key, ready)
    return ready
  }

  const monogatariEvokesReadyByEvent = useRef(new Map<string, MonogatariEvokeLatch>())
  const monogatariEvokeReady = (event: Extract<CombatPresentationEvent, { kind: 'orb' }>) => {
    const key = `${combatId}:${event.seq}`
    const latched = monogatariEvokesReadyByEvent.current.get(key)
    if (latched !== undefined) return latched.ready
    const ready = ['hero', 'release'].every(pose =>
      characterAttackBlobs.has(monogatariPoseAsset('monogatari_defect', pose))) &&
      characterAttackBlobs.has(assetPath(`combat/vfx/actions/${event.orb}-channel.webp`))
    const bornAt = performance.now()
    // A queued focus must not retract the hand beneath an older, still-live beam.
    const holdCast = [...monogatariEvokesReadyByEvent.current].some(([olderKey, older]) =>
      olderKey.startsWith(`${combatId}:`) && older.actorId === event.actorId && older.ready &&
      bornAt - older.bornAt > 16 && bornAt - older.bornAt < 760)
    monogatariEvokesReadyByEvent.current.set(key, { ready, bornAt, holdCast, actorId: event.actorId })
    return ready
  }

  const characterAttackAssets = prefersReducedMotion ? '' : [...new Set(players.filter((player) => !player.dead).flatMap((player) =>
    stagedAssetsOf(player)
      ?? (isMonogatariVisual(playerVisualId(player))
        ? [...['hero', ...(player.character === 'ironclad' ? ['ready', 'impact'] : ['charge', 'release'])]
          .map(pose => monogatariPoseAsset(playerVisualId(player), pose)),
          ...(player.character === 'defect' ? ['lightning', 'dark']
            .map(orb => assetPath(`combat/vfx/actions/${orb}-channel.webp`)) : [])]
      : player.character === 'hexaghost'
      ? [assetPath(`combat/rigged/hero-hexaghost-heat-${Math.max(0, Math.min(6, player.heat))}-attack.webp`)]
      : player.character === 'guardian'
        ? ['guardian', 'guardian-defense'].map((id) => assetPath(`combat/rigged/hero-${id}-attack.webp`))
        : player.character === 'watcher' || player.character === 'ironclad'
          ? ['ready', player.character === 'watcher' ? 'thrust' : 'impact']
            .map((pose) => assetPath(`combat/characters/${player.character}-${pose}.webp`))
          : [assetPath(`combat/rigged/hero-${player.character}-attack.webp`),
            ...(player.character === 'hermit' ? ['hermit-bullet', 'hermit-impact'].map(name => assetPath(`combat/vfx/actions/${name}.webp`)) : [])])))].sort().join('|')

  useEffect(() => {
    const controller = new AbortController()
    const assets = characterAttackAssets.split('|').filter(Boolean)
    if (useSafariCombatVideo) {
      setCharacterAttackBlobs((current) => new Map(assets
        .filter((src) => current.has(src))
        .map((src) => [src, current.get(src)!])))
      const cancels = assets.filter((src) => !characterAttackBlobs.has(src)).map((src) => {
        const video = combatVideoPath(src)
        if (video !== src) return preloadCombatVideo(video, success => {
          if (success && !controller.signal.aborted) setCharacterAttackBlobs((current) => new Map(current).set(src, true))
        })
        const image = new Image()
        image.src = src
        void image.decode().then(() => {
          if (!controller.signal.aborted) setCharacterAttackBlobs((current) => new Map(current).set(src, true))
        }, () => undefined)
        return () => { image.src = '' }
      })
      return () => { controller.abort(); cancels.forEach(cancel => cancel()) }
    }
    setCharacterAttackBlobs((current) => new Map(assets
      .filter((src) => current.has(src))
      .map((src) => [src, current.get(src)!])))
    void Promise.all(assets.filter((src) => !characterAttackBlobs.has(src)).map(async (src) => {
      try {
        if (isStagedAttackAsset(src) || src.includes('/characters/monogatari_') ||
          /\/(lightning|dark)-channel\.webp$/.test(src)) {
          const image = new Image()
          image.src = src
          await image.decode()
          return [src, true] as const
        }
        const response = await fetch(src, { signal: controller.signal })
        if (!response.ok) return
        const blob = await response.blob()
        const decodeUrl = URL.createObjectURL(blob)
        try {
          const image = new Image()
          image.src = decodeUrl
          await image.decode?.()
        } finally {
          URL.revokeObjectURL(decodeUrl)
        }
        return [src, blob] as const
      } catch {}
    })).then((loaded) => {
      if (controller.signal.aborted) return
      const ready = loaded.filter((entry): entry is readonly [string, Blob | true] => Boolean(entry))
      if (ready.length) setCharacterAttackBlobs((current) => new Map([...current, ...ready]))
    })
    return () => controller.abort()
  }, [characterAttackAssets])

  useEffect(() => {
    const running = new Set(activeVfx.filter(({ event }) => event.kind === 'orb' && event.sourceId === 'orb-evoke')
      .map(({ event }) => `${combatId}:${event.seq}`))
    for (const key of monogatariEvokesReadyByEvent.current.keys()) {
      if (prefersReducedMotion || !running.has(key)) monogatariEvokesReadyByEvent.current.delete(key)
    }
  }, [activeVfx, prefersReducedMotion, combatId])

  return {
    characterAttackBlobs,
    characterAttackAssets,
    stagedPosesReadyByAttack,
    stagedPosesReady,
    monogatariPosesReadyByAttack,
    monogatariPosesReady,
    monogatariEvokesReadyByEvent,
    monogatariEvokeReady,
  }
}
