#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { restoreLeaderboardRuns } from '../scripts/lib/leaderboard.mjs'
import { createStore, repairInterruptedJournals } from '../scripts/lib/rooms.mjs'

export async function validateRoomStore(storeFile, roomsModule) {
  const raw = JSON.parse(await readFile(storeFile, 'utf8'))
  if (raw?.version !== 1 || !Array.isArray(raw.rooms)) {
    throw new Error('The room store has an incompatible top-level schema.')
  }
  if (raw.profiles !== undefined && !Array.isArray(raw.profiles)) {
    throw new Error('The profiles field must be an array when present.')
  }
  const { createStore } = await import(pathToFileURL(roomsModule))
  const restored = createStore({ file: storeFile, restartRecovery: true, restartReconnectMs: 3_600_000 })
  if (restored.rooms.size !== raw.rooms.length) {
    throw new Error('The production room loader rejected at least one stored room.')
  }
}

export async function materializeLeaderboardArchive(storeFile, previousLeaderboardModule) {
  if (!existsSync(storeFile) && !existsSync(`${storeFile}.leaderboard.json`) && !existsSync(`${storeFile}.leaderboard.log`) &&
      !existsSync(`${storeFile}.stats.json`) && !existsSync(`${storeFile}.stats.log`)) return
  const raw = JSON.parse(await readFile(storeFile, 'utf8'))
  let archive
  try { archive = JSON.parse(await readFile(`${storeFile}.leaderboard.json`, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT' && !raw.leaderboardArchive && !existsSync(`${storeFile}.leaderboard.log`)) return
    throw error
  }
  if (!Array.isArray(archive)) throw new Error('The leaderboard archive must be an array.')
  if (restoreLeaderboardRuns(archive).length !== archive.length) throw new Error('The leaderboard archive has invalid runs.')
  const restored = createStore({ file: storeFile })
  if (previousLeaderboardModule) {
    const { MAX_LEADERBOARD_RUNS } = await import(pathToFileURL(previousLeaderboardModule))
    if (Number.isSafeInteger(MAX_LEADERBOARD_RUNS) && restored.leaderboardRuns.length >= MAX_LEADERBOARD_RUNS)
      throw new Error('Cannot roll back: the previous release has reached its leaderboard capacity.')
  }
  repairInterruptedJournals(restored)
  if (restored.leaderboardChanges.size)
    await appendFile(`${storeFile}.leaderboard.log`, [...restored.leaderboardChanges.values()].map((run) => JSON.stringify(run)).join('\n') + '\n', { mode: 0o600 })
  const temporary = `${storeFile}.rollback.tmp`
  await writeFile(temporary, JSON.stringify({ ...raw, leaderboardRuns: restored.leaderboardRuns,
    deckTypes: restored.deckTypes, deckClassificationBudget: restored.deckClassificationBudget }), { mode: 0o600 })
  await rename(temporary, storeFile)
  const archiveTemporary = `${storeFile}.leaderboard.rollback.tmp`
  await writeFile(archiveTemporary, JSON.stringify(restored.leaderboardRuns), { mode: 0o600 })
  await rename(archiveTemporary, `${storeFile}.leaderboard.json`)
  if (existsSync(`${storeFile}.leaderboard.log`)) await writeFile(`${storeFile}.leaderboard.log`, '', { mode: 0o600 })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--materialize') await materializeLeaderboardArchive(process.argv[3], process.argv[4])
  else await validateRoomStore(process.argv[2], process.argv[3])
}
