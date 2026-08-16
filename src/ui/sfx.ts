export const SFX_STORAGE_KEY = 'sts-sfx-enabled'

const SOUNDS = {
  ui: '/assets/sfx/ui.ogg',
  card: '/assets/sfx/card.ogg',
  attack: '/assets/sfx/attack.ogg',
  magic: '/assets/sfx/magic.ogg',
  enemy: '/assets/sfx/enemy-hit.ogg',
} as const

type Sound = keyof typeof SOUNDS

export function installSoundEffects() {
  function play(event: MouseEvent) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.closest('[inert]')) return
    const sound = button.dataset.sfx as Sound | 'none' | undefined
    if (sound === 'none') return
    const audio = new Audio(SOUNDS[sound && sound in SOUNDS ? sound : 'ui'])
    audio.volume = 0.35
    void audio.play().catch(() => {})
  }

  document.addEventListener('click', play)
  return () => document.removeEventListener('click', play)
}
