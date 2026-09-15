#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await validateRoomStore(process.argv[2], process.argv[3])
}
