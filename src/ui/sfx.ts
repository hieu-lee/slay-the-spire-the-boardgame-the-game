import { useEffect, useRef } from 'react'
import { enemyDef } from '../game/enemies.ts'

export const SFX_STORAGE_KEY = 'sts-sfx-enabled'

const SOUNDS = {
  ui: '/assets/sfx/ui.ogg',
  card: '/assets/sfx/card.ogg',
  draw: '/assets/sfx/draw.ogg',
  attack: '/assets/sfx/attack.ogg',
  magic: '/assets/sfx/magic.ogg',
  enemy: '/assets/sfx/enemy-hit.ogg',
  hurt: '/assets/sfx/player-hit.ogg',
  block: '/assets/sfx/block.ogg',
  heal: '/assets/sfx/heal.ogg',
  weak: '/assets/sfx/weak.ogg',
  win: '/assets/sfx/victory.ogg',
  lose: '/assets/sfx/defeat.ogg',
} as const

type Sound = keyof typeof SOUNDS

const BOSS_TRACKS = {
  1: '/assets/bgm/the-guardian-emerges.mp3',
  2: '/assets/bgm/battle-with-the-champ.mp3',
  3: '/assets/bgm/the-awakened-one.mp3',
  4: '/assets/bgm/the-heart.mp3',
} as const

type BossCombat = { phase: string; enemies: readonly { defId: string; ascension?: number; isBoss: boolean }[] }

function bossTrack(combat?: BossCombat | null) {
  if (!combat || combat.phase === 'won' || combat.phase === 'lost') return
  const boss = combat.enemies.find((enemy) => enemy.isBoss)
  const act = boss && enemyDef(boss.defId, boss.ascension).bossAct
  return act ? BOSS_TRACKS[act] : undefined
}

/** Loop the appropriate act theme while a boss combat is active. */
export function useBossFightMusic(combat?: BossCombat | null, enabled = true) {
  const track = enabled ? bossTrack(combat) : undefined

  useEffect(() => {
    if (!track) return
    const audio = new Audio(track)
    audio.loop = true
    audio.volume = 0.2
    void audio.play().catch(() => {})
    return () => audio.pause()
  }, [track])
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
  if (localStorage.getItem(SFX_STORAGE_KEY) === 'off') return
  playSound(sound)
}

function playSound(sound: Sound) {
  const audio = new Audio(SOUNDS[sound])
  audio.volume = 0.35
  void audio.play().catch(() => {})
}
