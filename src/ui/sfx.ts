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

const HALLWAY_TRACKS: Record<number, readonly string[]> = {
  1: [assetPath('bgm/exordium.mp3'), assetPath('bgm/battle-trance.mp3')],
  2: [assetPath('bgm/the-city.mp3'), assetPath('bgm/escape-plan.mp3')],
  3: [assetPath('bgm/dramatic-entrance.mp3'), assetPath('bgm/the-beyond.mp3')],
  4: [assetPath('bgm/the-ending.mp3')],
}

const ELITE_TRACK = assetPath('bgm/facing-the-elite.mp3')

type MusicCombat = { combatId: string; phase: string; enemies: readonly { defId: string; ascension?: number; actionIndex?: number; isBoss: boolean }[] }
type MusicRun = { act: number; combat?: MusicCombat | null }

function hallwayTrack(act: number, combatId: string) {
  const tracks = HALLWAY_TRACKS[act]
  if (!tracks) return
  const hash = [...combatId].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0)
  return tracks[hash % tracks.length]
}

function combatTrack(run?: MusicRun | null) {
  const combat = run?.combat
  if (!combat || combat.phase === 'won' || combat.phase === 'lost') return
  const boss = combat.enemies.find((enemy) => enemy.isBoss)
  const act = boss && enemyDef(boss.defId, boss.ascension).bossAct
  if (act) return BOSS_TRACKS[act]
  const lagavulin = combat.enemies.find((enemy) => enemy.defId === 'lagavulin')
  const lagavulinDef = lagavulin && enemyDef(lagavulin.defId, lagavulin.ascension)
  const sleeping = lagavulinDef?.pattern.kind === 'cube' &&
    lagavulinDef.pattern.slots[lagavulin!.actionIndex ?? 0]?.actions.some((action) => action.kind === 'idle')
  return lagavulin && !sleeping ? ELITE_TRACK : hallwayTrack(run.act, combat.combatId)
}

/** Loop the original game's act theme while combat is active. */
export function useCombatMusic(run?: MusicRun | null, enabled = true, volume = 20) {
  const track = enabled ? combatTrack(run) : undefined
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
  combatWinDelayMs = 0,
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
    const delayedWin = outcome === 'win' && run?.combat?.phase === 'won' && combatWinDelayMs > 0
    const timer = !restored && outcome && outcome !== previous.current && delayedWin
      ? window.setTimeout(() => {
          playSoundEffect(outcome)
          previous.current = outcome
        }, combatWinDelayMs)
      : undefined
    if (!restored && outcome && outcome !== previous.current && !delayedWin) {
      playSoundEffect(outcome)
      previous.current = outcome
    } else if (restored || !outcome) previous.current = outcome
    previousRestoration.current = restoration
    previousConnected.current = connected
    return () => { if (timer !== undefined) window.clearTimeout(timer) }
  }, [combatWinDelayMs, connected, outcome, restoration, run?.combat?.phase])
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

const IMPACT_SOUNDS = new Set(['attack', 'enemy', 'block', 'weak'])

export function playCombatSound(recipe: CombatSfxRecipe, impactDelayMs = 0, impactsOnly = false): () => void {
  if (currentSfxVolume() === 0) return () => {}
  const timers: number[] = []
  recipe.layers.forEach((layer) => {
    if (impactsOnly && (layer.delayMs > 0 || !IMPACT_SOUNDS.has(layer.sound))) return
    const delayMs = layer.delayMs || !IMPACT_SOUNDS.has(layer.sound) ? layer.delayMs : impactDelayMs
    const play = () => {
      if (currentSfxVolume() > 0) {
        playSound(layer.sound, layer.volume, layer.rate, recipe.cue, delayMs)
      }
    }
    if (delayMs > 0) timers.push(window.setTimeout(play, delayMs))
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
