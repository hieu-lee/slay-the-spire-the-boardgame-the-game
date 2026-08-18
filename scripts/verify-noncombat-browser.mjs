import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createRoomServer } from './room-server.mjs'
import { enterRoom, roomChoices } from '../src/game/run.ts'
import { createRun } from '../src/game/run.ts'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { DAILY_MODIFIERS } from '../src/game/meta.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'artifacts/noncombat-browser')
mkdirSync(outDir, { recursive: true })
const rooms = createRoomServer({ maxUpgradesPerWindow: 100 })
const roomAddress = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${roomAddress.port}`
const server = await createServer({ root: repoRoot, logLevel: 'silent', server: { port: 0, proxy: {
  '/api': { target: roomOrigin },
  '/ws': { target: roomOrigin, ws: true },
} } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const base = `http://localhost:${address.port}`
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = installScreenAudit(await browser.newPage({ viewport: { width: 1440, height: 900 } }))
const failures = []
page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
page.on('pageerror', (error) => failures.push(String(error)))

async function chooseLocalSeat(option) {
  const menu = page.locator('details.game-settings')
  await menu.locator(':scope > summary').click()
  await page.getByLabel('Seat').selectOption(option)
  await menu.locator(':scope > summary').click()
}

async function setRoom(kind) {
  await page.evaluate((roomKind) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.phase = 'room'
    run.neow = null
    run.players = run.players.map((player, index) => ({ ...player, gold: 12 - index, potions: index === 0 ? ['fire_potion'] : player.potions }))
    if (roomKind === 'merchant') run.roomState = {
      kind: 'merchant', relics: ['anchor', 'happy_flower', 'akabeko'], potions: ['fire_potion', 'swift_potion', 'blood_potion'], colorless: [],
      cards: Object.fromEntries(run.players.map((player) => [player.id, { choices: player.cardRewards.slice(0, 3), cardsDrawn: player.cardRewards.slice(0, 3), raresDrawn: [] }])), removalUsed: [], purchasedCards: {},
    }
    else if (roomKind === 'treasure') run.roomState = { kind: 'treasure', offers: Object.fromEntries(run.players.map((player, index) => [player.id, ['anchor', 'happy_flower', 'akabeko', 'lantern'][index]])), playerIds: run.players.map((player) => player.id), decisions: {} }
    else run.roomState = {
      kind: 'event', card: { id: 'big_fish', instanceId: 'browser-big-fish', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Big Fish', scope: 'player', rule: 'Each player chooses a different option.', options: [
        { id: 'banana', label: 'Banana', description: 'Heal 2 HP.', effects: [{ tag: 'heal', amount: 2 }] },
        { id: 'donut', label: 'Donut', description: 'Upgrade a starter Strike.', effects: [{ tag: 'upgrade-card', filter: 'starter Strike' }] },
        { id: 'box', label: 'Box', description: 'Gain a Relic. Gain a Curse.', effects: [{ tag: 'gain-relic' }, { tag: 'gain-curse' }] },
        { id: 'restraint', label: 'Restraint', description: 'Remove a starter Strike.', effects: [{ tag: 'remove-card', filter: 'starter Strike' }] },
      ] }, decisions: {}, dieRolls: {},
    }
    debug.setRun(run)
  }, kind)
}

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__)

await page.getByRole('button', { name: 'Achievements' }).click()
await page.getByRole('heading', { name: 'Achievements', exact: true }).waitFor()
const localAchievementCount = await page.locator('.achievement-card').count()
const localAchievementDevControls = await page.getByText('Mark complete', { exact: false }).count()
const localAchievementProgressUi = await page.locator('progress[aria-label="Achievement completion"], .achievement-card small, .achievement-card[data-complete]').count()
const localAchievementHeights = await page.locator('.achievement-card').evaluateAll((cards) =>
  [...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height)))])
await page.setViewportSize({ width: 1280, height: 800 })
await page.screenshot({ path: join(outDir, 'achievements-local-compact-desktop.png'), fullPage: true })
await page.getByRole('button', { name: 'Back to main menu' }).click()

await page.setViewportSize({ width: 1280, height: 720 })
await page.getByRole('button', { name: 'Settings' }).click()
const localMeta = page.locator('.start-menu__meta')
await localMeta.locator('summary').click()
await localMeta.getByLabel('Run mode').selectOption('daily')
await page.waitForFunction(() => document.querySelectorAll('.start-menu__daily li').length === 2)
const localDailyModifierCount = await page.locator('.start-menu__daily li').count()
const localDailyModifierNames = await page.locator('.start-menu__daily strong').allTextContents()
await localMeta.locator('summary').click()
await page.getByRole('button', { name: 'Close' }).click()
await page.getByRole('button', { name: 'Single Player' }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
const localDailyRunIds = await page.evaluate(() => window.__STS_DEBUG__.getRun().meta.modifierIds)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__)
await page.setViewportSize({ width: 1280, height: 720 })
await page.getByRole('button', { name: 'Settings' }).click()
await localMeta.locator('summary').click()
await localMeta.getByLabel('Run mode').selectOption('custom')
await localMeta.getByRole('checkbox', { name: /Cursed/ }).click()
await localMeta.getByRole('checkbox', { name: /Night Terrors/ }).click()
await localMeta.getByLabel('Starting Act').selectOption('2')
await page.waitForFunction(() => [...document.querySelectorAll('.start-menu__custom input')].filter((input) => input.checked).length === 2)
await localMeta.locator('.start-menu__meta-panel').evaluate((panel) => {
  const cursed = [...panel.querySelectorAll('label')].find((label) => label.textContent?.includes('Cursed'))
  panel.scrollTop = Math.max(0, (cursed?.offsetTop ?? 0) - 16)
})
const compactMetaFrame = await page.evaluate(() => {
  const setup = document.querySelector('.start-menu__setup')?.getBoundingClientRect()
  const panel = document.querySelector('.start-menu__meta-panel')?.getBoundingClientRect()
  return {
    documentOverflow: document.documentElement.scrollWidth > innerWidth,
    setupContained: Boolean(setup && setup.left >= 0 && setup.right <= innerWidth),
    panelContained: Boolean(panel && panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight),
  }
})
await page.screenshot({ path: join(outDir, 'meta-start-menu-compact-landscape.png'), fullPage: true })
await localMeta.locator('summary').click()
await page.getByRole('button', { name: 'Close' }).click()
await page.getByRole('button', { name: 'Single Player' }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
const localMetaRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
await page.locator('details.game-settings > summary').click()
const localModifierSummary = page.locator('.run-modifiers > summary')
await localModifierSummary.waitFor()
const localModifierSummaryText = await localModifierSummary.textContent()
await localModifierSummary.click()
const visibleNightTerrors = await page.getByText(/Night Terrors/).count()
await page.setViewportSize({ width: 1100, height: 760 })
await page.screenshot({ path: join(outDir, 'meta-custom-run.png'), fullPage: true })
await page.locator('details.game-settings > summary').click()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const roomId = run.map.rows[0][0]
  run.phase = 'room'
  run.neow = null
  run.map.position = roomId
  run.map.rooms[roomId].kind = 'campfire'
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Campfire' }).waitFor()
const localNightTerrorsRestDisabled = await page.getByRole('button', { name: /^Rest/ }).evaluateAll((buttons) =>
  buttons.length > 0 && buttons.every((button) => button.disabled))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'setup'
  run.setup = { ...run.setup, rowIndex: 3, repeatIndex: 0, playerIndex: 0, die: null }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Transform a card' }).waitFor()
const localSetupConfirm = page.getByRole('button', { name: 'Confirm' })
const localSetupRequiresCard = await localSetupConfirm.isDisabled()
await page.locator('.quick-setup__cards .card').first().click()
const localSetupSelectionEnables = await localSetupConfirm.isEnabled()
const localSetupContained = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
await page.screenshot({ path: join(outDir, 'quick-start-active-desktop.png'), fullPage: true })

await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__)
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
const soloNeowLayout = await page.evaluate(() => {
  const neow = document.querySelector('.neow-screen__neow')?.getBoundingClientRect()
  const speech = document.querySelector('.neow-face--solo')?.getBoundingClientRect()
  return { speechLeft: speech?.left ?? -1, speechRight: speech?.right ?? innerWidth + 1,
    gap: neow && speech ? Math.max(0, neow.left - speech.right, speech.left - neow.right) : Infinity,
    viewportWidth: innerWidth }
})
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'catch-up-solo-ui'))
await page.waitForFunction(() => Object.keys(window.__STS_DEBUG__.getRun().neow.players).length === 2)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.setup = { kind: 'catch-up', targetAct: 2, playerIds: ['p2'], rowIndex: 0, repeatIndex: 0, playerIndex: 0, die: null }
  run.neow.players = { p2: run.neow.players.p2 }
  debug.setViewer('p1')
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Resolve Silent' }).click()
await page.getByRole('heading', { name: 'Catch Up in progress' }).waitFor({ state: 'detached' })
const localSoloCatchUpSwitched = await page.locator('.neow-action__owner > span').textContent()
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'noncombat-ui'))
await page.waitForFunction(() => Object.keys(window.__STS_DEBUG__.getRun().neow.players).length === 4)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  window.__neowPotionRun = structuredClone(run)
  run.players[0].potions = ['swift_potion', 'blood_potion', 'energy_potion']
  run.neow.players.p1.redGoldPending = false
  run.neow.players.p1.redReward = { kind: 'potion', choices: ['fire_potion'], cardsDrawn: ['fire_potion'] }
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('.neow-offer--potion button .item-card-image')]
  .every((image) => image.naturalWidth > 0) && document.querySelectorAll('.neow-offer--potion button .item-card-image').length === 3)
const localNeowReplacementCards = await page.locator('.neow-offer--potion button .item-card-image').count()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  debug.setViewer('p1')
  debug.setRun(window.__neowPotionRun)
  delete window.__neowPotionRun
})
suite('non-combat browser')

check('solo Neow dialogue stays on-screen beside Neow', () => {
  assert(soloNeowLayout.speechLeft >= 0 && soloNeowLayout.speechRight <= soloNeowLayout.viewportWidth)
  assert(soloNeowLayout.gap <= 16, `Neow dialogue gap is ${soloNeowLayout.gap}px`)
})

check('solo Catch Up dialogue remains clickable beside Neow', () => assertEqual(localSoloCatchUpSwitched, 'Silent'))
check('Neow potion replacement choices use physical card art', () => assertEqual(localNeowReplacementCards, 3))

check('meta setup, achievements, and compact title layout survive real local navigation', () => {
  assertEqual(localAchievementCount, 19)
  assertEqual(localAchievementDevControls, 0, 'achievement developer controls are visible')
  assertEqual(localAchievementProgressUi, 0, 'the reference gallery still claims unsupported completion progress')
  assertDeepEqual(localAchievementHeights, [240], 'achievement cards have inconsistent heights')
  assertEqual(localDailyModifierCount, 2)
  assertDeepEqual(
    localDailyRunIds,
    DAILY_MODIFIERS.filter((modifier) => localDailyModifierNames.includes(modifier.name)).map((modifier) => modifier.id),
    'Daily Climb preview differs from the started run',
  )
  assertDeepEqual(localMetaRun.meta.modifierIds, ['cursed', 'night_terrors'])
  assertEqual(localMetaRun.setup.targetAct, 2)
  assert(localModifierSummaryText?.includes('Custom Run · 2 modifiers'))
  assert(visibleNightTerrors > 0, 'active modifier rule disappeared after starting')
  assert(localNightTerrorsRestDisabled, 'Night Terrors left Rest available at the Campfire')
  assert(localSetupRequiresCard && localSetupSelectionEnables, 'Quick Start card selection did not gate confirmation')
  assert(localSetupContained, 'Quick Start cards escaped the desktop viewport')
  assert(!compactMetaFrame.documentOverflow && compactMetaFrame.setupContained && compactMetaFrame.panelContained,
    'Run setup or its expanded meta panel escaped the 720×360 title frame')
})

await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
const localNeowFaces = await page.locator('.neow-face').count()
const localNeowOptions = await page.locator('.neow-face li').count()
const hiddenRedOrder = await page.evaluate(() => {
  const run = window.__STS_DEBUG__.getRun()
  return { pending: run.neow.players.p1.redRewardPending,
    offer: run.neow.players.p1.redReward, publicOffers: document.querySelectorAll('.neow-face__reveal').length }
})
const readNeowFaceActionOverlap = () => page.evaluate(() => {
  const action = document.querySelector('.neow-action')?.getBoundingClientRect()
  if (!action) return true
  return [...document.querySelectorAll('.neow-face')].some((face) => {
    const box = face.getBoundingClientRect()
    return box.left < action.right && box.right > action.left
      && box.top < action.bottom && box.bottom > action.top
  })
})
const neowFaceActionOverlap = await readNeowFaceActionOverlap()
assertEqual(await page.getByRole('button', { name: 'Reveal Card Reward' }).count(), 0, 'red Card Reward Reveal appeared before Gold resolved')
assertEqual(await page.getByRole('button', { name: 'Skip unseen' }).count(), 0, 'red Card Reward skip appeared before Gold resolved')
await page.screenshot({ path: join(outDir, 'neow-4p-desktop.png'), fullPage: true })
await page.getByRole('button', { name: 'Skip 3 Gold' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().neow.players.p1.redGoldPending === false)
assertEqual(await page.getByRole('button', { name: 'Reveal Card Reward' }).count(), 1, 'red Card Reward Reveal did not appear after Gold resolved')
assertEqual(await page.getByRole('button', { name: 'Skip unseen' }).count(), 1, 'red Card Reward skip did not appear after Gold resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  window.__neowCardRewards = run.players.map((player) => [...player.cardRewards])
  run.players = run.players.map((player, index) => ({
    ...player,
    cardRewards: [],
    relics: index === 0 ? [...player.relics, { defId: 'prismatic_shard', spent: false }] : player.relics,
  }))
  run.itemDecks.colorless = []
  debug.setRun(run)
})
await page.getByText('Fewer than 3 reward decks remain. Skip this reward unseen.').waitFor()
const exhaustedPrismaticRevealDisabled = await page.getByRole('button', { name: 'Reveal Card Reward' }).isDisabled()
const exhaustedPrismaticSkipEnabled = await page.getByRole('button', { name: 'Skip unseen' }).isEnabled()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player, index) => ({
    ...player,
    cardRewards: window.__neowCardRewards[index],
    relics: index === 0 ? player.relics.filter((relic) => relic.defId !== 'prismatic_shard') : player.relics,
  }))
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Reveal Card Reward' && !button.disabled))
await page.getByRole('button', { name: 'Reveal Card Reward' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().neow.players.p1.redReward !== null)
assertEqual(await page.getByRole('button', { name: 'Reveal Card Reward' }).count(), 0, 'revealed reward still offered Reveal')
assertEqual(await page.getByRole('button', { name: 'Skip unseen' }).count(), 0, 'revealed reward still offered unseen skip')
const publicRedNames = await page.locator('.neow-face--active .neow-face__reveal').textContent()
await page.getByRole('button', { name: 'Skip reward' }).click()
await page.getByRole('button', { name: 'Confirm reward' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().neow.players.p1.redRewardPending === false)
const firstBlessing = page.locator('.neow-options button').first()
await firstBlessing.click()
const cardChoice = page.locator('.neow-card-choice')
if (await cardChoice.count()) {
  const cards = cardChoice.locator('.card')
  const confirm = cardChoice.getByRole('button', { name: 'Gain reward' })
  for (let index = 0; index < await cards.count() && await confirm.isDisabled(); index += 1) await cards.nth(index).click()
  await confirm.click()
}
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().neow.players.p1.blueOption !== null)
await page.getByRole('button', { name: 'Resolve Silent' }).click()
const hotSeatOwner = await page.locator('.neow-face--active .neow-face__owner strong').textContent()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].relics.push({ defId: 'war_paint', spent: false, pending: true })
  debug.setRun(run)
})
const localPendingRelicLock = await page.waitForFunction(() => {
  const screen = document.querySelector('.neow-screen')
  const actions = [...(screen?.querySelectorAll('.neow-action button') ?? [])]
  return actions.length > 0 && actions.every((button) => button.disabled || button.getAttribute('aria-disabled') === 'true') &&
    screen?.querySelector('.neow-action__waiting')?.textContent?.includes('Waiting for Ironclad to resolve War Paint')
}).then((handle) => handle.jsonValue())
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].relics = run.players[0].relics.filter((relic) => !relic.pending)
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('.neow-action button')].some((button) => !button.disabled))
await page.setViewportSize({ width: 1280, height: 800 })
await page.screenshot({ path: join(outDir, 'neow-4p-compact-desktop.png'), fullPage: true })
const localNeowCompact = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > innerWidth,
  target: Math.min(...[...document.querySelectorAll('.neow-screen button')].map((button) => button.getBoundingClientRect().height)),
  actionOverlap: (() => {
    const action = document.querySelector('.neow-action')?.getBoundingClientRect()
    if (!action) return true
    return [...document.querySelectorAll('.neow-face')].some((face) => {
      const box = face.getBoundingClientRect()
      return box.left < action.right && box.right > action.left
        && box.top < action.bottom && box.bottom > action.top
    })
  })(),
  controls: [...document.querySelectorAll('.neow-screen button:not(.card)')].map((button) => ({
    label: button.textContent?.trim(),
    disabled: button.disabled,
    color: getComputedStyle(button).color,
    background: getComputedStyle(button).backgroundColor,
  })),
}))
await page.setViewportSize({ width: 1024, height: 768 })
const localNeowMinimumDesktopOverlap = await readNeowFaceActionOverlap()
const localNeowMinimumDesktopFacesVisible = await page.evaluate(() => {
  const stage = document.querySelector('.neow-screen')?.getBoundingClientRect()
  return Boolean(stage) && [...document.querySelectorAll('.neow-face')].every((face) => {
    const box = face.getBoundingClientRect()
    return box.top >= stage.top && box.bottom <= stage.bottom + 1
  })
})
await page.screenshot({ path: join(outDir, 'neow-4p-minimum-desktop.png'), fullPage: true })
await page.setViewportSize({ width: 1280, height: 800 })
check('local Neow exposes every public face and keeps hot-seat ownership explicit', () => {
  assertEqual(localNeowFaces, 4)
  assertEqual(localNeowOptions, 12)
  assertEqual(hiddenRedOrder.pending, true)
  assertEqual(hiddenRedOrder.offer, null)
  assertEqual(hiddenRedOrder.publicOffers, 0, 'face-down Neow rewards leaked before Reveal')
  assertEqual(neowFaceActionOverlap, false, 'Neow actions cover a dealt public card')
  assert(exhaustedPrismaticRevealDisabled && exhaustedPrismaticSkipEnabled,
    'exhausted Prismatic Neow supply did not disable Reveal while preserving skip')
  assert(publicRedNames?.includes('Face-up:'), 'revealed reward was not public')
  assertEqual(hotSeatOwner, 'Silent')
  assert(localPendingRelicLock, 'another seat\'s pending War Paint left local Neow choices enabled')
  assert(!localNeowCompact.overflow, 'Neow overflowed the compact desktop viewport')
  assertEqual(localNeowCompact.actionOverlap, false, 'Neow actions cover a compact-desktop dealt card')
  assertEqual(localNeowMinimumDesktopOverlap, false, 'Neow actions cover a minimum-desktop dealt card')
  assert(localNeowMinimumDesktopFacesVisible, 'a minimum-desktop Neow face is clipped')
  assert(localNeowCompact.target >= 44, 'Neow exposed a desktop control shorter than 44px')
})
check('Neow action labels keep readable computed contrast in every enabled state', () => {
  const channel = (value) => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const luminance = (css) => {
    const rgb = css.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
    assertEqual(rgb.length, 3, `could not parse computed color ${css}`)
    return channel(rgb[0]) * 0.2126 + channel(rgb[1]) * 0.7152 + channel(rgb[2]) * 0.0722
  }
  for (const control of localNeowCompact.controls) {
    const foreground = luminance(control.color)
    const background = luminance(control.background)
    const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
    assert(ratio >= 4.5, `${control.label} has only ${ratio.toFixed(2)}:1 computed contrast`)
  }
})
await page.setViewportSize({ width: 1440, height: 900 })

await setRoom('merchant')
await page.evaluate(() => window.__STS_DEBUG__.setViewer('p1'))
await page.getByLabel('Shopping for').selectOption('p1')
await page.getByRole('heading', { name: 'The Merchant' }).waitFor()
await page.locator('.merchant-figure').waitFor()
await page.screenshot({ path: join(outDir, 'merchant-4p-desktop.png'), fullPage: true })
const merchantCardFallback = page.locator('.merchant-board .item-card-image').first()
await merchantCardFallback.evaluate((image) => { image.src = '/missing-item-card.webp' })
await page.waitForFunction(() => document.querySelector('.merchant-board .item-card-image')
  ?.getAttribute('src') === '/assets/relic-icons/anchor.png')
await page.screenshot({ path: join(outDir, 'merchant-item-card-fallback.png'), fullPage: true })
const merchantFallbackSrc = await merchantCardFallback.getAttribute('src')
const merchantFallbackFace = await page.locator('.merchant-board .item-card-fallback').count()
const merchantShape = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, buttons: document.querySelectorAll('.merchant-board button').length, figure: document.querySelector('.merchant-figure')?.getBoundingClientRect().width ?? 0 }))
check('four-player Merchant is game-framed, responsive, and keyboard reachable', () => {
  assert(!merchantShape.overflow)
  assert(merchantShape.buttons >= 9)
  assert(merchantShape.figure > 200)
})
check('missing local item scans fall back to a full generated card face', () => {
  assertEqual(merchantFallbackSrc, '/assets/relic-icons/anchor.png')
  assertEqual(merchantFallbackFace, 1)
})
await page.keyboard.press('Tab')
const focused = await page.locator(':focus-visible').count()
check('Merchant exposes visible keyboard focus', () => assert(focused))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const index = run.players.findIndex((player) => player.id === 'p1')
  run.players[index] = { ...run.players[index], gold: 12, relics: [...run.players[index].relics, { defId: 'sozu', spent: false }] }
  debug.setRun(run)
})
const localSozuPotion = page.getByLabel('Potions').getByRole('button').filter({ hasText: 'Fire Potion' })
await localSozuPotion.getByText('Blocked by Sozu').waitFor()
const localSozuMerchantDisabled = await localSozuPotion.isDisabled()
check('local Merchant disables Potion purchases for a Sozu recipient', () => assert(localSozuMerchantDisabled))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const index = run.players.findIndex((player) => player.id === 'p1')
  run.players[index] = { ...run.players[index], relics: run.players[index].relics.filter((relic) => relic.defId !== 'sozu') }
  debug.setRun(run)
})
await setRoom('merchant')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => ({ ...player, gold: 0 }))
  debug.setRun(run)
})
await page.getByRole('group', { name: 'Card to remove' }).getByRole('button').first().click()
const brokePartyControlsDisabled = await page.waitForFunction(() => {
  const buttons = [...document.querySelectorAll('button')]
  return buttons.some((button) => button.textContent?.includes('Anchor') && button.disabled) &&
    buttons.some((button) => button.textContent?.includes('Remove') && button.disabled)
}).then((handle) => handle.jsonValue())
check('Merchant disables purchases and removal when the whole party is broke', () => assert(brokePartyControlsDisabled))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player, index) => ({ ...player, gold: index === 1 ? 5 : 0 }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /Anchor/ }).click()
await page.getByRole('button', { name: /Sold/ }).first().waitFor()
const sharedPurchaseRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
check('local co-op Merchant spends an exact shared-Gold payment', () => {
  assert(sharedPurchaseRun.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(sharedPurchaseRun.players[1].gold, 0)
})

await setRoom('merchant')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player, index) => ({ ...player, gold: index === 1 ? 3 : 0 }))
  debug.setRun(run)
})
const localDeckSize = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].deck.length)
await page.getByRole('group', { name: 'Card to remove' }).getByRole('button').first().click()
await page.getByRole('button', { name: /Remove/ }).click()
await page.waitForFunction((size) => window.__STS_DEBUG__.getRun().players[0].deck.length === size - 1, localDeckSize)
const removalPayerGold = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[1].gold)
check('local co-op card removal can use shared Gold', () => assertEqual(removalPayerGold, 0))

await setRoom('treasure')
await page.getByRole('heading', { name: 'Choose a Relic' }).waitFor()
await page.screenshot({ path: join(outDir, 'treasure-4p-desktop.png'), fullPage: true })
const treasureName = await page.locator('.treasure-relic strong').textContent()
const takeRelicButtons = await page.getByRole('button', { name: /Take relic/ }).count()
check('Treasure gives the active seat one dominant face-up relic choice', () => {
  assertEqual(treasureName, 'Anchor')
  assertEqual(takeRelicButtons, 1)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState = { kind: 'treasure', offers: {}, sharedOffers: ['anchor', 'happy_flower', 'akabeko', 'lantern'], playerIds: run.players.map((player) => player.id), decisions: { [run.players[1].id]: 0 } }
  debug.setRun(run)
})
await page.waitForFunction(() => document.activeElement?.textContent?.includes('Happy Flower'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState.decisions[run.players[0].id] = 1
  debug.setRun(run)
})
await page.getByRole('status').waitFor({ state: 'visible', timeout: 5_000 })
const sharedRelicStatus = await page.getByRole('status').textContent()
check('Choose Your Relic focuses the first unclaimed slot and shows locked waiting feedback', () => assertEqual(sharedRelicStatus, 'Choice locked. Waiting for the party…'))

await page.setViewportSize({ width: 1280, height: 800 })
await setRoom('event')
await page.getByRole('heading', { name: 'Big Fish' }).waitFor()
await page.locator('.room-stage').evaluate((element) => { element.scrollTop = 0 })
await page.screenshot({ path: join(outDir, 'event-4p-compact-desktop.png'), fullPage: true })
const eventShape = await page.evaluate(() => {
  const stage = document.querySelector('.room-stage')?.getBoundingClientRect()
  const last = [...document.querySelectorAll('.event-options button')].at(-1)?.getBoundingClientRect()
  return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, options: document.querySelectorAll('.event-options button').length, contained: Boolean(stage && last && stage.bottom >= last.bottom - 1) }
})
check('Event hierarchy remains usable on compact desktop and does not demand irrelevant cards', () => {
  assert(!eventShape.overflow)
  assertEqual(eventShape.options, 4)
  assert(eventShape.contained, 'the final Event choice escaped the compact desktop room frame')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState.decisions[run.players[0].id] = { optionIds: ['banana'] }
  debug.setRun(run)
  debug.setViewer(run.players[1].id)
})
await page.getByRole('button', { name: /\[Banana\]/ }).waitFor()
const claimedBigFishDisabled = await page.getByRole('button', { name: /\[Banana\]/ }).isDisabled()
check('Big Fish disables an option already claimed by another seat', () => assert(claimedBigFishDisabled))
await page.evaluate(() => window.__STS_DEBUG__.setViewer('p1'))

await page.setViewportSize({ width: 1100, height: 760 })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.roomState = { kind: 'event', card: { id: 'ancient_writing', instanceId: 'browser-writing', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Ancient Writing', scope: 'player', options: [
    { id: 'elegance', label: 'Elegance', description: 'Remove a card.', effects: [{ tag: 'remove-card' }] },
    { id: 'simplicity', label: 'Simplicity', description: 'Upgrade a starter Strike and Defend.', effects: [{ tag: 'upgrade-card', count: 2 }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Ancient Writing' }).waitFor()
const writingDefend = page.locator('.event-cards button').filter({ hasText: 'Defend' }).first()
const writingStrike = page.locator('.event-cards button').filter({ hasText: 'Strike' }).first()
await writingDefend.click()
await writingStrike.click()
const reverseSimplicityEnabled = await page.getByRole('button', { name: /\[Simplicity\]/ }).isEnabled()
await writingDefend.click()
await writingStrike.click()
check('Ancient Writing accepts its Strike and Defend in either click order', () => assert(reverseSimplicityEnabled))
await page.locator('.event-cards button').first().click()
await chooseLocalSeat({ label: 'Silent' })
await page.waitForFunction(() => [...document.querySelectorAll('.event-options button')].some((button) => button.textContent?.includes('[Elegance]') && button.disabled), undefined, { timeout: 5_000 })
const retainedCards = await page.locator('.event-cards button[aria-pressed="true"]').count()
const eleganceEnabled = await page.getByRole('button', { name: /\[Elegance\]/ }).isEnabled()
check('hot-seat Event form state resets between players', () => {
  assertEqual(retainedCards, 0)
  assertEqual(eleganceEnabled, false)
})
await page.locator('.event-cards button').first().click()
await page.getByRole('button', { name: /\[Elegance\]/ }).click()

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.ascension = 4
  run.players = run.players.map((player, index) => ({ ...player, potions: index === 1 ? ['fire_potion'] : [] }))
  run.roomState = { kind: 'event', card: { id: 'woman_in_blue', instanceId: 'browser-woman', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'The Woman in Blue', scope: 'player', options: [
    { id: 'buy_two', label: 'Buy 2', description: 'Pay 2 Gold. Gain 2 Potions.', effects: [{ tag: 'pay-gold', amount: 2 }, { tag: 'gain-potion', count: 2 }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'The Woman in Blue' }).waitFor()
const buyTwo = page.getByRole('button', { name: /\[Buy 2\]/ })
await buyTwo.focus()
await buyTwo.press('Enter')
await page.getByText('These rewards are face-up').waitFor()
const revealedPotions = await page.locator('.event-cards > fieldset > legend').allTextContents()
const passControls = await page.getByLabel('Pass to', { exact: true }).count()
const replacementControls = await page.getByLabel('Replace', { exact: true }).count()
const replacementCardImages = await page.locator('fieldset[aria-label="Replace"] .item-card-image')
  .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
for (const fieldset of await page.locator('.event-cards > fieldset').all()) await fieldset.getByRole('button', { name: 'Take' }).click()
const overCapacityResolveDisabled = await page.getByRole('button', { name: /Resolve rewards/ }).isDisabled()
check('revealed A4 Potion rewards expose take, skip, pass, and replacement controls', () => {
  assertEqual(revealedPotions.length, 2)
  assertEqual(passControls, 2)
  assertEqual(replacementControls, 2)
  assertDeepEqual(replacementCardImages, [true, true])
  assertEqual(new Set(revealedPotions).size, 2)
  assert(overCapacityResolveDisabled, 'two taken Potions enabled with only one free A4 slot')
})
await chooseLocalSeat({ label: 'Ironclad' })
await page.getByText('Waiting for that face-up reward to resolve…').waitFor()
const teammateReveal = await page.locator('.event-panel').textContent()
check('teammates see staged physical rewards but cannot race their resolution', () => {
  for (const name of revealedPotions) assert(teammateReveal.includes(name))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.players[0]
  run.players = run.players.map((player, index) => index < 2
    ? { ...player, relics: player.relics.some((relic) => relic.defId === 'sozu') ? player.relics : [...player.relics, { defId: 'sozu', spent: false }] }
    : player)
  run.roomState = { ...run.roomState, decisions: {}, pendingDecisions: {}, itemOffers: { [actor.id]: [{ kind: 'potion', id: 'fire_potion' }] } }
  debug.setRun(run)
  debug.setViewer(actor.id)
})
await page.getByText('These rewards are face-up').waitFor()
const sozuEventTake = page.getByRole('button', { name: 'Take' })
const sozuPass = page.getByLabel('Pass to', { exact: true })
const sozuPassOptions = await sozuPass.locator('option').allTextContents()
const sozuEventTakeDisabled = await sozuEventTake.isDisabled()
const sozuReplacementControls = await page.getByLabel('Replace', { exact: true }).count()
await sozuPass.selectOption({ label: 'Defect' })
const passedEventTakeEnabled = await sozuEventTake.isEnabled()
check('Event Potion pass excludes Sozu seats and requires a legal recipient', () => {
  assert(sozuEventTakeDisabled, 'Sozu holder could keep an Event Potion')
  assert(!sozuPassOptions.includes('Silent'), 'Sozu teammate remained a Potion recipient')
  assertEqual(sozuReplacementControls, 0)
  assert(passedEventTakeEnabled, 'legal non-Sozu recipient could not receive the Potion')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const reveals = Object.fromEntries(run.players.map((player) => [player.id, player.deck.slice(0, 3)]))
  run.roomState = { kind: 'event', card: { id: 'falling', instanceId: 'browser-falling', act: 3, minAscension: 0, requiresColorlessUnlock: false, name: 'Falling', scope: 'player', options: [
    { id: 'land', label: 'Land', description: 'Reveal 3 cards and remove one.', effects: [{ tag: 'remove-card', random: true, count: 1, filter: 'choose from three revealed cards' }] },
  ] }, decisions: {}, dieRolls: {}, revealedCards: Object.fromEntries(Object.entries(reveals).map(([id, cards]) => [id, cards.map((card) => card.uid)])), revealedCardDefs: Object.fromEntries(Object.entries(reveals).map(([id, cards]) => [id, cards.map((card) => card.defId)])) }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Falling' }).waitFor()
await page.waitForFunction(() => {
  const run = window.__STS_DEBUG__.getRun()
  const viewerId = run.players.find((player) => player.character === 'ironclad')?.id
  const expected = run.roomState.revealedCards[viewerId]?.length
  return expected > 0 && document.querySelectorAll('.event-cards button').length === expected
}, undefined, { timeout: 5_000 })
const fallingCards = await page.locator('.event-cards button').count()
const partyReveals = await page.locator('.event-party-reveal').count()
const fallingExpected = await page.evaluate(() => {
  const run = window.__STS_DEBUG__.getRun()
  return { own: 3, party: run.players.length - 1 }
})
check('Falling renders the owner selection and party face-up reveals', () => {
  assertEqual(fallingCards, fallingExpected.own)
  assertEqual(partyReveals, fallingExpected.party)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.players[0]
  run.roomState = { kind: 'event', card: { id: 'dead_adventurer', instanceId: 'browser-adventurer', act: 1, minAscension: 3, requiresColorlessUnlock: false, name: 'Dead Adventurer', scope: 'party', options: [
    { id: 'search', label: 'Search', description: 'Roll; one player may gain a Relic.', effects: [{ tag: 'roll-d6', results: { 6: [{ tag: 'gain-relic', target: 'one-player' }] } }] },
  ] }, decisions: {}, dieRolls: { [actor.id]: [6] }, pendingRolls: { [actor.id]: [6] }, pendingDecisions: { [actor.id]: { optionIds: ['search'] } }, itemOffers: { [actor.id]: [{ kind: 'relic', id: 'anchor' }] } }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Dead Adventurer' }).waitFor()
const targetChoices = await page.getByLabel('Reward recipient').locator('option').count()
const targetExpected = await page.evaluate(() => 1 + window.__STS_DEBUG__.getRun().players.filter((player) => !player.dead).length)
check('staged one-player item rewards retain their recipient selector', () => assertEqual(targetChoices, targetExpected))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const playerId = run.players.find((player) => player.character === 'ironclad').id
  run.phase = 'room'
  run.roomState = { kind: 'event', card: { id: 'sensory_stone', instanceId: 'browser-sequential-reward', act: 3, minAscension: 0, requiresColorlessUnlock: true, name: 'Sensory Stone', scope: 'player', options: [{ id: 'recall_two', label: 'Recall 2', description: 'Gain two Colorless rewards. Lose 2 HP.', effects: [{ tag: 'card-reward', source: 'colorless', count: 2 }, { tag: 'lose-hp', amount: 2 }] }] }, decisions: {}, dieRolls: {}, rewardOffers: { [playerId]: [['blind', 'trip', 'panacea']] }, pendingDecisions: { [playerId]: { optionIds: ['recall_two'] } } }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Choose your reward' }).waitFor()
await page.getByRole('button', { name: 'Blind' }).click()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const playerId = run.players.find((player) => player.character === 'ironclad').id
  run.roomState.rewardOffers[playerId] = [['dark_shackles', 'finesse', 'purity']]
  run.roomState.pendingDecisions[playerId].rewardIndexes = [0]
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Dark Shackles' }).waitFor()
const retainedSequentialReward = await page.locator('.event-cards button[aria-pressed="true"]').count()
const sequentialRewardDisabled = await page.getByRole('button', { name: /Take rewards/ }).isDisabled()
check('equal-length sequential Event rewards require a fresh choice', () => {
  assertEqual(retainedSequentialReward, 0)
  assert(sequentialRewardDisabled)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.players = run.players.map((player) => ({ ...player, deck: player.deck.map((card) => ({ ...card, upgraded: true })) }))
  run.roomState = { kind: 'event', card: { id: 'upgrade_shrine', instanceId: 'browser-noop-shrine', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Upgrade Shrine', scope: 'player', options: [{ id: 'pray', label: 'Pray', description: 'Upgrade a card.', effects: [{ tag: 'upgrade-card' }] }] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
const shrinePlayerIds = await page.evaluate(() => window.__STS_DEBUG__.getRun().players.filter((player) => !player.dead).map((player) => player.id))
await page.getByRole('heading', { name: 'Upgrade Shrine' }).waitFor()
const noOpPrayEnabled = await page.getByRole('button', { name: /\[Pray\]/ }).isEnabled()
await page.screenshot({ path: join(outDir, 'event-noop-shrine.png'), fullPage: true })
check('mandatory no-op Event choice stays visibly enabled', () => assertEqual(noOpPrayEnabled, true))
for (const [index, playerId] of shrinePlayerIds.entries()) {
  await page.evaluate((id) => window.__STS_DEBUG__.setViewer(id), playerId)
  await page.getByRole('button', { name: /\[Pray\]/ }).click()
  await page.waitForFunction(
    ({ id, last }) => last
      ? window.__STS_DEBUG__.getRun().roomState === null
      : Boolean(window.__STS_DEBUG__.getRun().roomState?.decisions?.[id]),
    { id: playerId, last: index === shrinePlayerIds.length - 1 },
  )
}
const noOpShrinePhase = await page.evaluate(() => window.__STS_DEBUG__.getRun().phase)
check('mandatory Event options remain playable when their card effect is a no-op', () => assertEqual(noOpShrinePhase, 'map'))

await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'filtered-noop-ui'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 1)
await setRoom('event')
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().roomState?.card?.id === 'big_fish')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].deck = run.players[0].deck.filter((card) => !(card.defId.includes('strike')))
  debug.setRun(run)
})
const noStrikeDonut = page.getByRole('button', { name: /\[Donut\]/ })
await noStrikeDonut.waitFor()
const noStrikeDonutEnabled = await noStrikeDonut.isEnabled()
await noStrikeDonut.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
check('filtered mandatory upgrades stay enabled and resolve as no-ops without a matching card', () => assertEqual(noStrikeDonutEnabled, true))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.players[0] = { ...run.players[0], gold: 5, deck: [
    { uid: 'designer-curse', defId: 'injury', upgraded: false },
    { uid: 'designer-upgrade', defId: 'strike_ironclad', upgraded: false },
  ] }
  run.roomState = { kind: 'event', card: { id: 'designer', instanceId: 'browser-designer-ordered', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Designer In-Spire', scope: 'player', options: [
    { id: 'full_service', label: 'Full Service', description: 'Pay 5 Gold. Remove a card and upgrade a card.', effects: [{ tag: 'pay-gold', amount: 5 }, { tag: 'remove-card' }, { tag: 'upgrade-card' }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().roomState?.card?.id === 'designer')
await page.getByRole('button', { name: 'Injury' }).click()
await page.getByRole('button', { name: 'Strike' }).click()
const fullService = page.getByRole('button', { name: /\[Full Service\]/ })
const fullServiceEnabled = await fullService.isEnabled()
await fullService.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
check('heterogeneous Event card effects validate each selected card in effect order', () => assertEqual(fullServiceEnabled, true))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.roomState = { kind: 'event', card: { id: 'lab', instanceId: 'browser-lab-stages', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Lab', scope: 'automatic', options: [
    { id: 'resolve', label: 'Take Potions', description: 'Each player gains a Potion. Roll once for the party; on 4–6 one player gains another Potion.', effects: [{ tag: 'gain-potion', target: 'each-player' }, { tag: 'roll-d6', results: { 4: [{ tag: 'gain-potion', target: 'one-player' }], 5: [{ tag: 'gain-potion', target: 'one-player' }], 6: [{ tag: 'gain-potion', target: 'one-player' }] } }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
const labTargetBeforeRoll = await page.getByLabel('Target player').count()
const labInitialEnabled = await page.getByRole('button', { name: /\[Take Potions\]/ }).isEnabled()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState.pendingRolls = { [run.players[0].id]: [6] }
  debug.setRun(run)
})
await page.getByLabel('Target player').waitFor()
const labBonusDisabled = await page.getByRole('button', { name: /\[Take Potions\]/ }).isDisabled()
await page.getByLabel('Target player').selectOption({ index: 1 })
const labBonusEnabled = await page.getByRole('button', { name: /\[Take Potions\]/ }).isEnabled()
check('Lab asks for a bonus recipient only after a successful party roll', () => {
  assertEqual(labTargetBeforeRoll, 0)
  assert(labInitialEnabled)
  assert(labBonusDisabled)
  assert(labBonusEnabled)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.players[0] = { ...run.players[0], gold: 0, potions: ['swift_potion'] }
  run.roomState = { kind: 'event', card: { id: 'the_joust', instanceId: 'browser-joust-payment', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'The Joust', scope: 'player', options: [
    { id: 'bet', label: 'Bet', description: 'Pay 2 Gold, a Relic, or a Potion. Roll the die; on 4–6 gain 6 Gold.', effects: [{ tag: 'pay-gold', amount: 2, filter: 'or lose one Relic or Potion' }, { tag: 'roll-d6', results: { 4: [{ tag: 'gain-gold', amount: 6 }], 5: [{ tag: 'gain-gold', amount: 6 }], 6: [{ tag: 'gain-gold', amount: 6 }] } }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
const joustRelic = page.locator('fieldset').filter({ hasText: 'Your relic' }).getByRole('button').first()
await page.waitForFunction(() => {
  const images = [...document.querySelectorAll('fieldset .item-card-image')]
  return images.length >= 2 && images.every((image) => image.complete && image.naturalWidth > 0)
})
const joustItemCards = await page.locator('fieldset').filter({ hasText: /Your relic|Your potions/ })
  .locator('.item-card-image').evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
await joustRelic.click()
const zeroGoldRelicBetEnabled = await page.getByRole('button', { name: /\[Bet\]/ }).isEnabled()
await joustRelic.click()
const clearedJoustRelic = await joustRelic.getAttribute('aria-pressed')
const zeroGoldBetAfterClearing = await page.getByRole('button', { name: /\[Bet\]/ }).isDisabled()
await page.getByRole('button', { name: 'Swift Potion', exact: true }).click()
const zeroGoldPotionBetEnabled = await page.getByRole('button', { name: /\[Bet\]/ }).isEnabled()
check('The Joust enables its printed Relic and Potion alternatives at zero Gold', () => {
  assert(zeroGoldRelicBetEnabled)
  assertDeepEqual(joustItemCards, [true, true])
  assertEqual(clearedJoustRelic, 'false')
  assert(zeroGoldBetAfterClearing)
  assert(zeroGoldPotionBetEnabled)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.players[0] = { ...run.players[0], potions: ['swift_potion', 'blood_potion'] }
  run.roomState = { kind: 'event', card: { id: 'nloth', instanceId: 'browser-nloth-potion', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: "N'loth", scope: 'player', options: [
    { id: 'offer_potion', label: 'Offer', description: 'Give a Potion. Add a random rare card to your deck.', effects: [{ tag: 'lose-potion' }, { tag: 'card-reward', source: 'rare', random: true }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Swift Potion', exact: true }).click()
await page.getByRole('button', { name: 'Blood Potion', exact: true }).click()
const selectedNlothPotions = await page.locator('fieldset.event-cards button[aria-pressed="true"]').count()
const nlothOfferEnabled = await page.getByRole('button', { name: /\[Offer\]/ }).isEnabled()
check("N'loth keeps its singular Potion payment valid when another Potion is chosen", () => {
  assertEqual(selectedNlothPotions, 1)
  assert(nlothOfferEnabled)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0] = { ...run.players[0], relics: [], potions: [] }
  run.roomState = { kind: 'event', card: { id: 'nloth', instanceId: 'browser-nloth-empty', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: "N'loth", scope: 'player', options: [
    { id: 'offer_relic', label: 'Offer', description: 'Give a random Relic. Gain a Rare Reward.', effects: [{ tag: 'lose-relic', random: true }, { tag: 'rare-reward' }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
const emptyNlothDisabled = await page.getByRole('button', { name: /random Relic/ }).isDisabled()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState = { kind: 'event', card: { id: 'forgotten_altar', instanceId: 'browser-forgotten-empty', act: 2, minAscension: 3, requiresColorlessUnlock: false, name: 'Forgotten Altar', scope: 'player', options: [
    { id: 'offer', label: 'Offer', description: 'Lose your selected Relic. Gain a Relic.', effects: [{ tag: 'lose-relic', random: true }, { tag: 'gain-relic' }] },
  ] }, decisions: {}, dieRolls: {}, revealedRelics: {} }
  debug.setRun(run)
})
const emptyAltarDisabled = await page.getByRole('button', { name: /Lose your selected Relic/ }).isDisabled()
check('random Relic payments disable when no Relic can be offered', () => {
  assert(emptyNlothDisabled)
  assert(emptyAltarDisabled)
})

await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'event-source-ui'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 2)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.players[0]
  run.phase = 'room'
  run.roomState = { kind: 'event', card: { id: 'note_for_yourself', instanceId: 'browser-note-source', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'A Note for Yourself', scope: 'player', options: [
    { id: 'take', label: 'Take', description: 'Gain a Card Reward from another character reward deck.', effects: [{ tag: 'card-reward', source: 'other-character' }] },
    { id: 'exchange', label: 'Exchange', description: 'Give a player a card in your deck. They give you a card in their deck.', effects: [{ tag: 'trade-card' }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
  window.__noteActor = actor.id
})
const noteTargetValues = await page.getByLabel('Target player').locator('option').evaluateAll((options) => options.map((option) => option.value))
const noteActorId = await page.evaluate(() => window.__noteActor)
await page.locator('.event-cards button').first().click()
await page.getByLabel('Target player').selectOption('defect')
const inactiveTradeDisabled = await page.getByRole('button', { name: /\[Exchange\]/ }).isDisabled()

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  run.roomState = { kind: 'event', card: { id: 'cursed_tome', instanceId: 'browser-prismatic-event', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Cursed Tome', scope: 'player', options: [
    { id: 'take', label: 'Take', description: 'Gain a Rare Reward and a Curse.', effects: [{ tag: 'rare-reward' }, { tag: 'gain-curse' }] },
    { id: 'skim', label: 'Skim', description: 'Gain a Card Reward. Lose 1 HP.', effects: [{ tag: 'card-reward' }, { tag: 'lose-hp', amount: 1 }] },
  ] }, decisions: {}, dieRolls: {}, availableRewardSources: {
    card: ['silent', 'defect', 'watcher', 'colorless'],
    rare: ['ironclad', 'defect', 'watcher'],
  } }
  debug.setRun(run)
})
const ordinarySources = page.getByRole('group', { name: 'Prismatic Shard · Card Reward · choose 3 reward decks' })
const rareSources = page.getByRole('group', { name: 'Prismatic Shard · Rare Reward · choose 3 reward decks' })
await ordinarySources.waitFor()
const ordinarySourceText = await ordinarySources.textContent()
const rareSourceText = await rareSources.textContent()
for (const checkbox of await ordinarySources.getByRole('checkbox').all().then((boxes) => boxes.slice(0, 3))) await checkbox.check()
const skimEnabledWithOrdinarySources = await page.getByRole('button', { name: /\[Skim\]/ }).isEnabled()
const takeDisabledWithoutRareSources = await page.getByRole('button', { name: /\[Take\]/ }).isDisabled()
for (const checkbox of await rareSources.getByRole('checkbox').all()) await checkbox.check()
const takeEnabledWithRareSources = await page.getByRole('button', { name: /\[Take\]/ }).isEnabled()
await page.screenshot({ path: join(outDir, 'event-prismatic-mixed.png'), fullPage: true })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState = { kind: 'event', card: { id: 'knowing_skull', instanceId: 'browser-prismatic-skull', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Knowing Skull', scope: 'player', rule: 'Choose one or two options.', options: [
    { id: 'riches', label: 'Riches?', description: 'Gain 3 Gold. Lose 1 HP.', effects: [{ tag: 'gain-gold', amount: 3 }, { tag: 'lose-hp', amount: 1 }] },
    { id: 'success', label: 'Success?', description: 'Gain a Card Reward. Lose 1 HP.', effects: [{ tag: 'card-reward' }, { tag: 'lose-hp', amount: 1 }] },
  ] }, decisions: {}, dieRolls: {}, availableRewardSources: { card: ['ironclad', 'silent', 'defect', 'watcher'], rare: [] } }
  debug.setRun(run)
})
const skullSources = page.getByRole('group', { name: 'Prismatic Shard · Card Reward · choose 3 reward decks' })
for (const checkbox of (await skullSources.getByRole('checkbox').all()).slice(0, 3)) await checkbox.check()
await page.getByRole('button', { name: /\[Success\?\]/ }).click()
const skullConfirm = page.getByRole('button', { name: 'Confirm chosen questions →' })
const skullConfirmReady = await skullConfirm.isEnabled()
await skullSources.getByRole('checkbox').first().uncheck()
const skullConfirmRevalidated = await skullConfirm.isDisabled()

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => ({ ...player, cardRewards: [], rareRewards: [] }))
  run.itemDecks.colorless = []
  run.itemDecks.characterCards = Object.fromEntries(Object.keys(run.itemDecks.characterCards).map((id) => [id, []]))
  run.itemDecks.characterRares = Object.fromEntries(Object.keys(run.itemDecks.characterRares).map((id) => [id, []]))
  run.roomState = { kind: 'event', card: { id: 'cursed_tome', instanceId: 'browser-prismatic-empty', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Cursed Tome', scope: 'player', options: [
    { id: 'take', label: 'Take', description: 'Gain a Rare Reward.', effects: [{ tag: 'rare-reward' }] },
    { id: 'skim', label: 'Skim', description: 'Gain a Card Reward.', effects: [{ tag: 'card-reward' }] },
  ] }, decisions: {}, dieRolls: {}, availableRewardSources: { card: [], rare: [] } }
  debug.setRun(run)
})
await page.getByRole('button', { name: /No legal choice/ }).waitFor()
const exhaustedPrismaticEvent = {
  normalDisabled: await page.getByRole('button', { name: /\[Skim\]/ }).isDisabled(),
  rareDisabled: await page.getByRole('button', { name: /\[Take\]/ }).isDisabled(),
  escapeVisible: await page.getByRole('button', { name: /No legal choice/ }).isVisible(),
}

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => ({ ...player, gold: 0 }))
  run.roomState = { kind: 'event', card: { id: 'designer', instanceId: 'browser-focus-enabled', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Designer In-Spire', scope: 'player', options: [
    { id: 'pay', label: 'Pay', description: 'Pay 2 Gold.', effects: [{ tag: 'pay-gold', amount: 2 }] },
    { id: 'punch', label: 'Punch!', description: 'Lose 1 HP.', effects: [{ tag: 'lose-hp', amount: 1 }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.waitForFunction(() => document.activeElement?.textContent?.includes('[Punch!]'))
const focusedLegalEventOption = await page.evaluate(() => document.activeElement?.textContent ?? '')
check('Event source and focus controls expose only legal actions', () => {
  assert(!noteTargetValues.includes(noteActorId), 'A Note offered the acting character as its other-character source')
  assert(inactiveTradeDisabled, 'A Note enabled a card exchange against an inactive character deck')
  assert(ordinarySourceText?.includes('Colorless') && !ordinarySourceText?.includes('Ironclad'), 'normal Event reward showed the Rare source inventory')
  assert(rareSourceText?.includes('Ironclad') && !rareSourceText?.includes('Colorless'), 'Rare Event reward showed the normal source inventory')
  assert(skimEnabledWithOrdinarySources && takeDisabledWithoutRareSources && takeEnabledWithRareSources,
    'mixed normal/Rare Event options did not gate their own Prismatic source choices')
  assert(skullConfirmReady && skullConfirmRevalidated, 'Knowing Skull Confirm ignored its selected Prismatic reward requirements')
  assert(exhaustedPrismaticEvent.normalDisabled && exhaustedPrismaticEvent.rareDisabled && exhaustedPrismaticEvent.escapeVisible,
    'exhausted Prismatic Event rewards hid the no-legal-choice escape')
  assert(focusedLegalEventOption.includes('[Punch!]'), 'Event did not focus its first enabled option')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.roomState = { kind: 'event', card: { id: 'big_fish', instanceId: 'browser-live-focus', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Big Fish', scope: 'player', rule: 'Each player chooses a different option.', options: [
    { id: 'banana', label: 'Banana', description: 'Heal 2 HP.', effects: [{ tag: 'heal', amount: 2 }] },
    { id: 'donut', label: 'Donut', description: 'Upgrade a starter Strike.', effects: [{ tag: 'upgrade-card', filter: 'starter Strike' }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.waitForFunction(() => document.activeElement?.textContent?.includes('[Banana]'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const teammate = run.players[1]
  run.roomState.decisions[teammate.id] = { optionIds: ['banana'] }
  debug.setRun(run)
})
await page.waitForFunction(() => document.activeElement?.textContent?.includes('[Donut]'))
const liveEventFocus = await page.evaluate(() => document.activeElement?.textContent ?? '')
check('Event focus moves when a teammate claims the focused unique option', () => assert(liveEventFocus.includes('[Donut]')))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.players[0]
  run.roomState = { kind: 'event', card: { id: 'wheel_of_change', instanceId: 'browser-wheel-resume', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Wheel of Change', scope: 'player', options: [
    { id: 'spin', label: 'Spin', description: 'Roll the die.', effects: [{ tag: 'roll-d6', results: { 3: [{ tag: 'remove-card' }] } }] },
  ] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
  window.__wheelActor = actor.id
  window.__wheelDeckSize = actor.deck.length
})
await page.waitForFunction(() => document.activeElement?.textContent?.includes('[Spin]'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  document.activeElement?.blur()
  run.roomState.pendingDecisions = { [run.players[0].id]: { optionIds: ['spin'], cardUids: [] } }
  run.roomState.pendingRolls = { [run.players[0].id]: [3] }
  debug.setRun(run)
})
await page.waitForFunction(() => document.activeElement?.textContent?.includes('[Spin]'))
await page.locator('.event-cards button').first().click()
await page.getByRole('button', { name: /\[Spin\]/ }).click()
await page.waitForFunction(() => {
  const run = window.__STS_DEBUG__.getRun()
  const actor = run.players.find((player) => player.id === window.__wheelActor)
  return actor.deck.length === window.__wheelDeckSize - 1
})
const wheelDeckSizes = await page.evaluate(() => ({
  before: window.__wheelDeckSize,
  after: window.__STS_DEBUG__.getRun().players.find((player) => player.id === window.__wheelActor).deck.length,
}))
check('post-roll Event selectors replace authoritative empty arrays', () => assertEqual(wheelDeckSizes.after, wheelDeckSizes.before - 1))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.players = run.players.map((player) => ({ ...player, gold: 0, relics: [], potions: [] }))
  run.roomState = { kind: 'event', card: { id: 'old_beggar', instanceId: 'browser-no-choice', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Old Beggar', scope: 'player', options: [{ id: 'give', label: 'Give', description: 'Pay 2 Gold. Remove a card.', effects: [{ tag: 'pay-gold', amount: 2 }, { tag: 'remove-card' }] }] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.locator('.event-cards button').first().click()
const unaffordableEventOptionDisabled = await page.getByRole('button', { name: /\[Give\]/ }).isDisabled()
const noChoicePlayerIds = await page.evaluate(() => window.__STS_DEBUG__.getRun().players.filter((player) => !player.dead).map((player) => player.id))
for (const [index, playerId] of noChoicePlayerIds.entries()) {
  await page.evaluate((id) => window.__STS_DEBUG__.setViewer(id), playerId)
  await page.getByRole('button', { name: /No legal choice/ }).click()
  await page.waitForFunction(
    ({ id, last }) => last
      ? window.__STS_DEBUG__.getRun().roomState === null
      : Boolean(window.__STS_DEBUG__.getRun().roomState?.decisions?.[id]),
    { id: playerId, last: index === noChoicePlayerIds.length - 1 },
  )
}
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().roomState === null)
const skippedEventPhase = await page.evaluate(() => window.__STS_DEBUG__.getRun().phase)
check('an Event with no legal Pay or Give option disables it and exposes a bounded leave action', () => {
  assert(unaffordableEventOptionDisabled, 'unaffordable Event payment remained enabled')
  assertEqual(skippedEventPhase, 'map')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'reward'
  run.neow = null
  run.roomState = null
  run.rewardDestination = 'map'
  run.rewards = run.players.map((player) => ({
    playerId: player.id, cardReward: true, choices: null, upgraded: false, prismatic: true,
    availableSources: ['ironclad', 'silent', 'defect', 'watcher'], potion: false, relic: false, bossRelics: false,
  }))
  run.players[0].potions = ['swift_potion', 'blood_potion', 'energy_potion']
  run.rewards[0].potion = 'fire_potion'
  debug.setRun(run)
})
const localRewardSources = page.locator('.reward-screen__player').first().getByRole('group', { name: 'Choose 3 different reward decks' })
await localRewardSources.waitFor()
for (const checkbox of (await localRewardSources.getByRole('checkbox').all()).slice(0, 3)) await checkbox.check()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.rewards[0].availableSources = ['silent', 'defect', 'watcher']
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.reward-screen__player .reward-screen__sources')?.querySelectorAll('input:checked').length === 2)
const localRewardSelectionReconciled = await localRewardSources.evaluate((group) => ({
  checked: group.querySelectorAll('input:checked').length,
  disabled: group.querySelector('button')?.disabled,
}))
const localRewardReplacementCards = await page.locator('.reward-screen__players > :first-child .reward-screen__potion button .item-card-image')
  .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
check('local Prismatic reward selections reconcile when a teammate exhausts a source', () => {
  assertEqual(localRewardSelectionReconciled.checked, 2)
  assert(localRewardSelectionReconciled.disabled)
  assertDeepEqual(localRewardReplacementCards, [true, true, true])
})

await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'courier-auto-advance-lock'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 1)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'map'
  run.neow = null
  run.players[0].relics.push({ defId: 'the_courier', spent: false })
  run.itemDecks.relics = ['anchor', ...run.itemDecks.relics.filter((id) => id !== 'anchor')]
  debug.setRun(run)
})
await page.locator('.room--reachable').click()
await page.getByRole('complementary', { name: 'The Courier' }).waitFor()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  run.combat = {
    ...run.combat,
    phase: 'player',
    players: [{ ...player, hand: [], energy: 0, miracles: 0, shivs: 0, potions: [], powers: [] }],
  }
  debug.setRun(run)
})
await page.waitForTimeout(650)
const courierAvailablePhase = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.phase)
await page.getByRole('button', { name: 'Look at Relic' }).click()
await page.getByRole('complementary', { name: 'The Courier offer' }).waitFor()
await page.waitForTimeout(650)
const courierLockedPhase = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.phase)
check('an available or open Courier blocks local automatic turn advancement', () => {
  assertEqual(courierAvailablePhase, 'player')
  assertEqual(courierLockedPhase, 'player')
})

await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'courier-ui'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 2)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'map'
  run.neow = null
  run.players = run.players.map((player, index) => ({ ...player, gold: index === 0 ? 2 : 4, relics: index === 0 ? [...player.relics, { defId: 'the_courier', spent: false }] : player.relics }))
  run.itemDecks.relics = ['old_coin', 'anchor', ...run.itemDecks.relics.filter((id) => id !== 'old_coin' && id !== 'anchor')]
  debug.setRun(run)
})
await page.locator('.room--reachable').click()
await page.getByRole('complementary', { name: 'The Courier' }).waitFor()
await page.getByRole('button', { name: 'Look at Relic' }).click()
await page.getByRole('complementary', { name: 'The Courier offer' }).getByText(/Anchor/).waitFor()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => ({ ...player, gold: 0 }))
  run.combat.players = run.combat.players.map((player) => ({ ...player, gold: 0 }))
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Buy / pledge') && button.disabled))
const brokeCourierDisabled = await page.getByRole('button', { name: /Buy \/ pledge/ }).isDisabled()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player, index) => ({ ...player, gold: index === 0 ? 2 : 4 }))
  run.combat.players = run.combat.players.map((player, index) => ({ ...player, gold: index === 0 ? 2 : 4 }))
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Buy / pledge') && !button.disabled))
const localCourierLocksCombat = await page.locator('.courier-combat-lock').evaluate((element) => element.hasAttribute('inert'))
await page.setViewportSize({ width: 1280, height: 800 })
await page.screenshot({ path: join(outDir, 'courier-combat-compact-desktop.png'), fullPage: true })
const courierFrame = await page.evaluate(() => {
  const panel = document.querySelector('.courier-panel')?.getBoundingClientRect()
  return { overflow: document.documentElement.scrollWidth > innerWidth, visible: Boolean(panel && panel.left >= 0 && panel.right <= innerWidth) }
})
const localCourierBuy = page.getByRole('button', { name: /Buy \/ pledge/ })
await localCourierBuy.waitFor()
assert(await localCourierBuy.isEnabled(), 'local Courier purchase was disabled')
await localCourierBuy.evaluate((button) => button.click())
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().courier.offer === null)
await page.getByRole('complementary', { name: 'The Courier offer' }).waitFor({ state: 'detached' })
const courierRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
check('The Courier is a contained once-per-combat shared-Gold flow', () => {
  assert(brokeCourierDisabled, 'Courier allowed an unaffordable zero-Gold authorization')
  assert(!courierFrame.overflow && courierFrame.visible)
  assert(localCourierLocksCombat, 'local Courier offer left combat controls interactive')
  assert(courierRun.combat.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(courierRun.combat.players[0].gold, 0)
  assertEqual(courierRun.combat.players[1].gold, 0)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].potions = ['swift_potion', 'blood_potion', 'energy_potion']
  run.combat.players[0].potions = [...run.players[0].potions]
  run.courier = { usedBy: ['p1'], offer: { playerId: 'p1', kind: 'potion', id: 'fire_potion' } }
  debug.setRun(run)
})
const courierReplacement = page.getByRole('group', { name: 'Replace Potion' })
await courierReplacement.waitFor()
const courierReplacementCards = await courierReplacement.locator('.item-card-image')
  .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
await courierReplacement.getByRole('button', { name: /Swift Potion/ }).click()
await page.screenshot({ path: join(outDir, 'courier-potion-replacement.png'), fullPage: true })
const courierReplacementSelected = await courierReplacement.getByRole('button', { name: /Swift Potion/ }).getAttribute('aria-pressed')
await page.getByRole('button', { name: 'Discard offer' }).click()
check('Courier potion replacement uses selectable physical card art', () => {
  assertDeepEqual(courierReplacementCards, [true, true, true])
  assertEqual(courierReplacementSelected, 'true')
})
await page.setViewportSize({ width: 1440, height: 900 })

const create = await fetch(`${roomOrigin}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ann', character: 'ironclad' }) }).then((response) => response.json())
const onlineSeats = [{ token: create.token, playerId: create.snapshot.you.playerId, name: 'Ann', character: 'ironclad' }]
for (const [name, character] of [['Bo', 'silent'], ['Cy', 'defect'], ['Di', 'watcher']]) {
  const joined = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, character }) }).then((response) => response.json())
  onlineSeats.push({ token: joined.token, playerId: joined.snapshot.you.playerId, name, character })
}
const liveRoom = rooms.store.rooms.get(create.snapshot.code)
const lobbyContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
await lobbyContext.addInitScript(({ code, token }) => sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token })), { code: create.snapshot.code, token: onlineSeats[0].token })
const lobbyPage = installScreenAudit(await lobbyContext.newPage())
lobbyPage.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
lobbyPage.on('pageerror', (error) => failures.push(String(error)))
await lobbyPage.goto(base, { waitUntil: 'networkidle' })
const guestLobbyContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
await guestLobbyContext.addInitScript(({ code, token }) => sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token })), { code: create.snapshot.code, token: onlineSeats[1].token })
const guestLobbyPage = installScreenAudit(await guestLobbyContext.newPage())
guestLobbyPage.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
guestLobbyPage.on('pageerror', (error) => failures.push(String(error)))
await guestLobbyPage.goto(base, { waitUntil: 'networkidle' })
const auxiliaryLobbyContexts = await Promise.all(onlineSeats.slice(2).map(async ({ token }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(({ code, token }) => sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token })), { code: create.snapshot.code, token })
  const auxiliaryPage = await context.newPage()
  await auxiliaryPage.goto(base, { waitUntil: 'networkidle' })
  return context
}))
// A connected seat no longer PRINTS "online" — the portrait says it is taken
// and only an absent player is captioned. The state is still on the label.
await lobbyPage.waitForFunction(() => [...document.querySelectorAll('.online-seat')]
  .filter((seat) => seat.getAttribute('aria-label')?.includes('online')).length === 4)
const onlineLobby = lobbyPage.locator('main.online-lobby')
await onlineLobby.locator('.online-lobby__settings > summary').click()
const ascensionOptions = await onlineLobby.getByLabel('Ascension').locator('option').count()
await onlineLobby.getByLabel('Choose Your Relic').click()
await lobbyPage.waitForFunction(() => document.querySelector('main.online-lobby input[type="checkbox"]')?.checked === true)
const onlineMeta = onlineLobby.locator('.start-menu__meta')
await onlineMeta.locator('summary').click()
await onlineMeta.getByLabel('Run mode').selectOption('custom')
await onlineMeta.getByRole('checkbox', { name: /Cursed/ }).click()
await onlineMeta.getByRole('checkbox', { name: /Night Terrors/ }).click()
await onlineMeta.getByLabel('Starting Act').selectOption('2')
await lobbyPage.waitForFunction(() => {
  const selected = [...document.querySelectorAll('.online-lobby__meta .start-menu__custom input')].filter((input) => input.checked)
  return selected.length === 2 && document.querySelector('.online-lobby__meta select[aria-label="Starting Act"]')?.value === '2'
})
await onlineMeta.locator('.start-menu__meta-panel').evaluate((panel) => { panel.scrollTop = panel.scrollHeight })
// By class, not by name: a non-leader's start button says who DOES start the
// run rather than repeating an instruction it will not carry out.
const leaderStartEnabled = await onlineLobby.locator('.online-lobby__start').isEnabled()
const guestStartLabel = await guestLobbyPage.locator('.online-lobby__start').textContent()
const guestStartDisabled = await guestLobbyPage.locator('.online-lobby__start').isDisabled()
const guestMetaDisabled = await guestLobbyPage.locator('.online-lobby__meta').getByLabel('Run mode').isDisabled()
await lobbyPage.screenshot({ path: join(outDir, 'meta-online-lobby.png'), fullPage: true })
check('online lobby persists Choose Your Relic and lists only unlocked Ascensions', () => {
  assertEqual(ascensionOptions, 1)
  assertEqual(liveRoom.chooseYourRelic, true)
})
check('online run setup is host-owned and rapid modifier edits compose against authoritative state', () => {
  assert(leaderStartEnabled, 'party leader could not start a connected ready lobby')
  assert(guestStartDisabled, 'non-leader could start the run')
  assert(/starts the run/.test(guestStartLabel), `the guest was not told who starts: ${guestStartLabel}`)
  assert(guestMetaDisabled, 'non-leader could edit official run setup')
  assertEqual(liveRoom.metaOptions.mode, 'custom')
  assertDeepEqual(liveRoom.metaOptions.modifiers, ['cursed', 'night_terrors'])
  assertEqual(liveRoom.metaOptions.quickStartAct, 2)
})
rooms.dropConnection(create.snapshot.code, onlineSeats[0].token)
const reconnectStartDisabled = await lobbyPage.waitForFunction(() => {
  const main = document.querySelector('main.online-lobby')
  const connection = main?.querySelector('.connection')?.textContent
  const start = [...(main?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('Spire') || button.textContent?.includes('Waiting'))
  return connection !== 'connected' && Boolean(start?.disabled)
}, undefined, { timeout: 5000 }).then((handle) => handle.jsonValue())
check('lobby Start disables immediately while the local client reconnects', () => assertEqual(reconnectStartDisabled, true))
await lobbyPage.locator('.connection--connected').waitFor()

await onlineLobby.getByRole('button', { name: /Achievements/ }).click()
await lobbyPage.getByRole('heading', { name: 'Achievements', exact: true }).waitFor()
const onlineAchievementCount = await lobbyPage.locator('.achievement-card').count()
const onlineAchievementDevControls = await lobbyPage.getByText('Mark complete', { exact: false }).count()
const onlineAchievementProgressUi = await lobbyPage.locator('progress[aria-label="Achievement completion"], .achievement-card small, .achievement-card[data-complete]').count()
await lobbyPage.screenshot({ path: join(outDir, 'achievements-online-reconnect.png'), fullPage: true })
await lobbyPage.getByRole('button', { name: 'Back to main menu' }).click()
await guestLobbyPage.getByRole('button', { name: /Achievements/ }).click()
await guestLobbyPage.getByRole('heading', { name: 'Achievements', exact: true }).waitFor()
const guestAchievementState = await guestLobbyPage.evaluate(() => ({
  count: document.querySelectorAll('.achievement-card').length,
  controls: [...document.querySelectorAll('main.compendium button, main.compendium input')]
    .filter((control) => !control.matches('.compendium__back')).length,
}))
await guestLobbyPage.getByRole('button', { name: 'Back to main menu' }).click()
check('online achievements remain a presentation-only record for every seat', () => {
  assertEqual(onlineAchievementCount, 19)
  assertEqual(onlineAchievementDevControls, 0)
  assertEqual(onlineAchievementProgressUi, 0)
  assertEqual(guestAchievementState.count, 19)
  assertEqual(guestAchievementState.controls, 0)
})

liveRoom.phase = 'run'
liveRoom.run = createRun(8800, onlineSeats.map(({ playerId: id, name, character }) => ({ id, name, character })), 0,
  liveRoom.campaignProgress, liveRoom.chooseYourRelic, false,
  { mode: 'custom', modifiers: ['cursed', 'night_terrors'], quickStartAct: 2 })
liveRoom.run.phase = 'setup'
liveRoom.run.neow = null
liveRoom.run.setup = { ...liveRoom.run.setup, rowIndex: 3, repeatIndex: 0, playerIndex: 0, die: null }
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await lobbyPage.getByRole('heading', { name: 'Transform a card' }).waitFor()
await guestLobbyPage.getByRole('heading', { name: 'Transform a card' }).waitFor()
const activeSetupConfirm = lobbyPage.getByRole('button', { name: 'Confirm' })
const waitingSetupConfirm = guestLobbyPage.getByRole('button', { name: 'Confirm' })
const activeSetupRequiresCard = await activeSetupConfirm.isDisabled()
const waitingSetupDisabled = await waitingSetupConfirm.isDisabled()
const waitingSetupStatus = await guestLobbyPage.getByRole('status').filter({ hasText: 'Waiting for Ann' }).count()
const waitingSetupFalseNoOp = await guestLobbyPage.getByText(/No eligible card/).count()
const onlineModifierSummary = await lobbyPage.locator('.run-modifiers > summary').textContent()
await lobbyPage.screenshot({ path: join(outDir, 'quick-start-active-online.png'), fullPage: true })
await guestLobbyPage.setViewportSize({ width: 1280, height: 800 })
await guestLobbyPage.screenshot({ path: join(outDir, 'quick-start-waiting-compact-desktop.png'), fullPage: true })
const waitingSetupContained = await guestLobbyPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
await lobbyPage.locator('.quick-setup__cards .card').first().click()
await activeSetupConfirm.click()
await guestLobbyPage.waitForFunction(() => [...document.querySelectorAll('.quick-setup__cards .card')].length > 0 &&
  [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Confirm')?.disabled === true &&
  ![...document.querySelectorAll('.quick-setup [role="status"]')].some((status) => status.textContent?.includes('Waiting for Ann')))
check('online Quick Setup exposes only the active seat controls and keeps hidden foreign decks neutral', () => {
  assert(activeSetupRequiresCard, 'active Transform did not require a card')
  assert(waitingSetupDisabled && waitingSetupStatus === 1, 'foreign seat was not held on an explicit waiting state')
  assertEqual(waitingSetupFalseNoOp, 0, 'redacted foreign deck was falsely described as having no eligible cards')
  assert(onlineModifierSummary?.includes('Custom Run · 2 modifiers'))
  assert(waitingSetupContained, 'Quick Setup waiting state overflowed compact desktop')
  assertEqual(liveRoom.run.setup.playerIndex, 1)
})

liveRoom.run.phase = 'room'
liveRoom.run.setup = { kind: 'catch-up', targetAct: 2, playerIds: [onlineSeats[3].playerId], rowIndex: 10, repeatIndex: 0, playerIndex: 0, die: null }
const catchUpPlayer = liveRoom.run.players[3]
liveRoom.run.roomState = {
  kind: 'merchant', relics: ['anchor'], potions: ['fire_potion'], colorless: [],
  cards: { [catchUpPlayer.id]: { choices: catchUpPlayer.cardRewards.slice(0, 3), cardsDrawn: catchUpPlayer.cardRewards.slice(0, 3), raresDrawn: [] } },
  removalUsed: [], purchasedCards: {},
}
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await lobbyPage.getByRole('status').filter({ hasText: 'Waiting for the Catch Up players' }).waitFor()
const oldSeatCatchUpMerchant = await lobbyPage.getByRole('heading', { name: 'The Merchant' }).count()
await lobbyPage.screenshot({ path: join(outDir, 'catch-up-waiting.png'), fullPage: true })
check('existing online seats wait outside a Catch Up-only Merchant visit', () => assertEqual(oldSeatCatchUpMerchant, 0))

await Promise.all([lobbyContext.close(), guestLobbyContext.close(), ...auxiliaryLobbyContexts.map((context) => context.close())])
liveRoom.phase = 'run'
liveRoom.run = createRun(8801, onlineSeats.map(({ playerId: id, name, character }) => ({ id, name, character })), 0, liveRoom.campaignProgress, liveRoom.chooseYourRelic)
const onlinePrismaticCards = [...liveRoom.run.players[0].cardRewards]
liveRoom.run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
liveRoom.run.setup = { kind: 'catch-up', targetAct: 2, playerIds: [onlineSeats[3].playerId], rowIndex: 0, repeatIndex: 0, playerIndex: 0, die: null }
liveRoom.run.neow.players = { [onlineSeats[3].playerId]: liveRoom.run.neow.players[onlineSeats[3].playerId] }
liveRoom.version += 1
const neowContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await neowContext.addInitScript(({ code, token }) => sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token })), { code: create.snapshot.code, token: onlineSeats[0].token })
const neowPage = installScreenAudit(await neowContext.newPage())
neowPage.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
neowPage.on('pageerror', (error) => failures.push(String(error)))
await neowPage.goto(base, { waitUntil: 'networkidle' })
await neowPage.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
await neowPage.getByRole('heading', { name: 'Catch Up in progress' }).waitFor()
const onlineCatchUpFaces = await neowPage.locator('.neow-face').count()
const onlineCatchUpProgress = await neowPage.locator('.neow-screen__progress').textContent()
const onlineCatchUpWaiting = await neowPage.getByRole('status').filter({ hasText: 'Waiting for the Catch Up players' }).count()
const onlineCatchUpPublicDetailsVisible = await neowPage.locator('.neow-face blockquote').evaluate((element) => {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0
})
await neowPage.screenshot({ path: join(outDir, 'catch-up-neow-online-compact-desktop.png'), fullPage: true })
liveRoom.run = createRun(8801, onlineSeats.map(({ playerId: id, name, character }) => ({ id, name, character })), 0, liveRoom.campaignProgress, liveRoom.chooseYourRelic)
liveRoom.run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await neowPage.waitForFunction(() => document.querySelectorAll('.neow-face').length === 4)
const onlineNeowFaces = await neowPage.locator('.neow-face').count()
await neowPage.getByRole('button', { name: 'Skip 3 Gold' }).click()
await neowPage.getByRole('button', { name: 'Reveal Card Reward' }).waitFor()
const sourceChoices = neowPage.locator('.neow-source-choice input')
await sourceChoices.nth(0).check()
await sourceChoices.nth(1).check()
await sourceChoices.nth(2).check()
liveRoom.run.players[0].cardRewards = []
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await neowPage.waitForFunction(() => document.querySelectorAll('.neow-source-choice input:checked').length === 0)
const reconciledPrismaticSources = await sourceChoices.evaluateAll((inputs) => ({
  checked: inputs.filter((input) => input.checked).length,
  enabled: inputs.filter((input) => !input.disabled).length,
}))
liveRoom.run.players[0].cardRewards = onlinePrismaticCards
liveRoom.run.players[0].relics = liveRoom.run.players[0].relics.filter((relic) => relic.defId !== 'prismatic_shard')
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await neowPage.locator('.neow-source-choice').waitFor({ state: 'detached' })
const onlineFaceDown = await neowPage.getByRole('button', { name: 'Reveal Card Reward' }).count()
await neowPage.getByRole('button', { name: 'Skip unseen' }).click()
await neowPage.locator('.neow-options').waitFor()
await neowPage.getByRole('button', { name: /Transform 1 card/ }).click()
const onlineNeowCardChoice = neowPage.locator('.neow-card-choice')
await onlineNeowCardChoice.locator('.card').first().click()
const onlineNeowConfirm = onlineNeowCardChoice.getByRole('button', { name: 'Gain reward' })
assert(await onlineNeowConfirm.isEnabled(), 'Neow card selection did not enable confirmation')
for (const action of [
  { kind: 'neow', stage: 'redGold', gain: false },
  { kind: 'neow', stage: 'reveal' },
]) {
  const response = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': onlineSeats[1].token },
    body: JSON.stringify({ action }),
  })
  assertEqual(response.status, 200, 'other seat Neow action was rejected')
}
await neowPage.locator('.neow-face').nth(1).locator('.neow-face__reveal').waitFor()
const onlineNeowSelectionSurvived = await onlineNeowCardChoice.locator('.card--selected').count() === 1 && await onlineNeowConfirm.isEnabled()
liveRoom.run.players[1].relics.push({ defId: 'astrolabe', spent: false, pending: true })
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
const onlinePendingRelicLock = await neowPage.waitForFunction(() => {
  const screen = document.querySelector('.neow-screen')
  const actions = [...(screen?.querySelectorAll('.neow-action button') ?? [])]
  return actions.length > 0 && actions.every((button) => button.disabled || button.getAttribute('aria-disabled') === 'true') &&
    Boolean(screen?.querySelector('.neow-action__waiting')?.textContent?.includes('Waiting for Bo to resolve Astrolabe'))
}).then((handle) => handle.jsonValue())
liveRoom.run.players[1].relics = liveRoom.run.players[1].relics.filter((relic) => !relic.pending)
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await neowPage.waitForFunction(() => [...document.querySelectorAll('.neow-action button')].some((button) => !button.disabled))
rooms.dropConnection(create.snapshot.code, onlineSeats[0].token)
const disconnectedNeow = await neowPage.waitForFunction(() => {
  const screen = document.querySelector('.neow-screen')
  const wrapper = screen?.closest('.online-mutations')
  return Boolean(screen && wrapper?.hasAttribute('inert'))
}, undefined, { timeout: 5000 }).then((handle) => handle.jsonValue())
const onlineNeowContained = await neowPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
// The reconnect banner displaces the scene out of the shell's positional `1fr`
// row, so this is where the `.neow-screen` height rules are load-bearing. What
// is asserted is REACHABILITY, not the absence of page scroll: `.neow-screen` is
// `overflow: hidden` with no scroller inside it, so any rule that caps the scene
// to the viewport does not shrink the dealt faces, it clips them away with no
// gesture that brings them back. An earlier pass here capped it and hid two of
// the four faces outright at 375x667. Page scroll is the acceptable outcome;
// an unreachable face is not, per styles.css:54.
const neowFloorScroll = []
for (const size of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 375, height: 667 }]) {
  await neowPage.setViewportSize(size)
  await neowPage.waitForFunction(() => Boolean(document.querySelector('.online-banner')))
  neowFloorScroll.push({
    size: `${size.width}x${size.height}`,
    ...await neowPage.evaluate(() => {
      const scene = document.querySelector('.neow-screen').getBoundingClientRect()
      const faces = [...document.querySelectorAll('.neow-face')]
      return {
        faces: faces.length,
        // Clipped by the scene's own `overflow: hidden` — scrolling cannot help.
        clipped: faces.filter((face) => face.getBoundingClientRect().bottom > scene.bottom + 1).length,
        // Below the document's scrollable extent — scrolling cannot help either.
        unreachable: faces.filter((face) =>
          face.getBoundingClientRect().bottom + scrollY > document.documentElement.scrollHeight + 1).length,
      }
    }),
  })
}
// Back to the size the screenshot below is framed for, and wait for the scene to
// re-expand so the capture is not taken mid-reflow.
await neowPage.setViewportSize({ width: 1280, height: 800 })
await neowPage.waitForFunction(() => (document.querySelector('.neow-screen')?.getBoundingClientRect().height ?? 0) > 500)
await neowPage.screenshot({ path: join(outDir, 'neow-online-reconnect-compact-desktop.png'), fullPage: true })
check('online Neow is public, authoritative, and inert during reconnect', () => {
  assertEqual(onlineCatchUpFaces, 1)
  assertEqual(onlineCatchUpProgress?.trim(), '0/1 ready')
  assertEqual(onlineCatchUpWaiting, 1)
  assert(onlineCatchUpPublicDetailsVisible, 'public Catch Up Neow details were hidden on compact desktop')
  assertEqual(reconciledPrismaticSources.checked, 0, 'an exhausted Prismatic source remained selected')
  assert(reconciledPrismaticSources.enabled >= 3, 'remaining Prismatic sources stayed disabled after reconciliation')
  assertEqual(onlineNeowFaces, 4)
  assertEqual(onlineFaceDown, 1)
  assertEqual(liveRoom.run.neow.players[onlineSeats[0].playerId].redRewardPending, false)
  assertEqual(liveRoom.run.neow.players[onlineSeats[0].playerId].redReward, null)
  assert(onlineNeowSelectionSurvived, 'another seat snapshot cleared an in-progress Neow card selection')
  assert(onlinePendingRelicLock, 'another seat\'s pending Astrolabe left online Neow choices enabled')
  assert(disconnectedNeow, 'disconnected Neow controls remained interactive')
  assert(onlineNeowContained, 'online Neow overflowed the compact desktop viewport')
  for (const sample of neowFloorScroll) {
    assertEqual(sample.faces, 4, `online Neow dealt ${sample.faces} faces at ${sample.size}`)
    assert(sample.clipped === 0, `${sample.clipped} of ${sample.faces} Neow faces were clipped away by the scene at ${sample.size}`)
    assert(sample.unreachable === 0, `${sample.unreachable} of ${sample.faces} Neow faces sat past the scrollable extent at ${sample.size}`)
  }
})
await neowContext.close()
liveRoom.run.phase = 'room'
liveRoom.run.neow = null
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, gold: [1, 4, 12, 12][index] }))
liveRoom.run.roomState = {
  kind: 'merchant', relics: ['anchor', 'happy_flower', 'akabeko'], potions: ['fire_potion', 'swift_potion', 'blood_potion'], colorless: [],
  cards: Object.fromEntries(liveRoom.run.players.map((player) => [player.id, { choices: player.cardRewards.slice(0, 3), cardsDrawn: player.cardRewards.slice(0, 3), raresDrawn: [] }])), removalUsed: [], purchasedCards: {},
}

const onlineContexts = []
const onlinePages = []
for (const seat of onlineSeats) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(({ code, token }) => sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token })), { code: create.snapshot.code, token: seat.token })
  const onlinePage = await context.newPage()
  onlinePage.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  onlinePage.on('pageerror', (error) => failures.push(String(error)))
  await onlinePage.goto(base, { waitUntil: 'networkidle' })
  await onlinePage.getByRole('heading', { name: 'The Merchant' }).waitFor()
  onlineContexts.push(context)
  onlinePages.push(onlinePage)
}
const [ann, bo] = onlinePages
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, gold: index === 0 ? 1 : 0 }))
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
const insufficientMerchantDisabled = await ann.getByRole('button', { name: /Anchor/ }).isDisabled()
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, gold: [1, 4, 12, 12][index] }))
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await ann.getByRole('button', { name: /Anchor/ }).click()
await ann.getByRole('button', { name: 'Cancel relic purchase and return all contributions' }).waitFor()
const pendingMerchantLeaveDisabled = await ann.getByRole('button', { name: /Leave merchant/ }).isDisabled()
const pendingMerchantLeaveFrame = await ann.getByRole('button', { name: /Leave merchant/ }).evaluate((button) => {
  const frame = button.closest('.room-stage')?.getBoundingClientRect()
  const bounds = button.getBoundingClientRect()
  return Boolean(frame && bounds.width > 120 && bounds.left >= frame.left && bounds.right <= frame.right)
})
await ann.screenshot({ path: join(outDir, 'merchant-4p-funded-online.png'), fullPage: true })
const competingBuyerDisabled = await bo.getByRole('button', { name: /Anchor/ }).isDisabled()
await bo.getByLabel('Shopping for').selectOption(onlineSeats[0].playerId)
await bo.getByRole('button', { name: /Anchor/ }).click()
await ann.getByRole('button', { name: /Sold/ }).first().waitFor()
await ann.reload({ waitUntil: 'networkidle' })
await ann.getByRole('heading', { name: 'The Merchant' }).waitFor()
await ann.getByRole('button', { name: /Sold/ }).first().waitFor()
await bo.setViewportSize({ width: 1280, height: 800 })
await bo.screenshot({ path: join(outDir, 'merchant-4p-reconnect-compact-desktop.png'), fullPage: true })
const compactOnline = await bo.evaluate(() => {
  const leave = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Leave merchant'))
  const stage = document.querySelector('.room-stage')?.getBoundingClientRect()
  return { width: document.documentElement.scrollWidth, viewport: innerWidth, leave: Boolean(leave), contained: Boolean(stage && leave && stage.bottom >= leave.getBoundingClientRect().bottom - 1), wide: [...document.querySelectorAll('*')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map((element) => `${element.tagName}.${element.className}:${Math.round(element.getBoundingClientRect().right)}`) }
})
const privateSnapshot = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[0].token } }).then((response) => response.json())
check('four-seat shared funding is buyer-authorized, atomic, and reconnect-stable', () => {
  assert(insufficientMerchantDisabled, 'Merchant accepted a new pledge the party could not complete')
  assert(competingBuyerDisabled, 'shared Merchant offer remained enabled for a competing buyer')
  assertEqual(pendingMerchantLeaveDisabled, true)
  assert(pendingMerchantLeaveFrame, 'funded Merchant clipped its disabled leave action')
  assert(liveRoom.run.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(liveRoom.run.players[0].gold, 0)
  assertEqual(liveRoom.run.players[1].gold, 0)
  assertEqual(privateSnapshot.run.players[1].deck, null)
  assert(!('itemDecks' in privateSnapshot.run), 'hidden shared deck order reached a client')
  assert(compactOnline.width <= compactOnline.viewport, `online Merchant is ${compactOnline.width}px wide in a ${compactOnline.viewport}px viewport (${compactOnline.wide.join(', ')})`)
  assert(compactOnline.leave, 'compact desktop Merchant lost its leave affordance')
  assert(compactOnline.contained, 'the Merchant leave action escaped the compact desktop room frame')
})

liveRoom.run.players[2] = { ...liveRoom.run.players[2], gold: 5 }
liveRoom.version += 1
const cyMerchant = onlinePages[2]
await ann.reload({ waitUntil: 'networkidle' })
await ann.getByRole('button', { name: /Happy Flower/ }).click()
await cyMerchant.reload({ waitUntil: 'networkidle' })
await cyMerchant.locator('.connection--connected').waitFor()
await cyMerchant.getByLabel('Shopping for').selectOption(onlineSeats[0].playerId)
await cyMerchant.getByRole('button', { name: /Happy Flower/ }).click()
await cyMerchant.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Happy Flower') && button.disabled))
const repeatMerchantPledgeDisabled = await cyMerchant.getByRole('button', { name: /Happy Flower/ }).isDisabled()
await ann.getByRole('button', { name: /Akabeko/ }).click()
await cyMerchant.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Akabeko') && button.disabled))
const reservedGoldBlocksSecondPledge = await cyMerchant.getByRole('button', { name: /Akabeko/ }).isDisabled()
check('Merchant reconnect preserves an existing payer total and subtracts reserved Gold', () => {
  assert(repeatMerchantPledgeDisabled)
  assert(reservedGoldBlocksSecondPledge)
  assertEqual(liveRoom.merchantPledges[`${onlineSeats[0].playerId}/relic/1`].payments[onlineSeats[2].playerId], 5)
})
liveRoom.merchantPledges = undefined
liveRoom.version += 1

liveRoom.run.ascension = 4
liveRoom.run.players[0] = { ...liveRoom.run.players[0], gold: 0, potions: ['swift_potion', 'blood_potion'] }
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
const merchantReplacement = ann.getByRole('group', { name: 'Replace potion' })
await merchantReplacement.getByRole('button', { name: /Swift Potion/ }).click()
const merchantReplacementCards = await merchantReplacement.locator('.item-card-image')
  .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
await ann.screenshot({ path: join(outDir, 'merchant-potion-replacement.png'), fullPage: true })
await ann.getByRole('button', { name: /Fire Potion/ }).click()
const potionContributor = onlinePages[2]
await potionContributor.reload({ waitUntil: 'networkidle' })
await potionContributor.getByLabel('Shopping for').selectOption(onlineSeats[0].playerId)
const pendingPotion = potionContributor.getByRole('button', { name: /Fire Potion/ })
const reconnectPotionEnabled = await pendingPotion.isEnabled()
const contributorReplacementInputs = await potionContributor.getByRole('group', { name: 'Replace potion' }).count()
await pendingPotion.click()
await potionContributor.getByRole('button', { name: /Sold/ }).first().waitFor()
check('Merchant reconnect preserves the buyer-authorized potion replacement for contributors', () => {
  assert(reconnectPotionEnabled, 'pending Potion funding required the contributor to guess the buyer replacement')
  assertEqual(contributorReplacementInputs, 0)
  assertDeepEqual(merchantReplacementCards, [true, true])
  assert(liveRoom.run.players[0].potions.includes('fire_potion'))
  assert(!liveRoom.run.players[0].potions.includes('swift_potion'))
})
await ann.waitForFunction(() => document.querySelectorAll('.merchant-potion-discard button[aria-pressed="true"]').length === 0)
const stalePotionReplacement = await merchantReplacement.getByRole('button', { pressed: true }).count()
const consecutivePotionDisabled = await ann.getByRole('button', { name: /Swift Potion/ }).isDisabled()
await merchantReplacement.getByRole('button', { name: /Blood Potion/ }).click()
const consecutivePotionEnabled = await ann.getByRole('button', { name: /Swift Potion/ }).isEnabled()
check('Merchant clears a replacement after that Potion leaves the buyer inventory', () => {
  assertEqual(stalePotionReplacement, 0)
  assert(consecutivePotionDisabled)
  assert(consecutivePotionEnabled)
})

const removableDeck = liveRoom.run.players[0].deck.filter((card) => card.defId !== 'ascenders_bane')
// A fresh deck is several duplicate-named Strikes and Defends, so identifying
// the restored pick by its accessible name alone cannot tell "the pledged
// UID" apart from "a different card that merely shares its name". The picker
// renders `removableDeck` in this exact order (RoomScreen.tsx's own filter),
// so position is the uid-specific assertion here.
const pendingRemovalIndex = 1
const pendingRemovalCard = removableDeck[pendingRemovalIndex]
liveRoom.merchantPledges = { [`remove/${onlineSeats[0].playerId}`]: { kind: 'removal', buyerId: onlineSeats[0].playerId, cardUid: pendingRemovalCard.uid, payments: { [onlineSeats[0].playerId]: 1 } } }
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await ann.locator('.connection--connected').waitFor()
const removalGroup = ann.getByRole('group', { name: 'Card to remove' })
const restoredRemovalSelectedCount = await removalGroup.getByRole('button', { pressed: true }).count()
const restoredRemovalPledgedPressed = await removalGroup.getByRole('button').nth(pendingRemovalIndex).getAttribute('aria-pressed')
const restoredRemovalLocked = await removalGroup.getByRole('button').nth(pendingRemovalIndex).getAttribute('aria-disabled')
check('Merchant reconnect restores and locks the removal owner’s authorized card', () => {
  assertEqual(restoredRemovalSelectedCount, 1, 'exactly one card is marked selected')
  assertEqual(restoredRemovalPledgedPressed, 'true', 'the SPECIFIC pledged card (by position, not just by name) is the one selected')
  assertEqual(restoredRemovalLocked, 'true')
})
liveRoom.merchantPledges = undefined
liveRoom.version += 1

liveRoom.run.players[0] = { ...liveRoom.run.players[0], relics: [...liveRoom.run.players[0].relics, { defId: 'sozu', spent: false }] }
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
const onlinePotionButtons = ann.locator('.merchant-shelf[aria-label="Potions"] button')
await ann.getByText('Blocked by Sozu').first().waitFor()
const onlineSozuMerchantDisabled = await onlinePotionButtons.evaluateAll((buttons) => buttons.every((button) => button.disabled))
const onlineSozuReplacementControls = await ann.getByRole('group', { name: 'Replace potion' }).count()
check('online Merchant disables every Potion purchase for a Sozu recipient', () => {
  assert(onlineSozuMerchantDisabled)
  assertEqual(onlineSozuReplacementControls, 0)
})
liveRoom.run.players[0] = { ...liveRoom.run.players[0], relics: liveRoom.run.players[0].relics.filter((relic) => relic.defId !== 'sozu') }
liveRoom.version += 1

liveRoom.run.phase = 'reward'
liveRoom.run.roomState = null
liveRoom.run.rewardDestination = 'map'
liveRoom.run.rewards = liveRoom.run.players.map((player) => ({
  playerId: player.id, cardReward: true, choices: null, upgraded: false, prismatic: true,
  availableSources: ['ironclad', 'silent', 'defect', 'watcher'], potion: false, relic: false, bossRelics: false,
}))
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
const onlineRewardSources = ann.locator('.reward-screen__player').first().getByRole('group', { name: 'Choose 3 different reward decks' })
await onlineRewardSources.waitFor()
for (const checkbox of (await onlineRewardSources.getByRole('checkbox').all()).slice(0, 3)) await checkbox.check()
liveRoom.run.rewards[0].availableSources = ['silent', 'defect', 'watcher']
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.waitForFunction(() => document.querySelector('.reward-screen__player .reward-screen__sources')?.querySelectorAll('input:checked').length === 2)
const onlineRewardSelectionReconciled = await onlineRewardSources.evaluate((group) => ({
  checked: group.querySelectorAll('input:checked').length,
  disabled: group.querySelector('button')?.disabled,
}))
check('online Prismatic reward selections reconcile after another seat exhausts a source', () => {
  assertEqual(onlineRewardSelectionReconciled.checked, 2)
  assert(onlineRewardSelectionReconciled.disabled)
})

liveRoom.run.phase = 'room'
liveRoom.run.roomState = {
  kind: 'treasure', offers: {}, playerIds: onlineSeats.map((seat) => seat.playerId),
  sharedOffers: ['happy_flower', 'akabeko', 'lantern', 'vajra'], decisions: {},
}
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await bo.reload({ waitUntil: 'networkidle' })
await ann.getByRole('button', { name: /Happy Flower/ }).click()
await bo.getByRole('button', { name: /Happy Flower/ }).waitFor({ state: 'visible' })
await bo.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Happy Flower') && button.disabled))
await bo.waitForFunction(() => document.activeElement?.textContent?.includes('Akabeko'))
const nextSharedRelicFocused = await bo.evaluate(() => document.activeElement?.textContent ?? '')
const sharedSnapshot = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[1].token } }).then((response) => response.json())
check('online shared relic claims move focus to the next slot without exposing Sapphire intent', () => {
  assert(nextSharedRelicFocused.includes('Akabeko'))
  assertEqual(sharedSnapshot.run.roomState.decisions[onlineSeats[0].playerId], 0)
})

liveRoom.run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
liveRoom.run.phase = 'room'
liveRoom.run.roomState = {
  kind: 'event', card: { id: 'cursed_tome', instanceId: 'browser-online-prismatic-event', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Cursed Tome', scope: 'player', options: [
    { id: 'take', label: 'Take', description: 'Gain a Rare Reward and a Curse.', effects: [{ tag: 'rare-reward' }, { tag: 'gain-curse' }] },
    { id: 'skim', label: 'Skim', description: 'Gain a Card Reward. Lose 1 HP.', effects: [{ tag: 'card-reward' }, { tag: 'lose-hp', amount: 1 }] },
  ] }, decisions: {}, dieRolls: {}, availableRewardSources: {
    card: ['ironclad', 'silent', 'defect', 'watcher', 'colorless'],
    rare: ['ironclad', 'silent', 'defect', 'watcher'],
  },
}
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
const onlineOrdinarySources = ann.getByRole('group', { name: 'Prismatic Shard · Card Reward · choose 3 reward decks' })
const onlineRareSources = ann.getByRole('group', { name: 'Prismatic Shard · Rare Reward · choose 3 reward decks' })
await onlineOrdinarySources.waitFor()
for (const checkbox of (await onlineOrdinarySources.getByRole('checkbox').all()).slice(0, 3)) await checkbox.check()
const onlineSkimEnabled = await ann.getByRole('button', { name: /\[Skim\]/ }).isEnabled()
const onlineTakeDisabled = await ann.getByRole('button', { name: /\[Take\]/ }).isDisabled()
for (const checkbox of (await onlineRareSources.getByRole('checkbox').all()).slice(0, 3)) await checkbox.check()
const onlineTakeEnabled = await ann.getByRole('button', { name: /\[Take\]/ }).isEnabled()
check('online Event snapshots preserve option-specific Prismatic source inventories', () => {
  assert(onlineSkimEnabled && onlineTakeDisabled && onlineTakeEnabled)
})

liveRoom.run.roomState = {
  kind: 'event', card: { id: 'knowing_skull', instanceId: 'browser-online-prismatic-skull', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Knowing Skull', scope: 'player', rule: 'Choose one or two options.', options: [
    { id: 'riches', label: 'Riches?', description: 'Gain 3 Gold. Lose 1 HP.', effects: [{ tag: 'gain-gold', amount: 3 }, { tag: 'lose-hp', amount: 1 }] },
    { id: 'success', label: 'Success?', description: 'Gain a Card Reward. Lose 1 HP.', effects: [{ tag: 'card-reward' }, { tag: 'lose-hp', amount: 1 }] },
  ] }, decisions: {}, dieRolls: {}, availableRewardSources: {
    card: ['ironclad', 'silent', 'defect', 'watcher'], rare: [],
  },
}
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
const onlineSkullSources = ann.getByRole('group', { name: 'Prismatic Shard · Card Reward · choose 3 reward decks' })
await onlineSkullSources.waitFor()
for (const checkbox of (await onlineSkullSources.getByRole('checkbox').all()).slice(0, 3)) await checkbox.check()
await ann.getByRole('button', { name: /\[Success\?\]/ }).click()
const onlineSkullConfirm = ann.getByRole('button', { name: 'Confirm chosen questions →' })
assert(await onlineSkullConfirm.isEnabled(), 'online Knowing Skull fixture did not reach a valid Prismatic choice')
liveRoom.run.roomState.availableRewardSources.card = ['silent', 'defect', 'watcher']
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.waitForFunction(() => document.querySelector('.room-proceed')?.disabled === true)
const onlineSkullRevalidated = await onlineSkullConfirm.isDisabled()
check('online Knowing Skull revalidates selected Prismatic sources after another seat exhausts one', () => assert(onlineSkullRevalidated))

const onlineEventRewardSupply = {
  players: liveRoom.run.players.map((player) => ({ cardRewards: [...player.cardRewards], rareRewards: [...player.rareRewards] })),
  colorless: [...liveRoom.run.itemDecks.colorless],
  characterCards: structuredClone(liveRoom.run.itemDecks.characterCards),
  characterRares: structuredClone(liveRoom.run.itemDecks.characterRares),
}
liveRoom.run.players = liveRoom.run.players.map((player) => ({ ...player, cardRewards: [], rareRewards: [] }))
liveRoom.run.itemDecks.colorless = []
liveRoom.run.itemDecks.characterCards = Object.fromEntries(Object.keys(liveRoom.run.itemDecks.characterCards).map((id) => [id, []]))
liveRoom.run.itemDecks.characterRares = Object.fromEntries(Object.keys(liveRoom.run.itemDecks.characterRares).map((id) => [id, []]))
liveRoom.run.roomState = {
  kind: 'event', card: { id: 'cursed_tome', instanceId: 'browser-online-prismatic-empty', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Cursed Tome', scope: 'player', options: [
    { id: 'take', label: 'Take', description: 'Gain a Rare Reward.', effects: [{ tag: 'rare-reward' }] },
    { id: 'skim', label: 'Skim', description: 'Gain a Card Reward.', effects: [{ tag: 'card-reward' }] },
  ] }, decisions: {}, dieRolls: {}, availableRewardSources: { card: [], rare: [] },
}
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.getByRole('button', { name: /No legal choice/ }).waitFor()
const onlineExhaustedPrismaticEvent = {
  normalDisabled: await ann.getByRole('button', { name: /\[Skim\]/ }).isDisabled(),
  rareDisabled: await ann.getByRole('button', { name: /\[Take\]/ }).isDisabled(),
}
check('online exhausted normal and Rare Prismatic Events expose the authoritative escape', () => {
  assert(onlineExhaustedPrismaticEvent.normalDisabled && onlineExhaustedPrismaticEvent.rareDisabled)
})
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, ...onlineEventRewardSupply.players[index] }))
liveRoom.run.itemDecks.colorless = onlineEventRewardSupply.colorless
liveRoom.run.itemDecks.characterCards = onlineEventRewardSupply.characterCards
liveRoom.run.itemDecks.characterRares = onlineEventRewardSupply.characterRares

liveRoom.run.phase = 'room'
liveRoom.run.roomState = {
  kind: 'event', card: { id: 'big_fish', instanceId: 'browser-online-big-fish', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Big Fish', scope: 'player', rule: 'Each player chooses a different option.', options: [
    { id: 'banana', label: 'Banana', description: 'Heal 2 HP.', effects: [{ tag: 'heal', amount: 2 }] },
    { id: 'donut', label: 'Donut', description: 'Upgrade a starter Strike.', effects: [{ tag: 'upgrade-card', filter: 'starter Strike' }] },
  ] }, decisions: { [onlineSeats[0].playerId]: { optionIds: ['banana'] } }, dieRolls: {},
}
liveRoom.version += 1
await bo.reload({ waitUntil: 'networkidle' })
const reconnectBigFishDisabled = await bo.getByRole('button', { name: /\[Banana\]/ }).isDisabled()
check('Big Fish unique choices remain disabled for teammates after reconnect', () => assert(reconnectBigFishDisabled))

liveRoom.run.phase = 'room'
liveRoom.run.roomState = {
  kind: 'event', card: { id: 'transmogriphier', instanceId: 'browser-online-transform', act: 1, minAscension: 0, requiresColorlessUnlock: false, name: 'Transmogriphier', scope: 'player', options: [
    { id: 'pray', label: 'Pray', description: 'Transform a card.', effects: [{ tag: 'transform-card' }] },
  ] }, decisions: {}, dieRolls: {},
}
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
const transformedUid = liveRoom.run.players[0].deck[0].uid
await ann.locator('.event-cards button').first().click()
await ann.getByRole('button', { name: /\[Pray\]/ }).click()
await ann.getByRole('status').filter({ hasText: 'Your choice is locked' }).waitFor()
check('online Transform uses the owner’s public reward count without exposing its deck', () => {
  assert(!liveRoom.run.players[0].deck.some((card) => card.uid === transformedUid))
})

const tradeCard = liveRoom.run.players[0].deck[0]
liveRoom.run.phase = 'room'
liveRoom.run.roomState = {
  kind: 'event', card: { id: 'note_for_yourself', instanceId: 'browser-online-trade-start', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'A Note for Yourself', scope: 'player', options: [
    { id: 'exchange', label: 'Exchange', description: 'Give a player a card in your deck. They give you a card in their deck.', effects: [{ tag: 'trade-card' }] },
  ] }, decisions: {}, dieRolls: {},
}
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await ann.locator('.event-cards button').first().click()
const targetlessTradeDisabled = await ann.getByRole('button', { name: /\[Exchange\]/ }).isDisabled()
await ann.getByLabel('Target player').selectOption(onlineSeats[1].playerId)
await ann.getByRole('button', { name: /\[Exchange\]/ }).click()
await ann.getByRole('status').filter({ hasText: 'Exchange pending' }).waitFor()
await ann.screenshot({ path: join(outDir, 'event-online-trade-initiation.png'), fullPage: true })
check('online Note trade uses teammate public deck count and stages server authority', () => {
  assert(targetlessTradeDisabled, 'Note exchange enabled before its target was chosen')
  assertEqual(liveRoom.run.roomState.pendingTrade.actorId, onlineSeats[0].playerId)
  assertEqual(liveRoom.run.roomState.pendingTrade.targetId, onlineSeats[1].playerId)
  assertEqual(liveRoom.run.roomState.pendingTrade.offeredId, tradeCard.defId)
})

const offeredTradeCard = liveRoom.run.players[0].deck[0]
liveRoom.run.roomState = {
  kind: 'event',
  card: { id: 'note_for_yourself', instanceId: 'browser-public-trade-wait', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'A Note for Yourself', scope: 'player', options: [] },
  decisions: {}, dieRolls: {},
  pendingTrade: { actorId: onlineSeats[0].playerId, targetId: onlineSeats[1].playerId, kind: 'card', offeredId: offeredTradeCard.defId, decision: { optionIds: ['exchange'], targetPlayerId: onlineSeats[1].playerId, cardUids: [offeredTradeCard.uid] } },
}
liveRoom.version += 1
const cy = onlinePages[2]
await cy.reload({ waitUntil: 'networkidle' })
await cy.getByRole('status').filter({ hasText: 'Exchange pending' }).waitFor()
const uninvolvedTrade = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[2].token } }).then((response) => response.json())
check('uninvolved online seats receive only a privacy-safe Event exchange wait marker', () => {
  assertEqual(uninvolvedTrade.run.roomState.pendingTrade.targetId, onlineSeats[1].playerId)
  assertEqual(uninvolvedTrade.run.roomState.pendingTrade.offeredId, '')
})

let onlineCourierRun = postNeowRun(8802, onlineSeats.map(({ playerId: id, name, character }) => ({ id, name, character })))
onlineCourierRun = enterRoom(onlineCourierRun, roomChoices(onlineCourierRun)[0].id)
onlineCourierRun.itemDecks.relics = ['anchor', ...onlineCourierRun.itemDecks.relics.filter((id) => id !== 'anchor')]
onlineCourierRun.combat.players = onlineCourierRun.combat.players.map((player) => ({ ...player, gold: player.id === onlineSeats[0].playerId ? 0 : player.id === onlineSeats[1].playerId ? 5 : player.id === onlineSeats[2].playerId ? 1 : 0, relics: player.id === onlineSeats[0].playerId ? [...player.relics, { defId: 'the_courier', spent: false }] : player.relics }))
onlineCourierRun.players = onlineCourierRun.players.map((player) => ({ ...player, gold: player.id === onlineSeats[0].playerId ? 0 : player.id === onlineSeats[1].playerId ? 5 : player.id === onlineSeats[2].playerId ? 1 : 0, relics: player.id === onlineSeats[0].playerId ? [...player.relics, { defId: 'the_courier', spent: false }] : player.relics }))
liveRoom.run = onlineCourierRun
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await bo.reload({ waitUntil: 'networkidle' })
await ann.getByRole('complementary', { name: 'The Courier' }).waitFor()
await ann.getByRole('button', { name: 'Look at Relic' }).click()
const courierLocksCombat = await ann.waitForFunction(() => document.querySelector('.courier-combat-lock')?.hasAttribute('inert') === true).then((handle) => handle.jsonValue())
await ann.getByRole('button', { name: /Buy \/ pledge ◉ 0/ }).click()
await bo.reload({ waitUntil: 'networkidle' })
await bo.locator('.connection--connected').waitFor()
await bo.getByRole('complementary', { name: 'The Courier offer' }).waitFor()
liveRoom.run.combat.players.find((player) => player.id === onlineSeats[1].playerId).dead = true
liveRoom.version += 1
rooms.publishRoom(liveRoom.code)
await bo.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Buy / pledge') && button.disabled))
const fallenCourierPledgeDisabled = await bo.getByRole('button', { name: /Buy \/ pledge/ }).isDisabled()
liveRoom.run.combat.players.find((player) => player.id === onlineSeats[1].playerId).dead = false
liveRoom.version += 1
rooms.publishRoom(liveRoom.code)
await bo.getByRole('button', { name: /Buy \/ pledge ◉ 5/ }).waitFor()
await bo.getByRole('button', { name: /Buy \/ pledge ◉ 5/ }).click()
await bo.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Buy / pledge') && button.disabled))
const repeatCourierPledgeDisabled = await bo.getByRole('button', { name: /Buy \/ pledge/ }).isDisabled()
await cy.reload({ waitUntil: 'networkidle' })
await cy.getByRole('button', { name: /Buy \/ pledge ◉ 1/ }).click()
await cy.getByRole('complementary', { name: 'The Courier offer' }).waitFor({ state: 'detached' })
check('a zero-Gold Courier owner can authorize teammate funding online', () => {
  assert(courierLocksCombat, 'Courier offer left combat controls interactive')
  assert(fallenCourierPledgeDisabled, 'fallen Last Stand seat could fund The Courier')
  assert(repeatCourierPledgeDisabled, 'Courier repeat contribution could replace an existing payer total')
  assert(liveRoom.run.combat.players.find((player) => player.id === onlineSeats[0].playerId).relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(liveRoom.run.combat.players.find((player) => player.id === onlineSeats[1].playerId).gold, 0)
})

let sozuCourierRun = postNeowRun(8803, onlineSeats.map(({ playerId: id, name, character }) => ({ id, name, character })))
sozuCourierRun = enterRoom(sozuCourierRun, roomChoices(sozuCourierRun)[0].id)
sozuCourierRun.players = sozuCourierRun.players.map((player, index) => ({ ...player, gold: 12, relics: index === 0 ? [...player.relics, { defId: 'the_courier', spent: false }, { defId: 'sozu', spent: false }] : player.relics }))
sozuCourierRun.combat.players = sozuCourierRun.combat.players.map((player, index) => ({ ...player, gold: 12, relics: index === 0 ? [...player.relics, { defId: 'the_courier', spent: false }, { defId: 'sozu', spent: false }] : player.relics }))
sozuCourierRun.courier = { usedBy: [onlineSeats[0].playerId], offer: { playerId: onlineSeats[0].playerId, kind: 'potion', id: 'fire_potion' } }
liveRoom.run = sozuCourierRun
liveRoom.courierPledge = undefined
liveRoom.version += 1
await bo.reload({ waitUntil: 'networkidle' })
const sozuCourierPanel = bo.getByRole('complementary', { name: 'The Courier offer' })
await sozuCourierPanel.getByText('Sozu prevents gaining Potions').waitFor()
const onlineSozuCourierDisabled = await sozuCourierPanel.getByRole('button', { name: /Buy \/ pledge/ }).isDisabled()
const onlineSozuCourierReplacement = await sozuCourierPanel.getByLabel('Replace Potion').count()
check('online Courier disables a Potion offer for its Sozu owner', () => {
  assert(onlineSozuCourierDisabled)
  assertEqual(onlineSozuCourierReplacement, 0)
})
liveRoom.run.players[0] = { ...liveRoom.run.players[0], relics: liveRoom.run.players[0].relics.filter((relic) => relic.defId !== 'sozu') }
liveRoom.run.combat.players[0] = { ...liveRoom.run.combat.players[0], relics: liveRoom.run.combat.players[0].relics.filter((relic) => relic.defId !== 'sozu') }
liveRoom.run.courier = { ...liveRoom.run.courier, offer: null }

liveRoom.eventPledge = undefined
liveRoom.run.phase = 'room'
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, gold: index === 2 || index === 3 ? 1 : 0 }))
liveRoom.run.roomState = {
  kind: 'event', card: { id: 'old_beggar', instanceId: 'browser-beggar', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'Old Beggar', scope: 'player', options: [
    { id: 'give', label: 'Give', description: 'Pay 2 Gold. Remove a card.', effects: [{ tag: 'pay-gold', amount: 2 }, { tag: 'remove-card' }] },
  ] }, decisions: {}, dieRolls: {},
}
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await ann.getByRole('heading', { name: 'Old Beggar' }).waitFor()
const removedUid = liveRoom.run.players[0].deck[0].uid
const deckSize = liveRoom.run.players[0].deck.length
await ann.locator('.event-cards button').first().click()
await ann.getByRole('button', { name: /\[Give\]/ }).click()
await ann.getByRole('button', { name: 'Cancel payment' }).waitFor()
const di = onlinePages[3]
await di.getByRole('heading', { name: 'Old Beggar' }).waitFor()
rooms.dropConnection(create.snapshot.code, onlineSeats[3].token)
await di.locator('.connection--reconnecting').waitFor()
await di.locator('.connection--connected').waitFor()
await di.setViewportSize({ width: 1280, height: 800 })
await di.getByRole('button', { name: /Contribute/ }).waitFor()
const contributorSnapshot = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[3].token } }).then((response) => response.json())
await di.screenshot({ path: join(outDir, 'event-funded-4p-reconnect-compact-desktop.png'), fullPage: true })
await di.getByRole('button', { name: /Contribute/ }).click()
await di.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Contribute') && button.disabled))
const repeatEventPledgeDisabled = await di.getByRole('button', { name: /Contribute/ }).isDisabled()
await cy.reload({ waitUntil: 'networkidle' })
await cy.getByRole('button', { name: /Contribute/ }).click()
await ann.getByText(/choice is locked/i).waitFor()
check('paid Event funding preserves the chooser action without leaking it to contributors', () => {
  assert(repeatEventPledgeDisabled, 'Event repeat contribution could replace an existing payer total')
  assert(!JSON.stringify(contributorSnapshot.eventPledge).includes(removedUid))
  assertEqual(liveRoom.run.players[0].deck.length, deckSize - 1)
  assertEqual(liveRoom.run.players[1].gold, 0)
})
liveRoom.run.phase = 'victory'
liveRoom.run.campaign = { ...liveRoom.run.campaign, finalized: true }
liveRoom.campaignProgress = { ...liveRoom.campaignProgress, unspentMarks: 1 }
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await ann.getByText('Campaign journal').waitFor()
const staleVictoryPanel = await ann.getByRole('heading', { name: /Act .* complete/ }).count()
check('finalized online runs replace the terminal panel with the campaign journal', () => assertEqual(staleVictoryPanel, 0))
await Promise.all(onlineContexts.filter((_, index) => index !== 1).map((context) => context.close()))

const stagedRoom = liveRoom
const stagedPlayerId = onlineSeats[1].playerId
stagedRoom.phase = 'run'
stagedRoom.run = postNeowRun(8810, onlineSeats.map(({ playerId: id, name, character }) => ({ id, name, character })))
stagedRoom.run.phase = 'room'
const stagedPlayer = stagedRoom.run.players.find((player) => player.id === stagedPlayerId)
stagedPlayer.deck.push({ uid: 'locked-inflame', defId: 'inflame', upgraded: false })
const lockedRelicId = stagedPlayer.relics[0].defId
stagedRoom.run.itemDecks.relics = stagedRoom.run.itemDecks.relics.filter((id) => id !== 'anchor')
stagedRoom.run.roomState = {
  kind: 'event', card: { id: 'we_meet_again', instanceId: 'browser-locked-reconnect', act: 2, minAscension: 0, requiresColorlessUnlock: false, name: 'We Meet Again!', scope: 'player', options: [
    { id: 'locked_reward', label: 'Locked reward', description: 'Resolve the locked card, Relic, and recipient.', effects: [{ tag: 'remove-card', filter: 'rare or uncommon' }, { tag: 'lose-relic' }, { tag: 'gain-relic', target: 'one-player' }] },
  ] }, decisions: {}, dieRolls: {}, pendingDecisions: { [stagedPlayerId]: { optionIds: ['locked_reward'], cardUids: ['locked-inflame'], relicIds: [lockedRelicId], targetPlayerId: stagedPlayerId } }, itemOffers: { [stagedPlayerId]: [{ kind: 'relic', id: 'anchor' }] },
}
stagedRoom.version += 1
const stagedPage = bo
await stagedPage.reload({ waitUntil: 'networkidle' })
await stagedPage.getByRole('heading', { name: 'We Meet Again!' }).waitFor()
const lockedCard = stagedPage.getByRole('button', { name: 'Inflame' })
const lockedRelic = stagedPage.locator('fieldset').filter({ hasText: 'Your relic' })
  .locator('button[aria-pressed="true"]')
const lockedTarget = stagedPage.getByLabel('Reward recipient')
const lockedSelectors = {
  cardPressed: await lockedCard.getAttribute('aria-pressed'), cardDisabled: await lockedCard.isDisabled(),
  relic: await lockedRelic.locator('img').getAttribute('src'), relicDisabled: await lockedRelic.isDisabled(),
  target: await lockedTarget.inputValue(), targetDisabled: await lockedTarget.isDisabled(),
}
await stagedPage.locator('.event-stage fieldset').filter({ hasText: 'Anchor' }).getByRole('button', { name: 'Take' }).click()
await stagedPage.getByRole('button', { name: /Resolve rewards/ }).click()
await stagedPage.waitForFunction(() => Boolean(document.querySelector('.event-stage [role="status"]')))
check('Event reconnect restores and resolves the authoritative locked selectors', () => {
  assertEqual(lockedSelectors.cardPressed, 'true')
  assert(lockedSelectors.cardDisabled && lockedSelectors.relicDisabled && lockedSelectors.targetDisabled)
  assertEqual(lockedSelectors.relic, `/assets/relic-icons/${lockedRelicId}.png`)
  assertEqual(lockedSelectors.target, stagedPlayerId)
  const resolvedPlayer = stagedRoom.run.players.find((player) => player.id === stagedPlayerId)
  assert(!resolvedPlayer.deck.some((card) => card.uid === 'locked-inflame'))
  assert(resolvedPlayer.relics.some((relic) => relic.defId === 'anchor'))
})
await onlineContexts[1].close()

await page.setViewportSize({ width: 1100, height: 760 })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[0][0]
  run.roomState = { kind: 'event', card: { id: 'secret_portal', instanceId: 'browser-portal', act: 3, minAscension: 0, requiresColorlessUnlock: false, name: 'Secret Portal', scope: 'party', options: [{ id: 'enter', label: 'Enter the Portal', description: 'Immediately move up to any room, ignoring paths.', effects: [{ tag: 'move', target: 'party', filter: 'any higher room' }] }] }, decisions: {}, dieRolls: {} }
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Secret Portal' }).waitFor()
const forward = page.getByLabel('Forward room')
assert((await forward.locator('option').count()) > 1, 'Secret Portal did not list higher rooms')
const targetlessPortalDisabled = await page.getByRole('button', { name: /Enter the Portal/ }).isDisabled()
await forward.selectOption({ index: 1 })
const destination = await forward.inputValue()
await page.getByRole('button', { name: /Enter the Portal/ }).click()
await page.waitForFunction((roomId) => window.__STS_DEBUG__.getRun().map.position === roomId, destination)
const internalIdInputs = await page.locator('input[placeholder="Room id"]').count()
check('Secret Portal exposes and enters labeled higher rooms without internal IDs', () => {
  assert(targetlessPortalDisabled, 'Secret Portal enabled before a destination was chosen')
  assertEqual(internalIdInputs, 0)
})

await page.evaluate(() => localStorage.setItem('sts-physical-campaign', JSON.stringify({
  version: 1,
  characters: { ironclad: 0, silent: 0, defect: 0, watcher: 0 },
  colorless: 2,
  actIV: 0,
  unspentMarks: 1,
  highestAscension: 0,
  nextRunNumber: 1,
  finishedRunIds: ['browser-finished-run'],
})))
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByText('Campaign journal').waitFor()
await page.locator('details.game-settings > summary').click()
await page.getByRole('button', { name: 'New run' }).click()
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByText('Campaign journal').waitFor()
await page.screenshot({ path: join(outDir, 'campaign-allocation.png'), fullPage: true })
const campaignAllocationContained = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
const pendingCampaign = await page.evaluate(() => ({ saved: JSON.parse(localStorage.getItem('sts-physical-campaign')), runId: window.__STS_DEBUG__.getRun().campaign.runId }))
const mapHiddenUntilAllocation = await page.locator('.map').count()
await page.getByRole('button', { name: /Mark Colorless/ }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-physical-campaign')).unspentMarks === 0)
const resumedCampaign = await page.evaluate(() => JSON.parse(localStorage.getItem('sts-physical-campaign')))
const unlockedColorlessCount = await page.evaluate(() => window.__STS_DEBUG__.getRun().itemDecks.colorless.length)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const boss = Object.values(run.map.rooms).find((room) => room.kind === 'boss')
  run.act = 2
  run.phase = 'victory'
  run.map.position = boss.id
  run.map.rooms[boss.id].visited = true
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Climb to Act 3' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().act === 3)
const unlockedCampaignRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
check('local reload resumes pending campaign allocation before exposing a new run', () => {
  assertEqual(mapHiddenUntilAllocation, 0)
  assertEqual(pendingCampaign.saved.nextRunNumber, 1)
  assertEqual(pendingCampaign.runId, 'campaign-2')
  assertEqual(resumedCampaign.unspentMarks, 0)
  assertEqual(resumedCampaign.colorless, 3)
  assertEqual(resumedCampaign.nextRunNumber, 2)
  assertEqual(unlockedCampaignRun.campaign.runId, 'campaign-2')
  assertEqual(unlockedColorlessCount, 22)
  assert(unlockedCampaignRun.eventDeck.some((card) => card.id === 'sensory_stone'))
  assert(campaignAllocationContained, 'campaign allocation overflowed its viewport')
})

await page.evaluate(() => localStorage.setItem('sts-physical-campaign', JSON.stringify({
  version: 1,
  characters: { ironclad: 0, silent: 0, defect: 0, watcher: 0 },
  colorless: 0,
  actIV: 4,
  unspentMarks: 1,
  highestAscension: 0,
  nextRunNumber: 1,
  finishedRunIds: ['browser-act-iv-run'],
})))
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: /Mark Act IV/ }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
await page.screenshot({ path: join(outDir, 'campaign-act-iv-map.png'), fullPage: true })
const actIVMapContained = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
const actIVRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
check('local reload rebuilds the pending run when Act IV unlocks', () => {
  assertEqual(actIVRun.campaignProgress.actIV, 5)
  assert(Object.values(actIVRun.map.rooms).some((room) => room.burning), 'Act IV unlock did not add a Burning Elite')
  assert(actIVMapContained, 'Act IV campaign map overflowed its viewport')
})

writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ failures }, null, 2))
check('non-combat surfaces reported no browser errors', () => assertEqual(failures.length, 0, failures.join('\n')))
await browser.close()
await server.close()
await rooms.close()
report('non-combat browser')
