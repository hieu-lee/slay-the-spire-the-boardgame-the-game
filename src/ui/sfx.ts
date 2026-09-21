import { useEffect, useRef } from 'react'
import { assetPath } from '../game/assets.ts'
import { enemyDef } from '../game/enemies.ts'
import { ANIMATION_SOUND_VOLUMES, type AnimationSound, type CombatSfxRecipe } from './combat-sfx.ts'
import { combatOutcomeAnimationActive } from './combat-screen/vfx.tsx'
import { currentSfxVolume, SFX_STORAGE_KEY } from './game-settings.ts'

export { SFX_STORAGE_KEY }

const SOUNDS = {
  ...Object.fromEntries(Object.keys(ANIMATION_SOUND_VOLUMES).map(sound => [sound, assetPath(`sfx/${sound}.mp3`)])) as Record<AnimationSound, string>,
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
const activeEffects = new Set<HTMLAudioElement>()
const vodAudio = new Set<HTMLAudioElement>()
const vodAudioNodes = new Map<HTMLAudioElement, MediaElementAudioSourceNode>()
let vodAudioContext: AudioContext | null = null
let vodAudioDestination: MediaStreamAudioDestinationNode | null = null
let vodAudioClock: OscillatorNode | null = null
let vodAudioMuted = false
export type RunVodAudioCue = { source: string; at: number; end?: number; volume: number; rate: number; loop: boolean; segment?: string; endSegment?: string }
let vodAudioCapture: { started: number; segment: string; cues: RunVodAudioCue[]; playing: Map<HTMLAudioElement, RunVodAudioCue> } | null = null

export function captureRunVodAudio() {
  vodAudio.forEach(releaseAudio)
  vodAudioCapture = { started: performance.now(), segment: 'initial', cues: [], playing: new Map() }
  return vodAudioCapture.cues
}

export function setRunVodAudioSegment(segment: string) {
  if (vodAudioCapture) { vodAudioCapture.segment = segment; vodAudioCapture.started = performance.now() }
}

function playAudio(audio: HTMLAudioElement) {
  if (!vodAudioCapture) return audio.play()
  const cue: RunVodAudioCue = { source: audio.src, at: (performance.now() - vodAudioCapture.started) / 1000,
    volume: audio.volume, rate: audio.playbackRate, loop: audio.loop, segment: vodAudioCapture.segment }
  vodAudioCapture.cues.push(cue)
  vodAudioCapture.playing.set(audio, cue)
  return Promise.resolve()
}

function audioElement(source: string) {
  const audio = new Audio()
  if (new URL(source, location.href).origin !== location.origin) audio.crossOrigin = 'anonymous'
  audio.src = source
  audio.muted = vodAudioMuted
  vodAudio.add(audio)
  const forget = () => {
    vodAudio.delete(audio)
    vodAudioNodes.get(audio)?.disconnect()
    vodAudioNodes.delete(audio)
  }
  audio.addEventListener('ended', forget, { once: true })
  audio.addEventListener('error', forget, { once: true })
  if (vodAudioContext && vodAudioDestination) {
    const node = vodAudioContext.createMediaElementSource(audio)
    node.connect(vodAudioContext.destination)
    node.connect(vodAudioDestination)
    vodAudioNodes.set(audio, node)
  }
  return audio
}

function releaseAudio(audio: HTMLAudioElement) {
  const cue = vodAudioCapture?.playing.get(audio)
  if (cue) {
    cue.end = (performance.now() - vodAudioCapture!.started) / 1000
    cue.endSegment = vodAudioCapture!.segment
  }
  vodAudioCapture?.playing.delete(audio)
  audio.pause()
  activeEffects.delete(audio)
  vodAudio.delete(audio)
  vodAudioNodes.get(audio)?.disconnect()
  vodAudioNodes.delete(audio)
}

export function startRunVodAudio() {
  vodAudioClock?.stop()
  vodAudioContext?.close().catch(() => {})
  vodAudioContext = new AudioContext()
  vodAudioDestination = vodAudioContext.createMediaStreamDestination()
  const clock = vodAudioContext.createOscillator()
  const silence = vodAudioContext.createGain()
  silence.gain.value = 0
  clock.connect(silence).connect(vodAudioDestination)
  clock.start()
  vodAudioClock = clock
  void vodAudioContext.resume()
  return vodAudioDestination.stream
}

export function setRunVodAudioMuted(muted: boolean) {
  vodAudioMuted = muted
  vodAudio.forEach((audio) => { audio.muted = muted })
}

export function stopRunVodAudio() {
  vodAudioCapture = null
  vodAudio.forEach(releaseAudio)
  vodAudio.clear()
  vodAudioNodes.clear()
  vodAudioClock?.stop()
  vodAudioClock = null
  vodAudioDestination = null
  const context = vodAudioContext
  vodAudioContext = null
  void context?.close()
}

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
const VICTORY_TRACK = assetPath('bgm/the-spire-slain.mp3')

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
  const boss = combat.enemies.find((enemy) => enemy?.isBoss)
  const act = boss && enemyDef(boss.defId, boss.ascension).bossAct
  if (act) return BOSS_TRACKS[act]
  const lagavulin = combat.enemies.find((enemy) => enemy?.defId === 'lagavulin')
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
    const next = audioElement(track)
    audio.current = next
    next.loop = true
    next.volume = volume / 100
    void playAudio(next).catch(() => {})
    return () => {
      releaseAudio(next)
      if (audio.current === next) audio.current = null
    }
  }, [track])

  useEffect(() => {
    if (audio.current) audio.current.volume = volume / 100
  }, [volume])
}

/** Play the original victory cue on the terminal run screen. */
export function useVictoryMusic(active = false, enabled = true, volume = 20) {
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!active || !enabled) return
    const next = audioElement(VICTORY_TRACK)
    audio.current = next
    next.volume = volume / 100
    void playAudio(next).catch(() => {})
    return () => {
      releaseAudio(next)
      if (audio.current === next) audio.current = null
    }
  }, [active, enabled])

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
    let timer: number | undefined
    const playWhenAnimationsFinish = () => {
      if (combatOutcomeAnimationActive()) {
        timer = window.setTimeout(playWhenAnimationsFinish, 100)
        return
      }
      playSoundEffect('win')
      previous.current = 'win'
    }
    if (!restored && outcome && outcome !== previous.current && delayedWin) {
      timer = window.setTimeout(playWhenAnimationsFinish, combatWinDelayMs)
    }
    if (!restored && outcome && outcome !== previous.current && !delayedWin) {
      playSoundEffect(outcome)
      previous.current = outcome
    } else if (restored || !outcome) previous.current = outcome
    previousRestoration.current = restoration
    previousConnected.current = connected
    return () => { if (timer !== undefined) window.clearTimeout(timer) }
  }, [combatWinDelayMs, connected, outcome, restoration, run?.combat?.phase])
}

export function installSoundEffects(warm = true) {
  // Warm short effect files before the first attack; playback still requires an interaction.
  const preload = warm ? Object.values(SOUNDS).map(source => {
    const audio = audioElement(source)
    audio.preload = 'auto'
    audio.load()
    return audio
  }) : []
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
    for (const audio of activeEffects) releaseAudio(audio)
    activeEffects.clear()
    preload.forEach(audio => { releaseAudio(audio); audio.removeAttribute('src'); audio.load() })
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
  const playing: HTMLAudioElement[] = []
  recipe.layers.forEach((layer) => {
    if (impactsOnly && (layer.delayMs > 0 || !IMPACT_SOUNDS.has(layer.sound))) return
    const delayMs = layer.delayMs || !IMPACT_SOUNDS.has(layer.sound) ? layer.delayMs : impactDelayMs
    const play = () => {
      if (currentSfxVolume() > 0) {
        playing.push(playSound(layer.sound, layer.volume, layer.rate, recipe.cue, delayMs))
      }
    }
    if (delayMs > 0) timers.push(window.setTimeout(play, delayMs))
    else play()
  })
  return () => {
    timers.forEach(timer => window.clearTimeout(timer))
    playing.forEach(releaseAudio)
  }
}

function playSound(sound: Sound, volume = 0.35, rate = 1, cue?: string, delayMs = 0) {
  // Bound a busy multiplayer mix; discard the oldest tail before adding another voice.
  if (activeEffects.size >= 24) {
    const oldest = activeEffects.values().next().value!
    releaseAudio(oldest)
  }
  const audio = audioElement(SOUNDS[sound])
  if (!vodAudioCapture) activeEffects.add(audio)
  audio.addEventListener('ended', () => activeEffects.delete(audio), { once: true })
  audio.volume = volume * currentSfxVolume()
  audio.playbackRate = rate
  audio.preservesPitch = false
  if (cue) audio.dataset.combatSfx = cue
  if (delayMs) audio.dataset.combatSfxDelay = String(delayMs)
  void playAudio(audio).catch(() => releaseAudio(audio))
  return audio
}
