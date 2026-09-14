import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const legacyOrigin = /^https:\/\/(?:[-a-z0-9]+\.trycloudflare\.com|[1-9a-km-z]{6}\.tunnel\.pyjam\.as)$/

export function validateSessionConfig(config, { sha, stableOrigin }) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid session configuration.')
  if (config.protocolVersion !== 1 || config.sha !== sha || typeof config.runId !== 'string') {
    throw new Error('Session metadata does not match the deployment.')
  }
  if (typeof config.origin !== 'string' || !Array.isArray(config.origins) ||
      config.origins.some((origin) => typeof origin !== 'string')) {
    throw new Error('Invalid session origins.')
  }
  for (const origin of [config.origin, ...config.origins]) {
    if (origin !== stableOrigin && !legacyOrigin.test(origin)) throw new Error(`Unsupported room origin: ${origin}`)
  }
  return config
}

function main([file, sha, stableOrigin, selectedOrigin]) {
  if (!file || !sha || !stableOrigin) {
    throw new Error('Usage: validate-session-config.mjs <file> <sha> <stable-origin> [selected-origin]')
  }
  const config = validateSessionConfig(JSON.parse(readFileSync(file, 'utf8')), { sha, stableOrigin })
  if (selectedOrigin) {
    if (![config.origin, ...config.origins].includes(selectedOrigin)) throw new Error('Selected origin is not configured.')
    const next = `${file}.next`
    writeFileSync(next, `${JSON.stringify({ ...config, origin: selectedOrigin })}\n`)
    renameSync(next, file)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
