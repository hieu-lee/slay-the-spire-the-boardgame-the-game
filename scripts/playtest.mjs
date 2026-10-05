#!/usr/bin/env node
// Durable, isolated AI sessions. Every invocation returns its new prompt; no polling needed.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { createRun, victoryIsTerminal } from '../src/game/run.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { POLICY_VERSION, decodeAction, applyAction, automaticAction, snapshot, sourceFor, revealCard, requiresReveal, boundary } from './playtest/engine.mjs'
import { observe, summarize, markdown } from './playtest/report.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const atomic = (file, value) => { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, file) }
const recordFile = (directory, index) => join(directory, `run-${String(index + 1).padStart(4, '0')}.json`)
function locked(file, work) {
  let fd
  try { fd = openSync(file, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid })) }
  catch (error) { throw new Error(`Cannot acquire ${file}: ${error.message}`) }
  try { return work() } finally { closeSync(fd); unlinkSync(file) }
}
export function sourceFingerprint() {
  const hash = createHash('sha256')
  const walk = (path) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${path}/${entry.name}`
      if (entry.isDirectory()) walk(file)
      else hash.update(file).update(readFileSync(join(root, file)))
    }
  }
  walk('src/game'); walk('scripts/playtest')
  hash.update(readFileSync(join(root, 'scripts/playtest.mjs')))
  return hash.digest('hex')
}
export function parseOptions(args) {
  const options = { command: args[0] ?? 'help', character: 'ironclad', runs: 50, workers: 1, worker: 0, run: 1,
    ascension: 0, seed: 1, out: 'artifacts/playtest/batch', maxSteps: 20000, unlocks: 'full' }
  const names = { character: 'character', runs: 'runs', workers: 'workers', worker: 'worker', ascension: 'ascension', seed: 'seed',
    out: 'out', run: 'run', 'max-steps': 'maxSteps', unlocks: 'unlocks', actions: 'actions', revision: 'revision', since: 'since', request: 'request' }
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--detail') { options.detail = true; continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i])
    if (!match || !names[match[1]]) throw new Error(`Unknown argument ${args[i]}`)
    const value = match[2] ?? args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`)
    const key = names[match[1]]
    options[key] = ['runs', 'workers', 'worker', 'run', 'ascension', 'seed', 'maxSteps', 'revision', 'since'].includes(key) ? Number(value) : value
  }
  if (!['init', 'inspect', 'act', 'report', 'replay', 'serve', 'help'].includes(options.command)) throw new Error('Command must be init, inspect, act, or report')
  if (!CHARACTER_IDS.includes(options.character)) throw new Error(`Character must be one of ${CHARACTER_IDS.join(', ')}`)
  for (const [key, min, max] of [['runs', 1, 100000], ['run', 1, 100000], ['workers', 1, 64], ['worker', 0, 63], ['ascension', 0, 13], ['seed', 0, 0xffffffff], ['maxSteps', 1, 1000000]]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid ${key}`)
  }
  for (const key of ['revision', 'since']) if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] < 0)) throw new Error(`Invalid ${key}`)
  if (options.seed + options.runs - 1 > 0xffffffff) throw new Error('Seed range exceeds uint32')
  if (!['full', 'starter'].includes(options.unlocks)) throw new Error('Unlocks must be full or starter')
  return options
}
function newSession(manifest, worker, index = worker, revision = 0) {
  if (index >= manifest.runs) return { worker, revision, run: null, record: null }
  const campaign = createCampaignProgress()
  if (manifest.unlocks === 'full') { for (const hero of CHARACTER_IDS) campaign.characters[hero] = 8; campaign.colorless = 8 }
  const run = createRun(manifest.seed + index, [{ id: 'p1', name: 'Playtest', character: manifest.character }], manifest.ascension, campaign)
  return { worker, revision, run, record: { index, seed: manifest.seed + index, outcome: 'running', steps: 0,
    acts: { 1: { reached: true, bossDefeated: false, floors: 0, combats: 0, turns: 0, damage: 0, taken: 0, blocked: 0, blockNetGained: 0 } },
    cards: {}, actions: [] }, reveal: null }
}
function advance(session, choice, next) {
  if (next === session.run) throw new Error(`Illegal action ${choice.name}`)
  observe(session.record, session.run, next, choice)
  session.record.actions.push(choice)
  session.record.steps++; session.revision++; session.run = next
}
function settle(session, manifest) {
  for (let step = 0; step < 200; step++) {
    const choice = session.run && automaticAction(session.run, session.reveal)
    if (!choice) return
    if (session.record.steps >= manifest.maxSteps) throw new Error(`Step limit ${manifest.maxSteps} reached; checkpoint retained`)
    choice.source = sourceFor(session.run, choice)
    advance(session, choice, applyAction(session.run, choice))
  }
  throw new Error('Automatic transition limit reached')
}
function finalize(session, manifest, directory) {
  if (!session.run?.campaign.finalized) return session
  const run = session.run
  if (!['victory', 'defeat'].includes(run.phase) || run.phase === 'victory' && !victoryIsTerminal(run, run.campaignProgress)) throw new Error('Non-terminal finalized run')
  const record = { ...session.record, outcome: run.phase, finalDeck: run.players[0].deck, campaign: run.campaign }
  const file = recordFile(directory, record.index)
  // Recover a crash between writing the result and advancing the worker checkpoint.
  if (existsSync(file)) {
    if (JSON.stringify(read(file)) !== JSON.stringify(record)) throw new Error('Existing run receipt differs from worker checkpoint')
  } else atomic(file, record)
  return { ...newSession(manifest, session.worker, record.index + manifest.workers, session.revision + 1), receipts: session.receipts, lastView: session.lastView }
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function viewFor(session, detail = false) {
  const view = snapshot(session, detail)
  if (!detail && !view.done) for (const key of ['cardText', 'relicText', 'potionText', 'enemyText', 'gemText']) view[key] = { ...session.lastView?.[key], ...view[key] }
  return view
}
function response(session, options, extra = {}) {
  const view = viewFor(session, options.detail)
  // Metadata and each top-level section are lossless; null deletes a removed section.
  const output = session.lastView && options.since === session.lastView.revision && !options.detail
    ? { baseRevision: options.since, revision: session.revision,
      changes: Object.fromEntries([...new Set([...Object.keys(session.lastView), ...Object.keys(view)])]
        .filter((key) => JSON.stringify(session.lastView[key]) !== JSON.stringify(view[key])).map((key) => [key, ['cardText', 'relicText', 'potionText', 'enemyText', 'gemText'].includes(key) && view[key]
          ? Object.fromEntries(Object.entries(view[key]).filter(([id, text]) => JSON.stringify(text) !== JSON.stringify(session.lastView[key]?.[id])))
          : view[key] ?? null])) }
    : view
  return { ...output, ...extra }
}
export function execute(options) {
  const directory = resolve(root, options.out)
  if (options.command === 'init') {
    mkdirSync(directory, { recursive: true })
    return locked(join(directory, 'init.lock'), () => {
      const expected = { schemaVersion: 1, character: options.character, runs: options.runs, workers: options.workers,
        ascension: options.ascension, seed: options.seed, maxSteps: options.maxSteps, unlocks: options.unlocks,
        policyVersion: POLICY_VERSION, fingerprint: sourceFingerprint() }
      const file = join(directory, 'manifest.json')
      const manifest = existsSync(file) ? read(file) : { ...expected, batchId: randomUUID(),
        revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), startedAt: new Date().toISOString() }
      if (Object.entries(expected).some(([key, value]) => JSON.stringify(manifest[key]) !== JSON.stringify(value))) throw new Error('Batch configuration/source changed; use a new --out directory')
      atomic(file, manifest)
      return { batch: manifest.batchId, directory, workers: manifest.workers, runs: manifest.runs,
        next: 'Each AI calls inspect with its own --worker 0..workers-1; then act with --revision and a unique --request ID.' }
    })
  }
  const manifest = read(join(directory, 'manifest.json'))
  if (options.command === 'report') {
    return locked(join(directory, 'report.lock'), () => {
      const records = Array.from({ length: manifest.runs }, (_, index) => recordFile(directory, index)).filter(existsSync).map(read)
      const errors = Array.from({ length: manifest.workers }, (_, worker) => join(directory, `worker-${worker}.json`)).filter(existsSync).map(read)
        .filter((session) => session.error && session.record && !existsSync(recordFile(directory, session.record.index))).map((session) => ({ ...session.record, outcome: 'error', error: session.error }))
      const report = summarize(manifest, [...records, ...errors])
      atomic(join(directory, 'report.json'), report); writeFileSync(join(directory, 'report.md'), markdown(report))
      return { completed: report.completed, requested: manifest.runs, wins: report.wins, averages: report.averages, acts: report.acts,
        errors: report.failures, report: join(directory, 'report.md'), json: join(directory, 'report.json') }
    })
  }
  if (options.command === 'replay') {
    if (sourceFingerprint() !== manifest.fingerprint) throw new Error('Replay requires the original source fingerprint')
    const saved = read(recordFile(directory, options.run - 1))
    const session = newSession(manifest, saved.index % manifest.workers, saved.index)
    for (const choice of saved.actions) advance(session, choice, applyAction(session.run, choice))
    if (!session.run.campaign.finalized || session.run.phase !== saved.outcome || JSON.stringify(session.run.players[0].deck) !== JSON.stringify(saved.finalDeck)
      || JSON.stringify(session.record.acts) !== JSON.stringify(saved.acts) || JSON.stringify(session.record.cards) !== JSON.stringify(saved.cards)) throw new Error('Replay did not match the terminal receipt')
    return { run: options.run, seed: saved.seed, verified: true, actions: saved.actions.length }
  }
  if (options.worker >= manifest.workers) throw new Error('Worker exceeds this batch worker count')
  if (sourceFingerprint() !== manifest.fingerprint) throw new Error('Engine/tooling changed; resume the original revision or start a new batch')
  return locked(join(directory, `worker-${options.worker}.lock`), () => {
    const file = join(directory, `worker-${options.worker}.json`)
    let session = existsSync(file) ? read(file) : newSession(manifest, options.worker)
    if (session.run?.campaign.finalized) { session = finalize(session, manifest, directory); settle(session, manifest) }
    if (options.command === 'inspect') {
      if (!existsSync(file)) settle(session, manifest)
      const output = response(session, options)
      session.lastView = viewFor(session)
      atomic(file, session)
      return { ...output, ...(session.error ? { error: session.error } : {}) }
    }
    const inputs = JSON.parse(options.actions ?? 'null')
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64 || inputs.some((input) => !Array.isArray(input))) throw new Error('Supply --actions as 1..64 action arrays')
    if (!options.request || options.request.length > 128) throw new Error('act requires a unique --request ID (max 128 characters)')
    const hash = digest({ actions: inputs, revision: options.revision })
    const receipt = session.receipts?.find((entry) => entry.id === options.request)
    if (receipt) {
      if (receipt.hash !== hash) throw new Error('Request ID was already used with different input')
      return { ...receipt.response, replayed: true }
    }
    if (options.revision === undefined || options.revision !== session.revision) throw new Error(`Stale revision; inspect worker ${options.worker} (current ${session.revision})`)
    let completed = 0, stopped = null, error = null
    delete session.error
    for (const input of inputs) {
      try {
        if (!session.run) { stopped = 'budget_complete'; break }
        if (session.record.steps >= manifest.maxSteps) throw new Error(`Step limit ${manifest.maxSteps} reached; checkpoint retained`)
        if (['reveal', 'revealCopy', 'revealChamber', 'revealPower'].includes(input[0])) {
          if (session.reveal) throw new Error('Finish the committed reveal before revealing another card')
          session.reveal = revealCard(session.run, input[1], ({ reveal: 'card', revealCopy: 'copy', revealChamber: 'chamber', revealPower: 'power' })[input[0]])
          session.revision++; completed++; stopped = 'reveal'; break
        }
        const choice = decodeAction(input)
        if (session.reveal && (choice.name !== ({ card: 'playCard', copy: 'playCardCopy', chamber: 'playHermitChamberCard', power: 'activatePower' })[session.reveal.kind]
          || session.reveal.kind !== 'copy' && choice.args[1] !== session.reveal.cardUid)) throw new Error('Finish the committed card reveal first')
        const prior = session.run
        if (!session.reveal && requiresReveal(prior, choice)) throw new Error('Use reveal/revealCopy/revealChamber/revealPower before this action')
        choice.source = sourceFor(prior, choice)
        const next = applyAction(prior, choice)
        advance(session, choice, next)
        const revealed = Boolean(session.reveal)
        session.reveal = null; completed++
        stopped = revealed ? 'reveal_resolved' : boundary(prior, next)
        settle(session, manifest)
        // Persist the finalized checkpoint before the immutable receipt; a retry cannot double count.
        if (session.run.campaign.finalized) {
          atomic(file, session)
          session = finalize(session, manifest, directory)
          settle(session, manifest); stopped = session.run ? 'next_run' : 'budget_complete'
        }
        if (stopped) break
      } catch (caught) {
        error = caught.message; session.error = error; stopped = 'error'; break
      }
    }
    const output = response(session, options, { sequence: { completed, total: inputs.length, stopped }, ...(error ? { error } : {}) })
    session.lastView = viewFor(session)
    session.receipts = [...(session.receipts ?? []), { id: options.request, hash, response: output }].slice(-32)
    atomic(file, session)
    return output
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.command === 'serve') {
      console.log(JSON.stringify(execute({ ...options, command: 'inspect' })))
      const lines = createInterface({ input: process.stdin })
      for await (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (!message || !['inspect', 'act', 'report'].includes(message.command) || Object.keys(message).some((key) => !['command', 'revision', 'request', 'actions', 'since', 'detail'].includes(key))) throw new Error('Use command inspect, act, or report and session arguments only')
          console.log(JSON.stringify(execute({ ...options, ...message, actions: message.actions === undefined ? undefined : JSON.stringify(message.actions) })))
        } catch (error) { console.log(JSON.stringify({ error: error.message })) }
      }
    } else if (options.command === 'help') console.log('AI playtesting: init / inspect / act / report. Read docs/playtesting.md for operations, parallel workers, safe sequences and resumption.\nExample: node --experimental-strip-types scripts/playtest.mjs init --character silent --runs 50 --workers 4 --out artifacts/playtest/silent-50')
    else {
      const output = execute(options); console.log(JSON.stringify(output))
      if (output.error || output.errors?.length) process.exitCode = 1
    }
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 }
}
