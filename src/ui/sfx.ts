export const SFX_STORAGE_KEY = 'sts-sfx-enabled'

const SOUNDS = {
  ui: '/assets/sfx/ui.ogg',
  card: '/assets/sfx/card.ogg',
  attack: '/assets/sfx/attack.ogg',
  magic: '/assets/sfx/magic.ogg',
  enemy: '/assets/sfx/enemy-hit.ogg',
  weak: '/assets/sfx/weak.ogg',
} as const

type Sound = keyof typeof SOUNDS

export function installSoundEffects() {
  function playSound(sound: Sound) {
    const audio = new Audio(SOUNDS[sound])
    audio.volume = 0.35
    void audio.play().catch(() => {})
  }

  function play(event: MouseEvent) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.closest('[inert]')) return
    const sound = button.dataset.sfx as Sound | 'none' | undefined
    if (sound === 'none') return
    playSound(sound && sound in SOUNDS ? sound : 'ui')
  }

  function playRequested(event: Event) {
    const sound = (event as CustomEvent<Sound>).detail
    if (sound && sound in SOUNDS) playSound(sound)
  }

  document.addEventListener('click', play)
  document.addEventListener('sts-sfx', playRequested)
  return () => {
    document.removeEventListener('click', play)
    document.removeEventListener('sts-sfx', playRequested)
  }
}

export function playSoundEffect(sound: Sound) {
  document.dispatchEvent(new CustomEvent<Sound>('sts-sfx', { detail: sound }))
}
