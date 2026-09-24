import { useEffect, useState } from 'react'
import type { CharacterId } from '../game/types.ts'
import { campfireSceneLocalPath, campfireScenePath } from '../game/assets.ts'

export function useCampfireScene(characters: CharacterId[]): string {
  const primary = campfireScenePath(characters)
  const backup = campfireScenePath(characters, true)
  const local = campfireSceneLocalPath()
  const [loaded, setLoaded] = useState<{ primary: string; src: string } | null>(null)

  useEffect(() => {
    if (primary === local) return
    const image = new Image()
    const fallback = new Image()
    let settled = false
    let started = false
    const release = () => {
      window.clearTimeout(timer)
      image.onload = image.onerror = fallback.onload = fallback.onerror = null
      image.removeAttribute('src')
      fallback.removeAttribute('src')
    }
    const show = (src: string) => {
      if (settled) return
      settled = true
      release()
      setLoaded({ primary, src })
    }
    const tryBackup = () => {
      if (settled || started) return
      started = true
      setLoaded({ primary, src: local })
      if (backup === primary) return
      fallback.onload = () => show(backup)
      fallback.onerror = () => fallback.removeAttribute('src')
      fallback.src = backup
    }
    image.onload = () => show(primary)
    image.onerror = tryBackup
    image.src = primary
    const timer = window.setTimeout(tryBackup, 4000)
    return release
  }, [primary, backup, local])

  return loaded?.primary === primary ? loaded.src : primary.startsWith('http') ? local : primary
}
