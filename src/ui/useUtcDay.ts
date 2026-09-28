import { useCallback, useEffect, useState } from 'react'
import { dailyDate } from '../daily-date.ts'

/**
 * Today's UTC day. It re-renders at 00:00 UTC, and on focus because timers
 * stall while a device sleeps, so a Daily Climb never starts on yesterday's
 * seed. `refresh` re-reads the clock now and returns the current day.
 */
export function useUtcDay(): [string, () => string] {
  const [day, setDay] = useState(() => dailyDate(Date.now()))
  const refresh = useCallback(() => {
    const current = dailyDate(Date.now())
    setDay(current)
    return current
  }, [])
  useEffect(() => {
    const nextMidnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000
    const timer = window.setTimeout(refresh, Math.max(0, nextMidnight - Date.now()) + 50)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [day, refresh])
  return [day, refresh]
}
