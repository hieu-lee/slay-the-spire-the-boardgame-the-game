// Drives the real app in a real browser: clicks cards, resolves turns, and
// asserts against the ENGINE state read through window.__STS_DEBUG__ rather
// than against pixels. Screenshots are written for human review, and the run
// fails on any console error, page error, or failed request.
//
// Usage: node scripts/verify-browser.mjs [--headed] [--out=dir]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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

// Deliberately NOT wiped: a reviewer running this suite at the same time as
// verify-all would delete the directory out from under the other run. Files are
// overwritten in place instead, which is safe when two runs overlap.
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
  // Screenshots are the artefact a human reviews, so they must show the app as
  // a player sees it. Captured too early, lazy-loaded card art is still blank
  // and the picture misrepresents the product rather than documenting it.
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('img')].every((img) => img.complete),
      { timeout: 4000 },
    )
    .catch(() => {})
  const file = join(outDir, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  const state = await page.evaluate(() => window.__STS_DEBUG__.getState())
  writeFileSync(join(outDir, `${label}.state.json`), JSON.stringify(state, null, 2))
  shots.push(label)
  return state
}

const readRun = () => page.evaluate(() => window.__STS_DEBUG__.getRun())
const readState = () => page.evaluate(() => window.__STS_DEBUG__.getState())

async function confirmDiscard(player) {
  await page.getByLabel('Seat').selectOption(player.id)
  const name = player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByRole('button', { name: new RegExp(`^Confirm ${name}`) }).click()
}

async function confirmAllDiscards() {
  const selectedSeat = await page.getByLabel('Seat').inputValue()
  const state = await readState()
  for (const player of state.players.filter((candidate) => !candidate.dead)) {
    await confirmDiscard(player)
  }
  await page.getByLabel('Seat').selectOption(selectedSeat)
}

async function endTurn() {
  await page.getByRole('button', { name: 'End turn' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
  if ((await readState()).phase === 'discard') {
    await confirmAllDiscards()
  }
}

/** Clicks the first reachable room, which starts whatever that room is. */
async function enterFirstRoom() {
  await page.locator('.room--reachable').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
}

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__ !== undefined)

suite('browser')

// A run opens on the map with the boot beside the board (p.9).
const opening = await readRun()
await shot('01-map-start')
check('a run opens on the map with one way in', () => {
  assertEqual(opening.phase, 'map', 'the run should start on the map')
  assertEqual(opening.act, 1)
  assertEqual(opening.map.position, null, 'the boot starts beside the map')
})

const reachableAtStart = await page.locator('.room--reachable').count()
check('exactly one room is reachable at the start', () => {
  assertEqual(reachableAtStart, 1, 'the opening encounter is the only way in')
})

await enterFirstRoom()
const booted = await shot('02-combat-start')
check('the first room is an encounter and starts a combat', () => {
  assertEqual(booted.phase, 'player', 'combat opens on the Player Turn')
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
await shot('03-after-card-played')

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
const beforeDiscard = await readState()
check('end-of-turn effects resolve before the hand order is confirmed', () => {
  assertEqual(beforeDiscard.phase, 'discard', 'the game pauses for the post-trigger hand')
  assertEqual(beforeDiscard.players[0].hand.length, 4, 'the hand is still present for ordering')
})
await shot('03b-discard-order')
const discardPlayers = beforeDiscard.players.filter((player) => !player.dead)
await confirmDiscard(discardPlayers[0])
if (discardPlayers.length > 1) {
  const waitingForDiscards = await readState()
  check('one local seat cannot finalize another living player\'s hand', () => {
    assertEqual(waitingForDiscards.phase, 'discard', 'the other seat must confirm its own order')
    assertEqual(waitingForDiscards.players[0].hand.length, 4, 'no hand is discarded early')
  })
}
for (const player of discardPlayers.slice(1)) await confirmDiscard(player)
await page.getByLabel('Seat').selectOption(discardPlayers[0].id)
const afterEnd = await readState()
check('ending the turn discards the hand and hands over to the enemies', () => {
  assertEqual(afterEnd.players[0].hand.length, 0, 'the hand is discarded')
  assertEqual(afterEnd.phase, 'enemy', 'the Enemy Turn follows')
})
await shot('04-enemy-phase')

await page.getByRole('button', { name: 'Resolve enemies' }).click()
const afterEnemies = await readState()
check('resolving enemies ends the round and holds the board', () => {
  assert(
    afterEnemies.phase === 'roundEnd' || afterEnemies.phase === 'lost',
    `expected the round to end or the party to fall, got ${afterEnemies.phase}`,
  )
})
await shot('05-after-enemy-turn')

// The whole reason a combat is worth playing is that it lasts more than one
// round. This suite used to stop at the click above, which is exactly why the
// game shipped unplayable past round 1: nothing on screen started turn 2.
if (afterEnemies.phase === 'roundEnd') {
  await page.getByRole('button', { name: /Start turn 2/ }).click()
  const secondRound = await readState()
  check('a second round can actually be started and played', () => {
    assertEqual(secondRound.phase, 'player', 'the next Player Turn begins')
    assertEqual(secondRound.turn, 2, 'the turn counter advances')
    assertEqual(secondRound.players[0].hand.length, 5, 'a fresh hand is dealt')
    assertEqual(secondRound.players[0].energy, 3, 'and Energy is reset')
  })

  const beforeSecondPlay = await readState()
  const secondAttack = beforeSecondPlay.players[0].hand.findIndex((card) =>
    card.defId.startsWith('strike'),
  )
  assert(secondAttack >= 0, 'expected a Strike in the second hand')
  await page.locator('.hand .card').nth(secondAttack).click()
  await page.locator('.enemy').first().click()
  const afterSecondPlay = await readState()
  check('cards are playable in the second round, not just the first', () => {
    assertEqual(afterSecondPlay.players[0].hand.length, 4, 'the card leaves hand')
    assert(
      totalEnemyHp(afterSecondPlay) < totalEnemyHp(beforeSecondPlay),
      'and it still damages an enemy',
    )
  })
  await shot('05b-second-round')
}

// Play the encounter out to its end, clicking only what a player can click.
// The suite used to stop a few clicks in, which is how a combat that could not
// reach round 2 shipped green. A whole fight is the only thing that proves the
// loop closes.
async function playOutCombat(limit = 40) {
  for (let step = 0; step < limit; step++) {
    const state = await readState()
    if (state.phase === 'won' || state.phase === 'lost') return state

    if (state.phase === 'roundEnd') {
      await page.getByRole('button', { name: /^Start turn/ }).click()
      continue
    }
    if (state.phase === 'enemy') {
      await page.getByRole('button', { name: 'Resolve enemies' }).click()
      continue
    }

    // Player turn: swing with whatever is affordable, then end the turn.
    const attack = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.hand .card')]
      const index = cards.findIndex((card) => !card.disabled)
      return index
    })
    if (attack >= 0) {
      await page.locator('.hand .card').nth(attack).click()
      // Targeted cards need an enemy; untargeted ones resolve on the spot.
      const wantsTarget = await page.locator('.prompt').count()
      if (wantsTarget > 0) {
        const enemy = page.locator('.enemy:not([disabled])').first()
        if (await enemy.count()) await enemy.click()
        else await page.locator('.prompt__cancel').click()
      }
      continue
    }
    await endTurn()
  }
  throw new Error('the combat never ended')
}

const finished = await playOutCombat()
// Sampled from a FOUR-player round, which is where rounds actually run long.
// Against a short round these all pass trivially: a tail keeps every line, so
// the fixed-tail regression they exist to catch slips straight through.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'log-round'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
await endTurn()
await page.getByRole('button', { name: 'Resolve enemies' }).click()
await page.waitForFunction(() =>
  ['roundEnd', 'won', 'lost'].includes(window.__STS_DEBUG__.getState().phase),
)
const logShape = await page.evaluate(() => {
  const list = document.querySelector('.combat__log')
  if (!list) return null
  const items = [...list.querySelectorAll('li')]
  const listBox = list.getBoundingClientRect()
  const engineNewest = window.__STS_DEBUG__.getState().log.at(-1)
  const showing = items.find((li) => li.textContent.trim() === engineNewest.trim())
  const box = showing?.getBoundingClientRect()
  const colourOf = (el) => (el ? getComputedStyle(el).color : '')
  return {
    engineNewest,
    engineLines: window.__STS_DEBUG__.getState().log.length,
    // Everything since the round opened — what the panel is supposed to show.
    engineRound: (() => {
      const log = window.__STS_DEBUG__.getState().log
      let start = -1
      for (let i = log.length - 1; i >= 0; i--) {
        if (/^Turn \d+ begins/.test(log[i])) {
          start = i
          break
        }
      }
      return (start >= 0 ? log.slice(start) : log).map((line) => line.trim())
    })(),
    rendered: items.map((li) => li.textContent.trim()),
    found: showing != null,
    isFirst: showing != null && showing === items[0],
    fullyVisible: box != null && box.top >= listBox.top - 1 && box.bottom <= listBox.bottom + 1,
    overflowing: list.scrollHeight > list.clientHeight + 1,
    newestColour: colourOf(items[0]),
    // NOT the last item: that is usually the round divider, which has a colour
    // of its own — so the comparison passed even with the emphasis removed.
    olderColour: colourOf(
      items.slice(1).find((li) => !li.className.includes('combat__log-turn')) ?? null,
    ),
  }
})
check('the log shows the whole round, dropping nothing', () => {
  // A fixed tail silently dropped lines — a four-player enemy turn ran to
  // fifteen and rendered ten, losing a "hit for 4" without the box even
  // overflowing to hint that anything was missing.
  assert(logShape, 'expected a combat log on screen')
  assert(logShape.engineLines > 4, `the fight produced only ${logShape.engineLines} lines`)
  // Long enough that the tail this exists to catch would ACTUALLY cut it. The
  // regression was a fixed `slice(-10)`, so the round has to exceed ten lines
  // or the check passes with that bug still in place — which it did at nine.
  assert(
    logShape.engineRound.length > 10,
    `this round is only ${logShape.engineRound.length} lines; a 10-line tail would keep them all`,
  )
  assert(logShape.rendered.length > 1, 'more than one line should be rendered')
  const missing = logShape.engineRound.filter((line) => !logShape.rendered.includes(line))
  assertEqual(
    missing.length,
    0,
    `the log dropped ${missing.length} line(s) of this round: ${missing.join(' | ')}`,
  )
})
check('the newest line is rendered first and fully visible', () => {
  assert(
    logShape.found,
    `the engine's newest line "${logShape.engineNewest}" is not rendered: ${logShape.rendered.join(' | ')}`,
  )
  assert(logShape.isFirst, `the newest line should lead the list, not "${logShape.rendered[0]}"`)
  assert(
    logShape.fullyVisible,
    `the newest line "${logShape.engineNewest}" is clipped or scrolled out of its box`,
  )
})
check('the newest line is visibly emphasised, not just positioned', () => {
  assert(logShape.olderColour, 'need a non-divider older line to compare against')
  assert(
    logShape.newestColour !== logShape.olderColour,
    `the newest line looks identical to an older one (${logShape.newestColour})`,
  )
})

check('a whole encounter can be fought to its end', () => {
  assert(
    finished.phase === 'won' || finished.phase === 'lost',
    `the combat should end, got ${finished.phase}`,
  )
})
await shot('05c-combat-over')

// Victory is its own path — rewards, and the hand-off back to the map — and a
// starter deck does not reliably win the opening fight, so it is set up rather
// than hoped for. Testing "won or lost" alone would pass with the victory path
// completely broken.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'winnable'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const foe of run.combat.enemies) foe.hp = 1
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.every((foe) => foe.hp === 1))

const won = await playOutCombat()
check('a combat can actually be won', () => {
  assertEqual(won.phase, 'won', 'the party should win against 1 hit point of enemy')
  assert(won.enemies.every((foe) => foe.dead), 'and every enemy is dead')
})
await shot('05d-victory')

// The combat screen clears itself into the printed three-card reward (p.8).
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'reward', { timeout: 5000 })
const hiddenRewardRun = await readRun()
const revealButtons = await page.getByRole('button', { name: /^Reveal 3 for/ }).count()
check('card rewards stay face down until each player reveals or skips', () => {
  assertEqual(hiddenRewardRun.rewards.length, 2)
  assert(hiddenRewardRun.rewards.every((offer) => offer.choices === null), 'an offer leaked before reveal')
  assertEqual(revealButtons, 2)
})
await shot('05e-card-rewards-hidden')
for (const player of hiddenRewardRun.players) {
  await page.getByRole('button', { name: `Reveal 3 for ${player.name}` }).click()
}
await page.waitForFunction(() => document.querySelectorAll('.reward-screen__cards .card').length === 6)
// An upgraded reward still reveals base faces; only the card collected is
// upgraded. Force that printed reward type so the UI contract stays covered.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.rewards[0].upgraded = true
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.reward-screen__upgrade') !== null)
if (artSynced) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.reward-screen__cards .card__art')]
      .every((image) => image.complete && image.naturalWidth > 0),
  )
}
const rewardRun = await readRun()
const rewardCards = await page.locator('.reward-screen__cards .card').count()
const rewardArt = await page.locator('.reward-screen__cards .card__art').evaluateAll((images) =>
  images.map((image) => ({ src: image.getAttribute('src'), ok: image.complete && image.naturalWidth > 0 })),
)
const collectLocked = await page.getByRole('button', { name: 'Everyone must choose' }).isDisabled()
check('victory reveals three card rewards to every living player', () => {
  assertEqual(rewardRun.rewards.length, 2, 'both players receive their own reward')
  assertEqual(rewardCards, 6, 'three choices are shown per player')
  assert(collectLocked, 'the party cannot leave before everyone chooses')
  if (artSynced) {
    const broken = rewardArt.filter((entry) => !entry.ok)
    assertEqual(broken.length, 0, `broken reward art: ${broken.map((entry) => entry.src).join(', ')}`)
  }
})
await shot('05ea-card-rewards')
const firstReward = page.locator('.reward-screen__choice').first()
const baseRewardLabel = await firstReward.locator('.card').getAttribute('aria-label')
const baseRewardArt = await firstReward.locator('.card__art').getAttribute('src')
await firstReward.getByRole('button', { name: /^Show .* upgrade$/ }).click()
const upgradedRewardLabel = await firstReward.locator('.card').getAttribute('aria-label')
const upgradedRewardArt = await firstReward.locator('.card__art').getAttribute('src')
const previewPressed = await firstReward.getByRole('button', { name: /^Show .* base$/ }).getAttribute('aria-pressed')
const previewSelected = await firstReward.locator('.card').getAttribute('aria-pressed')
check('Full Knowledge previews both faces even when the collected reward will be upgraded', () => {
  assert(!(baseRewardLabel ?? '').includes('+,'), `the base face was not shown first: ${baseRewardLabel}`)
  assert((upgradedRewardLabel ?? '').includes('+,'), `the upgraded face is not announced: ${upgradedRewardLabel}`)
  assert(baseRewardArt !== upgradedRewardArt && upgradedRewardArt?.endsWith('+.webp'), 'the art did not flip')
  assertEqual(previewPressed, 'true', 'the upgrade preview control is not announced as pressed')
  assertEqual(previewSelected, 'false', 'previewing an upgrade must not choose the reward')
})
await shot('05eaa-card-reward-upgrade')
await firstReward.getByRole('button', { name: /^Show .* base$/ }).click()
await page.setViewportSize({ width: 390, height: 844 })
const mobileRewardLayout = await page.locator('.reward-screen').evaluate((element) => ({
  width: element.clientWidth,
  scrollWidth: element.scrollWidth,
  cards: [...element.querySelectorAll('.card')].slice(0, 3).map((card) => card.getBoundingClientRect().width),
  rows: [...element.querySelectorAll('.reward-screen__cards')].map((row) => ({
    width: row.clientWidth,
    scrollWidth: row.scrollWidth,
  })),
  hints: [...element.querySelectorAll('.reward-screen__scroll-hint')].map((hint) => ({
    text: hint.textContent,
    display: getComputedStyle(hint).display,
  })),
  previewTargets: [...element.querySelectorAll('.reward-screen__choice > button')].map((button) => {
    const rect = button.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }),
}))
check('mobile reward cards stay readable inside their own horizontal tray', () => {
  assert(mobileRewardLayout.scrollWidth <= mobileRewardLayout.width, 'the reward screen overflows sideways')
  assert(mobileRewardLayout.cards.every((width) => width >= 145), 'reward cards became too small to read')
  assert(mobileRewardLayout.rows.every((row) => row.scrollWidth > row.width), 'the card tray does not scroll')
  assert(
    mobileRewardLayout.hints.every((hint) => hint.display !== 'none' && hint.text?.includes('3 choices')),
    'the horizontal tray has no visible scroll/count affordance',
  )
  assert(
    mobileRewardLayout.previewTargets.every((target) => target.width >= 44 && target.height >= 44),
    'an upgrade-preview touch target is smaller than 44px',
  )
})
await shot('05eb-card-rewards-mobile')
await page.locator('.reward-screen').evaluate((element) => { element.scrollTop = element.scrollHeight })
const mobileCollectVisible = await page.getByRole('button', { name: 'Everyone must choose' }).evaluate((button) => {
  const box = button.getBoundingClientRect()
  return box.top >= 0 && box.bottom <= window.innerHeight
})
check('the final reward decision remains reachable on a phone', () => {
  assert(mobileCollectVisible, 'the collect control cannot be scrolled into view')
})
await shot('05ec-card-rewards-mobile-bottom')
await page.setViewportSize({ width: 1440, height: 900 })
await page.locator('.reward-screen').evaluate((element) => { element.scrollTop = 0 })

const deckSizesBeforeReward = rewardRun.players.map((player) => player.deck.length)
await page.locator('.reward-screen__player').nth(0).locator('.card').first().click()
const selectedCardPressed = await page.locator('.reward-screen__player').nth(0).locator('.card').first().getAttribute('aria-pressed')
await page.getByRole('button', { name: /Skip Silent's card/ }).click()
const skipSelection = await page.getByRole('button', { name: /Skip Silent's card/ }).evaluate((button) => ({
  pressed: button.getAttribute('aria-pressed'),
  text: button.textContent,
  background: getComputedStyle(button).backgroundColor,
}))
const unselectedSkipBackground = await page.getByRole('button', { name: /Skip Ironclad's card/ }).evaluate(
  (button) => getComputedStyle(button).backgroundColor,
)
check('a chosen skip is visibly and accessibly selected', () => {
  assertEqual(selectedCardPressed, 'true', 'the selected card is not exposed as pressed')
  assertEqual(skipSelection.pressed, 'true')
  assert(skipSelection.text.includes('✓'), 'the chosen skip has no visible checkmark')
  assert(skipSelection.background !== unselectedSkipBackground, 'the chosen skip looks like the default button')
})
await shot('05ed-card-rewards-chosen')
await page.getByRole('button', { name: 'Collect rewards' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const backOnMap = await readRun()
check('winning hands the party back to the map with somewhere to go', () => {
  assertEqual(backOnMap.phase, 'map', 'the run continues on the map')
  assert(backOnMap.map.position !== null, 'and the boot has moved onto the board')
  assert(
    backOnMap.map.rooms[backOnMap.map.position].visited,
    'the room just cleared is marked visited',
  )
  assertEqual(backOnMap.players[0].deck.length, deckSizesBeforeReward[0] + 1, 'the chosen card persists')
  assertEqual(backOnMap.players[0].deck.at(-1).upgraded, true, 'an upgraded reward upgrades only the collected card')
  assertEqual(backOnMap.players[1].deck.length, deckSizesBeforeReward[1], 'skipping adds no card')
})
await shot('05f-back-on-map')

// Hit feedback has to survive the rest of the combat. The flinch class used to
// stick forever the first time a state change landed inside its 380ms window
// without hurting anyone — and being unchanged, it then never re-animated.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'flinch'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')

// Orbs are board state the log talks about ("Defect's Lightning orb hit ...
// for 1"), so they have to be visible. Nothing rendered them at all.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].orbs = ['lightning', 'frost', null]
  const viewer = run.combat.players[0]
  viewer.miracles = 1
  viewer.energy = 2
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Use Miracle (+1 Energy)' }).click()
const miracleSpent = await readState()
check('the local board can spend a Miracle for Energy', () => {
  assertEqual(miracleSpent.players[0].miracles, 0)
  assertEqual(miracleSpent.players[0].energy, 3)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs[0] === 'lightning')
const orbView = await page.evaluate(() => ({
  beads: document.querySelectorAll('.seat--viewer .token--orb').length,
  classes: [...document.querySelectorAll('.seat--viewer .token--orb')].map((b) => b.className),
  label: document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
}))
check('channelled orbs are visible on the seat', () => {
  assertEqual(orbView.beads, 2, 'one bead per channelled orb')
  // The per-type class is what colours them; without it all three orb kinds
  // render as the same bead and the board stops telling you which is which.
  assert(
    orbView.classes.some((name) => name.includes('token--orb-lightning')),
    `expected a lightning bead: ${orbView.classes.join(' | ')}`,
  )
  assert(
    orbView.classes.some((name) => name.includes('token--orb-frost')),
    `expected a frost bead: ${orbView.classes.join(' | ')}`,
  )
  assert(orbView.label.includes('lightning orb'), `and named to a screen reader: ${orbView.label}`)
  assert(orbView.label.includes('frost orb'), `both of them: ${orbView.label}`)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].potions = ['block_potion', 'fire_potion']
  for (const enemy of run.combat.enemies) {
    enemy.block = 0
    enemy.abilityUsed = true
  }
  debug.setRun(run)
})
const blockBeforePotion = (await readState()).players[0].block
await page.locator('.combat__actions').getByRole('button', { name: /Block Potion/ }).click()
await page.waitForSelector('.seat--targetable')
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05f-block-potion-targeting')
await page.locator('.enemy:not([disabled])').first().click()
const wrongBlockTarget = await readState()
check('a support potion ignores enemy clicks while waiting for a player', () => {
  assertEqual(wrongBlockTarget.players[0].block, blockBeforePotion)
  assert(wrongBlockTarget.players[0].potions.includes('block_potion'))
})
await page.locator('.seat--viewer').click()
const blockedByPotion = await readState()
check('a support potion chooses a player from the combat board', () => {
  assertEqual(blockedByPotion.players[0].block, blockBeforePotion + 2)
  assertEqual(blockedByPotion.players[0].potions.includes('block_potion'), false)
})
const durabilityBeforePotion = blockedByPotion.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
await page.locator('.combat__actions').getByRole('button', { name: /Fire Potion/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05g-potion-targeting')
await page.locator('.enemy:not([disabled])').first().click()
const firedPotion = await readState()
check('a targeted potion waits for an enemy, then consumes itself', () => {
  const durability = firedPotion.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
  assertEqual(durability, durabilityBeforePotion - 4)
  assertEqual(firedPotion.players[0].potions.includes('fire_potion'), false)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].dead = true
  run.combat.players[0].potions = ['energy_potion']
  debug.setRun(run)
})
const deadPotionControls = await page.locator('.combat__actions').getByRole('button', { name: /Energy Potion/ }).count()
const deadPotionSummary = await page.locator('.seat--viewer .seat__potions').textContent()
check('a dead seat keeps public potion information but gets no Player Turn controls', () => {
  assertEqual(deadPotionControls, 0)
  assert(deadPotionSummary.includes('Energy Potion'))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].dead = false
  run.combat.players[0].potions = []
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].dead === false)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].strength = 8
  run.combat.players[0].strengthLossAtEndOfTurn = 0
  run.combat.players[0].potions = ['flex_potion']
  debug.setRun(run)
})
await page.locator('.combat__actions').getByRole('button', { name: /Flex Potion/ }).click()
const cappedFlex = await readState()
const cappedFlexReminder = await page.locator('.seat--viewer .seat__pending').textContent()
const cappedFlexSeatName = await page.locator('.seat--viewer').getAttribute('aria-label')
check('capped Flex shows its pending end-of-turn Strength loss', () => {
  assertEqual(cappedFlex.players[0].strength, 8)
  assertEqual(cappedFlex.players[0].strengthLossAtEndOfTurn, 1)
  assert(cappedFlexReminder.includes('−1 Strength at end of turn'))
  assert(cappedFlexSeatName.includes('Strength loss at end of turn 1'))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].strength = 0
  run.combat.players[0].strengthLossAtEndOfTurn = 0
  run.combat.players[0].potions = []
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].strength === 0)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const viewer = run.combat.players[0]
  viewer.hand = [{ uid: 'miracle-defend', defId: 'defend_ironclad', upgraded: false }]
  viewer.energy = 6
  viewer.miracles = 1
  viewer.shivs = 1
  viewer.weak = 0
  for (const enemy of run.combat.enemies) {
    enemy.block = 0
    enemy.vulnerable = 0
    // This probe measures one Shiv, not a first-damage special ability.
    enemy.abilityUsed = true
  }
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 6)
await page.getByRole('button', { name: 'Use Miracle on next card' }).click()
const miracleToggle = await page.getByRole('button', { name: /Use Miracle on next card/ }).getAttribute('aria-pressed')
await page.locator('.hand .card').click()
const cappedMiracle = await readState()
check('a capped Miracle can be spent atomically on the next card', () => {
  assertEqual(miracleToggle, 'true', 'the pending Miracle payment is not exposed as pressed')
  assertEqual(cappedMiracle.players[0].miracles, 0)
  assertEqual(cappedMiracle.players[0].energy, 6, 'Defend immediately consumes the temporary seventh Energy')
})

const durabilityBeforeShiv = cappedMiracle.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
await page.getByRole('button', { name: 'Use Shiv' }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy:not([disabled])').first().click()
const shivSpent = await readState()
check('the local board can aim and spend a Shiv', () => {
  assertEqual(shivSpent.players[0].shivs, 0)
  const durability = shivSpent.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
  assertEqual(durability, durabilityBeforeShiv - 1)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [{ uid: 'overflow-dance', defId: 'blade_dance', upgraded: false }]
  run.combat.players[0].energy = 3
  run.combat.players[0].shivs = 4
  run.combat.players[1].shivs = 1
  Object.assign(run.combat.enemies[0], { hp: 1, maxHp: 1, block: 0, dead: false })
  Object.assign(run.combat.enemies[1], { hp: 5, maxHp: 5, block: 0, dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.uid === 'overflow-dance')
await page.locator('.hand .card').click()
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.getByRole('button', { name: /5 of 5 hit points/ }).click()
const splitOverflow = await readState()
check('overflow Shivs choose independent targets', () => {
  assert(splitOverflow.enemies[0].dead, 'the first overflow Shiv should finish its target')
  assertEqual(splitOverflow.enemies[1].hp, 4, 'the second overflow Shiv should hit another target')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].orbs = [null, null, null]
  debug.setRun(run)
})

async function hurtViewer() {
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].hp -= 1
    debug.setRun(run)
  })
}

// Two alternating classes, so a second hit inside the window restarts the
// animation instead of leaving the class name unchanged.
const FLINCHING = '.seat--struck, .seat--struck-alt'
async function flinchCount(expected) {
  await page
    .waitForFunction(
      ({ want, selector }) => document.querySelectorAll(selector).length === want,
      { want: expected, selector: FLINCHING },
      { timeout: 2000 },
    )
    .catch(() => {})
  return page.locator(FLINCHING).count()
}

await hurtViewer()
const flinchedAtOnce = await flinchCount(1)
// A state change that hurts nobody, landing inside the flinch window.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].gold += 1
  debug.setRun(run)
})
const flinchCleared = await flinchCount(0)
await hurtViewer()
const flinchedAgain = await flinchCount(1)

check('a hit is felt, and keeps being felt for the rest of the combat', () => {
  assertEqual(flinchedAtOnce, 1, 'the damaged seat should flinch')
  assertEqual(flinchCleared, 0, 'and stop flinching even if another change interrupts')
  assertEqual(flinchedAgain, 1, 'and flinch again on the next hit')
})

// Two blows landing inside the same 380ms window: the class has to CHANGE, or
// the browser never restarts the animation and the second hit is not felt.
const beats = await page.evaluate(async () => {
  const seen = []
  document.addEventListener('animationstart', (event) => {
    if (event.animationName.startsWith('struck')) seen.push(event.animationName)
  })
  for (let i = 0; i < 2; i++) {
    // Re-read the bridge every time: App rebuilds it on each render, so a
    // captured reference keeps returning the state it closed over and the
    // second "hit" would silently write back the hit points already there.
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].hp -= 1
    debug.setRun(run)
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  await new Promise((resolve) => setTimeout(resolve, 120))
  return { count: seen.length, names: seen }
})
check('two hits in quick succession are both felt', () => {
  // The invariant is that the two flinches use DIFFERENT animations, which is
  // what makes the browser restart the second one. The exact event count is
  // not an invariant: StrictMode double-invokes the effect, so an extra
  // animationstart can legitimately land, and asserting equality made this
  // flaky — which is worse than not testing it at all.
  assert(beats.count >= 2, `expected at least two flinches, got ${beats.count}`)
  assertEqual(
    new Set(beats.names).size,
    2,
    `the two flinches must use different animations to restart: ${beats.names.join(', ')}`,
  )
})

// The enemy's remaining hit points are the number the whole turn is planned
// around. Twice it fell below the fold at small sizes because the board was
// sized by reasoning rather than measurement, so this measures.
//
// From a clean one-player board: this is about how the board is SIZED, and by
// this point in the suite the seat carries injected Powers and tokens that
// make the row taller for unrelated reasons.
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'fold'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 1)
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
const foldProbe = []
for (const size of [
  { width: 360, height: 720 },
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
]) {
  await page.setViewportSize(size)
  foldProbe.push(
    await page.evaluate((label) => {
      const board = document.querySelector('.board')
      const bar = document.querySelector('.enemy .bar')
      if (!board || !bar) return { label, missing: true }
      const b = board.getBoundingClientRect()
      const r = bar.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        label,
        missing: false,
        inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        // Inside the board is not enough: the board itself can sit partly off
        // the page, so the viewport is the thing that decides whether a player
        // can actually see the number.
        onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
        onTop: !!hit?.closest('.bar'),
      }
    }, `${size.width}x${size.height}`),
  )
}
await page.setViewportSize({ width: 1440, height: 900 })
check("an enemy's hit points are on screen without scrolling, at every size", () => {
  for (const probe of foldProbe) {
    assert(!probe.missing, `${probe.label}: no enemy bar found`)
    assert(probe.inside, `${probe.label}: the bar is outside the board's visible box`)
    assert(probe.onScreen, `${probe.label}: the bar is off the viewport entirely`)
    assert(probe.onTop, `${probe.label}: the bar is covered by something else`)
  }
})

// And during the round-end pause, where the log opens up and used to squeeze
// the board until the bar was sliced — exactly when the pause asks you to read
// the board.
//
// From a clean board on purpose: this is about the LOG's effect on the board,
// and by this point in the suite the seat carries injected Powers and tokens
// that make the row taller for reasons that have nothing to do with the log.
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'pause'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 1)
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
await endTurn()
await page.getByRole('button', { name: 'Resolve enemies' }).click()
await page.waitForFunction(() =>
  ['roundEnd', 'won', 'lost'].includes(window.__STS_DEBUG__.getState().phase),
)
const pauseProbe = []
for (const size of [
  { width: 360, height: 720 },
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
]) {
  await page.setViewportSize(size)
  pauseProbe.push(
    await page.evaluate((label) => {
      const board = document.querySelector('.board')
      const bar = document.querySelector('.enemy .bar')
      if (!board || !bar) return { label, missing: true }
      const b = board.getBoundingClientRect()
      const r = bar.getBoundingClientRect()
      return {
        label,
        missing: false,
        inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
      }
    }, `${size.width}x${size.height}`),
  )
}
await page.setViewportSize({ width: 1440, height: 900 })
// And on the FOUR-player board, where the rows are tightest and the portrait
// squash rules apply. Both fold probes ran only on the two-player board, so
// the squash could be deleted with everything green.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'fold-four'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
const crowdedState = await readState()
const crowdedEnemyCount = crowdedState.enemies.length
const crowdedViewerRow = crowdedState.players[0].row
const crowdedViewerEnemyCount = crowdedState.enemies
  .filter((enemy) => !enemy.isBoss && enemy.row === crowdedViewerRow).length
const crowdedProbe = []
// The whole four-row board scrolls, but the row you control — including every
// summon in it — must fit at each supported size.
for (const size of [
  { width: 390, height: 844 },
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
]) {
  await page.setViewportSize(size)
  // The board scrolls the viewer's row into view on resize; give it a frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  crowdedProbe.push(
    await page.evaluate((label) => {
      const bars = [...document.querySelectorAll('.enemy .bar')]
      const board = document.querySelector('.board')
      if (!board || bars.length === 0) return { label, missing: true }
      const b = board.getBoundingClientRect()
      // The row the viewer controls is the one scrolled into view, so its
      // main enemy AND every summon must be readable at once.
      const own = [...document.querySelectorAll('.row--viewer .enemy .bar')]
      const rects = own.map((bar) => bar.getBoundingClientRect())
      return {
        label,
        missing: false,
        rows: bars.length,
        own: own.length,
        inside: rects.every((r) => r.top >= b.top - 1 && r.bottom <= b.bottom + 1),
        onScreen: rects.every((r) => r.top >= 0 && r.bottom <= window.innerHeight),
      }
    }, `4p ${size.width}x${size.height}`),
  )
}
await page.setViewportSize({ width: 1440, height: 900 })

check("a four-player board still shows the viewer's own enemy", () => {
  for (const probe of crowdedProbe) {
    assert(!probe.missing, `${probe.label}: no enemy bar found`)
    assertEqual(probe.rows, crowdedEnemyCount, `${probe.label}: every main enemy and summon is visible`)
    assertEqual(probe.own, crowdedViewerEnemyCount, `${probe.label}: viewer-row summon count`)
    assert(probe.inside, `${probe.label}: the bar is outside the board's visible box`)
    assert(probe.onScreen, `${probe.label}: the bar is off the viewport entirely`)
  }
})

check("an enemy's hit points stay on screen during the round-end pause", () => {
  for (const probe of pauseProbe) {
    assert(!probe.missing, `${probe.label}: no enemy bar found`)
    assert(probe.inside, `${probe.label}: the log squeezed the bar out of the board`)
    assert(probe.onScreen, `${probe.label}: the bar is off the viewport entirely`)
  }
})

// A dead enemy must stop telegraphing and stop announcing tokens: a corpse
// showing an attack it will never make is misleading while choosing a target.
const corpse = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const foe = run.combat.enemies[0]
  foe.hp = 0
  foe.dead = true
  foe.poison = 3
  foe.block = 2
  debug.setRun(run)
  return foe.uid
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].dead)
const corpseView = await page.evaluate(() => {
  const tile = document.querySelector('.enemy--dead')
  return {
    found: tile != null,
    intents: tile?.querySelectorAll('.intent').length ?? -1,
    tokens: tile?.querySelectorAll('.token').length ?? -1,
    disabled: tile?.disabled ?? false,
    label: tile?.getAttribute('aria-label') ?? '',
  }
})
check('a defeated enemy stops telegraphing and stops carrying tokens', () => {
  assert(corpseView.found, `expected a defeated enemy on the board (${corpse})`)
  assertEqual(corpseView.intents, 0, 'a corpse has no intent')
  assertEqual(corpseView.tokens, 0, 'and no tokens')
  assert(corpseView.disabled, 'and cannot be clicked')
  assert(corpseView.label.includes('defeated'), `and says so: ${corpseView.label}`)
})

// A cost the hand cannot fully pay must still be committable — the engine
// accepts it, and the UI used to demand the printed count and strand the card.
const lastCard = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const me = run.combat.players[0]
  me.hand = [{ uid: 'solo-survivor', defId: 'survivor', upgraded: false }]
  me.energy = 3
  me.block = 0
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  document.querySelector('.hand .card')?.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const state = window.__STS_DEBUG__.getState()
  return { block: state.players[0].block, hand: state.players[0].hand.length }
})
check('a card whose cost the hand cannot pay is still playable', () => {
  assertEqual(lastCard.hand, 0, 'the card left the hand')
  assert(lastCard.block > 0, `and it resolved, giving Block (got ${lastCard.block})`)
})

// An evoke with nothing to evoke is refused by the engine, and a refusal is
// reference-equality — so the card must not be clickable in the first place,
// or the click lands and appears to do nothing at all.
const emptyEvoke = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const me = run.combat.players[0]
  me.hand = [{ uid: 'solo-dual', defId: 'dual_cast', upgraded: false }]
  me.orbs = [null, null, null]
  me.energy = 3
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const card = document.querySelector('.hand .card')
  return { disabled: card?.disabled ?? false }
})
check('a card that cannot resolve is not offered', () => {
  assert(emptyEvoke.disabled, 'Dual Cast with no orbs charged should be greyed out')
})

// A row card and a single-target card are the same interaction -- click one
// enemy -- so without a mark on the card and a word in the prompt, nothing
// tells the player that Cleave hits the crowd and Strike does not.
const aoeAffordance = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const me = run.combat.players[0]
  me.hand = [
    { uid: 'aoe-cleave', defId: 'cleave', upgraded: false },
    { uid: 'aoe-strike', defId: 'strike_ironclad', upgraded: false },
  ]
  me.energy = 3
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  const cards = [...document.querySelectorAll('.hand .card')]
  const badges = cards.map((card) => card.querySelector('.card__aoe') !== null)
  const names = cards.map((card) => card.getAttribute('aria-label') ?? '')
  // A bounding box and `visibility` are not enough on their own: the Icon
  // renders <img width=18 height=18>, so the box is 18x18 even if the file
  // 404s, and both `opacity: 0` and a badge parked off-screen keep a box of
  // that size. So walk up to the card accumulating opacity, and require the
  // badge to sit INSIDE the card it belongs to.
  const painted = cards.map((card) => {
    const badge = card.querySelector('.card__aoe img')
    if (!badge) return null
    const box = badge.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    let opacity = 1
    for (let node = badge; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      opacity *= Number(style.opacity)
    }
    return (
      box.width > 0 &&
      box.height > 0 &&
      opacity > 0.1 &&
      box.left >= cardBox.left - 1 &&
      box.right <= cardBox.right + 1 &&
      box.top >= cardBox.top - 1 &&
      box.bottom <= cardBox.bottom + 1
    )
  })

  // Stage the row card and read the prompt it asks the player for.
  cards[0].click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const rowPrompt = document.querySelector('.prompt')?.textContent ?? ''

  // And the single-target card, so the prompt is pinned in BOTH directions --
  // `hitsRow` is its own code path in CombatScreen, not the one the badge uses,
  // so a version that claimed every card takes a row would pass otherwise.
  document.querySelectorAll('.hand .card')[1]?.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const singlePrompt = document.querySelector('.prompt')?.textContent ?? ''

  return { badges, names, painted, rowPrompt, singlePrompt }
})
check('a card that takes a whole row says so', () => {
  assert(aoeAffordance.badges[0], 'Cleave should carry the area-of-effect burst')
  assert(!aoeAffordance.badges[1], 'a single-target Strike should not')
  assert(
    aoeAffordance.painted[0] === true,
    'and the burst must actually be painted, not merely present in the markup',
  )
  assert(
    /hits a whole row and any boss/.test(aoeAffordance.names[0]),
    `the card's accessible name should carry the reach: "${aoeAffordance.names[0]}"`,
  )
  assert(
    !/hits a whole row/.test(aoeAffordance.names[1]),
    `and a single-target card should not claim it: "${aoeAffordance.names[1]}"`,
  )
  assert(
    /whole row/.test(aoeAffordance.rowPrompt),
    `the prompt should say the row is hit, got "${aoeAffordance.rowPrompt}"`,
  )
  assert(
    !/whole row/.test(aoeAffordance.singlePrompt),
    `a single-target card must not claim a row, got "${aoeAffordance.singlePrompt}"`,
  )
})

// The face is a scan, so the printed text is an image nobody's screen reader
// will ever read. The accessible name is the only card text some players get.
const exhaustName = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [{ uid: 'ex-1', defId: 'poisoned_stab', upgraded: false }]
  run.combat.players[0].energy = 3
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return document.querySelector('.hand .card')?.getAttribute('aria-label') ?? ''
})
check('a card that spends itself says so too', () => {
  assert(
    /exhausts when played/.test(exhaustName),
    `Poisoned Stab exhausts and should announce it: "${exhaustName}"`,
  )
})

// The hand is fanned, not stacked: each card tilted by its distance from the
// middle. Zeroing the angle and the lift left a flat row and passed everything.
// Its own hand, because the check above deliberately leaves one card.
await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = Array.from({ length: 5 }, (_unused, i) => ({
    uid: `fan-${i}`,
    defId: 'strike_ironclad',
    upgraded: false,
  }))
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
})
const fanShape = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.hand .card')]
  if (cards.length < 3) return { few: true }
  const matrix = (card) => getComputedStyle(card).transform
  return {
    few: false,
    count: cards.length,
    first: matrix(cards[0]),
    middle: matrix(cards[Math.floor(cards.length / 2)]),
    last: matrix(cards[cards.length - 1]),
  }
})
check('the hand is fanned rather than laid flat', () => {
  assert(!fanShape.few, 'need at least three cards to see a fan')
  assert(fanShape.first !== 'none', 'the outer cards should be transformed')
  assert(
    fanShape.first !== fanShape.last,
    `the two ends of the fan should tilt opposite ways, both are ${fanShape.first}`,
  )
  assert(
    fanShape.first !== fanShape.middle,
    'the middle card should sit straighter than the ends',
  )
})

// The telegraph belongs ABOVE the creature, the way the video game shows it.
// Its position comes from the markup order, so swapping the two spans back
// would silently undo it.
const intentPlace = await page.evaluate(() => {
  const enemy = document.querySelector('.enemy')
  const intent = enemy?.querySelector('.enemy__intent')
  const portrait = enemy?.querySelector('.enemy__portrait')
  if (!intent || !portrait) return { missing: true }
  return {
    missing: false,
    intentBottom: Math.round(intent.getBoundingClientRect().bottom),
    portraitTop: Math.round(portrait.getBoundingClientRect().top),
  }
})
check('an enemy telegraphs above itself', () => {
  assert(!intentPlace.missing, 'expected an enemy with an intent')
  assert(
    intentPlace.intentBottom <= intentPlace.portraitTop + 1,
    `the intent sits below the portrait (${intentPlace.intentBottom} vs ${intentPlace.portraitTop})`,
  )
})

// The energy count sits ON the gold disc, so it cannot be gold.
const energyContrast = await page.evaluate(() => {
  const pip = document.querySelector('.pip--energy')
  const number = pip?.querySelector('.icon-value__number')
  if (!pip || !number) return { missing: true }
  const parse = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number)
  const lum = ([r, g, b]) => {
    const channel = (v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const ink = lum(parse(getComputedStyle(number).color))
  // The disc is a gradient; sample its lightest declared stop conservatively.
  const plate = lum([255, 226, 150])
  const ratio = (Math.max(ink, plate) + 0.05) / (Math.min(ink, plate) + 0.05)
  return { missing: false, ratio }
})
check('the energy count is readable on its disc', () => {
  assert(!energyContrast.missing, 'expected an energy pip')
  assert(
    energyContrast.ratio >= 4.5,
    `the count contrasts at ${energyContrast.ratio.toFixed(2)}:1 against the disc`,
  )
})

// Four players is the maximum the box supports and the layout most likely to
// break, so it gets its own capture.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'four-player'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await shot('06a-four-player-map')
await enterFirstRoom()
const four = await shot('06-four-players')
check('a four player game lays out one row per player', () => {
  const mainEnemies = four.enemies.filter((enemy) => !enemy.uid.includes('-summon'))
  assertEqual(four.players.length, 4, 'four seats')
  assertEqual(new Set(four.players.map((p) => p.row)).size, 4, 'each player gets their own row')
  assertEqual(mainEnemies.length, 4, 'a normal encounter draws one card per player')
  assertEqual(new Set(mainEnemies.map((enemy) => enemy.defId)).size, 4, 'opening cards are not duplicated')
})

const rowCount = await page.locator('.row').count()
check('every player row is rendered on screen', () => {
  assertEqual(rowCount, 4, 'the board should show four rows')
})
const enemyAbilities = await page.locator('.enemy').evaluateAll((enemies) => enemies.map((enemy) => ({
  text: enemy.querySelector('.enemy__ability')?.textContent ?? '',
  label: enemy.getAttribute('aria-label') ?? '',
})))
check('printed enemy special abilities are visible and announced', () => {
  const curl = enemyAbilities.find((ability) => ability.text.includes('Curl Up'))
  assert(curl, 'the Louse Curl Up ability is absent from the board')
  assert(curl.label.includes('after the first damage'), `the accessible rule is incomplete: ${curl.label}`)
})
await page.locator('.hand .card[aria-label^="Strike,"]').first().click()
await page.locator('.enemy').filter({ hasText: 'Red Louse' }).click()
await page.waitForFunction(() => document.querySelector('.enemy__ability--spent') !== null)
const spentCurl = await page.locator('.enemy__ability--spent').evaluate((ability) => ({
  text: ability.textContent ?? '',
  label: ability.closest('.enemy')?.getAttribute('aria-label') ?? '',
  decoration: getComputedStyle(ability).textDecorationLine,
}))
check('a used Curl Up is visibly and accessibly spent', () => {
  assert(spentCurl.text.includes('spent'), `the visible ability still looks active: ${spentCurl.text}`)
  assert(spentCurl.label.includes('spent'), `the accessible ability still sounds active: ${spentCurl.label}`)
  assert(spentCurl.decoration.includes('line-through'), 'the spent state has no non-colour visual treatment')
})

// A normal Red Louse encounter can put a main enemy plus two summons in one
// row. The fixed opening only reaches two, so exercise the real wider case.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const state = run.combat
  const row = state.players[0].row
  const red = state.enemies.find((enemy) => enemy.defId === 'red_louse')
  state.enemies.push({
    ...red,
    uid: 'layout-third-enemy',
    row,
    isBoss: false,
    hp: red.maxHp,
    block: 0,
    abilityUsed: false,
  })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.row--viewer .enemy').length === 3)
const threeEnemyProbe = []

// Nothing should overflow horizontally at any supported width.
for (const [label, width, height] of [
  ['07-mobile', 390, 844],
  ['08-tablet', 820, 1180],
  ['09-desktop-wide', 1920, 1080],
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
  threeEnemyProbe.push(await page.evaluate((size) => {
    const board = document.querySelector('.board')
    const row = document.querySelector('.row--viewer')
    const bars = [...document.querySelectorAll('.row--viewer .enemy .bar')]
    if (!board || !row || bars.length !== 3) return { size, missing: true }
    const boardRect = board.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const rects = bars.map((bar) => bar.getBoundingClientRect())
    return {
      size,
      missing: false,
      insideRow: rects.every((rect) => rect.left >= rowRect.left - 1 && rect.right <= rowRect.right + 1),
      insideBoard: rects.every((rect) => rect.top >= boardRect.top - 1 && rect.bottom <= boardRect.bottom + 1),
      onScreen: rects.every((rect) => rect.top >= 0 && rect.bottom <= window.innerHeight),
    }
  }, `${width}x${height}`))
}

check('three enemies in one player row remain readable at every supported width', () => {
  for (const probe of threeEnemyProbe) {
    assert(!probe.missing, `${probe.size}: expected three enemy health bars`)
    assert(probe.insideRow, `${probe.size}: an enemy clips outside its player row`)
    assert(probe.insideBoard, `${probe.size}: an enemy health bar clips outside the board`)
    assert(probe.onScreen, `${probe.size}: an enemy health bar is off screen`)
  }
})

// Cards that need a choice or an ally are the ones most easily broken by a UI
// rewrite: a wrong auto-commit silently skips the discard, exhaust or ally
// selection and quietly breaks the printed rule.
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'choice-flows'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const state = run.combat
  const p1 = state.players[0]
  // Deal a known hand: Survivor (discard 1), True Grit (exhaust 1 + block ally),
  // Predator (enemy + ally), and two spare cards to choose.
  p1.hand = [
    { uid: 'h-survivor', defId: 'survivor', upgraded: false },
    { uid: 'h-grit', defId: 'true_grit', upgraded: false },
    { uid: 'h-predator', defId: 'predator', upgraded: false },
    { uid: 'h-backstab', defId: 'backstab', upgraded: false },
    { uid: 'h-sweeping', defId: 'sweeping_beam', upgraded: false },
    { uid: 'h-spare1', defId: 'strike_ironclad', upgraded: false },
    { uid: 'h-spare2', defId: 'strike_ironclad', upgraded: false },
    { uid: 'h-fnp', defId: 'feel_no_pain', upgraded: false },
    { uid: 'h-heavy', defId: 'heavy_blade', upgraded: false },
    { uid: 'h-heavy-plus', defId: 'heavy_blade', upgraded: true },
  ]
  p1.energy = 6
  debug.setRun(run)
})
// Wait for a card that ONLY the injected hand contains. Waiting on hand.length
// is not enough: the natural opening hand is also five cards, so the condition
// can be true before the injection lands. That raced about one run in eight.
await page.waitForFunction(() =>
  window.__STS_DEBUG__.getState()?.players[0].hand.some((card) => card.uid === 'h-survivor'),
)
// And wait for React to actually render that hand before clicking by index.
await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 10)
const injectedLabels = await page.locator('.hand .card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label') ?? ''),
)
check('scanned card labels include conditional numbers and support targets', () => {
  const backstab = injectedLabels.find((label) => label.startsWith('Backstab')) ?? ''
  const predator = injectedLabels.find((label) => label.startsWith('Predator')) ?? ''
  const sweeping = injectedLabels.find((label) => label.startsWith('Sweeping Beam')) ?? ''
  const feelNoPain = injectedLabels.find((label) => label.startsWith('Feel No Pain')) ?? ''
  const heavy = injectedLabels.find((label) => label.startsWith('Heavy Blade,')) ?? ''
  const heavyPlus = injectedLabels.find((label) => label.startsWith('Heavy Blade+')) ?? ''
  assert(backstab.includes('2 if the target is at full hit points'), `Backstab bonus is missing: ${backstab}`)
  assert(predator.includes('support effect may target any player'), `Predator support target is missing: ${predator}`)
  assert(sweeping.includes('hits every enemy'), `Sweeping Beam target is missing: ${sweeping}`)
  assert(feelNoPain.includes('whenever you exhaust a card'), `Power trigger is missing: ${feelNoPain}`)
  assert(heavy.includes('3 per Strength'), `Heavy Blade multiplier is wrong: ${heavy}`)
  assert(heavyPlus.includes('5 per Strength'), `Heavy Blade+ multiplier is wrong: ${heavyPlus}`)
})

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
await shot('10-survivor-choice')

// True Grit: exhaust a card, then choose which ally gets the Block.
await clickCard('h-grit')
await clickCard('h-spare2')
const gritPrompt = await page.locator('.prompt').textContent()
const pickedPressed = await page.locator('.hand .card--picked').getAttribute('aria-pressed')
check('True Grit asks for an ally after the exhaust choice', () => {
  assert(
    /Choose who gets it/i.test(gritPrompt ?? ''),
    `after picking the exhaust target it must still ask for an ally, got ${gritPrompt}`,
  )
  assertEqual(pickedPressed, 'true', 'the picked exhaust card is not announced as selected')
})
await page.locator('.seat').nth(0).click()
const afterGrit = await readState()
check('True Grit exhausts the chosen card and blocks the chosen ally', () => {
  const p1 = afterGrit.players[0]
  assert(p1.exhaust.some((c) => c.uid === 'h-spare2'), 'the chosen card should be exhausted')
  const blocked = afterGrit.players.reduce((sum, p) => sum + p.block, 0)
  assert(blocked > 2, `some player should have gained True Grit's Block, total was ${blocked}`)
})
await shot('11-true-grit-ally')

// Predator needs two independent choices: who it attacks, then who draws.
const allyHandBeforePredator = (await readState()).players[1].hand.length
await clickCard('h-predator')
await page.locator('.enemy:not([disabled])').first().click()
const predatorPrompt = await page.locator('.prompt').textContent()
check('Predator asks for its ally after its enemy is chosen', () => {
  assert(/Choose who gets it/i.test(predatorPrompt ?? ''), `expected an ally prompt, got ${predatorPrompt}`)
})
await page.locator('.seat:not(.seat--viewer)').click()
const afterPredator = await readState()
check('Predator draws two cards for the chosen ally', () => {
  assertEqual(afterPredator.players[1].hand.length, allyHandBeforePredator + 2)
})

// Enemies can Weaken players and make them Vulnerable. If the seat panel does
// not show those tokens, a player cannot see a debuff that is affecting them.
// reset() goes through React state, so reading it back in the same tick would
// see the old run. Wait for it to land before touching anything.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'debuff-display'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await page.locator('.room--reachable').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].weak = 2
  run.combat.players[0].vulnerable = 1
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].weak === 2)
const seatTokens = await page.evaluate(() =>
  [...document.querySelectorAll('.seat .token')].map((el) => el.className),
)
// aria-label replaces the button's contents wholesale, so anything left out of
// it is unreachable no matter how it is marked up — which is how the tokens'
// own hidden labels ended up invisible. The class-name check above cannot see
// that; this reads the label a screen reader would actually announce.
const debuffLabel = await page.evaluate(
  () => document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
)
check('the seat announces its debuffs, not just renders them', () => {
  assert(/Weak \d/.test(debuffLabel), `expected a Weak count in: ${debuffLabel}`)
  assert(/Vulnerable \d/.test(debuffLabel), `expected a Vulnerable count in: ${debuffLabel}`)
})

check('a player can see the Weak and Vulnerable on their own seat', () => {
  assert(
    seatTokens.some((name) => name.includes('token--weak')),
    `expected a Weak token on the seat, saw: ${seatTokens.join(', ') || 'none'}`,
  )
  assert(
    seatTokens.some((name) => name.includes('token--vulnerable')),
    `expected a Vulnerable token on the seat, saw: ${seatTokens.join(', ') || 'none'}`,
  )
})
await shot('13-player-debuffs')

// A Power stays in play for the whole combat and changes how every turn plays
// out. If it is not on screen the player cannot plan around it.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].powers = [
    { uid: 'pw-1', defId: 'demon_form', upgraded: false },
    { uid: 'pw-2', defId: 'metallicize', upgraded: false },
  ]
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 2)

// Powers render as their own card art, so the assertion is that the images
// actually LOADED — a broken scan would leave the seat blank while a check on
// markup alone still passed. `complete` also goes true on FAILURE, so waiting
// on it settles the race without hiding a genuinely broken path.
await page.waitForFunction(() => {
  const art = [...document.querySelectorAll('.row__seat .power .power__art')]
  return art.length === 2 && art.every((img) => img.complete)
})
const powerArt = await page.evaluate(() =>
  [...document.querySelectorAll('.row__seat .power')].map((button) => {
    const img = button.querySelector('.power__art')
    return {
      alt: button.getAttribute('aria-label') ?? '',
      loaded: img.complete && img.naturalWidth > 0,
      width: img.getBoundingClientRect().width,
      isButton: button.tagName === 'BUTTON',
      focusable: button.tabIndex >= 0,
    }
  }),
)
check('Powers in play are shown on the seat as card art', () => {
  assertEqual(powerArt.length, 2, 'both Powers should be on the seat')
  for (const art of powerArt) {
    assert(art.loaded, `the Power's card scan failed to load: ${art.alt}`)
    assert(art.width > 8, `the Power thumbnail collapsed to ${art.width}px`)
  }
})

// The name fallback exists only for a missing scan. It is absolutely
// positioned over the tile, so if it ever paints ABOVE the art the thumbnail
// silently turns back into a text chip — which is exactly what it replaced.
const topmostOverPower = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
  if (!tile) return 'no tile'
  const box = tile.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return hit?.className ?? 'nothing'
})
check('the card art paints over the name fallback, not under it', () => {
  assert(
    String(topmostOverPower).includes('power__art'),
    `expected the art on top of the tile, found: ${topmostOverPower}`,
  )
})

// The enlarge has to escape the board's scroll container. It previously did
// not, and this suite missed it by hovering ONE tile at ONE viewport where the
// popover happened to fit inside the board's box. Every tile, two sizes.
const hoverProbes = []
for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 620 },
  // Narrow enough that a 190px card anchored at the tile would overflow the
  // right edge, which is the only way the horizontal clamp is exercised.
  { width: 360, height: 720 },
]) {
  await page.setViewportSize(size)
  const tiles = await page.locator('.row__seat .power').count()
  for (let i = 0; i < tiles; i++) {
    await page.locator('.row__seat .power').nth(i).hover()
    await page.waitForSelector('.power__zoom')
    hoverProbes.push(
      await page.evaluate(
        (label) => {
          const img = document.querySelector('.power__zoom')
          if (!img) return { label, missing: true }
          const box = img.getBoundingClientRect()
          return {
            label,
            missing: false,
            width: Math.round(box.width),
            height: Math.round(box.height),
            left: Math.round(box.left),
            top: Math.round(box.top),
            right: Math.round(box.right),
            bottom: Math.round(box.bottom),
            viewport: { w: window.innerWidth, h: window.innerHeight },
            // The card is `pointer-events: none` so that moving onto it does
            // not end the hover, which means elementFromPoint looks straight
            // through it. Whether it is actually PAINTED is checked below by
            // screenshotting the region instead.
            visible: getComputedStyle(img).visibility === 'visible',
          }
        },
        `${size.width}x${size.height} tile ${i}`,
      ),
    )
  }
}
await page.setViewportSize({ width: 1440, height: 900 })

// Re-hover after the resize. Changing the viewport re-renders and drops the
// zoom, so reading it straight afterwards found `null` roughly one run in
// twelve and reported it as the card being parented wrongly. This is the same
// cause as an earlier flake in this file: a hover does not survive a resize.
await page.locator('.row__seat .power').first().hover()
await page.waitForSelector('.power__zoom')

// The clipping bug this all exists for was caused by the card being a
// DESCENDANT of the board. Geometry alone cannot see that — at a viewport
// where the board happens not to clip, an inline card looks identical.
const zoomParent = await page.evaluate(() => {
  const img = document.querySelector('.power__zoom')
  return {
    parentIsBody: img?.parentElement === document.body,
    parent: img?.parentElement?.className ?? img?.parentElement?.tagName ?? 'none',
  }
})
check('the enlarged card is rendered outside the board, not inside it', () => {
  assert(
    zoomParent.parentIsBody,
    `the enlarged card is a child of "${zoomParent.parent}" — anything with a scroll box will clip it`,
  )
})

// The clamp only does anything when the tile sits close enough to an edge that
// an unclamped card would overflow. At the widths above it never did, so the
// clamp could be deleted with every assertion still green.
await page.setViewportSize({ width: 1440, height: 900 })
await page.mouse.move(0, 0)
// Shove the row hard right so the tile is within a card's width of the edge.
await page.evaluate(() => {
  const row = document.querySelector('.row__seat .power').closest('.row__seat')
  row.style.marginLeft = `${window.innerWidth - 120}px`
})
// A REAL hover: React synthesises onMouseEnter from mouseover/mouseout and
// ignores a dispatched `mouseenter`, so the previous version of this probe
// never ran the placement code and read a stale card from an earlier hover.
await page.locator('.row__seat .power').first().hover()
await page.waitForSelector('.power__zoom')
const clampProbe = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
  const zoom = document.querySelector('.power__zoom')
  const box = zoom.getBoundingClientRect()
  return {
    tileLeft: Math.round(tile.getBoundingClientRect().left),
    zoomLeft: Math.round(box.left),
    zoomRight: Math.round(box.right),
    viewportWidth: window.innerWidth,
  }
})
await page.evaluate(() => {
  const row = document.querySelector('.row__seat .power').closest('.row__seat')
  row.style.marginLeft = ''
})
await page.mouse.move(0, 0)

check('an enlarged card near the right edge is pulled back on screen', () => {
  assert(
    clampProbe.tileLeft + 190 > clampProbe.viewportWidth,
    `precondition: the tile must be close enough to the edge to need clamping ` +
      `(tile at ${clampProbe.tileLeft}, viewport ${clampProbe.viewportWidth})`,
  )
  // The exact clamped position, not an inequality: "left of the tile" is true
  // of a stale card sitting at x=27 as well as a correctly clamped one.
  assertEqual(
    clampProbe.zoomLeft,
    clampProbe.viewportWidth - 190 - 8,
    'the card should sit exactly one margin in from the right edge',
  )
  assert(
    clampProbe.zoomRight <= clampProbe.viewportWidth,
    `and fully on screen, got right edge ${clampProbe.zoomRight}`,
  )
})

check('every Power enlarges into full view at every size', () => {
  assert(hoverProbes.length >= 4, `expected several probes, got ${hoverProbes.length}`)
  for (const probe of hoverProbes) {
    assert(!probe.missing, `${probe.label}: no enlarged card appeared`)
    assert(probe.width > 150 && probe.height > 200, `${probe.label}: not enlarged (${probe.width}x${probe.height})`)
    assert(probe.left >= 0, `${probe.label}: clipped off the left (${probe.left})`)
    assert(probe.top >= 0, `${probe.label}: clipped off the top (${probe.top})`)
    assert(probe.right <= probe.viewport.w, `${probe.label}: off the right (${probe.right} > ${probe.viewport.w})`)
    assert(probe.bottom <= probe.viewport.h, `${probe.label}: off the bottom (${probe.bottom} > ${probe.viewport.h})`)
    assert(probe.visible, `${probe.label}: the enlarged card is not visible`)
  }
})

// Geometry alone cannot tell "on screen" from "painted behind the board", so
// the same region is captured with and without the card and compared.
await page.mouse.move(0, 0)
// The region comes from where the card ACTUALLY lands, not a fixed rectangle:
// a hardcoded clip silently stops covering the card the moment the layout
// moves, and then compares two identical patches of background forever.
await page.locator('.row__seat .power').first().hover()
await page.waitForSelector('.power__zoom')
const zoomRegion = await page.evaluate(() => {
  const box = document.querySelector('.power__zoom').getBoundingClientRect()
  return {
    x: Math.max(0, Math.round(box.left)),
    y: Math.max(0, Math.round(box.top)),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
})
const withZoom = await page.screenshot({ clip: zoomRegion })
await page.mouse.move(0, 0)
await page.waitForFunction(() => !document.querySelector('.power__zoom'))
const withoutZoom = await page.screenshot({ clip: zoomRegion })
await page.locator('.row__seat .power').first().hover()
await page.waitForSelector('.power__zoom')
check('the enlarged card is actually painted, not just positioned', () => {
  assert(
    !withoutZoom.equals(withZoom),
    'hovering a Power changed nothing on screen in the region the card should occupy',
  )
})

await page.locator('.row__seat .power').first().hover()
await page.waitForSelector('.power__zoom')
const tileWhileHovered = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
  const box = tile.getBoundingClientRect()
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.className
})
check('the tile keeps showing its own art while the card is enlarged', () => {
  assert(
    String(tileWhileHovered).includes('power__art'),
    `the tile went blank while hovered: ${tileWhileHovered}`,
  )
})
await shot('14b-power-hover')
await page.mouse.move(0, 0)

// The tile crop is the whole reason a Power reads as board state rather than a
// text chip: it must land on the ILLUSTRATION, not on the card's rules box.
// Moving it onto the rules box is invisible to every other assertion here.
const cropSample = await page.evaluate(() => {
  const img = document.querySelector('.row__seat .power .power__art')
  const tile = img.getBoundingClientRect()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const context = canvas.getContext('2d')
  context.drawImage(img, 0, 0)

  // Reproduce object-fit: cover + object-position to find the visible band.
  const fit = getComputedStyle(img).objectFit
  const scale = Math.max(tile.width / img.naturalWidth, tile.height / img.naturalHeight)
  const drawnHeight = img.naturalHeight * scale
  const overflow = Math.max(0, drawnHeight - tile.height)
  const position = parseFloat(getComputedStyle(img).objectPosition.split(' ')[1]) / 100
  const topPx = (overflow * position) / scale
  const bandHeight = tile.height / scale

  const spread = (y0, y1) => {
    const data = context.getImageData(0, Math.max(0, y0), canvas.width, Math.max(1, y1 - y0)).data
    let sum = 0
    let sumSq = 0
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      const value = (data[i] + data[i + 1] + data[i + 2]) / 3
      sum += value
      sumSq += value * value
      n++
    }
    const mean = sum / n
    return Math.sqrt(sumSq / n - mean * mean)
  }

  return {
    band: spread(Math.round(topPx), Math.round(topPx + bandHeight)),
    // The rules box: the flat panel across the bottom of every card.
    rulesBox: spread(Math.round(canvas.height * 0.68), Math.round(canvas.height * 0.92)),
    // Where the visible band sits as a fraction of card height. Geometry is
    // exact where the contrast heuristic is only a signal — rules text is
    // high-contrast too, so a crop sitting on the text still looked "busy".
    bandTop: topPx / img.naturalHeight,
    bandBottom: (topPx + bandHeight) / img.naturalHeight,
    fit,
  }
})
check('the Power tile crop sits on the illustration', () => {
  // The band is recomputed here from natural dimensions, which cannot see the
  // actual object-fit — so that is asserted directly, or switching to `fill`
  // would leave this maths describing a crop the browser is not applying.
  assertEqual(cropSample.fit, 'cover', 'the tile crops its art rather than squashing it')
  // The illustration oval runs roughly 12%-58% of card height on these scans.
  // The gate is tight enough to exclude the default 50% centring, which would
  // otherwise drift down onto the rules panel.
  const centre = (cropSample.bandTop + cropSample.bandBottom) / 2
  assert(
    centre > 0.12 && centre < 0.42,
    `the visible band is centred at ${(centre * 100).toFixed(0)}% of card height, off the artwork`,
  )
})

check('the Power tile does not show the flat rules panel', () => {
  assert(
    cropSample.band > cropSample.rulesBox * 1.3,
    `the crop looks flat like the rules box (band spread ${cropSample.band.toFixed(1)} vs ` +
      `rules box ${cropSample.rulesBox.toFixed(1)}) — it should land on the illustration`,
  )
})

// The whole pinned-zoom lifecycle. Every one of these behaviours has a comment
// naming the bug it fixes, and none of them was checked: the suite hovered and
// focused but never clicked to pin.
const pinLife = await page.evaluate(async () => {
  const tiles = [...document.querySelectorAll('.row__seat .power')]
  const count = () => document.querySelectorAll('.power__zoom').length
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  tiles[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  tiles[0].click()
  await settle()
  const afterPin = count()

  // Hovering a neighbour must not steal a pin.
  tiles[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  const afterNeighbour = count()

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  const afterEscape = count()

  tiles[0].click()
  await settle()
  const rePinned = count()
  document.querySelector('.board')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await settle()
  const afterClickAway = count()

  return { afterPin, afterNeighbour, afterEscape, rePinned, afterClickAway }
})
// A pin belongs to the player, not to the row that happens to hold it: another
// row could see its own state as empty, put a hover card up, and destroy it.
const crossRow = await page.evaluate(async () => {
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const rows = [...document.querySelectorAll('.row__seat')].filter(
    (row) => row.querySelector('.power'),
  )
  if (rows.length < 2) return { rows: rows.length, skipped: true }
  const mine = rows[0].querySelector('.power')
  const theirs = rows[1].querySelector('.power')

  mine.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  mine.click()
  await settle()
  const pinned = document.querySelectorAll('.power__zoom').length

  theirs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  const afterOtherRowHover = document.querySelectorAll('.power__zoom').length
  const stillMine = rows[0].querySelector('.power--open') != null

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  return { rows: rows.length, skipped: false, pinned, afterOtherRowHover, stillMine }
})
check('a pin survives a hover in another row', () => {
  if (crossRow.skipped) return // needs two seats carrying Powers
  assertEqual(crossRow.pinned, 1, 'the card is pinned')
  assertEqual(crossRow.afterOtherRowHover, 1, 'and another row hovering does not destroy it')
  assert(crossRow.stillMine, 'the pin stays with the row that made it')
})

check('a pinned Power stays pinned, and every dismissal works', () => {
  assertEqual(pinLife.afterPin, 1, 'clicking a tile pins the card')
  assertEqual(pinLife.afterNeighbour, 1, 'hovering a neighbour does not steal the pin')
  assertEqual(pinLife.afterEscape, 0, 'Escape dismisses it')
  assertEqual(pinLife.rePinned, 1, 'it can be pinned again')
  assertEqual(pinLife.afterClickAway, 0, 'and clicking elsewhere puts it down')
})

check('a Power can be reached without a mouse', () => {
  // Hover-only left touch and keyboard users with unidentifiable 34x22 blobs.
  for (const art of powerArt) {
    assert(art.isButton, 'a Power tile should be a button')
    assert(art.focusable, 'and reachable by keyboard')
  }
})

check('a Power tells a screen reader what it does, not just its name', () => {
  const alts = powerArt.map((art) => art.alt)
  const demon = alts.find((alt) => alt.startsWith('Demon Form'))
  assert(demon, `expected a Demon Form label, saw: ${alts.join(' | ')}`)
  assert(demon.includes('Strength'), `the label should say what it grants: ${demon}`)
  assert(demon.includes('start of each turn'), `and when it grants it: ${demon}`)
})

// aria-label replaces an element's contents wholesale, so anything missing
// from it is invisible to a screen reader however it is marked up.
const seatLabel = await page.evaluate(
  () => document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
)
check('the seat announces its tokens, and does not repeat the Powers', () => {
  assert(seatLabel.includes('hit points'), `expected hit points in: ${seatLabel}`)
  // The Powers are a sibling list with their own labels. Naming them here too
  // made a screen reader announce every Power twice.
  assert(
    !seatLabel.includes('Demon Form'),
    `the seat label duplicates the Power list: ${seatLabel}`,
  )
})

const nested = await page.evaluate(
  () => document.querySelector('.seat--viewer')?.querySelectorAll('button, a, [tabindex]').length ?? -1,
)
check('the seat button contains no other interactive element', () => {
  assertEqual(nested, 0, 'nested interactive elements break the seat button')
})
await shot('14-powers-in-play')

// Steam Barrier reads the top discard card, and p.13 lets each player choose
// the order. Exercise the actual end-turn control rather than injecting the
// pile behind it.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [
    { uid: 'end-bash', defId: 'bash', upgraded: false },
    { uid: 'end-deflect', defId: 'deflect', upgraded: false },
    { uid: 'end-protect', defId: 'protect', upgraded: false },
  ]
  debug.setRun(run)
})
await page.setViewportSize({ width: 390, height: 844 })
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const mobileDiscardControls = await page.locator('.combat__actions').evaluate((element) => {
  const box = element.getBoundingClientRect()
  return { left: box.left, right: box.right, width: window.innerWidth }
})
check('multiplayer discard controls fit a touch-sized screen', () => {
  assert(mobileDiscardControls.left >= 0, 'discard controls spill off the left edge')
  assert(mobileDiscardControls.right <= mobileDiscardControls.width, 'discard controls spill off the right edge')
})
await shot('15a-mobile-discard-order')
const discardOptions = await page.getByLabel('Top discard for Ironclad').locator('option').allTextContents()
check('Retain cards are excluded from the top-discard choice', () => {
  assert(!discardOptions.some((option) => option.includes('Protect')), `Retain leaked into: ${discardOptions.join(' | ')}`)
})
await page.getByLabel('Top discard for Ironclad').selectOption('end-deflect')
await confirmAllDiscards()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
await page.waitForFunction(() => document.querySelector('.pile__top')?.textContent?.includes('Deflect'))
const mobilePileTop = await page.locator('.pile__top').first().evaluate((element) => {
  const box = element.getBoundingClientRect()
  return {
    text: element.textContent ?? '',
    visible: box.width > 0 && box.height > 0,
    onScreen: box.left >= 0 && box.right <= window.innerWidth,
  }
})
check('the top discard card and cost are visible on touch-sized screens', () => {
  assert(mobilePileTop.visible, 'the top card should be painted')
  assert(mobilePileTop.onScreen, 'the top card should fit on screen')
  assert(/0 · Deflect/.test(mobilePileTop.text), `expected Deflect and its cost, got ${mobilePileTop.text}`)
})
await shot('15-mobile-discard-top')

// A card keeps its uid when it cycles through the deck. A top-card choice from
// one turn must not silently select that same card when it comes back later.
await page.getByLabel('Seat').selectOption('p1')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'end-deflect', defId: 'deflect', upgraded: false },
    { uid: 'end-bash', defId: 'bash', upgraded: false },
  ]
  run.combat.phase = 'player'
  run.combat.turn += 1
  debug.setRun(run)
})
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
await page.waitForFunction(() => document.querySelector('[aria-label="Top discard for Ironclad"]')?.value === 'end-bash')
const freshDiscardTop = await page.getByLabel('Top discard for Ironclad').inputValue()
check('a prior turn\'s top-card choice is cleared when that card returns', () => {
  assertEqual(freshDiscardTop, 'end-bash', 'the new hand defaults to its current top')
})
await page.setViewportSize({ width: 1440, height: 900 })

// The campfire is the first non-combat room with real interaction: each player
// independently Rests or Smiths, and nobody leaves until all have chosen.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  debug.reset(2, 'campfire')
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[run.map.rows.length - 2][0]
  run.players = run.players.map((player) => ({ ...player, hp: 4 }))
  debug.setRun(run)
})
await page.waitForSelector('.campfire')
const leaveLockedBefore = await page.locator('.campfire__leave').isDisabled()
check('a campfire will not let the party leave until everyone has chosen', () => {
  assert(leaveLockedBefore, 'the leave button must be disabled while a choice is outstanding')
})

await page.locator('.campfire__player').nth(0).getByRole('button', { name: /Rest/ }).click()
await page.locator('.campfire__player').nth(1).getByRole('button', { name: /Smith/ }).click()
await page.waitForSelector('.campfire__deck .card')
await shot('12-campfire')
await page.locator('.campfire__deck .card').first().click()
const leaveLockedAfter = await page.locator('.campfire__leave').isDisabled()
await page.locator('.campfire__leave').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const afterCampfire = await readRun()

check('Rest heals and Smith upgrades, and the party returns to the map', () => {
  assert(!leaveLockedAfter, 'once every player has chosen, leaving is allowed')
  assertEqual(afterCampfire.phase, 'map', 'the party returns to the map')
  assertEqual(afterCampfire.players[0].hp, 7, 'the resting player heals 3 (p.9)')
  assertEqual(afterCampfire.players[1].hp, 4, 'the smithing player does not heal')
  assertEqual(
    afterCampfire.players[1].deck.filter((card) => card.upgraded).length,
    1,
    'and upgrades exactly one card',
  )
})

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
