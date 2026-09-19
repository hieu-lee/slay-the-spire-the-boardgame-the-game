#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
for (const args of [
  ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'],
  ['build'],
]) {
  const result = spawnSync(pnpm, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('✓ dependency lock and production build passed')
