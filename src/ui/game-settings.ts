import { useEffect, useState } from 'react'

export type GameSettings = {
  bgmVolume: number
  sfxVolume: number
  voiceVolume: number
  screenShake: boolean
  reducedMotion: boolean
  highContrast: boolean
}

export const GAME_SETTINGS_KEY = 'sts-game-settings'
export const SFX_STORAGE_KEY = 'sts-sfx-enabled'

const DEFAULTS: GameSettings = {
  bgmVolume: 20,
  sfxVolume: 100,
  voiceVolume: 100,
  screenShake: true,
  reducedMotion: false,
  highContrast: false,
}
let sfxVolume = 1

const volume = (value: unknown, fallback: number) => typeof value === 'number'
  ? Math.max(0, Math.min(100, Math.round(value)))
  : fallback

export function loadGameSettings(): GameSettings {
  try {
    const savedSettings = localStorage.getItem(GAME_SETTINGS_KEY)
    const legacyMuted = savedSettings === null && localStorage.getItem(SFX_STORAGE_KEY) === 'off'
    const saved = JSON.parse(savedSettings ?? '{}') as Partial<GameSettings>
    return {
      bgmVolume: volume(saved.bgmVolume, legacyMuted ? 0 : DEFAULTS.bgmVolume),
      sfxVolume: volume(saved.sfxVolume, legacyMuted ? 0 : DEFAULTS.sfxVolume),
      voiceVolume: volume(saved.voiceVolume, DEFAULTS.voiceVolume),
      screenShake: typeof saved.screenShake === 'boolean' ? saved.screenShake : DEFAULTS.screenShake,
      reducedMotion: typeof saved.reducedMotion === 'boolean' ? saved.reducedMotion : DEFAULTS.reducedMotion,
      highContrast: typeof saved.highContrast === 'boolean' ? saved.highContrast : DEFAULTS.highContrast,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function useGameSettings() {
  const [settings, setSettings] = useState(() => {
    const loaded = loadGameSettings()
    sfxVolume = loaded.sfxVolume / 100
    return loaded
  })
  useEffect(() => {
    sfxVolume = settings.sfxVolume / 100
    try {
      localStorage.setItem(GAME_SETTINGS_KEY, JSON.stringify(settings))
      localStorage.setItem(SFX_STORAGE_KEY, settings.sfxVolume === 0 ? 'off' : 'on')
    } catch {
      // Private browsing and storage policies should not stop the game.
    }
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion)
    document.documentElement.dataset.highContrast = String(settings.highContrast)
    document.documentElement.dataset.screenShake = String(settings.screenShake)
  }, [settings])
  return [settings, setSettings] as const
}

export function currentSfxVolume() {
  return sfxVolume
}

export const defaultGameSettings = () => ({ ...DEFAULTS })
