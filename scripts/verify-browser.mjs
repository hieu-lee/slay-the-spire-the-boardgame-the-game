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
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

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
  if ((await readState()).phase === 'start') {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }
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
  if ((await readState()).phase === 'start') {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }
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
    assertEqual(afterSecondPlay.players[0].energy, beforeSecondPlay.players[0].energy - 1,
      'the card spends its printed Energy')
    assert(afterSecondPlay.log.length > beforeSecondPlay.log.length &&
      afterSecondPlay.log.some((line) => line.includes('played Strike')),
      'the play resolves even when Weak or Block prevents HP damage')
  })
  await shot('05b-second-round')
}

// Play the encounter out to its end, clicking only what a player can click.
// The suite used to stop a few clicks in, which is how a combat that could not
// reach round 2 shipped green. A whole fight is the only thing that proves the
// loop closes.
async function playOutCombat(limit = 60) {
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
  const stalled = await readState()
  throw new Error(`the combat never ended: phase=${stalled.phase}, turn=${stalled.turn}, enemies=${stalled.enemies.map((enemy) => enemy.hp).join(',')}`)
}

const finished = await playOutCombat()
// Sampled from a FOUR-player round, which is where rounds actually run long.
// Against a short round these all pass trivially: a tail keeps every line, so
// the fixed-tail regression they exist to catch slips straight through.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'log-round'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await enterFirstRoom()
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
await enterFirstRoom()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const foe of run.combat.enemies) {
    foe.hp = 1
    foe.cardReward = 'normal'
  }
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
await enterFirstRoom()

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
  slots: document.querySelectorAll('.seat--viewer .token--orb').length,
  beads: document.querySelectorAll('.seat--viewer .token--orb:not(.token--orb-empty)').length,
  classes: [...document.querySelectorAll('.seat--viewer .token--orb')].map((b) => b.className),
  label: document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
}))
check('channelled orbs are visible on the seat', () => {
  assertEqual(orbView.slots, 2, 'non-Defect seats show occupied Orbs without empty capacity')
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

// p.16 makes every evoke two real choices: any occupied Orb, then an enemy
// for Lightning or Dark. Exercise the staged picker through the rendered UI,
// not by passing a context directly to the engine.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-dual-cast', defId: 'dual_cast', upgraded: false }]
  player.energy = 3
  player.orbs = ['lightning', 'frost', 'dark']
  run.combat.phase = 'player'
  for (const enemy of run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  }
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Dual Cast,/ }).click()
await page.getByRole('button', { name: /dark slot 3/i }).waitFor()
await page.waitForTimeout(250)
await shot('06-orb-evoke-choice')
await page.getByRole('button', { name: /dark slot 3/i }).click()
await page.getByText('Choose an enemy for this evoke').waitFor()
await page.waitForTimeout(250)
await shot('06b-orb-evoke-target')
await page.locator('.enemy--targeted').nth(1).click()
await page.getByRole('button', { name: /lightning slot 1/i }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const chosenEvokes = await readState()
check('the local UI collects a separate Orb and enemy for every evoke', () => {
  assertDeepEqual(chosenEvokes.players[0].orbs, [null, 'frost', null])
  const hp = chosenEvokes.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b)
  assertDeepEqual(hp.slice(0, 2), [17, 18])
  assert(hp.slice(2).every((value) => value === 20), 'only the two chosen enemies should take damage')
  assertEqual(chosenEvokes.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-recursion', defId: 'recursion', upgraded: false }]
  player.energy = 3
  player.orbs = ['lightning', 'frost', 'dark']
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Recursion,/ }).click()
await page.getByRole('button', { name: /dark slot 3/i }).waitFor()
await page.waitForTimeout(250)
await shot('06c-recursion-choice')
await page.getByRole('button', { name: /dark slot 3/i }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const recursed = await readState()
check('Recursion uses the Orb picker and re-channels the chosen type', () => {
  assertDeepEqual(recursed.players[0].orbs, ['lightning', 'frost', 'dark'])
  assert(recursed.enemies.some((enemy) => enemy.hp === 17), 'the chosen Dark should evoke for 3')
  assertEqual(recursed.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'ui-flex', defId: 'flex', upgraded: false },
    { uid: 'ui-anger', defId: 'anger', upgraded: false },
  ]
  player.draw = [{ uid: 'ui-spare', defId: 'defend_ironclad', upgraded: false }]
  player.energy = 3
  player.strength = 0
  player.strengthLossAtEndOfTurn = 0
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 2)
await shot('06d-flex-anger-hand')
await page.getByRole('button', { name: /^Flex,/ }).click()
await page.getByRole('button', { name: /^Anger,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const flexAnger = await readState()
check('Flex expires and Exhausts while Anger returns to draw top', () => {
  const player = flexAnger.players[0]
  assertEqual(player.strength, 1)
  assertEqual(player.strengthLossAtEndOfTurn, 1)
  assert(player.exhaust.some((card) => card.uid === 'ui-flex'))
  assertEqual(player.draw[0].uid, 'ui-anger')
  assert(flexAnger.enemies.some((enemy) => enemy.hp === 18), 'Flex should strengthen Anger to 2 damage')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-iron-wave', defId: 'iron_wave', upgraded: true }]
  player.energy = 3
  player.block = 0
  player.strength = 0
  player.strengthLossAtEndOfTurn = 0
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Iron Wave\+,/ }).click()
await page.getByRole('button', { name: '1 damage and 2 Block' }).waitFor()
await page.waitForTimeout(250)
await shot('06e-iron-wave-mode')
await page.getByRole('button', { name: '1 damage and 2 Block' }).click()
await page.getByText('Choose an enemy').waitFor()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const ironWave = await readState()
check('Iron Wave+ commits its printed mode and target as one play', () => {
  assert(ironWave.enemies.some((enemy) => enemy.hp === 19))
  assertEqual(ironWave.players[0].block, 2)
  assertEqual(ironWave.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-acrobatics', defId: 'acrobatics', upgraded: false }]
  player.draw = [
    { uid: 'ui-acro-neutralize', defId: 'neutralize', upgraded: false },
    { uid: 'ui-acro-defend', defId: 'defend_silent', upgraded: false },
    { uid: 'ui-acro-strike', defId: 'strike_silent', upgraded: false },
    { uid: 'ui-acro-spare', defId: 'backflip', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Acrobatics,/ }).click()
const acrobaticsDialog = page.getByRole('dialog', { name: 'Choose 1 to discard' })
await acrobaticsDialog.waitFor()
await acrobaticsDialog.getByRole('button', { name: /^Neutralize,/ }).click()
await page.waitForTimeout(250)
await shot('06f-acrobatics-post-draw-choice')
await acrobaticsDialog.getByRole('button', { name: 'Discard selected card' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 2)
const acrobatics = await readState()
check('Acrobatics reveals its draw before committing the chosen discard', () => {
  assertDeepEqual(acrobatics.players[0].hand.map((card) => card.uid), ['ui-acro-defend', 'ui-acro-strike'])
  assertDeepEqual(acrobatics.players[0].discard.map((card) => card.uid), ['ui-acro-neutralize', 'ui-acrobatics'])
  assertEqual(acrobatics.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-third-eye', defId: 'third_eye', upgraded: true }]
  player.draw = [
    { uid: 'ui-scry-defend', defId: 'defend_watcher', upgraded: false },
    { uid: 'ui-scry-strike', defId: 'strike_watcher', upgraded: false },
    { uid: 'ui-scry-vigilance', defId: 'vigilance', upgraded: false },
    { uid: 'ui-scry-eruption', defId: 'eruption', upgraded: false },
    { uid: 'ui-scry-protect', defId: 'protect', upgraded: false },
    { uid: 'ui-scry-spare', defId: 'tranquility', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  player.block = 0
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Third Eye\+,/ }).click()
const scryDialog = page.getByRole('dialog', { name: 'Scry 5' })
await scryDialog.waitFor()
await scryDialog.getByRole('button', { name: /^Strike,/ }).click()
await scryDialog.getByRole('button', { name: /^Eruption,/ }).click()
const endTurnLocked = await page.getByRole('button', { name: 'End turn' }).isDisabled()
const cancelHidden = await page.getByRole('button', { name: 'Cancel' }).count()
await page.waitForTimeout(250)
await shot('06g-third-eye-scry-choice')
await scryDialog.getByRole('button', { name: 'Discard 2 and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const thirdEye = await readState()
check('Third Eye locks the revealed play and keeps unselected cards in order', () => {
  assert(endTurnLocked, 'a revealed card could be abandoned by ending the turn')
  assertEqual(cancelHidden, 0, 'a revealed draw could be peeked and cancelled')
  assertEqual(thirdEye.players[0].block, 3)
  assertDeepEqual(thirdEye.players[0].draw.map((card) => card.uid),
    ['ui-scry-defend', 'ui-scry-vigilance', 'ui-scry-protect', 'ui-scry-spare'])
  assertDeepEqual(thirdEye.players[0].discard.map((card) => card.uid),
    ['ui-scry-strike', 'ui-scry-eruption', 'ui-third-eye'])
  assertEqual(thirdEye.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'ui-dagger-throw', defId: 'dagger_throw', upgraded: true },
    { uid: 'ui-dagger-existing', defId: 'defend_silent', upgraded: false },
  ]
  player.draw = [{ uid: 'ui-dagger-drawn', defId: 'neutralize', upgraded: false }]
  player.discard = []
  player.energy = 3
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid === 'ui-dagger-throw'))
await page.getByRole('button', { name: /^Dagger Throw\+,/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted[aria-label*="10 of 10 hit points"]').click()
const daggerDialog = page.getByRole('dialog', { name: 'Choose 1 to discard' })
await daggerDialog.waitFor()
await daggerDialog.getByRole('button', { name: /^Neutralize,/ }).click()
await shot('06h-dagger-throw-choice')
await daggerDialog.getByRole('button', { name: 'Discard selected card' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies
  .some((enemy) => enemy.maxHp === 10 && enemy.hp === 7))
const daggerThrow = await readState()
check('Dagger Throw chooses its attack target before revealing its discard', () => {
  assertEqual(daggerThrow.enemies.find((enemy) => enemy.maxHp === 10).hp, 7)
  assertDeepEqual(daggerThrow.players[0].hand.map((card) => card.uid), ['ui-dagger-existing'])
  assertDeepEqual(daggerThrow.players[0].discard.map((card) => card.uid), ['ui-dagger-drawn', 'ui-dagger-throw'])
  assertEqual(daggerThrow.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'ui-prepared', defId: 'prepared', upgraded: true },
    { uid: 'ui-prepared-existing', defId: 'defend_silent', upgraded: false },
  ]
  player.draw = [
    { uid: 'ui-prepared-neutralize', defId: 'neutralize', upgraded: false },
    { uid: 'ui-prepared-strike', defId: 'strike_silent', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Prepared\+,/ }).click()
const preparedDialog = page.getByRole('dialog', { name: 'Choose 2 to discard' })
await preparedDialog.waitFor()
await preparedDialog.getByRole('button', { name: /^Neutralize,/ }).click()
await preparedDialog.getByRole('button', { name: /^Defend,/ }).click()
const preparedOrder = await preparedDialog.locator('p').textContent()
await shot('06i-prepared-choice')
await preparedDialog.getByRole('button', { name: 'Discard selected cards' }).click()
await preparedDialog.waitFor({ state: 'hidden' })
const prepared = await readState()
check('Prepared+ draws two, discards exactly two, and costs no Energy', () => {
  assert(preparedOrder.includes('1. Neutralize → 2. Defend'), preparedOrder)
  assertDeepEqual(prepared.players[0].hand.map((card) => card.uid), ['ui-prepared-strike'])
  assertDeepEqual(prepared.players[0].discard.map((card) => card.uid),
    ['ui-prepared-neutralize', 'ui-prepared-existing', 'ui-prepared'])
  assertEqual(prepared.players[0].energy, 3)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-riddle', defId: 'riddle_with_holes', upgraded: true }]
  player.energy = 3
  for (const member of run.combat.players) member.shivs = 0
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Riddle with Holes\+,/ }).waitFor()
await shot('06j-riddle-with-holes-card')
await page.getByRole('button', { name: /^Riddle with Holes\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].shivs === 5)
const riddle = await readState()
check('Riddle with Holes+ fills the shared Shiv supply with five Shivs', () => {
  assertEqual(riddle.players[0].shivs, 5)
  assertEqual(riddle.players[0].energy, 1)
  assertEqual(riddle.players[0].hand.length, 0)
})
await shot('06k-riddle-shiv-supply')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-pray', defId: 'pray', upgraded: true }]
  player.draw = [
    { uid: 'ui-pray-draw-1', defId: 'strike_watcher', upgraded: false },
    { uid: 'ui-pray-draw-2', defId: 'defend_watcher', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  player.miracles = 0
  player.drawLocked = false
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Pray\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].drawLocked === true)
const prayed = await readState()
const drawLockLabel = await page.locator('.seat--viewer .seat__pending')
  .filter({ hasText: 'Cannot draw more cards this turn' }).textContent()
check('Pray+ grants two Miracles, draws two, and visibly locks later draws', () => {
  assertEqual(prayed.players[0].miracles, 2)
  assertEqual(prayed.players[0].hand.length, 2)
  assertEqual(prayed.players[0].energy, 2)
  assert(prayed.players[0].drawLocked)
  assertEqual(drawLockLabel, 'Cannot draw more cards this turn')
})
await shot('06l-pray-draw-lock')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(actor, {
    row: 0,
    hand: [{ uid: 'ui-dash', defId: 'dash', upgraded: true }],
    energy: 3,
    block: 0,
    drawLocked: false,
    dead: false,
    strength: 0,
    weak: 0,
  })
  Object.assign(ally, { row: 1, dead: false, hp: Math.max(1, ally.hp) })
  const target = run.combat.enemies.find((enemy) => !enemy.dead)
  if (!target) throw new Error('Dash browser fixture needs a living enemy')
  for (const enemy of run.combat.enemies) {
    if (!enemy.dead) Object.assign(enemy, { block: 0, vulnerable: 0 })
  }
  debug.setRun(run)
})
const dashHpBefore = (await readState()).enemies.reduce((total, enemy) => total + enemy.hp, 0)
await page.getByRole('button', { name: /^Dash\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.getByText('Choose another player to switch rows with, or keep rows').waitFor()
const dashSwitchTarget = page.locator('.seat--targetable')
assertEqual(await dashSwitchTarget.count(), 1, 'Dash did not expose exactly one other player as a switch target')
assertEqual(await page.getByRole('button', { name: 'Keep rows' }).count(), 1,
  'Dash did not expose its printed optional skip')
await shot('06m-dash-row-switch-choice')
await dashSwitchTarget.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].row === 1)
const dashed = await readState()
check('Dash+ resolves damage and Block before optionally switching player rows', () => {
  assertDeepEqual(dashed.players.slice(0, 2).map((player) => player.row), [1, 0])
  assertEqual(dashed.players[0].block, 3)
  assertEqual(dashHpBefore - dashed.enemies.reduce((total, enemy) => total + enemy.hp, 0), 3)
  assertEqual(dashed.players[0].energy, 1)
})
await shot('06n-dash-row-switched')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [{ uid: 'ui-just-lucky', defId: 'just_lucky', upgraded: true }],
    draw: [
      { uid: 'ui-lucky-defend', defId: 'defend_watcher', upgraded: false },
      { uid: 'ui-lucky-strike', defId: 'strike_watcher', upgraded: false },
    ],
    discard: [],
    energy: 3,
    block: 0,
    strength: 0,
    weak: 0,
  })
  run.combat.die = 1
  for (const enemy of run.combat.enemies) {
    if (!enemy.dead) Object.assign(enemy, { block: 0, vulnerable: 0 })
  }
  debug.setRun(run)
})
const luckyScryHpBefore = (await readState()).enemies.reduce((total, enemy) => total + enemy.hp, 0)
await page.getByRole('button', { name: /^Just Lucky\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
const luckyScryDialog = page.getByRole('dialog', { name: 'Scry 2' })
await luckyScryDialog.waitFor()
await luckyScryDialog.getByRole('button', { name: /^Defend,/ }).click()
await shot('06o-just-lucky-scry-choice')
await luckyScryDialog.getByRole('button', { name: 'Discard 1 and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const luckyScry = await readState()
check('Just Lucky+ uses die 1 for its private Scry branch', () => {
  assertEqual(luckyScryHpBefore - luckyScry.enemies.reduce((total, enemy) => total + enemy.hp, 0), 2)
  assertEqual(luckyScry.players[0].block, 0)
  assertDeepEqual(luckyScry.players[0].draw.map((card) => card.uid), ['ui-lucky-strike'])
  assertDeepEqual(luckyScry.players[0].discard.map((card) => card.uid), ['ui-lucky-defend', 'ui-just-lucky'])
  assertEqual(luckyScry.players[0].energy, 3)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-just-lucky-block', defId: 'just_lucky', upgraded: false }],
    draw: [{ uid: 'ui-lucky-kept', defId: 'defend_watcher', upgraded: false }],
    discard: [],
    block: 0,
  })
  run.combat.die = 4
  debug.setRun(run)
})
const luckyBlockHpBefore = (await readState()).enemies.reduce((total, enemy) => total + enemy.hp, 0)
await page.getByRole('button', { name: /^Just Lucky,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const luckyBlock = await readState()
const luckyDialogCount = await page.getByRole('dialog').count()
check('Just Lucky uses die 4 for its immediate Block branch without a Scry prompt', () => {
  assertEqual(luckyBlockHpBefore - luckyBlock.enemies.reduce((total, enemy) => total + enemy.hp, 0), 1)
  assertEqual(luckyBlock.players[0].block, 1)
  assertDeepEqual(luckyBlock.players[0].draw.map((card) => card.uid), ['ui-lucky-kept'])
  assertEqual(luckyDialogCount, 0)
})
await shot('06p-just-lucky-block-branch')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-rainbow', defId: 'rainbow', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 3,
    orbs: [null, null, null],
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Rainbow\+,/ }).waitFor()
await shot('06q-rainbow-card')
await page.getByRole('button', { name: /^Rainbow\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs.join(',') === 'lightning,frost,dark')
const rainbow = await readState()
check('Rainbow+ channels Lightning, Frost, and Dark in order without Exhausting', () => {
  assertDeepEqual(rainbow.players[0].orbs, ['lightning', 'frost', 'dark'])
  assertEqual(rainbow.players[0].energy, 1)
  assertEqual(rainbow.players[0].discard.some((card) => card.uid === 'ui-rainbow'), true)
  assertEqual(rainbow.players[0].exhaust.some((card) => card.uid === 'ui-rainbow'), false)
})
await shot('06r-rainbow-orbs')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-glacier', defId: 'glacier', upgraded: true }],
    discard: [],
    energy: 3,
    block: 0,
    orbs: [null, null, null],
  })
  Object.assign(run.combat.players[1], { block: 0, dead: false, hp: Math.max(1, run.combat.players[1].hp) })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Glacier\+,/ }).click()
await page.getByText('Choose who gets it').waitFor()
const glacierAlly = page.locator('.seat--targetable').filter({ hasText: 'Silent' })
assertEqual(await glacierAlly.count(), 1, 'Glacier+ did not expose the living ally as a Block target')
await glacierAlly.scrollIntoViewIfNeeded()
await shot('06s-glacier-ally-choice')
await glacierAlly.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs[0] === 'frost')
const glacier = await readState()
check('Glacier+ gives the chosen ally Block while the caster channels Frost', () => {
  assertEqual(glacier.players[0].block, 0)
  assertEqual(glacier.players[1].block, 3)
  assertDeepEqual(glacier.players[0].orbs, ['frost', null, null])
  assertEqual(glacier.players[0].energy, 1)
})
await shot('06t-glacier-ally-frost')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-good-instincts', defId: 'good_instincts', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    block: 0,
  })
  Object.assign(run.combat.players[1], { block: 0, dead: false, hp: Math.max(1, run.combat.players[1].hp) })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Good Instincts\+,/ }).click()
await page.getByText('Choose who gets it').waitFor()
const instinctsAlly = page.locator('.seat--targetable').filter({ hasText: 'Silent' })
assertEqual(await instinctsAlly.count(), 1, 'Good Instincts+ did not expose the living ally as a Block target')
await instinctsAlly.scrollIntoViewIfNeeded()
await shot('06u-good-instincts-ally-choice')
await instinctsAlly.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[1].block === 2)
const instincts = await readState()
check('Good Instincts+ gives a chosen ally 2 Block for zero Energy', () => {
  assertEqual(instincts.players[0].block, 0)
  assertEqual(instincts.players[1].block, 2)
  assertEqual(instincts.players[0].energy, 0)
  assertEqual(instincts.players[0].discard.some((card) => card.uid === 'ui-good-instincts'), true)
})
await shot('06v-good-instincts-ally-block')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { turn: 1 })
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-dramatic-entrance', defId: 'dramatic_entrance', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    strength: 0,
    weak: 0,
  })
  for (const enemy of run.combat.enemies) {
    enemy.dead = false
    enemy.hp = 20
    enemy.maxHp = 20
    enemy.block = 0
    enemy.vulnerable = 0
  }
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss)
  if (!target) throw new Error('Dramatic Entrance browser fixture needs a non-boss enemy')
  target.hp = 19
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Dramatic Entrance\+,/ }).waitFor()
const entranceBefore = await readState()
const entranceTarget = entranceBefore.enemies.find((enemy) => !enemy.dead && !enemy.isBoss)
assert(entranceTarget, 'Dramatic Entrance browser fixture needs a non-boss enemy')
await page.getByRole('button', { name: /^Dramatic Entrance\+,/ }).click()
await page.waitForSelector('.enemy--targeted')
const entranceEnemy = page.locator(`.enemy--targeted[aria-label*="${entranceTarget.hp} of ${entranceTarget.maxHp} hit points"]`).first()
await entranceEnemy.scrollIntoViewIfNeeded()
await shot('06w-dramatic-entrance-row-target')
await entranceEnemy.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const entrance = await readState()
check('Dramatic Entrance+ deals 5 to its chosen row on turn 1 and Exhausts', () => {
  for (const before of entranceBefore.enemies) {
    const after = entrance.enemies.find((enemy) => enemy.uid === before.uid)
    const expected = before.row === entranceTarget.row || before.isBoss ? before.hp - 5 : before.hp
    assertEqual(after.hp, expected, `${before.uid} took the wrong row damage`)
  }
  assertEqual(entrance.players[0].energy, 0)
  assertEqual(entrance.players[0].exhaust.some((card) => card.uid === 'ui-dramatic-entrance'), true)
})
await page.locator(`.enemy[aria-label*="${entranceTarget.hp - 5} of ${entranceTarget.maxHp} hit points"]`).scrollIntoViewIfNeeded()
await shot('06x-dramatic-entrance-row-hit')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-panacea', defId: 'panacea', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    weak: 1,
    vulnerable: 1,
  })
  Object.assign(run.combat.players[1], {
    dead: false,
    hp: Math.max(1, run.combat.players[1].hp),
    weak: 2,
    vulnerable: 2,
  })
  debug.setRun(run)
})
const panaceaCard = page.getByRole('button', { name: /^Panacea\+,/ })
await panaceaCard.waitFor()
const panaceaLabel = await panaceaCard.getAttribute('aria-label')
await panaceaCard.scrollIntoViewIfNeeded()
await shot('06y-panacea-party-debuffs')
await panaceaCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players.every((player) => player.weak === 0 && player.vulnerable === 0))
const panacea = await readState()
check('Panacea+ clears Weak and Vulnerable from every player and Exhausts', () => {
  for (const player of panacea.players) {
    assertEqual(player.weak, 0)
    assertEqual(player.vulnerable, 0)
  }
  assertEqual(panacea.players[0].energy, 0)
  assertEqual(panacea.players[0].exhaust.some((card) => card.uid === 'ui-panacea'), true)
  assert(panaceaLabel.includes('support effect applies to all players'),
    `Panacea+ accessible name hid its party-wide scope: ${panaceaLabel}`)
})
await page.locator('.seat').first().scrollIntoViewIfNeeded()
await shot('06z-panacea-party-cleansed')

const colorlessBatch1Restore = await readRun()
await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-apparition', defId: 'apparition', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 1,
    hpLostThisRound: 0,
    hpLossLimitThisRound: undefined,
  })
  debug.setRun(run)
}, colorlessBatch1Restore)
const apparitionCard = page.getByRole('button', { name: /^Apparition\+,/ })
await apparitionCard.waitFor()
const apparitionLabel = await apparitionCard.getAttribute('aria-label')
await apparitionCard.scrollIntoViewIfNeeded()
await shot('06za-apparition-ready')
await apparitionCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hpLossLimitThisRound === 1)
const apparition = await readState()
const apparitionSeatLabel = await page.locator('.seat--viewer').getAttribute('aria-label')
const apparitionStatus = await page.locator('.seat--viewer .seat__pending').textContent()
check('Apparition+ visibly protects the round and Exhausts without Ethereal', () => {
  assert(apparitionLabel.includes('cannot lose more than 1 hit points this round'), apparitionLabel)
  assert(!apparitionLabel.includes('ethereal'), apparitionLabel)
  assertEqual(apparition.players[0].hpLossLimitThisRound, 1)
  assertEqual(apparition.players[0].exhaust.some((card) => card.uid === 'ui-apparition'), true)
  assert(apparitionSeatLabel.includes('Apparition protection, 1 hit point loss remaining this round'), apparitionSeatLabel)
  assert(apparitionStatus.includes('Apparition · 1 HP loss remaining'), apparitionStatus)
})
await shot('06zb-apparition-protected')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { die: 1 })
  Object.assign(actor, {
    hand: [{ uid: 'ui-dark-shackles', defId: 'dark_shackles', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    block: 0,
  })
  run.combat.enemies.forEach((enemy, index) => Object.assign(enemy, {
    defId: index === 0 ? 'cultist' : 'red_louse',
    row: actor.row,
    isBoss: false,
    dead: false,
    hp: 20,
    maxHp: 20,
    actionIndex: 0,
  }))
  debug.setRun(run)
}, colorlessBatch1Restore)
const shacklesCard = page.getByRole('button', { name: /^Dark Shackles\+,/ })
await shacklesCard.waitFor()
const shacklesLabel = await shacklesCard.getAttribute('aria-label')
await shacklesCard.scrollIntoViewIfNeeded()
await shot('06zc-dark-shackles-intents')
await shacklesCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 3)
const shackles = await readState()
check('Dark Shackles+ reads visible enemy intents without a target prompt', () => {
  assert(shacklesLabel.includes('3 per enemy intending to attack you'), shacklesLabel)
  assertEqual(shackles.players[0].block, 3)
  assertEqual(shackles.players[0].exhaust.some((card) => card.uid === 'ui-dark-shackles'), true)
})
await shot('06zd-dark-shackles-block')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-madness', defId: 'madness', upgraded: true },
      { uid: 'ui-madness-target', defId: 'hand_of_greed', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    energy: 0,
    freeCardsThisTurn: 0,
  })
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
}, colorlessBatch1Restore)
const madnessCard = page.getByRole('button', { name: /^Madness\+,/ })
await madnessCard.waitFor()
const madnessLabel = await madnessCard.getAttribute('aria-label')
await madnessCard.click()
const freeGreed = page.getByRole('button', { name: /^Hand of Greed, cost 0,/ })
await freeGreed.waitFor()
await freeGreed.scrollIntoViewIfNeeded()
await shot('06ze-madness-free-card')
await freeGreed.click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].freeCardsThisTurn === 0)
const madness = await readState()
check('Madness+ exposes Retain and discounts exactly the next card', () => {
  assert(madnessLabel.includes('your next card this turn costs 0'), madnessLabel)
  assert(madnessLabel.includes('retain'), madnessLabel)
  assertEqual(madness.players[0].energy, 0)
  assertEqual(madness.players[0].freeCardsThisTurn, 0)
  assertEqual(madness.players[0].exhaust.some((card) => card.uid === 'ui-madness'), true)
})
await shot('06zf-madness-spent')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hpLossLimitThisRound == null)

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-panache', defId: 'panache', upgraded: true }],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 0,
  })
  run.combat.players[1].hand = []
  run.combat.enemies.forEach((enemy, index) => Object.assign(enemy, {
    row: index, hp: 20, maxHp: 20, block: 0, weak: 0, vulnerable: 0, poison: 0, dead: false,
  }))
  debug.setRun(run)
}, colorlessBatch1Restore)
const panacheCard = page.getByRole('button', { name: /^Panache\+,/ })
await panacheCard.waitFor()
const panacheLabel = await panacheCard.getAttribute('aria-label')
await panacheCard.click()
const panachePower = page.getByRole('button', { name: /^Panache\+?:/ })
await panachePower.waitFor()
const panachePowerLabel = await panachePower.getAttribute('aria-label')
check('Panache+ exposes its empty-hand row effect accessibly', () => {
  assert(panacheLabel.includes('deal 5 damage if your hand is empty'), panacheLabel)
  assert(panacheLabel.includes('hits a whole row and any boss'), panacheLabel)
  assert(panachePowerLabel.includes('5 damage'), panachePowerLabel)
  assert(panachePowerLabel.includes('if your hand is empty'), panachePowerLabel)
  assert(panachePowerLabel.includes('to one enemy row and any boss'), panachePowerLabel)
  assert(panachePowerLabel.includes('at the end of each turn'), panachePowerLabel)
})
await panachePower.scrollIntoViewIfNeeded()
await panachePower.click()
await shot('06zg-panache-power')
await page.locator('.end-turn-order summary').click()
const panacheTarget = page.getByRole('combobox', { name: /Target for .*Panache/ })
const panacheTargetUid = await panacheTarget.locator('option').nth(1).getAttribute('value')
await panacheTarget.selectOption(panacheTargetUid)
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[1].hp === 15)
const panache = await readState()
check('Panache+ resolves the selected row at end of turn', () => {
  assertEqual(panache.enemies[0].hp, 20)
  assertEqual(panache.enemies[1].hp, 15)
})
await shot('06zh-panache-row-hit')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-apotheosis', defId: 'apotheosis', upgraded: true },
      { uid: 'ui-apotheosis-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 2,
    starterStrikeDamageBonus: 0,
    starterDefendBlockBonus: 0,
  })
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
}, colorlessBatch1Restore)
const apotheosisCard = page.getByRole('button', { name: /^Apotheosis\+,/ })
await apotheosisCard.waitFor()
const apotheosisLabel = await apotheosisCard.getAttribute('aria-label')
await apotheosisCard.click()
const apotheosisPower = page.getByRole('button', { name: /^Apotheosis\+?:/ })
await apotheosisPower.waitFor()
const apotheosisPowerLabel = await apotheosisPower.getAttribute('aria-label')
check('Apotheosis+ remains visible as a Power and states both starter bonuses', () => {
  assert(apotheosisLabel.includes('starter Strikes deal +1 damage'), apotheosisLabel)
  assert(apotheosisLabel.includes('starter Defends gain +1 Block'), apotheosisLabel)
  assert(apotheosisPowerLabel.includes('starter Strikes deal +1 damage'), apotheosisPowerLabel)
  assert(apotheosisPowerLabel.includes('starter Defends gain +1 Block'), apotheosisPowerLabel)
})
await apotheosisPower.click()
await shot('06zi-apotheosis-power')
await page.getByRole('button', { name: /^Strike, cost 1,/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.hp === 18))
const apotheosis = await readState()
check('Apotheosis adds one damage to a starter Strike', () => {
  assertEqual(apotheosis.enemies.filter((enemy) => enemy.hp === 18).length, 1)
})
await shot('06zj-apotheosis-strike')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [],
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-bomb', defId: 'the_bomb', upgraded: true, counter: 2 }],
  })
  run.combat.players[1].hand = []
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
}, colorlessBatch1Restore)
const bombPower = page.getByRole('button', { name: /^The Bomb\+?:/ })
await bombPower.waitFor()
const bombLabel = await bombPower.getAttribute('aria-label')
const bombCounter = await bombPower.locator('.power__counter').textContent()
check('The Bomb+ exposes its public cube countdown visually and accessibly', () => {
  assert(bombLabel.includes('at 3 cubes deal 12 damage to every enemy, then Exhaust this Power'), bombLabel)
  assert(bombLabel.includes('2 of 3 cubes'), bombLabel)
  assertEqual(bombCounter, '◆2/3')
})
await bombPower.scrollIntoViewIfNeeded()
await bombPower.click()
await shot('06zk-bomb-two-cubes')
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 0)
const bomb = await readState()
check('The Bomb+ third cube damages every enemy and Exhausts the Power', () => {
  assert(bomb.enemies.every((enemy) => enemy.hp === 8), 'The Bomb did not deal 12 to every enemy')
  assertEqual(bomb.players[0].exhaust.some((card) => card.uid === 'ui-bomb'), true)
})
await shot('06zl-bomb-exploded')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player' &&
  !window.__STS_DEBUG__.getState().players[0].powers.some((card) => card.uid === 'ui-bomb'))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-purity', defId: 'purity', upgraded: true },
      ...Array.from({ length: 5 }, (_, index) => ({
        uid: `ui-purity-fodder-${index}`, defId: 'strike_ironclad', upgraded: false,
      })),
    ],
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-purity-feel-no-pain', defId: 'feel_no_pain', upgraded: false }],
    energy: 0,
    block: 0,
  })
  debug.setRun(run)
})
const purityCard = page.getByRole('button', { name: /^Purity\+,/ })
await purityCard.waitFor()
const purityLabel = await purityCard.getAttribute('aria-label')
await purityCard.click()
await page.getByRole('button', { name: 'Exhaust none' }).waitFor()
const purityPrompt = await page.locator('.prompt').textContent()
await page.getByRole('button', { name: /^Strike,/ }).nth(0).click()
await page.getByRole('button', { name: /^Strike,/ }).nth(1).click()
await page.getByRole('button', { name: 'Exhaust 2' }).waitFor()
await shot('06za-purity-optional-exhaust')
await page.getByRole('button', { name: 'Exhaust 2' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const purity = await readState()
check('Purity+ lets the player Exhaust any number up to five', () => {
  assert(purityLabel.includes('exhaust up to 5 cards from hand'), purityLabel)
  assert(purityPrompt.includes('Exhaust up to 5 cards'), purityPrompt)
  assertEqual(purity.players[0].hand.length, 3)
  assertEqual(purity.players[0].exhaust.length, 3, 'two chosen cards and Purity itself Exhaust')
  assertEqual(purity.players[0].block, 3, 'Feel No Pain sees all three Exhausts')
})
await shot('06zb-purity-resolved')

const exhaustPairRestore = await readState()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-burning-pact', defId: 'burning_pact', upgraded: true },
      { uid: 'ui-burning-pact-fuel', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: Array.from({ length: 3 }, (_, index) => ({
      uid: `ui-burning-pact-draw-${index}`, defId: 'strike_ironclad', upgraded: false,
    })),
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-burning-pact-fnp', defId: 'feel_no_pain', upgraded: false }],
    energy: 1,
    block: 0,
  })
  debug.setRun(run)
})
const burningPactCard = page.getByRole('button', { name: /^Burning Pact\+,/ })
await burningPactCard.waitFor()
const burningPactLabel = await burningPactCard.getAttribute('aria-label')
await burningPactCard.click()
await page.getByText(/Exhaust 1 card.*0\/1 chosen/).waitFor()
await shot('06zc-burning-pact-exhaust-choice')
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const burningPact = await readState()
check('Burning Pact+ Exhausts its choice before drawing three cards', () => {
  assert(burningPactLabel.includes('exhaust 1 card from hand'), burningPactLabel)
  assert(burningPactLabel.includes('draw 3'), burningPactLabel)
  assertDeepEqual(burningPact.players[0].exhaust.map((card) => card.uid), ['ui-burning-pact-fuel'])
  assertEqual(burningPact.players[0].hand.length, 3)
  assertEqual(burningPact.players[0].block, 1, 'Feel No Pain did not observe the Exhaust')
})
await shot('06zd-burning-pact-resolved')

const severTarget = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss) ?? run.combat.enemies[0]
  for (const enemy of run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false, vulnerable: 0 })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-sever-soul', defId: 'sever_soul', upgraded: true },
      { uid: 'ui-sever-soul-one', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-sever-soul-two', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: [],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 2,
    strength: 0,
    weak: 0,
  })
  debug.setRun(run)
  return target.uid
})
const severSoulCard = page.getByRole('button', { name: /^Sever Soul\+,/ })
await severSoulCard.waitFor()
const severSoulLabel = await severSoulCard.getAttribute('aria-label')
await severSoulCard.click()
const emptySeverConfirmation = page.getByRole('button', { name: 'Exhaust none' })
await emptySeverConfirmation.waitFor()
assert(await emptySeverConfirmation.isDisabled(), 'Sever Soul+ allowed zero Exhaust choices')
await page.getByRole('button', { name: /^Defend,/ }).first().click()
await page.getByRole('button', { name: 'Exhaust 1', exact: true }).waitFor()
await shot('06ze-sever-soul-range-choice')
await page.getByRole('button', { name: 'Exhaust 1', exact: true }).click()
await page.getByText('Choose an enemy').waitFor()
await page.locator('.enemy--targeted:not(:disabled)').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
const severSoul = await readState()
check('Sever Soul+ requires one or two Exhaust choices and deals its printed hit', () => {
  assert(severSoulLabel.includes('exhaust 1-2 cards from hand'), severSoulLabel)
  assertEqual(severSoul.players[0].exhaust.length, 1)
  assertEqual(severSoul.players[0].hand.length, 1)
  assertEqual(severSoul.enemies.find((enemy) => enemy.uid === severTarget).hp, 6)
})
await shot('06zf-sever-soul-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-second-wind', defId: 'second_wind', upgraded: true },
      { uid: 'ui-second-wind-sentinel', defId: 'sentinel', upgraded: false },
      { uid: 'ui-second-wind-defend', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-second-wind-strike', defId: 'strike_ironclad', upgraded: false },
      { uid: 'ui-second-wind-daze', defId: 'daze', upgraded: false },
    ],
    draw: [],
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-second-wind-fnp', defId: 'feel_no_pain', upgraded: false }],
    energy: 1,
    block: 0,
  })
  debug.setRun(run)
})
const secondWindCard = page.getByRole('button', { name: /^Second Wind\+,/ })
await secondWindCard.waitFor()
const secondWindLabel = await secondWindCard.getAttribute('aria-label')
const sentinelLabel = await page.getByRole('button', { name: /^Sentinel,/ }).getAttribute('aria-label')
const dazeFallback = page.getByTitle('Daze')
const dazeFallbackBox = await dazeFallback.boundingBox()
const dazeFallbackLayer = await dazeFallback.locator('.card__fallback').evaluate((fallback) =>
  getComputedStyle(fallback).zIndex)
assert(dazeFallbackBox?.height > 100, `Daze collapsed to ${dazeFallbackBox?.height ?? 0}px without scan art`)
assertEqual(dazeFallbackLayer, '0', 'Daze fallback is layered behind its card')
await shot('06zg-second-wind-exhaust-family')
await secondWindCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 1)
const secondWind = await readState()
check('Second Wind+ exhausts non-Attacks, counts Daze, then resolves Sentinel and Feel No Pain', () => {
  assert(secondWindLabel.includes('exhaust all non-Attack cards in hand'), secondWindLabel)
  assert(secondWindLabel.includes('gain 2 Block per card exhausted'), secondWindLabel)
  assert(sentinelLabel.includes('support effect may target any player'), sentinelLabel)
  assert(sentinelLabel.includes('when this card is exhausted, gain 2 Energy'), sentinelLabel)
  assertDeepEqual(secondWind.players[0].hand.map((card) => card.uid), ['ui-second-wind-strike'])
  assertDeepEqual(secondWind.players[0].exhaust.map((card) => card.uid), [
    'ui-second-wind-sentinel', 'ui-second-wind-defend',
  ])
  assertEqual(secondWind.players[0].block, 9, '6 printed Block plus three Feel No Pain triggers')
  assertEqual(secondWind.players[0].energy, 2, 'Sentinel did not refund 2 Energy after Second Wind')
})
await shot('06zh-second-wind-resolved')

const fiendTarget = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const target = run.combat.enemies.find((enemy) => enemy.row === 1) ?? run.combat.enemies[0]
  for (const enemy of run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  Object.assign(target, { hp: 20, maxHp: 20, block: 0, dead: false, vulnerable: 0, abilityUsed: true })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-fiend-fire', defId: 'fiend_fire', upgraded: true },
      { uid: 'ui-fiend-fire-strike', defId: 'strike_ironclad', upgraded: false },
      { uid: 'ui-fiend-fire-sentinel', defId: 'sentinel', upgraded: false },
      { uid: 'ui-fiend-fire-daze', defId: 'daze', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 2, block: 0, strength: 1, weak: 0,
    powers: [{ uid: 'ui-fiend-fire-fnp', defId: 'feel_no_pain', upgraded: false }],
  })
  run.combat.log = []
  debug.setRun(run)
  return target.uid
})
const fiendFireCard = page.getByRole('button', { name: /^Fiend Fire\+,/ })
await fiendFireCard.waitFor()
const fiendFireLabel = await fiendFireCard.getAttribute('aria-label')
await shot('06zi-fiend-fire-full-hand')
await fiendFireCard.click()
await page.getByText('Choose an enemy').waitFor()
await page.locator('.enemy--targeted:not(:disabled)').click()
await page.waitForFunction(() => ![...document.querySelectorAll('button')]
  .some((button) => button.getAttribute('aria-label')?.startsWith('Fiend Fire+,')))
await page.getByText('11/20', { exact: true }).waitFor()
const fiendFire = await readState()
check('Fiend Fire+ Exhausts the whole hand and lands a separate Strength-modified hit per card', () => {
  assert(fiendFireLabel.includes('exhaust all cards in hand'), fiendFireLabel)
  assert(fiendFireLabel.includes('deal 2 as a separate hit per card exhausted'), fiendFireLabel)
  assert(fiendFireLabel.includes('exhausts when played'), fiendFireLabel)
  assertEqual(fiendFire.enemies.find((enemy) => enemy.uid === fiendTarget).hp, 11)
  assertDeepEqual(fiendFire.players[0].hand, [])
  assertDeepEqual(fiendFire.players[0].exhaust.map((card) => card.uid), [
    'ui-fiend-fire-strike', 'ui-fiend-fire-sentinel', 'ui-fiend-fire',
  ])
  assertEqual(fiendFire.players[0].block, 4)
  assertEqual(fiendFire.players[0].energy, 2)
})
await shot('06zj-fiend-fire-resolved')
await page.evaluate((combat) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat = combat
  debug.setRun(run)
}, exhaustPairRestore)
await page.waitForFunction((uid) =>
  window.__STS_DEBUG__.getState().players[0].hand.some((card) => card.uid === uid),
exhaustPairRestore.players[0].hand[0].uid)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-melter', defId: 'melter', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 1,
    strength: 0,
    weak: 0,
  })
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss)
  if (!target) throw new Error('Melter browser fixture needs a non-boss enemy')
  Object.assign(target, { dead: false, hp: 19, maxHp: 20, block: 4, vulnerable: 0 })
  debug.setRun(run)
})
const melterCard = page.getByRole('button', { name: /^Melter\+,/ })
await melterCard.waitFor()
await melterCard.click()
const melterTarget = page.locator('.enemy--targeted[aria-label*="19 of 20 hit points"]').first()
await melterTarget.scrollIntoViewIfNeeded()
await shot('07a-melter-blocked-target')
await melterTarget.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.hp === 16 && enemy.block === 0))
const melter = await readState()
check('Melter+ removes all target Block before dealing 3 damage', () => {
  const target = melter.enemies.find((enemy) => enemy.hp === 16)
  assert(target, 'Melter+ did not deal its full hit through Block')
  assertEqual(target.block, 0)
  assertEqual(melter.players[0].energy, 0)
})
await page.locator('.enemy[aria-label*="16 of 20 hit points"]').scrollIntoViewIfNeeded()
await shot('07b-melter-block-cleared')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-heatsinks', defId: 'heatsinks', upgraded: true },
      { uid: 'ui-fusion', defId: 'fusion', upgraded: true },
    ],
    draw: Array.from({ length: 3 }, (_, index) => ({
      uid: `ui-heatsinks-draw-${index}`, defId: 'defend_defect', upgraded: false,
    })),
    discard: [],
    exhaust: [],
    powers: [],
    energy: 2,
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Heatsinks\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 1)
await page.getByRole('button', { name: /^Fusion\+,/ }).scrollIntoViewIfNeeded()
await shot('07c-heatsinks-before-power-trigger')
await page.getByRole('button', { name: /^Fusion\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const heatsinks = await readState()
const heatsinksLabel = await page.locator('.powers .power').first().getAttribute('aria-label')
check('Heatsinks+ ignores itself then draws 3 when Fusion+ is played', () => {
  assertEqual(heatsinks.players[0].powers.length, 2)
  assertEqual(heatsinks.players[0].hand.length, 3)
  assertEqual(heatsinks.players[0].energy, 0)
  assert(
    heatsinksLabel?.includes('whenever you play a power card'),
    `Heatsinks announces the wrong trigger: ${heatsinksLabel}`,
  )
})
await shot('07d-heatsinks-power-draw')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.players[0], { name: 'Defect', character: 'defect' })
  Object.assign(run.combat.players[0], {
    name: 'Defect',
    character: 'defect',
    hand: [{ uid: 'ui-capacitor', defId: 'capacitor', upgraded: false }],
    powers: [],
    orbs: [null, null, null],
    energy: 1,
    shivs: 0,
    miracles: 0,
  })
  run.combat.log = []
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Capacitor,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs.length === 5)
const capacitorView = await page.evaluate(() => ({
  slots: document.querySelectorAll('.seat--viewer .token--orb').length,
  label: document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
  power: document.querySelector('.powers .power')?.getAttribute('aria-label') ?? '',
}))
check('Capacitor exposes all gained Orb slots visually and accessibly', () => {
  assertEqual(capacitorView.slots, 5)
  assert(capacitorView.label.includes('0 of 5 Orb slots occupied'), capacitorView.label)
  assert(capacitorView.power.includes('gain 2 Orb slots'), capacitorView.power)
})
await shot('07e-capacitor-orb-slots')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-meteor', defId: 'meteor_strike', upgraded: true },
      { uid: 'ui-streamline', defId: 'streamline', upgraded: true },
    ],
    powers: [
      { uid: 'ui-capacitor-power', defId: 'capacitor', upgraded: false },
      { uid: 'ui-heatsinks-power', defId: 'heatsinks', upgraded: false },
      { uid: 'ui-fusion-power', defId: 'fusion', upgraded: false },
      { uid: 'ui-machine-power', defId: 'machine_learning', upgraded: false },
    ],
    orbs: [null, null, null, null, null],
    energy: 1,
  })
  run.combat.log = []
  debug.setRun(run)
})
const discountedCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  cost: card.querySelector('.card__cost')?.textContent,
  label: card.getAttribute('aria-label'),
})))
check('Power discounts update both visible and accessible card costs', () => {
  assertDeepEqual(discountedCards.map((card) => card.cost), ['1', '0'])
  assert(discountedCards[0].label?.includes('cost 1'), discountedCards[0].label)
  assert(discountedCards[1].label?.includes('cost 0'), discountedCards[1].label)
  assert(discountedCards.every((card) => card.label?.includes('costs 1 less for each Power')), discountedCards)
})
await shot('07f-power-discounted-cards')
await page.getByRole('button', { name: /^Meteor Strike\+, cost 1,/ }).click()
await page.locator('.enemy').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
await page.getByRole('button', { name: /^Streamline\+, cost 0,/ }).click()
await page.locator('.enemy').first().click()
const discountedPlay = await readState()
const discountedDiscardTop = await page.locator('.pile__top').filter({ hasText: 'Streamline+' }).textContent()
check('discounted attacks spend their current cost and still resolve', () => {
  assertEqual(discountedPlay.players[0].energy, 0)
  assertEqual(discountedPlay.players[0].hand.length, 0)
  assertEqual(discountedDiscardTop, '0 · Streamline+')
})
await shot('07g-power-discounted-attacks')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.players[0], { name: 'Silent', character: 'silent' })
  Object.assign(run.combat.players[0], {
    name: 'Silent',
    character: 'silent',
    hand: [
      { uid: 'ui-adrenaline', defId: 'adrenaline', upgraded: true },
      { uid: 'ui-catalyst', defId: 'catalyst', upgraded: true },
      { uid: 'ui-flechettes', defId: 'flechettes', upgraded: true },
      { uid: 'ui-grand-finale', defId: 'grand_finale', upgraded: true },
    ],
    draw: [
      { uid: 'ui-final-deflect', defId: 'deflect', upgraded: false },
      { uid: 'ui-final-acrobatics', defId: 'acrobatics', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 0,
    orbs: [null, null, null],
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: 20 + index, maxHp: 20 + index, block: 0, poison: 2, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
const finaleBeforeDraw = page.getByRole('button', { name: /^Grand Finale\+,/ })
const finaleDisabledBeforeDraw = await finaleBeforeDraw.isDisabled()
const finaleLabelBeforeDraw = await finaleBeforeDraw.getAttribute('aria-label')
check('Grand Finale+ is disabled and explains its empty-draw requirement', () => {
  assert(finaleDisabledBeforeDraw, 'Grand Finale should be disabled with cards in draw')
  assert(finaleLabelBeforeDraw?.includes('draw pile is empty'))
})
await page.getByRole('button', { name: /^Adrenaline\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].draw.length === 0)
const afterAdrenaline = await readState()
const finaleEnabledAfterDraw = !(await page.getByRole('button', { name: /^Grand Finale\+,/ }).isDisabled())
check('Adrenaline+ gains 2 Energy, draws 2, and unlocks Grand Finale+', () => {
  assertEqual(afterAdrenaline.players[0].energy, 2)
  assertEqual(afterAdrenaline.players[0].hand.length, 5)
  assert(finaleEnabledAfterDraw)
})
await shot('07h-grand-finale-unlocked')
await page.getByRole('button', { name: /^Catalyst\+,/ }).click()
await page.locator('.enemy').first().click()
await page.getByRole('button', { name: /^Flechettes\+,/ }).click()
await page.locator('.enemy').first().click()
await page.getByRole('button', { name: /^Grand Finale\+,/ }).click()
await page.locator('.enemy').first().click()
const silentCombo = await readState()
check('the Silent combo multiplies Poison, counts Skills, and lands Grand Finale+', () => {
  const target = silentCombo.enemies.find((enemy) => enemy.poison === 6)
  assert(target, 'Catalyst+ did not triple the targeted enemy Poison')
  assertEqual(target.hp, target.maxHp - 15, 'Flechettes+ for 3 then Grand Finale+ for 12')
  assertEqual(silentCombo.players[0].energy, 0)
  assertEqual(silentCombo.players[0].exhaust.length, 2)
})
await shot('07i-silent-poison-finale-combo')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-setup', defId: 'setup', upgraded: true },
      { uid: 'ui-blur', defId: 'blur', upgraded: true },
      { uid: 'ui-all-out-attack', defId: 'all_out_attack', upgraded: true },
      { uid: 'ui-expertise', defId: 'expertise', upgraded: true },
      { uid: 'ui-all-out-discard', defId: 'slice', upgraded: false },
    ],
    draw: [
      { uid: 'ui-power-draw-1', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-power-draw-2', defId: 'defend_silent', upgraded: false },
      { uid: 'ui-power-draw-3', defId: 'slice', upgraded: false },
      { uid: 'ui-power-draw-4', defId: 'deflect', upgraded: false },
      { uid: 'ui-power-draw-5', defId: 'neutralize', upgraded: false },
      { uid: 'ui-power-draw-6', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-power-draw-7', defId: 'defend_silent', upgraded: false },
      { uid: 'ui-power-draw-8', defId: 'backflip', upgraded: false },
      { uid: 'ui-power-draw-9', defId: 'acrobatics', upgraded: false },
      { uid: 'ui-power-draw-10', defId: 'blade_dance', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 6,
    block: 0,
    shivs: 0,
    hp: 20,
    maxHp: 20,
  })
  for (const player of run.combat.players) Object.assign(player, { hp: 20, maxHp: 20, dead: false })
  run.combat.players[1].energy = 0
  run.combat.discardedThisTurn = [actor.id]
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: 30 + index, maxHp: 30 + index, block: 0, poison: 0, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Setup\+,/ }).click()
await page.locator('.seat--targetable:not(.seat--viewer)').click()
await page.getByRole('button', { name: /^Blur\+,/ }).click()
await page.getByRole('button', { name: /^All-Out Attack\+,/ }).click()
await page.locator('.prompt').filter({ hasText: 'Discard 1' }).waitFor()
await page.getByRole('button', { name: /^Slice,/ }).click()
await page.getByRole('button', { name: /^Expertise\+,/ }).click()
const silentTurnCards = await readState()
check('Silent turn cards resolve discard, draw-to-size, Block, and all-enemy damage', () => {
  assertEqual(silentTurnCards.players[0].powers.length, 0)
  assertEqual(silentTurnCards.players[0].block, 4)
  assertEqual(silentTurnCards.players[0].energy, 3)
  assertEqual(silentTurnCards.players[1].energy, 2)
  assert(silentTurnCards.players[0].exhaust.some((card) => card.uid === 'ui-setup'))
  assertEqual(silentTurnCards.players[0].hand.length, 7)
  assert(silentTurnCards.players[0].discard.some((card) => card.uid === 'ui-all-out-discard'))
  assert(silentTurnCards.enemies.every((enemy) => enemy.hp === enemy.maxHp - 3))
})
await shot('07j-silent-turn-cards')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-after-image', defId: 'after_image', upgraded: true },
      { uid: 'ui-calculated-gamble', defId: 'calculated_gamble', upgraded: false },
      { uid: 'ui-reflex', defId: 'reflex', upgraded: true },
      { uid: 'ui-tactician', defId: 'tactician', upgraded: true },
      { uid: 'ui-gamble-spare', defId: 'slice', upgraded: false },
    ],
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-gamble-draw-${index}`, defId: index % 2 ? 'deflect' : 'slice', upgraded: false,
    })),
    discard: [], exhaust: [], powers: [], energy: 1, block: 0,
  })
  run.combat.discardedThisTurn = []
  run.combat.log = []
  debug.setRun(run)
})
const discardReactionLabels = await page.locator('.hand .card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label') ?? ''))
check('discard-reaction cards announce their unplayable and reactive rules', () => {
  const reflex = discardReactionLabels.find((label) => label.startsWith('Reflex+')) ?? ''
  const tactician = discardReactionLabels.find((label) => label.startsWith('Tactician+')) ?? ''
  assert(reflex.includes('unplayable') && reflex.includes('when discarded by a card effect, draw 3 cards'), reflex)
  assert(tactician.includes('unplayable') && tactician.includes('gain 3 Energy') && tactician.includes('exhausts'), tactician)
})
await shot('07k-silent-discard-engine-ready')
await page.getByRole('button', { name: /^After Image\+,/ }).click()
const afterImagePowerLabel = await page.locator('.power').getAttribute('aria-label')
check('After Image in play announces when its Block triggers', () => {
  assert(afterImagePowerLabel?.includes('whenever a card effect makes you discard one or more cards'),
    afterImagePowerLabel ?? 'After Image Power was not rendered')
})
await page.getByRole('button', { name: /^Calculated Gamble,/ }).click()
const discardCombo = await readState()
check('Calculated Gamble resolves Reflex, Tactician, and After Image through the UI', () => {
  const actor = discardCombo.players[0]
  assertEqual(actor.hand.length, 6)
  assertEqual(actor.energy, 4)
  assertEqual(actor.block, 1)
  assertEqual(actor.powers.length, 1)
  assertDeepEqual(actor.exhaust.map((card) => card.uid).sort(), ['ui-calculated-gamble', 'ui-tactician'])
  assert(actor.discard.some((card) => card.uid === 'ui-reflex'))
  assert(discardCombo.discardedThisTurn.includes(actor.id))
})
await shot('07l-silent-discard-engine-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].powers = []
  debug.setRun(run)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-outmaneuver', defId: 'outmaneuver', upgraded: false, retainedLastTurn: true },
      { uid: 'ui-escape-plan', defId: 'escape_plan', upgraded: false },
      { uid: 'ui-masterful-stab', defId: 'masterful_stab', upgraded: false },
      { uid: 'ui-finisher', defId: 'finisher', upgraded: false },
    ],
    draw: [{ uid: 'ui-escape-skill', defId: 'defend_silent', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 1, block: 0,
    lostHpThisCombat: true, attacksPlayedThisTurn: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const silentLedgerCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('the four Silent ledger cards render scans and spoken dynamic rules', () => {
  assert(silentLedgerCards.every((card) => card.artLoaded), 'all four card scans should load')
  assert(silentLedgerCards.some((card) => card.label.startsWith('Masterful Stab, cost 2,') &&
    card.label.includes('after you lose hit points this combat')), 'Masterful Stab should render its current cost')
  assert(silentLedgerCards.some((card) => card.label.startsWith('Finisher') &&
    card.label.includes('other Attack played this turn')), 'Finisher should announce its attack count')
  assert(silentLedgerCards.some((card) => card.label.startsWith('Outmaneuver') &&
    card.label.includes('Retained last turn')), 'Outmaneuver should announce its condition')
})
await shot('07m-silent-ledger-cards-ready')
await page.getByRole('button', { name: /^Outmaneuver,/ }).click()
await page.getByRole('button', { name: /^Escape Plan,/ }).click()
await page.getByRole('button', { name: /^Masterful Stab,/ }).click()
await page.locator('.enemy').first().click()
await page.getByRole('button', { name: /^Finisher,/ }).click()
await page.locator('.enemy').first().click()
const silentLedgers = await readState()
check('the Silent ledger combo resolves through the real card controls', () => {
  const actor = silentLedgers.players[0]
  assertEqual(actor.energy, 0, 'Retain gain and dynamic costs balance to zero')
  assertEqual(actor.block, 1, 'Escape Plan drew a Skill and gained Block')
  assertEqual(actor.attacksPlayedThisTurn, 2, 'Masterful Stab and Finisher are recorded')
  assert(silentLedgers.enemies.some((enemy) => enemy.hp === 17),
    'Masterful Stab then one Finisher hit should deal 3 to their target')
  assert(!Object.hasOwn(actor.discard.find((card) => card.uid === 'ui-outmaneuver'), 'retainedLastTurn'),
    'playing Outmaneuver clears its retained history')
})
await shot('07n-silent-ledger-cards-resolved')

const enemiesBeforeSilentModifiers = structuredClone((await readState()).enemies)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-accuracy', defId: 'accuracy', upgraded: true },
      { uid: 'ui-footwork', defId: 'footwork', upgraded: true },
      { uid: 'ui-envenom', defId: 'envenom', upgraded: true },
      { uid: 'ui-choke', defId: 'choke', upgraded: true },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 6, block: 0, shivs: 1,
    shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: index === 0 ? 20 : 30, maxHp: index === 0 ? 20 : 30,
    block: 0, weak: 0, poison: 0, dead: false,
  }))
  Object.assign(run.combat.enemies[0], { weak: 1, poison: 2 })
  run.combat.log = []
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const silentModifierCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('the four Silent modifier cards render scans and complete spoken rules', () => {
  assert(silentModifierCards.every((card) => card.artLoaded), 'all modifier card scans should load')
  assert(silentModifierCards.some((card) => card.label.startsWith('Accuracy+') && card.label.includes('Shivs deal +1')))
  assert(silentModifierCards.some((card) => card.label.startsWith('Footwork+') &&
    card.label.includes('Block on your Attacks and Skills') && card.label.includes('retain')))
  assert(silentModifierCards.some((card) => card.label.startsWith('Envenom+') &&
    card.label.includes('each hit also applies 1 Poison')))
  assert(silentModifierCards.some((card) => card.label.startsWith('Choke+') &&
    card.label.includes('Weak and Poison on the target')))
})
await shot('07o-silent-modifier-cards-ready')
await page.getByRole('button', { name: /^Accuracy\+,/ }).click()
await page.getByRole('button', { name: /^Footwork\+,/ }).click()
await page.getByRole('button', { name: /^Envenom\+,/ }).click()
await page.getByRole('button', { name: 'Use Shiv' }).click()
await page.locator('.enemy').filter({ hasText: /20\/20/ }).first().click()
await page.getByRole('button', { name: /^Choke\+,/ }).click()
await page.locator('.enemy').filter({ hasText: /18\/20/ }).first().click()
const silentModifiers = await readState()
check('Accuracy, Footwork, Envenom, and Choke resolve through the real controls', () => {
  const actor = silentModifiers.players[0]
  const target = silentModifiers.enemies.find((enemy) => enemy.hp === 10)
  assertEqual(actor.energy, 0)
  assertEqual(actor.shivDamageBonus, 1)
  assertEqual(actor.cardBlockBonus, 1)
  assertEqual(actor.hitPoison, 1)
  assertEqual(actor.powers.length, 3)
  assert(target, 'the Accuracy Shiv and token-scaled Choke+ should deal 10 total')
  assertEqual(target.poison, 4, 'Envenom applies once for the Shiv and once for Choke+')
})
await shot('07p-silent-modifier-cards-resolved')
await page.evaluate((enemies) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    powers: [], shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
  })
  run.combat.enemies = enemies
  debug.setRun(run)
}, enemiesBeforeSilentModifiers)
await page.waitForFunction(() => {
  const player = window.__STS_DEBUG__.getState().players[0]
  return player.shivDamageBonus === 0 && player.cardBlockBonus === 0 && player.hitPoison === 0 &&
    document.querySelectorAll('.power').length === 0
})

const runBeforeSilentChoices = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  if (!ally) throw new Error('the Silent choice playtest needs a teammate')
  Object.assign(actor, {
    character: 'silent',
    hand: [
      { uid: 'ui-distraction', defId: 'distraction', upgraded: true },
      { uid: 'ui-bouncing-flask', defId: 'bouncing_flask', upgraded: true },
      { uid: 'ui-dodge-roll', defId: 'dodge_and_roll', upgraded: true },
      { uid: 'ui-concentrate', defId: 'concentrate', upgraded: true },
      { uid: 'ui-concentrate-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-concentrate-defend', defId: 'defend_silent', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 6, block: 0,
    shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
  })
  ally.block = 0
  ally.dead = false
  if (run.combat.enemies.length < 2) {
    run.combat.enemies.push({
      ...run.combat.enemies[0], uid: 'ui-bounce-second', row: run.combat.enemies[0].row + 1,
    })
  }
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, weak: 0, poison: 0, abilityUsed: false, dead: false,
    row: index,
  }))
  run.combat.powerTriggersUsedThisTurn = []
  run.combat.log = []
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const silentChoiceCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('the Silent choice cards render scans and announce their independent decisions', () => {
  assert(silentChoiceCards.every((card) => card.artLoaded), 'all four choice-card scans should load')
  assert(silentChoiceCards.some((card) => card.label.startsWith('Dodge and Roll+') &&
    card.label.includes('3 separate 1 Block icons')))
  assert(silentChoiceCards.some((card) => card.label.startsWith('Bouncing Flask+') &&
    card.label.includes('3 separate 1 Poison tokens')))
  assert(silentChoiceCards.some((card) => card.label.startsWith('Concentrate+') &&
    card.label.includes('discard any number') && card.label.includes('plus 1')))
  assert(silentChoiceCards.some((card) => card.label.startsWith('Distraction+') &&
    card.label.includes('once per turn') && card.label.includes('put Poison')))
})
await shot('07q-silent-choice-cards-ready')
await page.getByRole('button', { name: /^Distraction\+,/ }).click()
await page.getByRole('button', { name: /^Bouncing Flask\+,/ }).click()
await page.locator('.enemy').nth(0).click()
await page.locator('.enemy').nth(1).click()
await page.locator('.enemy').nth(0).click()
await page.getByRole('button', { name: /^Dodge and Roll\+,/ }).click()
await page.locator('button.seat').nth(0).click()
await page.locator('button.seat').nth(1).click()
await page.locator('button.seat').nth(1).click()
await page.getByRole('button', { name: /^Concentrate\+,/ }).click()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand.push({
    uid: 'ui-concentrate-new-draw', defId: 'neutralize', upgraded: false,
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Neutralize,/ }).waitFor()
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.getByRole('button', { name: /^Neutralize,/ }).click()
await page.getByRole('button', { name: 'Discard 3' }).click()
const silentChoices = await readState()
check('independent targets, optional discard, and once-per-turn Poison resolve through the controls', () => {
  const actor = silentChoices.players[0]
  const ally = silentChoices.players[1]
  assertEqual(actor.block, 3, 'Distraction plus one Dodge icon protects the Silent')
  assertEqual(ally.block, 2, 'two Dodge icons can share one ally target')
  assertEqual(actor.energy, 6, 'Concentrate+ includes a card drawn after staging and respects the Energy cap')
  assertDeepEqual(silentChoices.enemies.map((enemy) => enemy.poison).filter(Boolean).sort((a, b) => b - a), [2, 1])
  assertEqual(actor.powers.length, 1)
  assert(silentChoices.powerTriggersUsedThisTurn.includes(`${actor.id}/power:ui-distraction`),
    'the once-per-turn trigger should be visibly spent')
  assertEqual(actor.exhaust.at(-1)?.uid, 'ui-concentrate')
})
await page.locator('button.seat').nth(1).scrollIntoViewIfNeeded()
await shot('07r-silent-choice-cards-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeSilentChoices)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid.startsWith('ui-')))

const runBeforeShivPowers = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(actor, {
    character: 'silent',
    hand: [
      { uid: 'ui-storm-steel', defId: 'storm_of_steel', upgraded: true },
      { uid: 'ui-storm-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-storm-defend', defId: 'defend_silent', upgraded: false },
    ],
    powers: [], energy: 6, shivs: 4, attacksPlayedThisTurn: 0,
  })
  ally.shivs = 1
  if (run.combat.enemies.length < 2) {
    run.combat.enemies.push({
      ...run.combat.enemies[0], uid: 'ui-storm-added-enemy', row: run.combat.enemies[0].row + 1,
    })
  }
  run.combat.enemies = run.combat.enemies.slice(0, 2).map((enemy, index) => ({
    ...enemy, uid: `ui-storm-enemy-${index}`, hp: 20, maxHp: 20, block: 0,
    weak: 0, vulnerable: 0, poison: 0, abilityUsed: true, dead: false, row: index,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Storm of Steel\+,/ }).waitFor()
await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const shivPowerCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('Storm of Steel renders its complete upgraded rules', () => {
  assert(shivPowerCards.every((card) => card.artLoaded))
  assert(shivPowerCards.some((card) => card.label.startsWith('Storm of Steel+,') &&
    card.label.includes('discard any number') && card.label.includes('1 Shiv per card discarded plus 1')))
})
await shot('07s-silent-storm-of-steel-ready')
await page.getByRole('button', { name: /^Storm of Steel\+,/ }).click()
const prematureStormSkip = await page.getByRole('button', { name: 'Skip remaining overflow attacks' }).count()
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.getByRole('button', { name: 'Discard 2' }).click()
await page.getByText('Choose overflow Shiv target 1/3, or skip the rest').waitFor()
await page.getByRole('button', { name: 'Skip remaining overflow attacks' }).waitFor()
await page.locator('.enemy').nth(0).click()
await page.locator('.enemy').nth(1).click()
await page.locator('.enemy').nth(0).click()
const shivPowers = await readState()
check('Storm of Steel dynamically targets overflow Shivs after its discard choice', () => {
  assertEqual(prematureStormSkip, 0, 'overflow cannot skip the unresolved discard choice')
  assertEqual(shivPowers.players[0].shivs, 4)
  assertEqual(shivPowers.players[1].shivs, 1)
  assertDeepEqual(shivPowers.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b), [18, 19])
  assertEqual(shivPowers.players[0].attacksPlayedThisTurn, 3)
})
await page.locator('.enemy').first().scrollIntoViewIfNeeded()
await shot('07t-silent-storm-of-steel-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeShivPowers)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid.startsWith('ui-')))

const runBeforeUnload = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    character: 'silent',
    hand: [{ uid: 'ui-unload', defId: 'unload', upgraded: true }],
    draw: [], discard: [], exhaust: [], powers: [], energy: 3, shivs: 2,
    shivDamageBonus: 1, hitPoison: 0, attacksPlayedThisTurn: 0,
  })
  if (run.combat.enemies.length < 2) {
    run.combat.enemies.push({
      ...run.combat.enemies[0], uid: 'ui-unload-added-enemy', row: run.combat.enemies[0].row + 1,
    })
  }
  run.combat.enemies = run.combat.enemies.slice(0, 2).map((enemy, index) => ({
    ...enemy, uid: `ui-unload-enemy-${index}`, hp: 20, maxHp: 20, block: 0,
    weak: 0, vulnerable: 0, poison: 0, abilityUsed: true, dead: false, row: index,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Unload\+,/ }).waitFor()
const unloadLabel = await page.getByRole('button', { name: /^Unload\+,/ }).getAttribute('aria-label')
check('Unload renders its complete upgraded separate-attack rule', () => {
  assert(unloadLabel?.includes('use all Shivs now; each deals +2 damage as a separate attack'))
})
await shot('07u-silent-unload-ready')
await page.getByRole('button', { name: /^Unload\+,/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose an enemy'))
await page.locator('.enemy').nth(0).click()
await page.getByText('Choose Shiv attack 1/2').waitFor()
await page.locator('.enemy').nth(0).click()
await page.getByText('Choose Shiv attack 2/2').waitFor()
await page.locator('.enemy').nth(1).click()
const unloaded = await readState()
check('Unload targets its card hit and every held Shiv through the combat board', () => {
  assertDeepEqual(unloaded.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b), [14, 16])
  assertEqual(unloaded.players[0].shivs, 0)
  assertEqual(unloaded.players[0].attacksPlayedThisTurn, 3)
  assertEqual(unloaded.players[0].discard.at(-1)?.uid, 'ui-unload')
})
await page.locator('.enemy').first().scrollIntoViewIfNeeded()
await shot('07v-silent-unload-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeUnload)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid === 'ui-unload'))

const runBeforeInfiniteBlades = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(actor, {
    character: 'silent', hand: [], discard: [], exhaust: [], energy: 0, shivs: 3,
    strength: 0, attacksPlayedThisTurn: 0,
    powers: [
      { uid: 'ui-infinite-demon', defId: 'demon_form', upgraded: false },
      { uid: 'ui-infinite-blades', defId: 'infinite_blades', upgraded: true },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-infinite-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  Object.assign(ally, { shivs: 2, hand: [], draw: Array.from({ length: 5 }, (_, index) => ({
    uid: `ui-infinite-ally-${index}`, defId: 'defend_ironclad', upgraded: false,
  })) })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, weak: 0, vulnerable: 0,
    poison: 0, dead: false, abilityUsed: true,
  }))
  debug.setRun(run)
})
await page.locator('.power').first().waitFor()
const infinitePowerLabels = await page.locator('.power').evaluateAll((powers) =>
  powers.map((power) => power.getAttribute('aria-label') ?? ''))
check('Infinite Blades announces its upgraded recurring Shiv effect', () => {
  assert(infinitePowerLabels.some((label) =>
    label.includes('Infinite Blades') && label.includes('2 Shivs') && label.includes('start of each turn')),
  JSON.stringify(infinitePowerLabels))
})
const infinitePower = page.locator('.power[aria-label^="Infinite Blades"]')
await infinitePower.click()
await page.waitForFunction(() => document.querySelector('.power__zoom')?.complete)
await shot('07w-silent-infinite-blades-ready')
await infinitePower.click()
await page.getByRole('button', { name: 'Start turn 2' }).click()
await page.locator('.combat[data-phase="start"]').waitFor()
await page.locator('.end-turn-order > summary').click()
await page.locator('.end-turn-order button[aria-label*="Infinite Blades"][aria-label$="earlier"]').click()
await page.locator('.end-turn-order > summary').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose overflow Shiv 1/2'))
await shot('07x-silent-infinite-blades-choice')
await page.locator('.enemy:not([disabled])').first().click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose overflow Shiv 2/2'))
await page.getByRole('button', { name: 'Skip this Shiv' }).click()
await shot('07x2-silent-infinite-blades-reset')
await page.getByRole('button', { name: 'Reset start choices' }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose overflow Shiv 1/2'))
await page.locator('.enemy:not([disabled])').first().click()
await page.getByRole('button', { name: 'Skip this Shiv' }).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const infiniteBlades = await readState()
check('Infinite Blades orders, targets, and explicitly skips Start-of-Turn overflow', () => {
  const actor = infiniteBlades.players[0]
  assertEqual(actor.shivs, 3)
  assertEqual(infiniteBlades.players[1].shivs, 2)
  assertEqual(actor.attacksPlayedThisTurn, 1)
  assertEqual(actor.strength, 1, 'Demon Form resolves after the reordered Shiv attack')
  assertDeepEqual(infiniteBlades.enemies.filter((enemy) => enemy.hp < 20).map((enemy) => enemy.hp), [19])
})
await page.locator('.enemy').first().scrollIntoViewIfNeeded()
await shot('07y-silent-infinite-blades-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeInfiniteBlades)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'start')

const runBeforeNoxiousFumes = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(actor, {
    character: 'silent', hand: [], discard: [], exhaust: [], energy: 0,
    powers: [{ uid: 'ui-noxious-fumes', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-noxious-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  for (const ally of run.combat.players.slice(1)) {
    Object.assign(ally, { hand: [], draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-noxious-${ally.id}-${index}`, defId: 'defend_ironclad', upgraded: false,
    })) })
  }
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, poison: 0, dead: false, abilityUsed: true,
  }))
  Object.assign(run.combat.enemies[0], { hp: 0, dead: true })
  debug.setRun(run)
})
const noxiousPower = page.locator('.power[aria-label^="Noxious Fumes"]')
await noxiousPower.waitFor()
const noxiousLabel = await noxiousPower.getAttribute('aria-label')
check('Noxious Fumes announces its recurring single-enemy Poison', () => {
  assert(noxiousLabel.includes('1 Poison to one enemy') && noxiousLabel.includes('start of each turn'), noxiousLabel)
})
await noxiousPower.click()
await page.waitForFunction(() => document.querySelector('.power__zoom')?.complete)
await shot('07z-silent-noxious-fumes-ready')
await noxiousPower.click()
await page.getByRole('button', { name: 'Start turn 2' }).click()
await page.locator('.combat[data-phase="start"]').waitFor()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Noxious Fumes') &&
  document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
const noxiousDeadTargets = await page.locator('.enemy[disabled].enemy--targeted').count()
const noxiousLiveTargets = await page.locator('.enemy:not([disabled]).enemy--targeted').count()
const noxiousLivingEnemies = (await readState()).enemies.filter((enemy) => !enemy.dead).length
check('Start-of-Turn targeting highlights living enemies but not defeated ones', () => {
  assertEqual(noxiousDeadTargets, 0)
  assertEqual(noxiousLiveTargets, noxiousLivingEnemies)
})
await shot('07za-silent-noxious-fumes-target')
await page.locator('.enemy:not([disabled])').nth(1).click()
await page.getByRole('button', { name: 'Reset start choices' }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
await page.locator('.enemy:not([disabled])').nth(1).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const noxiousBase = await readState()
check('base Noxious Fumes poisons only its chosen enemy at the next Start of Turn', () => {
  assertEqual(noxiousBase.enemies.filter((enemy) => enemy.poison === 1).length, 1)
  assertEqual(noxiousBase.enemies.reduce((sum, enemy) => sum + enemy.poison, 0), 1)
})
await shot('07zb-silent-noxious-fumes-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'roundEnd', turn: 2 })
  run.combat.players[0].powers = [
    { uid: 'ui-noxious-fumes-plus', defId: 'noxious_fumes', upgraded: true },
  ]
  for (const enemy of run.combat.enemies) enemy.poison = 0
  debug.setRun(run)
})
const noxiousUpgraded = page.locator('.power[aria-label^="Noxious Fumes+"]')
await noxiousUpgraded.waitFor()
const noxiousUpgradedLabel = await noxiousUpgraded.getAttribute('aria-label')
await page.getByRole('button', { name: 'Start turn 3' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const noxiousAll = await readState()
check('upgraded Noxious Fumes automatically poisons every enemy', () => {
  assert(noxiousUpgradedLabel.includes('1 Poison to every enemy'), noxiousUpgradedLabel)
  assert(noxiousAll.enemies.every((enemy) => enemy.poison === (enemy.dead ? 0 : 1)))
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeNoxiousFumes)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'start')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].potions = ['cunning_potion', 'block_potion', 'fire_potion', 'explosive_potion']
  run.combat.players[0].shivs = 3
  run.combat.players[0].strength = 0
  run.combat.players[0].strengthLossAtEndOfTurn = 0
  run.combat.players[0].drawLocked = false
  run.combat.players[1].shivs = 2
  const fragile = run.combat.enemies.find((enemy) => !enemy.dead && !enemy.isBoss)
  const durable = run.combat.enemies.find((enemy) => !enemy.dead && enemy.uid !== fragile?.uid)
  if (!fragile || !durable) throw new Error('potion browser fixture needs two living enemies')
  for (const enemy of run.combat.enemies) {
    enemy.block = 0
    enemy.abilityUsed = true
    if (!enemy.dead) {
      enemy.hp = Math.max(enemy.hp, 10)
      enemy.maxHp = Math.max(enemy.maxHp, 10)
    }
  }
  Object.assign(fragile, { hp: 1, maxHp: 1 })
  Object.assign(durable, { hp: 11, maxHp: 11 })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => !enemy.dead && enemy.hp === 1))
const cunningBefore = await readState()
const fragilePotionTarget = cunningBefore.enemies.find((enemy) => !enemy.dead && enemy.hp === 1)
const cunningTarget = cunningBefore.enemies.find((enemy) => !enemy.dead && enemy.hp === 11)
assert(fragilePotionTarget && cunningTarget, 'the browser potion playtest needs fragile and durable targets')
await page.locator('.combat__actions').getByRole('button', { name: /Cunning Potion/ }).click()
await page.waitForSelector('.enemy--targeted')
const fragilePotionButton = page.getByRole('button', { name: /1 of 1 hit points/ }).first()
const cunningTargetButton = page.getByRole('button', {
  name: new RegExp(`${cunningTarget.hp} of ${cunningTarget.maxHp} hit points`),
}).first()
await fragilePotionButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/3'))
await fragilePotionButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('3/3'))
await cunningTargetButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/3'))
const invalidPotionTargets = await readState()
check('Cunning Potion keeps targeting open when a queued attack would hit a dead enemy', () => {
  assert(invalidPotionTargets.players[0].potions.includes('cunning_potion'))
  assertEqual(invalidPotionTargets.enemies.find((enemy) => enemy.uid === fragilePotionTarget.uid).hp, 1)
})
await cunningTargetButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/3'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].shivs = 0
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/1'))
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05fa-cunning-potion-overflow')
await cunningTargetButton.click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].potions.includes('cunning_potion'))
const cunningAfter = await readState()
check('Cunning Potion restarts overflow targeting when a teammate frees shared Shivs', () => {
  const after = cunningAfter.enemies.find((enemy) => enemy.uid === cunningTarget.uid)
  assertEqual(after.hp, cunningTarget.hp - 1)
  assertEqual(cunningAfter.players[0].shivs, 5, 'the full shared supply stays capped')
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

const explosiveTarget = firedPotion.enemies
  .filter((enemy) => !enemy.dead && !enemy.isBoss)
  .sort((a, b) => b.row - a.row)[0]
assert(explosiveTarget, 'the browser potion playtest needs one living row target')
await page.locator('.combat__actions').getByRole('button', { name: /Explosive Potion/ }).click()
await page.waitForSelector('.row__potion-target')
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05h-explosive-potion-row-targeting')
await page.getByRole('button', { name: `Target row ${explosiveTarget.row + 1}` }).click()
const explodedPotion = await readState()
check('Explosive Potion damages the chosen row and any boss, but no other row', () => {
  for (const [index, before] of firedPotion.enemies.entries()) {
    const after = explodedPotion.enemies[index]
    const shouldTakeDamage = !before.dead && (before.row === explosiveTarget.row || before.isBoss)
    assertEqual(after.hp, shouldTakeDamage ? Math.max(0, before.hp - 2) : before.hp)
  }
  assertEqual(explodedPotion.players[0].potions.includes('explosive_potion'), false)
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
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].shivs = 0
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/1'))
const changedCardSupply = await readState()
check('a gain-Shiv card restarts targeting when the shared supply changes', () => {
  assertEqual(changedCardSupply.players[0].hand[0]?.uid, 'overflow-dance')
  assertEqual(changedCardSupply.enemies[0].hp, 1)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].shivs = 1
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/2'))
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/2'))
const refusedCardOverflow = await readState()
check('a card keeps targeting open when a queued Shiv would hit a dead enemy', () => {
  assertEqual(refusedCardOverflow.players[0].hand[0]?.uid, 'overflow-dance')
  assertEqual(refusedCardOverflow.enemies[0].hp, 1)
  assertEqual(refusedCardOverflow.enemies[1].hp, 5)
})
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
await enterFirstRoom()
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
await enterFirstRoom()
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
await enterFirstRoom()
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
  const dualDisabled = document.querySelector('.hand .card')?.disabled ?? false
  me.hand = [{ uid: 'solo-recursion', defId: 'recursion', upgraded: false }]
  debug.setRun(structuredClone(run))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const recursionDisabled = document.querySelector('.hand .card')?.disabled ?? false
  me.hand = [{ uid: 'solo-chaos', defId: 'chaos', upgraded: false }]
  debug.setRun(structuredClone(run))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const chaosLabel = document.querySelector('.hand .card')?.getAttribute('aria-label') ?? ''
  return { dualDisabled, recursionDisabled, chaosLabel }
})
check('a card that cannot resolve is not offered', () => {
  assert(emptyEvoke.dualDisabled, 'Dual Cast with no orbs charged should be greyed out')
  assert(emptyEvoke.recursionDisabled, 'Recursion with no orbs charged should be greyed out')
  assert(emptyEvoke.chaosLabel.includes('Lightning on die 1 or 2') &&
    emptyEvoke.chaosLabel.includes('Frost on 3 or 4') && emptyEvoke.chaosLabel.includes('Dark on 5 or 6'),
  'Chaos should announce its full die mapping')
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
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [{ uid: 'ui-curl-up-strike', defId: 'strike_ironclad', upgraded: false }]
  run.combat.players[0].energy = 3
  debug.setRun(run)
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
  state.enemies = state.enemies.filter((enemy) => enemy.isBoss || enemy.row !== row)
  for (let index = 0; index < 3; index++) state.enemies.push({
    ...red,
    uid: `layout-enemy-${index}`,
    row,
    isBoss: false,
    hp: red.maxHp,
    dead: false,
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
await enterFirstRoom()
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
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const [stale, fallback] = run.combat.enemies.filter((enemy) => !enemy.dead)
  if (!stale || !fallback) throw new Error('Predator retry fixture needs two living enemies')
  Object.assign(stale, { hp: 7, maxHp: 7, block: 0 })
  Object.assign(fallback, { hp: 9, maxHp: 9, block: 0 })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.hp === 7))
const allyHandBeforePredator = (await readState()).players[1].hand.length
await clickCard('h-predator')
await page.locator('.enemy[aria-label*="7 of 7 hit points"]').click()
const predatorPrompt = await page.locator('.prompt').textContent()
check('Predator asks for its ally after its enemy is chosen', () => {
  assert(/Choose who gets it/i.test(predatorPrompt ?? ''), `expected an ally prompt, got ${predatorPrompt}`)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const stale = run.combat.enemies.find((enemy) => enemy.hp === 7)
  Object.assign(stale, { hp: 0, dead: true })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose an enemy'))
const stalePredator = await readState()
check('a staged card drops a primary target defeated by a teammate', () => {
  assert(stalePredator.players[0].hand.some((card) => card.uid === 'h-predator'))
})
await page.locator('.enemy--targeted:not(:disabled)').first().click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose who gets it'))
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
await enterFirstRoom()
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

// Curses are full card faces, not hidden counters: verify their scans, spoken
// rules, end-turn effects, Ethereal cleanup and Retain through the real UI.
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'curse-playtest'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await enterFirstRoom()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hp = 8
  player.block = 1
  player.orbs = ['lightning', 'lightning', null]
  const enemy = run.combat.enemies[0]
  run.combat.enemies = [
    { ...enemy, uid: 'curse-fragile', hp: 1, maxHp: 1, block: 0, dead: false, row: 0 },
    { ...enemy, uid: 'curse-safe', defId: 'acid_slime', hp: 4, maxHp: 4, block: 0, dead: false, row: 1 },
  ]
  player.hand = [
    { uid: 'curse-clumsy', defId: 'clumsy', upgraded: false },
    { uid: 'curse-decay', defId: 'decay', upgraded: false },
    { uid: 'curse-doubt', defId: 'doubt', upgraded: false },
    { uid: 'curse-pain', defId: 'pain', upgraded: false },
    { uid: 'curse-regret', defId: 'regret', upgraded: false },
    { uid: 'curse-shame', defId: 'shame', upgraded: false },
    { uid: 'curse-bane', defId: 'ascenders_bane', upgraded: false },
  ]
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 7)
await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const curseCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('Curse scans and spoken keyword rules render in hand', () => {
  assert(curseCards.every((card) => card.artLoaded), 'every Curse scan should load')
  assert(curseCards.some((card) => card.label.startsWith('Clumsy') && card.label.includes('ethereal')),
    'Clumsy should announce Ethereal')
  assert(curseCards.some((card) => card.label.startsWith('Pain') && card.label.includes('2 or fewer')),
    'Pain should announce its hand-size condition')
})
await shot('15b-curse-hand')
await page.locator('.end-turn-order > summary').click()
for (let step = 0; step < 6; step++) {
  await page.getByRole('button', { name: /Move Ironclad — Shame earlier/ }).click()
}
const visibleEndTurnOrder = await page.locator('.end-turn-order li span').allTextContents()
check('the player can order end-of-turn abilities before committing', () => {
  assert(visibleEndTurnOrder.findIndex((label) => label.endsWith('Shame')) <
    visibleEndTurnOrder.findIndex((label) => label.endsWith('Decay')),
    `expected Shame before Decay: ${visibleEndTurnOrder.join(' → ')}`)
  assert(visibleEndTurnOrder.some((label) => label.endsWith('Lightning Orb 1')),
    'each Orb should appear as its own ability')
})
await shot('15bb-end-turn-order')
await page.getByRole('button', { name: 'End turn' }).click()
await page.getByRole('alert').filter({ hasText: 'living target' }).waitFor()
const rejectedOrbPlan = await readState()
check('a stale Lightning target keeps the whole end-turn plan editable', () => {
  assertEqual(rejectedOrbPlan.phase, 'player')
  assertDeepEqual(rejectedOrbPlan.enemies.map((enemy) => enemy.hp), [1, 4],
    'the rejected plan must not leak partial Orb damage')
})
await shot('15bba-stale-orb-target')
await page.getByLabel('Target for Ironclad — Lightning Orb 2').selectOption({ label: 'Acid Slime' })
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const cursePrepared = await readState()
check('the Curse end-turn step resolves before discard ordering', () => {
  const player = cursePrepared.players[0]
  assertEqual(player.hp, 7, 'the chosen Shame-before-Decay order exposes one damage')
  assertEqual(player.block, 0, 'Shame removes the only Block before Decay')
  assertEqual(player.weak, 1, 'Doubt grants Weak')
  assertDeepEqual(cursePrepared.enemies.map((enemy) => enemy.hp), [0, 3],
    'each Lightning Orb uses its selected target')
  assertDeepEqual(player.exhaust.map((card) => card.uid).sort(), ['curse-bane', 'curse-clumsy'])
  assertEqual(player.hand.length, 5, 'Ethereal cards leave before the discard picker')
})
await shot('15c-ethereal-discard')
await confirmAllDiscards()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const curseDiscarded = await readState()
check('Regret stays retained after the rest of the Curse hand is discarded', () => {
  assertDeepEqual(curseDiscarded.players[0].hand.map((card) => card.uid), ['curse-regret'])
})

// The campfire is the first non-combat room with real interaction: each player
// independently Rests or Smiths, and nobody leaves until all have chosen.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'campfire'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 2)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
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

page.once('dialog', (dialog) => dialog.accept())
await page.getByLabel('Ascension').selectOption('9')
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().ascension === 9)
const ascendedSetup = await readRun()
const ascensionHeader = await page.locator('.run-status').textContent()
check('the solo table starts and labels a cumulative Ascension 9 run', () => {
  assertEqual(ascendedSetup.players[0].maxHp, 9, 'A2 reduces Ironclad max HP')
  assertEqual(ascendedSetup.players[0].hp, 8, 'A9 starts Ironclad 1 HP below the reduced maximum')
  assert(ascendedSetup.players.every((player) =>
    player.deck.some((card) => card.defId === 'ascenders_bane')), 'A5 remains cumulative at A9')
  assert(ascensionHeader.includes('Ascension 9'), `missing Ascension status: ${ascensionHeader}`)
})
await shot('16-ascension-9-setup')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  debug.setRun({ ...structuredClone(debug.getRun()), phase: 'defeat' })
})
await page.getByRole('button', { name: 'Try again' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const ascensionRetry = await readRun()
check('Try again preserves every Ascension setup modifier', () => {
  assertEqual(ascensionRetry.ascension, 9)
  assertEqual(ascensionRetry.players[0].maxHp, 9)
  assertEqual(ascensionRetry.players[0].hp, 8)
  assert(ascensionRetry.players[0].deck.some((card) => card.defId === 'ascenders_bane'))
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
