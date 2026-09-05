import type { RunState } from './game/run.ts'
import type { CharacterId } from './game/types.ts'
import { resetRoomEndpoint, roomUrl } from './multiplayer/room-endpoint.ts'
import { damageTotals } from './ui/run-summary-data.ts'

const INSTALLATION_KEY = 'sts-leaderboard-installation'
const OUTBOX_KEY = 'sts-leaderboard-outbox'
const AUTO_FLUSH = import.meta.env.PROD || import.meta.env.VITE_HOSTED_SESSION === 'true' || import.meta.env.VITE_LEADERBOARD === 'true'

export type LeaderboardRow = {
  character: CharacterId
  ascension: number
  runs: number
  act3Runs: number
  act3Wins: number
  act3WinRate: number | null
  averageDamagePerFight: number | null
  averageDamageBlocked: number | null
  act4Wins: number
}

export type LeaderboardSnapshot = { totalRuns: number; rows: LeaderboardRow[] }

type LeaderboardSubmission = {
  id: string
  character: CharacterId
  ascension: number
  mode: RunState['meta']['mode']
  damageStatsComplete: boolean
  startedAtAct: number
  highestBossActDefeated: number
  combatsFinished: number
  damageDealt: number
  damageTaken: number
  damageBlocked: number
}

let fallbackOutbox: LeaderboardSubmission[] = []
let flushing: Promise<void> | null = null

function readOutbox(): LeaderboardSubmission[] {
  try {
    const saved = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')
    const runs = Array.isArray(saved) ? saved : []
    return [...runs, ...fallbackOutbox].filter((run, index, all) =>
      all.findIndex((candidate) => candidate.id === run.id) === index)
  } catch { return fallbackOutbox }
}

function writeOutbox(runs: LeaderboardSubmission[]) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(runs))
    fallbackOutbox = []
  } catch { fallbackOutbox = runs }
}

function installationId() {
  try {
    const saved = localStorage.getItem(INSTALLATION_KEY)
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(INSTALLATION_KEY, id)
    return id
  } catch { return crypto.randomUUID() }
}

export function queueFinishedSoloRun(run: RunState) {
  if (!run.campaign.finalized || run.players.length !== 1) return
  const totals = damageTotals(run.players[0]?.damageStats)
  const submission: LeaderboardSubmission = {
    id: `${installationId()}:${run.campaign.runId}:${run.seed}`,
    character: run.players[0]!.character,
    ascension: run.ascension,
    mode: run.meta.mode,
    damageStatsComplete: run.combatsFinished !== undefined,
    startedAtAct: run.campaign.startedAtAct,
    highestBossActDefeated: run.campaign.highestBossActDefeated,
    combatsFinished: Math.max(0, Math.floor(run.combatsFinished ?? 0)),
    damageDealt: totals.dealt,
    damageTaken: totals.taken,
    damageBlocked: totals.blocked,
  }
  const queued = readOutbox()
  if (!queued.some((entry) => entry.id === submission.id)) writeOutbox([...queued, submission])
}

async function flush() {
  for (const run of readOutbox()) {
    let submitted = false
    for (let attempt = 0; attempt < 2 && !submitted; attempt += 1) {
      try {
        const response = await fetch(await roomUrl('/api/leaderboard'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(run),
        })
        if (response.status === 400 || response.status === 413) {
          submitted = true
          writeOutbox(readOutbox().filter((entry) => entry.id !== run.id))
          continue
        }
        if (!response.ok) throw new Error('Leaderboard submission failed')
        submitted = true
        writeOutbox(readOutbox().filter((entry) => entry.id !== run.id))
      } catch {
        resetRoomEndpoint()
        if (attempt === 1) return
      }
    }
  }
}

export function flushLeaderboardOutbox(force = false) {
  if (!AUTO_FLUSH && !force) return Promise.resolve()
  flushing ??= flush().finally(() => { flushing = null })
  return flushing
}

export async function loadLeaderboard(): Promise<LeaderboardSnapshot> {
  await flushLeaderboardOutbox(true)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(await roomUrl('/api/leaderboard'), { cache: 'no-store' })
      if (!response.ok) throw new Error('Leaderboard unavailable')
      return await response.json() as LeaderboardSnapshot
    } catch (error) {
      resetRoomEndpoint()
      if (attempt === 1) throw error
    }
  }
  throw new Error('Leaderboard unavailable')
}
