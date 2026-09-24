import type { CharacterId, CardInstance } from './game/types.ts'
import { resetRoomEndpoint, roomUrl } from './multiplayer/room-endpoint.ts'

export type StatsQuery =
  | { op: 'card'; id: string; upgraded: boolean | null }
  | { op: 'not'; value: StatsQuery }
  | { op: 'and' | 'or'; left: StatsQuery; right: StatsQuery }

export type StatsMetrics = {
  runs: number
  averageFloors: number | null
  averageDamage: number | null
  averageBlock: number | null
}

export type StatsSnapshot = StatsMetrics & {
  pending: number
  rows: (StatsMetrics & { deckType: string; character: CharacterId })[]
  nextCards: (StatsMetrics & { defId: string; deltaFloors: number | null; deltaDamage: number | null; deltaBlock: number | null })[]
}

export type StatsFilters = { character: CharacterId | 'all'; ascension: number | 'all' | `${number}+`; mode: 'all' | 'standard' | 'daily' | 'custom' | 'multiplayer'; query: StatsQuery | null }
export type SampleDeck = { deckType: string; character: CharacterId; cards: Omit<CardInstance, 'uid'>[] }

function paramsFor(filters: StatsFilters) {
  const params = new URLSearchParams({ character: filters.character, ascension: String(filters.ascension), mode: filters.mode })
  if (filters.query) params.set('q', JSON.stringify(filters.query))
  return params
}

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const endpoint = await roomUrl(path)
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
      timeout = setTimeout(abort, 8_000)
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(response.status === 404 ? 'That deck is no longer available.' : 'Could not open the stats archive.')
      return await response.json() as T
    } catch (error) {
      if (signal.aborted) throw error
      resetRoomEndpoint()
      if (attempt === 1) throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
  throw new Error('Could not open the stats archive.')
}

export const loadStats = (filters: StatsFilters, signal: AbortSignal) =>
  request<StatsSnapshot>(`/api/stats?${paramsFor(filters)}`, signal)

export const loadSampleDeck = (type: string, filters: StatsFilters, signal: AbortSignal) => {
  const params = paramsFor(filters)
  params.set('type', type)
  return request<SampleDeck>(`/api/stats/deck?${params}`, signal)
}
