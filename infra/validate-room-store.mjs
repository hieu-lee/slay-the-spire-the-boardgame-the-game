#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { mergeLeaderboardRuns, restoreLeaderboardRuns } from '../scripts/lib/leaderboard.mjs'

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

export async function materializeLeaderboardArchive(storeFile) {
  const raw = JSON.parse(await readFile(storeFile, 'utf8'))
  let archive
  try { archive = JSON.parse(await readFile(`${storeFile}.leaderboard.json`, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT' && !raw.leaderboardArchive) return
    throw error
  }
  if (!Array.isArray(archive)) throw new Error('The leaderboard archive must be an array.')
  if (restoreLeaderboardRuns(archive).length !== archive.length) throw new Error('The leaderboard archive has invalid runs.')
  const runs = mergeLeaderboardRuns(raw.leaderboardRuns ?? [], archive)
  const temporary = `${storeFile}.rollback.tmp`
  await writeFile(temporary, JSON.stringify({ ...raw, leaderboardRuns: runs }), { mode: 0o600 })
  await rename(temporary, storeFile)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--materialize') await materializeLeaderboardArchive(process.argv[3])
  else await validateRoomStore(process.argv[2], process.argv[3])
}
