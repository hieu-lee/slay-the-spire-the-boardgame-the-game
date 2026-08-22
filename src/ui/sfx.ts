import { useEffect, useRef } from 'react'
import { assetPath } from '../game/assets.ts'
import { enemyDef } from '../game/enemies.ts'
import type { CombatSfxRecipe } from './combat-sfx.ts'
import { currentSfxVolume, SFX_STORAGE_KEY } from './game-settings.ts'

export { SFX_STORAGE_KEY }

const SOUNDS = {
  ui: assetPath('sfx/ui.ogg'),
  card: assetPath('sfx/card.ogg'),
  draw: assetPath('sfx/draw.ogg'),
  attack: assetPath('sfx/attack.ogg'),
  magic: assetPath('sfx/magic.ogg'),
  enemy: assetPath('sfx/enemy-hit.ogg'),
  hurt: assetPath('sfx/player-hit.ogg'),
  block: assetPath('sfx/block.ogg'),
  heal: assetPath('sfx/heal.ogg'),
  weak: assetPath('sfx/weak.ogg'),
  win: assetPath('sfx/victory.ogg'),
  lose: assetPath('sfx/defeat.ogg'),
} as const

type Sound = keyof typeof SOUNDS

const BOSS_TRACKS = {
  1: assetPath('bgm/the-guardian-emerges.mp3'),
  2: assetPath('bgm/battle-with-the-champ.mp3'),
  3: assetPath('bgm/the-awakened-one.mp3'),
  4: assetPath('bgm/the-heart.mp3'),
} as const

type BossCombat = { phase: string; enemies: readonly { defId: string; ascension?: number; isBoss: boolean }[] }

function bossTrack(combat?: BossCombat | null) {
  if (!combat || combat.phase === 'won' || combat.phase === 'lost') return
  const boss = combat.enemies.find((enemy) => enemy.isBoss)
  const act = boss && enemyDef(boss.defId, boss.ascension).bossAct
  return act ? BOSS_TRACKS[act] : undefined
}

/** Loop the appropriate act theme while a boss combat is active. */
export function useBossFightMusic(combat?: BossCombat | null, enabled = true, volume = 20) {
  const track = enabled ? bossTrack(combat) : undefined
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!track) return
    const next = new Audio(track)
    audio.current = next
    next.loop = true
    next.volume = volume / 100
    void next.play().catch(() => {})
    return () => {
      next.pause()
      if (audio.current === next) audio.current = null
    }
  }, [track])

  useEffect(() => {
    if (audio.current) audio.current.volume = volume / 100
  }, [volume])
}

export function useRunOutcomeSound(
  run?: { phase: string; combat?: { phase: string } | null } | null,
  restoration?: number,
  connected = true,
) {
  const outcome = run?.phase === 'defeat' || run?.combat?.phase === 'lost'
    ? 'lose'
    : run?.phase === 'victory' || run?.combat?.phase === 'won' ? 'win' : null
  const previous = useRef(outcome)
  const previousRestoration = useRef(restoration)
  const previousConnected = useRef(connected)

  useEffect(() => {
    const restored = restoration !== undefined && restoration !== previousRestoration.current ||
      !connected || !previousConnected.current
    if (!restored && outcome && outcome !== previous.current) playSoundEffect(outcome)
    previous.current = outcome
    previousRestoration.current = restoration
    previousConnected.current = connected
  }, [connected, outcome, restoration])
}

export function installSoundEffects() {
  function play(event: Event) {
    const target = event.target instanceof Element ? event.target : null
    const control = event.type === 'change'
      ? target?.closest('input, select, textarea')
      : target?.closest('button, summary, a[href]')
    if (!control || control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true' || control.closest('[inert]')) return
    const sound = control.getAttribute('data-sfx') as Sound | 'none' | null
    if (sound === 'none') return
    playSound(sound && sound in SOUNDS ? sound : 'ui')
  }

  document.addEventListener('click', play)
  document.addEventListener('change', play)
  return () => {
    document.removeEventListener('click', play)
    document.removeEventListener('change', play)
  }
}

export function playSoundEffect(sound: Sound) {
  if (currentSfxVolume() === 0) return
  playSound(sound)
}

export function playCombatSound(recipe: CombatSfxRecipe): () => void {
  if (currentSfxVolume() === 0) return () => {}
  const timers: number[] = []
  recipe.layers.forEach((layer) => {
    const play = () => {
      if (currentSfxVolume() > 0) {
        playSound(layer.sound, layer.volume, layer.rate, recipe.cue, layer.delayMs)
      }
    }
    if (layer.delayMs > 0) timers.push(window.setTimeout(play, layer.delayMs))
    else play()
  })
  return () => timers.forEach((timer) => window.clearTimeout(timer))
}

function playSound(sound: Sound, volume = 0.35, rate = 1, cue?: string, delayMs = 0) {
  const audio = new Audio(SOUNDS[sound])
  audio.volume = volume * currentSfxVolume()
  audio.playbackRate = rate
  audio.preservesPitch = false
  if (cue) audio.dataset.combatSfx = cue
  if (delayMs) audio.dataset.combatSfxDelay = String(delayMs)
  void audio.play().catch(() => {})
}
