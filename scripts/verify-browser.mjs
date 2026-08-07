// Drives the real app in a real browser: clicks cards, resolves turns, and
// asserts against the ENGINE state read through window.__STS_DEBUG__ rather
// than against pixels. Screenshots are written for human review, and the run
// fails on any console error, page error, or failed request.
//
// Usage: node scripts/verify-browser.mjs [--headed] [--out=dir]
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const headed = args.includes('--headed')
const outDir = join(
  repoRoot,
  (args.find((a) => a.startsWith('--out=')) ?? '--out=artifacts/browser').slice(6),
)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// Port 0 asks the OS for a free port. A fixed port collides whenever another
// copy of this suite is running — including verify-all's own parallelism.
const server = await createServer({
  root: repoRoot,
  logLevel: 'silent',
  server: { port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const base = `http://localhost:${address.port}`

const browser = await chromium.launch({ headless: !headed })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleErrors = []
const pageErrors = []
const requestFailures = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('requestfailed', (request) =>
  requestFailures.push(`${request.url()} ${request.failure()?.errorText ?? ''}`),
)
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().startsWith(base)) {
    requestFailures.push(`${response.status()} ${response.url()}`)
  }
})

const shots = []
async function shot(label) {
  const file = join(outDir, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  const state = await page.evaluate(() => window.__STS_DEBUG__.getState())
  writeFileSync(join(outDir, `${label}.state.json`), JSON.stringify(state, null, 2))
  shots.push(label)
  return state
}

const readState = () => page.evaluate(() => window.__STS_DEBUG__.getState())

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__ !== undefined)

suite('browser')

check('the app boots into a playable combat', () => {})
const booted = await shot('01-combat-start')
check('combat starts with a full hand and three energy', () => {
  assertEqual(booted.phase, 'player', 'the game should open on the Player Turn')
  assertEqual(booted.players[0].hand.length, 5, 'five cards are dealt')
  assertEqual(booted.players[0].energy, 3, 'energy starts at 3')
  assert(booted.die >= 1 && booted.die <= 6, `die should be 1-6, got ${booted.die}`)
})

// Play a card by clicking it and then clicking an enemy, the way a player does.
// Rows render highest-first, so the first enemy on screen is NOT enemies[0];
// the assertion compares total enemy HP instead of guessing which one was hit.
const beforePlay = await readState()
const totalEnemyHp = (state) => state.enemies.reduce((sum, enemy) => sum + enemy.hp, 0)

// Pick an attack rather than whichever card happens to be first, since a Skill
// would not damage anything and the check would be vacuous.
const attackIndex = beforePlay.players[0].hand.findIndex((card) => card.defId.startsWith('strike'))
assert(attackIndex >= 0, 'expected at least one Strike in the opening hand')
await page.locator('.hand .card').nth(attackIndex).click()
await page.locator('.enemy').first().click()
const afterPlay = await readState()

check('clicking a card then an enemy actually plays it', () => {
  assertEqual(afterPlay.players[0].hand.length, 4, 'the card leaves hand')
  assertEqual(afterPlay.players[0].energy, 2, 'energy is spent')
  assertEqual(afterPlay.players[0].discard.length, 1, 'and the card is discarded')
  assert(
    totalEnemyHp(afterPlay) < totalEnemyHp(beforePlay),
    `an enemy should have taken damage: ${totalEnemyHp(beforePlay)} -> ${totalEnemyHp(afterPlay)}`,
  )
})
await shot('02-after-card-played')

// Card art must actually load; a broken path renders an empty box that no state
// assertion would catch.
const artStatus = await page.evaluate(() =>
  [...document.querySelectorAll('.card__art')].map((img) => ({
    src: img.getAttribute('src'),
    ok: img.complete && img.naturalWidth > 0,
  })),
)
const cardArtDir = join(repoRoot, 'public/assets/cards')
const artSynced = existsSync(cardArtDir) && readdirSync(cardArtDir).length > 0
// A missing file under public/ is served by Vite's SPA fallback as 200 + HTML,
// so a network-status check cannot see it. Only naturalWidth tells the truth.
const enemyArtStatus = await page.evaluate(() =>
  [...document.querySelectorAll('.enemy__portrait > img')].map((img) => ({
    src: img.getAttribute('src'),
    ok: img.complete && img.naturalWidth > 0,
  })),
)
const enemyArtDir = join(repoRoot, 'public/assets/enemies')
const enemyArtSynced = existsSync(enemyArtDir) && readdirSync(enemyArtDir).length > 0
check('every enemy portrait on screen actually loaded', () => {
  assert(enemyArtStatus.length > 0, 'expected enemies to be rendered')
  if (!enemyArtSynced) return // artwork is not committed; nothing to load
  const broken = enemyArtStatus.filter((entry) => !entry.ok)
  assert(broken.length === 0, `broken enemy art: ${broken.map((b) => b.src).join(', ')}`)
})

check('every card image in hand actually loaded', () => {
  assert(artStatus.length > 0, 'expected cards to be rendered')
  if (!artSynced) {
    // Artwork is not committed (see ATTRIBUTION.md), so a fresh clone has none.
    // The cards still render; only the images are absent.
    return
  }
  const broken = artStatus.filter((entry) => !entry.ok)
  assert(broken.length === 0, `broken card art: ${broken.map((b) => b.src).join(', ')}`)
})

await page.getByRole('button', { name: 'End turn' }).click()
const afterEnd = await readState()
check('ending the turn discards the hand and hands over to the enemies', () => {
  assertEqual(afterEnd.players[0].hand.length, 0, 'the hand is discarded')
  assertEqual(afterEnd.phase, 'enemy', 'the Enemy Turn follows')
})
await shot('03-enemy-phase')

await page.getByRole('button', { name: 'Resolve enemies' }).click()
const afterEnemies = await readState()
check('resolving enemies returns play to the party', () => {
  assert(
    afterEnemies.phase === 'player' || afterEnemies.phase === 'lost',
    `expected the Player Turn or a loss, got ${afterEnemies.phase}`,
  )
})
await shot('04-after-enemy-turn')

// Four players is the maximum the box supports and the layout most likely to
// break, so it gets its own capture.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'four-player'))
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players.length === 4)
const four = await shot('05-four-players')
check('a four player game lays out one row per player', () => {
  assertEqual(four.players.length, 4, 'four seats')
  assertEqual(new Set(four.players.map((p) => p.row)).size, 4, 'each player gets their own row')
  assertEqual(four.enemies.length, 4, 'a normal encounter draws one enemy per player')
})

const rowCount = await page.locator('.row').count()
check('every player row is rendered on screen', () => {
  assertEqual(rowCount, 4, 'the board should show four rows')
})

// Nothing should overflow horizontally at any supported width.
for (const [label, width, height] of [
  ['06-mobile', 390, 844],
  ['07-tablet', 820, 1180],
  ['08-desktop-wide', 1920, 1080],
]) {
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(60)
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  check(`the layout does not overflow horizontally at ${width}px`, () => {
    assert(
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `page scrolls horizontally at ${width}px: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
    )
  })
  await shot(label)
}

// Cards that need a choice or an ally are the ones most easily broken by a UI
// rewrite: a wrong auto-commit silently skips the discard, exhaust or ally
// selection and quietly breaks the printed rule.
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  debug.reset(2, 'choice-flows')
  const state = structuredClone(debug.getState())
  const p1 = state.players[0]
  // Deal a known hand: Survivor (discard 1), True Grit (exhaust 1 + block ally),
  // Defend+ (block ally), and two spare cards to choose.
  p1.hand = [
    { uid: 'h-survivor', defId: 'survivor', upgraded: false },
    { uid: 'h-grit', defId: 'true_grit', upgraded: false },
    { uid: 'h-defendplus', defId: 'defend_ironclad', upgraded: true },
    { uid: 'h-spare1', defId: 'strike_ironclad', upgraded: false },
    { uid: 'h-spare2', defId: 'strike_ironclad', upgraded: false },
  ]
  p1.energy = 6
  debug.setState(state)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 5)

// The hand shrinks as cards are played, so the on-screen index has to be
// derived from live state rather than from a fixed list.
async function clickCard(uid) {
  const index = await page.evaluate(
    (target) => window.__STS_DEBUG__.getState().players[0].hand.findIndex((c) => c.uid === target),
    uid,
  )
  if (index < 0) throw new Error(`card ${uid} is not in hand`)
  await page.locator('.hand .card').nth(index).click()
}

// Survivor: stage it, then pick a card to discard.
await clickCard('h-survivor')
const stagedSurvivor = await page.locator('.prompt').textContent()
await clickCard('h-spare1')
const afterSurvivor = await readState()
check('Survivor requires a discard choice and actually discards', () => {
  assert(/Discard 1/i.test(stagedSurvivor ?? ''), `expected a discard prompt, got ${stagedSurvivor}`)
  const p1 = afterSurvivor.players[0]
  assertEqual(p1.block, 2, 'Survivor grants 2 Block')
  assert(
    p1.discard.some((c) => c.uid === 'h-spare1'),
    'the chosen card must actually reach the discard pile',
  )
  assert(!p1.hand.some((c) => c.uid === 'h-spare1'), 'and must leave hand')
})
await shot('09-survivor-choice')

// True Grit: exhaust a card, then choose which ally gets the Block.
await clickCard('h-grit')
await clickCard('h-spare2')
const gritPrompt = await page.locator('.prompt').textContent()
check('True Grit asks for an ally after the exhaust choice', () => {
  assert(
    /Choose who gets it/i.test(gritPrompt ?? ''),
    `after picking the exhaust target it must still ask for an ally, got ${gritPrompt}`,
  )
})
await page.locator('.seat').nth(0).click()
const afterGrit = await readState()
check('True Grit exhausts the chosen card and blocks the chosen ally', () => {
  const p1 = afterGrit.players[0]
  assert(p1.exhaust.some((c) => c.uid === 'h-spare2'), 'the chosen card should be exhausted')
  const blocked = afterGrit.players.reduce((sum, p) => sum + p.block, 0)
  assert(blocked > 2, `some player should have gained True Grit's Block, total was ${blocked}`)
})
await shot('10-true-grit-ally')

// A card whose width is unbounded turns aspect-ratio into runaway height. This
// caught a real regression where one enemy portrait grew to ~560px tall and the
// page to three times the viewport.
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(60)
const boxes = await page.evaluate(() => ({
  pageHeight: document.documentElement.scrollHeight,
  viewport: window.innerHeight,
  widest: Math.max(...[...document.querySelectorAll('.enemy')].map((el) => el.getBoundingClientRect().width), 0),
  tallest: Math.max(...[...document.querySelectorAll('.enemy')].map((el) => el.getBoundingClientRect().height), 0),
}))
check('enemy cards stay a sane size and the page does not run away', () => {
  assert(boxes.widest <= 320, `an enemy card is ${Math.round(boxes.widest)}px wide; cards should stay card-sized`)
  assert(boxes.tallest <= 320, `an enemy card is ${Math.round(boxes.tallest)}px tall; aspect-ratio has run away`)
  assert(
    boxes.pageHeight <= boxes.viewport * 1.5,
    `page is ${boxes.pageHeight}px for a ${boxes.viewport}px viewport; the board should fit`,
  )
})

writeFileSync(
  join(outDir, 'summary.json'),
  JSON.stringify(
    { screenshots: shots, consoleErrors, pageErrors, requestFailures },
    null,
    2,
  ),
)

check('the browser reported no errors', () => {
  assert(consoleErrors.length === 0, `console errors:\n    ${consoleErrors.join('\n    ')}`)
  assert(pageErrors.length === 0, `page errors:\n    ${pageErrors.join('\n    ')}`)
  assert(requestFailures.length === 0, `failed requests:\n    ${requestFailures.join('\n    ')}`)
})

await browser.close()
await server.close()
report('browser')
