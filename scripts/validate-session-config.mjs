import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SESSION_FIELDS = ['alwaysOn', 'origin', 'protocolVersion', 'runId', 'sha']

export function validateSessionConfig(config, { sha, stableOrigin }) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid session configuration.')
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(SESSION_FIELDS)) {
    throw new Error('Session configuration contains unsupported fields.')
  }
  if (config.protocolVersion !== 1 || config.sha !== sha ||
      typeof config.runId !== 'string' || !/^[0-9]+$/.test(config.runId)) {
    throw new Error('Session metadata does not match the deployment.')
  }
  if (config.alwaysOn !== true || config.origin !== stableOrigin) {
    throw new Error('The always-on room origin does not match the deployment.')
  }
  return config
}

function main([file, sha, stableOrigin]) {
  if (!file || !sha || !stableOrigin) {
    throw new Error('Usage: validate-session-config.mjs <file> <sha> <stable-origin>')
  }
  validateSessionConfig(JSON.parse(readFileSync(file, 'utf8')), { sha, stableOrigin })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
