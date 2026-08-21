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
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Seat').selectOption(option)
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /Back/ }).click()
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

async function openMerchantShop(target = page) {
  const enter = target.getByRole('button', { name: 'Enter merchant shop' })
  if (await enter.count()) await enter.click()
  await target.getByLabel('Shopping for').waitFor()
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
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Run settings' }).click()
const localMeta = page.locator('.start-menu__meta')
await localMeta.locator('summary').click()
await localMeta.getByLabel('Run mode').selectOption('daily')
await page.waitForFunction(() => document.querySelectorAll('.start-menu__daily li').length === 2)
const localDailyModifierCount = await page.locator('.start-menu__daily li').count()
const localDailyModifierNames = await page.locator('.start-menu__daily strong').allTextContents()
await localMeta.locator('summary').click()
await page.getByRole('button', { name: 'Close' }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
const localDailyRunIds = await page.evaluate(() => window.__STS_DEBUG__.getRun().meta.modifierIds)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__)
await page.setViewportSize({ width: 1280, height: 720 })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Run settings' }).click()
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
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
const localMetaRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
await page.getByRole('button', { name: 'Settings' }).click()
const localModifierSummary = page.locator('.run-modifiers > summary')
await localModifierSummary.waitFor()
const localModifierSummaryText = await localModifierSummary.textContent()
await localModifierSummary.click()
const visibleNightTerrors = await page.getByText(/Night Terrors/).count()
await page.setViewportSize({ width: 1100, height: 760 })
await page.screenshot({ path: join(outDir, 'meta-custom-run.png'), fullPage: true })
await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /Back/ }).click()
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
await page.getByRole('button', { name: 'Embark' }).click()
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
await page.getByRole('heading', { name: 'The Merchant' }).waitFor()
await page.locator('.merchant-arrival__party img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())))
const arrivalCharacters = await page.locator('.merchant-arrival__party img').count()
const arrivalCharacterNames = await page.locator('.merchant-arrival__party figcaption').count()
const arrivalMerchant = await page.getByRole('button', { name: 'Enter merchant shop' }).count()
const arrivalBrowseButton = await page.getByText('Browse wares').count()
const arrivalLayout = await page.locator('.merchant-arrival').evaluate((stage) => {
  const feet = [...stage.querySelectorAll('.merchant-arrival__party img')].map((image) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data
    let opaqueBottom = canvas.height
    outer: for (let y = canvas.height - 1; y >= 0; y -= 1) {
      for (let x = 0; x < canvas.width; x += 1) if (alpha[(y * canvas.width + x) * 4 + 3] >= 16) {
        opaqueBottom = y + 1
        break outer
      }
    }
    const box = image.getBoundingClientRect()
    return box.top + opaqueBottom / canvas.height * box.height
  })
  return {
    feetOffset: Math.max(...feet) - Math.min(...feet),
    // How far the drawn feet sit from the party box's bottom edge, which the viewport
    // sweep treats as the floor line.
    feetOffBoxBottom: Math.abs(Math.max(...feet)
      - stage.querySelector('.merchant-arrival__party').getBoundingClientRect().bottom),
  }
})
await page.screenshot({ path: join(outDir, 'merchant-arrival-4p-desktop.png'), fullPage: true })

/* The carpets, as fractions of each backdrop, plus the card-free slice of the green
   one the Merchant has to sit in. Both actors are placed in this same art space, so
   every viewport has to land them inside these boxes — that is the whole point of the
   projected scene. `background-wide.webp` frames the room wider, hence its own boxes. */
const CARPETS = {
  'background.webp': { rug: [0.12, 0.495, 0.57, 0.88], seat: [0.63, 0.79, 0.60, 0.79] },
  'background-wide.webp': { rug: [0.335, 0.54, 0.555, 0.73], seat: [0.62, 0.735, 0.58, 0.72] },
}
/** Transparent margins of merchant-seated.webp, so the seat check reads the drawn Merchant. */
const SEATED_INSET = { left: 0.1394, right: 0.0329, bottom: 0.0407 }
async function readArrivalAnchors() {
  return page.locator('.merchant-arrival').evaluate((stage) => {
    const frame = stage.getBoundingClientRect()
    const scene = stage.querySelector('.merchant-arrival__scene')
    const box = scene.getBoundingClientRect()
    const art = /([^/]+\.webp)/.exec(getComputedStyle(scene).backgroundImage)?.[1]
    // Sideways, the stage can itself escape the window, so measure against both; the
    // page scrolls vertically, so down the stage is the only frame that clips.
    const visible = (rect) => rect.left >= Math.max(frame.left, 0) - 1
      && rect.right <= Math.min(frame.right, innerWidth) + 1
      && rect.top >= frame.top - 1 && rect.bottom <= frame.bottom + 1
    const inArtSpace = (element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: (rect.left - box.left) / box.width,
        right: (rect.right - box.left) / box.width,
        top: (rect.top - box.top) / box.height,
        bottom: (rect.bottom - box.top) / box.height,
        onScreen: visible(rect),
        scale: rect.width / innerWidth,
      }
    }
    const seat = stage.querySelector('.merchant-arrival__merchant')
    const seatBox = seat.getBoundingClientRect()
    // The lower body is where the Proceed button, parked bottom right, tends to land.
    const seatHits = [0.5, 0.75, 0.95].map((depth) => {
      const hit = document.elementFromPoint(seatBox.left + seatBox.width / 2, seatBox.top + seatBox.height * depth)
      return seat.contains(hit)
    })
    // Each sprite is pushed down by its own transparent gap, which lands the drawn feet
    // on the party box's own bottom edge — so that edge is the floor line.
    const feetLine = stage.querySelector('.merchant-arrival__party').getBoundingClientRect().bottom
    const proceed = stage.querySelector('.room-proceed')?.getBoundingClientRect()
    const title = stage.querySelector('.merchant-arrival__title')?.getBoundingClientRect()
    const titleOverlap = title ? [...stage.querySelectorAll('.merchant-arrival__party img')].reduce((largest, image) => {
      const actor = image.getBoundingClientRect()
      return Math.max(largest, Math.max(0, Math.min(title.right, actor.right) - Math.max(title.left, actor.left))
        * Math.max(0, Math.min(title.bottom, actor.bottom) - Math.max(title.top, actor.top)))
    }, 0) : Infinity
    return {
      art,
      party: inArtSpace(stage.querySelector('.merchant-arrival__party')),
      merchant: inArtSpace(seat),
      feetLine: (feetLine - box.top) / box.height,
      seatReachable: seatHits.every(Boolean),
      backdropCoversFrame: box.left <= Math.max(frame.left, 0) + 0.5
        && box.right >= Math.min(frame.right, innerWidth) - 0.5,
      // The scene overflows the stage on purpose; the stage must clip it, not scroll it,
      // or focus moving into the shop and back would leave the room permanently offset.
      scrollable: (() => {
        stage.scrollTop = 64
        stage.scrollLeft = 64
        const scrolled = stage.scrollTop !== 0 || stage.scrollLeft !== 0
        stage.scrollTop = 0
        stage.scrollLeft = 0
        return scrolled
      })(),
      titleOverlap,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      proceedVisible: Boolean(proceed && visible(proceed)),
    }
  })
}
const arrivalAnchors = []
for (const size of [
  { width: 3440, height: 1440 }, { width: 2560, height: 1440 }, { width: 1920, height: 1080 },
  { width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1000, height: 900 },
  { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 667, height: 375 },
]) {
  await page.setViewportSize(size)
  arrivalAnchors.push({ ...size, ...await readArrivalAnchors() })
  await page.screenshot({ path: join(outDir, `merchant-arrival-4p-${size.width}x${size.height}.png`), fullPage: true })
}
await page.setViewportSize({ width: 1440, height: 900 })
check('Merchant map entry opens the arrival scene with the whole party', () => {
  assertEqual(arrivalCharacters, 4)
  assertEqual(arrivalCharacterNames, 0, 'character names still appear below the standing assets')
  assertEqual(arrivalMerchant, 1)
  assertEqual(arrivalBrowseButton, 0, 'the redundant Browse wares control is still visible')
  assert(arrivalLayout.feetOffset < 2, `the heroes' feet differ by ${arrivalLayout.feetOffset}px`)
  assert(arrivalLayout.feetOffBoxBottom < 2,
    `the drawn feet sit ${arrivalLayout.feetOffBoxBottom}px off the party box's floor line`)
  for (const sample of arrivalAnchors) {
    const where = `${sample.width}×${sample.height}`
    const carpets = CARPETS[sample.art]
    assert(carpets, `the Merchant arrival uses an unknown backdrop (${sample.art}) at ${where}`)
    assert(sample.width >= 1401 ? sample.art === 'background-wide.webp' : sample.art === 'background.webp',
      `the Merchant arrival uses ${sample.art} at ${where}`)
    const [rugLeft, rugRight, rugTop, rugBottom] = carpets.rug
    assert(sample.party.left >= rugLeft && sample.party.right <= rugRight,
      `the party stands off the circular carpet at ${where} (${sample.party.left.toFixed(3)}–${sample.party.right.toFixed(3)})`)
    assert(sample.feetLine >= rugTop && sample.feetLine <= rugBottom,
      `the heroes' feet miss the circular carpet at ${where} (${sample.feetLine.toFixed(3)})`)
    const [seatLeft, seatRight, seatFloorTop, seatFloorBottom] = carpets.seat
    const seatWidth = sample.merchant.right - sample.merchant.left
    const drawnLeft = sample.merchant.left + seatWidth * SEATED_INSET.left
    const drawnRight = sample.merchant.right - seatWidth * SEATED_INSET.right
    const drawnBottom = sample.merchant.bottom
      - (sample.merchant.bottom - sample.merchant.top) * SEATED_INSET.bottom
    assert(drawnLeft >= seatLeft && drawnRight <= seatRight,
      `the seated Merchant leaves the clear strip of the green carpet at ${where} (${drawnLeft.toFixed(3)}–${drawnRight.toFixed(3)})`)
    assert(drawnBottom >= seatFloorTop && drawnBottom <= seatFloorBottom,
      `the seated Merchant sits off the green carpet at ${where} (${drawnBottom.toFixed(3)})`)
    assert(sample.merchant.scale < 0.22,
      `the seated Merchant fills ${(sample.merchant.scale * 100).toFixed(0)}% of the window at ${where}`)
    assert(sample.party.onScreen && sample.merchant.onScreen, `the Merchant arrival crops an actor at ${where}`)
    assert(sample.seatReachable, `a control covers the seated Merchant at ${where}, so tapping him misfires`)
    assert(!sample.scrollable, `the Merchant arrival scrolls its own backdrop at ${where}`)
    assert(sample.backdropCoversFrame, `the Merchant backdrop leaves a visible side gap at ${where}`)
    assert(sample.titleOverlap <= 1, `the Merchant title overlaps the party by ${sample.titleOverlap}px² at ${where}`)
    assert(!sample.overflow && sample.proceedVisible, `the Merchant arrival is clipped at ${where}`)
  }
})
await openMerchantShop()
await page.getByLabel('Shopping for').selectOption('p1')
await page.getByRole('heading', { name: 'The Merchant' }).waitFor()
await page.screenshot({ path: join(outDir, 'merchant-4p-desktop.png'), fullPage: true })
await page.setViewportSize({ width: 1280, height: 720 })
const merchant720 = await page.locator('.merchant-shop-stage').evaluate((stage) => {
  const box = stage.getBoundingClientRect()
  const leave = stage.querySelector('.room-proceed')?.getBoundingClientRect()
  return { bottom: box.bottom, viewport: innerHeight, leaveBottom: leave?.bottom ?? Infinity }
})
await page.screenshot({ path: join(outDir, 'merchant-4p-1280x720.png'), fullPage: true })
await page.setViewportSize({ width: 1024, height: 600 })
const merchant600 = await page.locator('.merchant-shop-stage').evaluate((stage) => {
  const stageBox = stage.getBoundingClientRect()
  const shelfItems = [...stage.querySelectorAll('.merchant-shelf .merchant-item > :is(.item-icon-image, .room-item-icon)')]
  const card = stage.querySelector('.merchant-card .card')?.getBoundingClientRect()
  const prices = [...stage.querySelectorAll('.merchant-shelf .room-price')].map((price) => price.getBoundingClientRect())
  const widths = shelfItems.map((item) => item.getBoundingClientRect().width)
  return {
    iconCount: shelfItems.length,
    stageBottom: stageBox.bottom,
    viewport: innerHeight,
    itemWidth: Math.min(...widths),
    iconSpread: Math.max(...widths) - Math.min(...widths),
    cardWidth: card?.width ?? 0,
    iconsSmallerThanCards: card ? Math.min(...widths) < card.width : false,
    // Scrolled to the end, the last price must be on screen. A four-seat shop at
    // 600px tall does not fit at a readable card size, so the guarantee HERE is
    // reachability rather than "never scrolls"; the desktop shop cases in the
    // sweep below are the ones that assert no scroll at all.
    lastPriceBelow: (() => {
      const before = stage.scrollTop
      stage.scrollTop = stage.scrollHeight
      const last = [...stage.querySelectorAll('.merchant-shelf--potions .room-price')].at(-1)?.getBoundingClientRect()
      const below = last ? Math.round(last.bottom - stage.getBoundingClientRect().bottom) : 0
      stage.scrollTop = before
      return below
    })(),
  }
})
await page.mouse.move(0, 0)
await page.screenshot({ path: join(outDir, 'merchant-4p-1024x600.png'), fullPage: true })
await page.setViewportSize({ width: 390, height: 844 })
const merchant390 = await page.locator('.merchant-stage').evaluate((stage) => {
  const shelfItem = stage.querySelector('.merchant-shelf .merchant-item > .item-icon-image')?.getBoundingClientRect()
  const mobileCard = stage.querySelector('.merchant-card .card')?.getBoundingClientRect()
  const board = stage.querySelector('.merchant-board')?.getBoundingClientRect()
  const removal = stage.querySelector('.merchant-removal')?.getBoundingClientRect()
  const detail = stage.querySelector('.merchant-shelf .room-item-text')
  return {
    itemWidth: shelfItem?.width ?? 0,
    iconsSmallerThanCards: Boolean(shelfItem && mobileCard && shelfItem.width < mobileCard.width),
    removalRatio: board && removal ? removal.width / board.width : 0,
    detailVisible: detail ? getComputedStyle(detail).position === 'static' && detail.getBoundingClientRect().height > 0 : false,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }
})
await page.screenshot({ path: join(outDir, 'merchant-4p-390x844.png'), fullPage: true })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0] = { ...run.players[0], gold: 12 }
  debug.setRun(run)
})
await page.setViewportSize({ width: 390, height: 600 })
const mobilePotion = page.locator('[data-merchant-target="potion-2"]')
await mobilePotion.scrollIntoViewIfNeeded()
await mobilePotion.click()
const mobileMerchantHand = await page.locator('.merchant-hand').evaluate((hand) => {
  const stage = hand.closest('.merchant-shop-stage')
  const target = stage?.querySelector('[data-merchant-target="potion-2"]')
  if (!stage || !target) return null
  const frame = stage.getBoundingClientRect()
  const item = target.getBoundingClientRect()
  const expectedY = item.top - frame.top + stage.scrollTop + item.height * 0.55
  return {
    position: getComputedStyle(hand).position,
    yError: Math.abs(Number.parseFloat(hand.style.getPropertyValue('--merchant-point-y')) - expectedY),
    scrolled: scrollY > 0 || stage.scrollTop > 0,
  }
})
await page.screenshot({ path: join(outDir, 'merchant-purchase-hand-mobile.png') })
await page.setViewportSize({ width: 1440, height: 900 })

// A real pointerless context, not just a narrow window: Playwright reports
// `hover: hover` at any viewport size, so a width-only pass never exercises the
// `(hover: none)` branch. Two viewports, because they catch different things —
// the tall one has room to spare and proves the prose prints and the tip hides;
// the SHORT one with a potion belt is where the prose-bearing tiles actually
// overflowed the stage and spilled text into the neighbouring track.
async function measureTouchShelf(width, height, holdsPotion) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true })
  // Audited like every other page here: these contexts take screenshots too, and
  // unwrapped they would not fail on a shelf icon that never loaded.
  const page = installScreenAudit(await context.newPage())
  try {
    page.setDefaultTimeout(120_000)
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow', undefined, { timeout: 120_000 })
    await page.evaluate((belt) => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.phase = 'room'
      run.neow = null
      run.players = run.players.map((player) => ({ ...player, gold: 40, potions: belt ? ['fire_potion'] : [] }))
      // A Sold slot beside a stocked one, and a Colorless pile. This is the
      // context where the shelf's tracks are WIDER than the icon module — the
      // tiles carry prose here — so it is the only place a percentage-sized icon
      // or Sold glyph diverges from a module-sized one. A fully stocked fixture
      // rendered no `.room-item-icon` at all and left that rule unmeasured.
      run.roomState = { kind: 'merchant', relics: ['anchor', '', 'akabeko'],
        potions: ['fire_potion', '', 'blood_potion'],
        colorless: ['dramatic_entrance', 'apotheosis', 'finesse'],
        cards: Object.fromEntries(run.players.map((player) => [player.id,
          { choices: ['twin_strike', 'second_wind', 'limit_break'], cardsDrawn: [], raresDrawn: [] }])),
        removalUsed: [], purchasedCards: {} }
      window.__STS_DEBUG__.setRun(run)
    }, holdsPotion)
    await openMerchantShop(page)
    await page.locator('.merchant-shelf--relics .merchant-item').first().waitFor({ timeout: 120_000 })
    const shape = await page.locator('.merchant-shelf--relics .merchant-item').first().evaluate((tile) => {
      const name = tile.querySelector('strong')
      const rules = tile.querySelector('.room-item-text')
      return {
        coarse: matchMedia('(hover: none)').matches,
        nameVisible: Boolean(name) && getComputedStyle(name).position === 'static' && name.getBoundingClientRect().height > 0,
        rulesVisible: Boolean(rules) && getComputedStyle(rules).position === 'static' && rules.getBoundingClientRect().height > 0,
        rulesText: rules?.textContent?.trim() ?? '',
      }
    })
    // Tabbed to, not `.focus()`ed: `:focus-visible` is the only state a
    // pointerless device can use to trigger the tip's reveal rule, and a
    // programmatic focus never matches it.
    for (let tab = 0; tab < 60; tab += 1) {
      if (await page.evaluate(() => document.activeElement
        ?.closest('.merchant-shelf--relics .merchant-item') !== null)) break
      await page.keyboard.press('Tab')
    }
    const focused = await page.evaluate(() => {
      const tile = document.activeElement?.closest('.merchant-shelf--relics .merchant-item')
      if (!tile) return { focusVisible: false, tipHidden: false }
      const tip = tile.querySelector('.merchant-tooltip')
      return {
        focusVisible: tile.matches(':focus-visible'),
        tipHidden: !tip || getComputedStyle(tip).display === 'none',
      }
    })
    const stage = await page.locator('.merchant-stage').evaluate((element) => ({
      overflow: Math.round(element.scrollHeight - element.clientHeight),
      // "Prices below the fold" measured directly, because the container's own
      // scroll height does not say WHICH content is lost — the stage may scroll
      // for reasons that have nothing to do with the prices. How far the LAST
      // potion price sits past the stage's bottom edge is the thing that actually
      // went wrong. The pointerless module's own floors are asserted separately,
      // by `smallestIcon` and `smallestCardFace` below.
      // Reachability, not "does it scroll". Past a point the stock genuinely
      // exceeds a 600px window, and the choice is a scroll or cards too small to
      // read — the defect to prevent is stock a player cannot GET to. So the rug
      // is scrolled to its end and the last potion price must then be on screen.
      lastPriceBelow: (() => {
        const before = element.scrollTop
        element.scrollTop = element.scrollHeight
        const prices = [...document.querySelectorAll('.merchant-shelf--potions .room-price')]
        const last = prices.at(-1)?.getBoundingClientRect()
        const below = last ? Math.round(last.bottom - element.getBoundingClientRect().bottom) : 0
        element.scrollTop = before
        return below
      })(),
      smallestIcon: Math.round(Math.min(...[...document.querySelectorAll(
        '.merchant-shelf .merchant-item > :is(.item-icon-image, .room-item-icon)')]
        .map((icon) => icon.getBoundingClientRect().width), Infinity)),
      soldGlyphs: document.querySelectorAll('.merchant-shelf .merchant-item > .room-item-icon').length,
      // `order` puts each tile's price back under its art. Without it a tile
      // carrying more prose — or a Sold slot carrying none — pushes its own price
      // down and the shelf's prices stop sharing a baseline.
      priceSpread: ['relics', 'potions'].reduce((worst, shelf) => {
        const tops = [...document.querySelectorAll(`.merchant-shelf--${shelf} .room-price`)]
          .map((price) => Math.round(price.getBoundingClientRect().top))
        return tops.length ? Math.max(worst, Math.max(...tops) - Math.min(...tops)) : worst
      }, 0),
      // The prose-carrying tracks must stay equal within a shelf AND between the
      // two shelves, which share one grid column. Sized to their own content they
      // came out 111/99/182 against 57/55/57 and nothing lined up.
      tileSpread: (() => {
        const widths = ['relics', 'potions'].map((shelf) =>
          [...document.querySelectorAll(`.merchant-shelf--${shelf} .merchant-item`)]
            .map((tile) => tile.getBoundingClientRect().width))
        const all = widths.flat()
        return all.length ? Math.round(Math.max(...all) - Math.min(...all)) : 0
      })(),
      // Each group's heading must start where its own first item starts. On wide
      // prose-carrying tracks the art centres itself, which left the shelf
      // headings hanging some 60px left of the stock they label.
      headingOffset: [...document.querySelectorAll('.merchant-shelf, .merchant-cards')].reduce((worst, group) => {
        const heading = group.querySelector('h3')?.getBoundingClientRect()
        const art = group.querySelector('.item-icon-image, .room-item-icon, .card')?.getBoundingClientRect()
        return heading && art ? Math.max(worst, Math.round(Math.abs(art.left - heading.left))) : worst
      }, 0),
      // Art and Sold glyphs measured together: on these wide tracks a glyph sized
      // in percent takes the TRACK's width, not the module's, and its price then
      // floats away from the prices beside it.
      iconSpread: (() => {
        const widths = [...document.querySelectorAll(
          '.merchant-shelf .merchant-item > :is(.item-icon-image, .room-item-icon)')]
          .map((icon) => icon.getBoundingClientRect().width)
        return widths.length ? Math.round(Math.max(...widths) - Math.min(...widths)) : -1
      })(),
      smallestCardFace: Math.round(Math.min(...[...document.querySelectorAll('.merchant-cards .card')]
        .map((face) => face.getBoundingClientRect().width), Infinity)),
      // Printed text must stay inside its own track; an icon-width track let the
      // first tile's rules spill into its neighbour.
      spill: [...document.querySelectorAll('.merchant-shelf .merchant-item')].reduce((worst, tile) => {
        const box = tile.getBoundingClientRect()
        return [...tile.querySelectorAll('.room-item-text, .room-price, strong')].reduce((inner, kid) => {
          const rect = kid.getBoundingClientRect()
          return rect.width > 0
            ? Math.max(inner, Math.round(rect.right - box.right), Math.round(box.left - rect.left))
            : inner
        }, worst)
      }, 0),
    }))
    await page.screenshot({ path: join(outDir, `merchant-touch-${width}x${height}.png`), fullPage: true })
    return { ...shape, ...focused, ...stage }
  } finally {
    await context.close()
  }
}

const touchShelf = await measureTouchShelf(800, 1180, false)
// Short, and holding a potion: the belt takes height from the stage exactly
// where the prose-bearing tiles need it.
const touchShelfShort = await measureTouchShelf(1024, 600, true)

// A sweep, because the shop's failures were never at ONE viewport in ONE state.
// Each of these combinations hid a real bug from every check above: the potion
// belt takes a band out of the stage, the Colorless pile adds the tallest row,
// and a short window is where the rug ran out of room and started painting over
// the Leave banner — burying the potion prices and stopping three tiles taking
// clicks, all while the stage reported no overflow at all.
// Booting a run costs a navigation, two clicks and a wait, so only the cases that
// genuinely need a different CONTEXT get one — `hasTouch`/`isMobile` cannot be
// changed on a live context, while a viewport can. The pointer cases therefore
// share one page and just resize, which is five fewer boots in a suite whose
// browser lane runs two at a time.
async function openRun(context) {
  const page = installScreenAudit(await context.newPage())
  page.setDefaultTimeout(120_000)
  page.setDefaultNavigationTimeout(120_000)
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow', undefined, { timeout: 120_000 })
  return page
}

async function stockShop(page, { belt, colorless, broke }) {
  await page.evaluate(({ holdsPotion, stocksColorless, isBroke }) => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'room'
    run.neow = null
    // `isBroke` matters: a disabled tile's tint out-specifies the sale colour, so
    // an unaffordable discount lost the only marker it has.
    run.players = run.players.map((player) => ({ ...player, gold: isBroke ? 0 : 40, potions: holdsPotion ? ['fire_potion'] : [] }))
    // A real run's log, not a fresh one's: the open panel grows with the run, and
    // with three entries it covered nothing, so its size caps went unmeasured.
    run.log = Array.from({ length: 30 }, (_, index) => `The party does something noteworthy, entry ${index + 1}.`)
    // FULLY stocked, deliberately. A Sold slot prints no rules line, so a
    // fixture with two of them makes the rug shorter than a real shop's and hid
    // the overflow these cases exist to catch. The Sold-slot rendering is
    // measured by the pointerless shelf pass instead.
    run.roomState = { kind: 'merchant', relics: ['anchor', 'happy_flower', 'akabeko'],
      potions: ['fire_potion', 'swift_potion', 'blood_potion'],
      // One Colorless slot SOLD, so every case renders a Sold plate beside two card
      // faces. The plates only overlap once the module reaches its ceiling, and a
      // fully stocked pile never drew one for the sweep to measure.
      colorless: stocksColorless ? ['dramatic_entrance', '', 'finesse'] : [],
      cards: Object.fromEntries(run.players.map((player) => [player.id,
        { choices: ['twin_strike', 'second_wind', 'limit_break'], cardsDrawn: [], raresDrawn: [] }])),
      removalUsed: [], purchasedCards: {} }
    window.__STS_DEBUG__.setRun(run)
  }, { holdsPotion: belt, stocksColorless: colorless, isBroke: Boolean(broke) })
  await openMerchantShop(page)
  await page.locator('.merchant-shelf--relics .merchant-item').first().waitFor({ timeout: 120_000 })
}

function measureRug() {
  const stage = document.querySelector('.merchant-stage')
  const board = document.querySelector('.merchant-board')
  // Every control and price must be the topmost thing at its own centre where
  // it SITS — scrolled just into view, not hunted for a position that happens
  // to free it. Nothing here floats over the rug, so anything covering it is
  // the rug covering itself, and a player has no reason to think a tile that
  // does nothing would start working after a scroll.
  const topmost = (selector) => [...board.querySelectorAll(selector)].filter((element) => {
    const first = element.getBoundingClientRect()
    if (first.width < 4 || first.height < 4) return false
    element.scrollIntoView({ block: 'nearest' })
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return !(hit && (hit === element || element.contains(hit) || hit.contains(element)))
  }).length
  const buriedControls = topmost('button')
  const buriedPrices = topmost('.room-price')
  const buriedCards = topmost('.card')
  const leave = document.querySelector('.merchant-stage > .room-proceed')
  leave.scrollIntoView({ block: 'nearest' })
  const leaveBox = leave.getBoundingClientRect()
  const leaveOwns = [0.1, 0.5, 0.9].every((across) => {
    const hit = document.elementFromPoint(leaveBox.left + leaveBox.width * across, leaveBox.top + leaveBox.height / 2)
    return Boolean(hit && (hit === leave || leave.contains(hit)))
  })
  // The rug must not reach into the Leave banner's own row. When the rug's row
  // could be squeezed below its content the rug simply overflowed it and
  // painted into that band — the banner then covered the stock underneath,
  // and because the banner still owned its own pixels every hit-test on the
  // banner passed while the prices behind it were unreadable.
  const rugIntoLeave = Math.round(board.getBoundingClientRect().bottom - leaveBox.top)
  stage.scrollTop = stage.scrollHeight
  const lastPrice = [...board.querySelectorAll('.merchant-shelf--potions .room-price')].at(-1)?.getBoundingClientRect()
  const lastPriceBelow = lastPrice ? Math.round(lastPrice.bottom - stage.getBoundingClientRect().bottom) : 0
  // Scrolled to the end, the way out must be fully on screen. If the stage
  // ever clipped instead of scrolling, this is the control that got cut off.
  const scrolledLeave = leave.getBoundingClientRect()
  const stageEnd = stage.getBoundingClientRect()
  const leaveReachable = scrolledLeave.bottom <= stageEnd.bottom + 1 && scrolledLeave.top >= stageEnd.top - 1
  stage.scrollTop = 0
  const boardBox = board.getBoundingClientRect()
  const clipped = [...board.querySelectorAll('.card, .merchant-card__sold, .item-icon-image, .room-item-icon, .room-price')]
    .reduce((worst, element) => {
      const box = element.getBoundingClientRect()
      return box.width > 2
        ? Math.max(worst, Math.round(box.right - boardBox.right), Math.round(boardBox.left - box.left))
        : worst
    }, 0)
  // When there IS more rug than window, the player must be able to scroll it.
  // `overflow: hidden` still moves under `scrollTop`, so measuring a scroll
  // says nothing — only the property does. `clip` and `hidden` both leave the
  // stock below the fold with no wheel, no drag and no scrollbar.
  // The two stock rows share a grid column, so their tiles must share a width —
  // at every width, not just the pointerless desktop one. Sized to their own
  // content the relic tiles came out 99px against the potions' 56px on a phone.
  const shelfTileSpread = (() => {
    const widths = ['relics', 'potions'].flatMap((shelf) =>
      [...board.querySelectorAll(`.merchant-shelf--${shelf} .merchant-item`)]
        .map((tile) => tile.getBoundingClientRect().width))
    return widths.length ? Math.round(Math.max(...widths) - Math.min(...widths)) : 0
  })()
  // A card on the rug exists to be read. The shared card face caps its rules text
  // at 0.49rem whatever the card's width, so a wider card bought a bigger picture
  // and type that was still under 7px; the shop overrides that ramp, and the
  // override is worth nothing if the taller text then clips.
  const cardRules = [...board.querySelectorAll('.merchant-cards .card-face__rules')]
  const cardRulesFont = cardRules.length ? parseFloat(getComputedStyle(cardRules[0]).fontSize) : 0
  const cardRulesClipped = cardRules.filter((panel) => panel.scrollHeight > panel.clientHeight + 1).length
  const cardFaceWidth = Math.round(board.querySelector('.merchant-cards .card')?.getBoundingClientRect().width ?? 0)
  // Both card rows draw at ONE size. The rug's three `auto` columns want more than
  // a capped board can give, so the Colorless pile — which lives in one column —
  // used to collapse to its zero minimum and render a quarter smaller than the
  // character row, which escapes by spanning all three.
  const colorlessCardWidth = Math.round(
    board.querySelector('.merchant-cards--colorless .card')?.getBoundingClientRect().width ?? 0)
  // The discounted slot's only visual marker is its price colour, now that the
  // chip that used to sit on the art is gone. Compared against a full-price
  // sibling, because "is it blue" is not a thing a test should hard-code.
  const salePrice = board.querySelector('.merchant-shelf--relics .room-price--sale')
  const plainPrice = [...board.querySelectorAll('.merchant-shelf--relics .room-price')]
    .find((price) => !price.classList.contains('room-price--sale'))
  const saleMark = salePrice?.querySelector('.room-price__sale-mark')
  const discountMarked = Boolean(salePrice) && Boolean(plainPrice) && Boolean(saleMark)
    && saleMark.getBoundingClientRect().width > 0
    && getComputedStyle(salePrice).color !== getComputedStyle(plainPrice).color
  // Pairwise overlap, in the SWEEP and not only in the single 1440x900 fixture:
  // the Sold plates only overlap once the module reaches its clamp ceiling, which
  // is the one place the narrow fixture never looked.
  const overlapBoxes = [...board.querySelectorAll(
    'h3, .room-price, .card, .merchant-card__sold, .item-icon-image, .room-item-icon')]
    .map((element) => ({ element, box: element.getBoundingClientRect() }))
    .filter((entry) => entry.box.width > 2 && entry.box.height > 2)
  const overlapPairs = []
  for (let i = 0; i < overlapBoxes.length; i += 1) for (let j = i + 1; j < overlapBoxes.length; j += 1) {
    const a = overlapBoxes[i], b = overlapBoxes[j]
    if (a.element.contains(b.element) || b.element.contains(a.element)) continue
    if (!(a.box.right <= b.box.left + 1 || b.box.right <= a.box.left + 1
      || a.box.bottom <= b.box.top + 1 || b.box.bottom <= a.box.top + 1)) {
      overlapPairs.push(`${(a.element.className || a.element.tagName).toString().split(' ')[0]}/${(b.element.className || b.element.tagName).toString().split(' ')[0]}`)
    }
  }
  // On a phone the stage takes every pixel below the header, less the belt's band.
  // The desktop belt height carries the same specificity and sits later in the
  // file, so unscoped it silently stole 42px of stage from a phone holding a potion.
  // With the log's panel OPEN. No fixture had ever opened it, so its size caps and
  // its dock could both be deleted with every check green — and an open panel is a
  // normal state, not an edge case. Measured over the whole STAGE, since the panel
  // can reach the Leave banner as well as the rug.
  const logPanel = document.querySelector('details.log')
  const buriedByOpenLog = (() => {
    if (!logPanel) return 0
    const wasOpen = logPanel.open
    logPanel.open = true
    const covered = [...stage.querySelectorAll('button, .room-price')].filter((element) => {
      const box = element.getBoundingClientRect()
      if (box.width < 4 || box.height < 4) return false
      return !['nearest', 'start', 'end'].some((block) => {
        element.scrollIntoView({ block })
        const spot = element.getBoundingClientRect()
        const hit = document.elementFromPoint(spot.left + spot.width / 2, spot.top + spot.height / 2)
        return Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)))
      })
    }).length
    logPanel.open = wasOpen
    return covered
  })()
  const stageHeight = stage.clientHeight
  const stageOverflow = Math.round(stage.scrollHeight - stage.clientHeight)
  const stageScrolls = ['auto', 'scroll', 'overlay'].includes(getComputedStyle(stage).overflowY)
  return { buriedControls, buriedPrices, buriedCards, leaveOwns, lastPriceBelow, clipped,
    rugIntoLeave, leaveReachable, stageOverflow, stageScrolls, stageHeight, shelfTileSpread, buriedByOpenLog,
    overlaps: overlapPairs.slice(0, 3), overlapCount: overlapPairs.length,
    cardRulesFont, cardRulesClipped, cardFaceWidth, colorlessCardWidth, discountMarked,
    sideways: Math.round(board.scrollWidth - board.clientWidth) + Math.round(stage.scrollWidth - stage.clientWidth) }
}

// The pointerless rows are not decoration: every tile prints a name and a rules
// line there, which roughly doubles tile height, and that is the state where the
// rug ran out of room and painted over the Leave banner.
const SHOP_CASES = [
  // Tall enough to leave the short-window trim behind, so the BASE module — the
  // container-query derivation every other regime is a variation on — is the one
  // under test. Swapping its `100cqh` for `100vh` overflows these by 154px while
  // every shorter case stays green.
  { width: 1440, height: 900, belt: true, colorless: true },
  { width: 1600, height: 1000, belt: true, colorless: true },
  // Tall and narrow, where the module's own `13vw` term binds and its height term
  // does not — the case that stranded a dead band under the rug.
  { width: 820, height: 1400, belt: true, colorless: true },
  // Tall and narrow enough that the module is limited by WIDTH, which is where the
  // rug's three columns stopped fitting and squeezed the Colorless pile.
  { width: 900, height: 1600, belt: true, colorless: true },
  // Tall AND wide enough to drive the module to its 176px clamp ceiling, which no
  // other case reaches — the ceiling is where the card-text ramp meets its cap.
  { width: 1920, height: 1200, belt: true, colorless: true },
  { width: 1280, height: 720, belt: true, colorless: true },
  { width: 1024, height: 600, belt: true, colorless: true },
  // The pointerless regime's binding case, per its own comment: tall enough that
  // its fixed cost decides the module rather than the clamp floor.
  { width: 1440, height: 900, belt: true, colorless: true, touch: true },
  { width: 1024, height: 600, belt: true, colorless: true, touch: true },
  { width: 900, height: 620, belt: true, colorless: true },
  { width: 900, height: 620, belt: true, colorless: true, touch: true },
  { width: 900, height: 620, belt: false, colorless: true },
  { width: 390, height: 844, belt: true, colorless: true },
  { width: 390, height: 844, belt: false, colorless: true },
  // Broke: every tile disabled, which is where the discount marker was lost.
  { width: 1440, height: 900, belt: false, colorless: true, broke: true },
]
const shopCases = []
const pointerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const pointerPage = await openRun(pointerContext)
try {
  for (const shopCase of SHOP_CASES) {
    if (shopCase.touch) {
      const context = await browser.newContext({
        viewport: { width: shopCase.width, height: shopCase.height }, hasTouch: true, isMobile: true })
      try {
        const page = await openRun(context)
        await stockShop(page, shopCase)
        shopCases.push({ ...shopCase, ...await page.evaluate(measureRug) })
      } finally {
        await context.close()
      }
      continue
    }
    await pointerPage.setViewportSize({ width: shopCase.width, height: shopCase.height })
    await stockShop(pointerPage, shopCase)
    shopCases.push({ ...shopCase, ...await pointerPage.evaluate(measureRug) })
  }
} finally {
  await pointerContext.close()
}

// The three room branches in App.tsx are meant to be mutually exclusive, and the
// campfire branch used to test only the room's KIND — so a campfire tile with an
// interaction still open mounted both screens, stacked. Reviewers disagreed on
// which flows can still reach that state, so this is written as the invariant it
// is: whatever the route in, only one room screen may ever be mounted.
// The Wing Boots prompt is one of the three surfaces this work re-cut and had no
// check at all: dropping its class entirely changed nothing. It is a STRIP — one
// full-width button per destination read as a dialog and cost the map a third of
// its band, pushing the bottom rows of nodes below the fold.
const wingPrompt = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const run = structuredClone(before)
  run.phase = 'map'
  run.neow = null
  run.roomState = null
  // A room whose next row holds something its own exits do not reach.
  // TWO or more destinations, or the strip cannot be told from a stack: with one
  // option every button trivially shares one row and the check cannot fail.
  let from = null
  let offPath = []
  for (const row of run.map.rows.slice(0, -1)) {
    for (const candidate of row) {
      const exits = run.map.rooms[candidate].exits
      const next = run.map.rows[run.map.rooms[candidate].row + 1] ?? []
      const unreached = next.filter((id) => !exits.includes(id))
      if (unreached.length > offPath.length) {
        from = candidate
        offPath = unreached
      }
    }
  }
  if (offPath.length < 2) return { reachable: false }
  run.map.position = from
  run.map.rooms[from] = { ...run.map.rooms[from], visited: true }
  run.players = run.players.map((player) => ({ ...player, row: run.map.rooms[from].row,
    relics: [...player.relics, { defId: 'wing_boots', spent: false, uses: 3 }] }))
  debug.setRun(run)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  // With the log's panel OPEN, and at a phone width too. The prompt is a bottom
  // strip, so an open panel landed straight on its destinations — a real click on
  // a Wing Boots option timed out with the run still on the map.
  const openLog = document.querySelector('details.log')
  if (openLog) openLog.open = true
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const prompt = document.querySelector('.map-prompt')
  const map = document.querySelector('.map')
  const options = [...(prompt?.querySelectorAll('button') ?? [])]
  const measured = {
    reachable: true,
    rendered: Boolean(prompt),
    height: prompt ? Math.round(prompt.getBoundingClientRect().height) : 0,
    options: options.length,
    // Every destination must be clickable at its own centre, and the buttons must
    // sit on ONE row beside the label rather than stacking.
    hittable: options.every((option) => {
      const box = option.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return Boolean(hit && (hit === option || option.contains(hit)))
    }),
    rows: new Set(options.map((option) => Math.round(option.getBoundingClientRect().top))).size,
    coveredByLog: openLog ? options.filter((option) => {
      const box = option.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return Boolean(hit && (hit === openLog || openLog.contains(hit)))
    }).length : 0,
    // Nothing on the map may be unreachable once the prompt takes its share.
    // Scrolled in FIRST and then hit-tested: a node still half below the map's
    // fold has its centre outside the map's clip, where the prompt sits — which
    // reads as "the prompt covers the map" and is only ever a scroll away.
    unreachableNodes: [...document.querySelectorAll('.room')].filter((node) => {
      node.scrollIntoView({ block: 'center' })
      const box = node.getBoundingClientRect()
      const band = map.getBoundingClientRect()
      if (box.bottom > band.bottom + 1 || box.top < band.top - 1) return true
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return !(hit && (hit === node || node.contains(hit) || hit.contains(node)))
    }).length,
  }
  debug.setRun(before)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  return measured
})
// The same prompt at a PHONE width, for the log-coverage half. The strip's shape
// assertions above are desktop figures, but the collision the dock prevents only
// happens where the panel and the strip share the bottom of the screen.
await page.setViewportSize({ width: 390, height: 844 })
const wingPromptPhone = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const run = structuredClone(before)
  run.phase = 'map'
  run.neow = null
  run.roomState = null
  run.log = Array.from({ length: 30 }, (_, index) => `Entry number ${index + 1} of the run log.`)
  let from = null
  let offPath = []
  for (const row of run.map.rows.slice(0, -1)) {
    for (const candidate of row) {
      const room = run.map.rooms[candidate]
      const next = run.map.rows[room.row + 1] ?? []
      const unreached = next.filter((id) => !room.exits.includes(id))
      if (unreached.length > offPath.length) {
        from = candidate
        offPath = unreached
      }
    }
  }
  if (offPath.length < 1) return { reachable: false }
  run.map.position = from
  run.map.rooms[from] = { ...run.map.rooms[from], visited: true }
  run.players = run.players.map((player) => ({ ...player, row: run.map.rooms[from].row,
    relics: [...player.relics, { defId: 'wing_boots', spent: false, uses: 3 }] }))
  debug.setRun(run)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const log = document.querySelector('details.log')
  if (log) log.open = true
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const options = [...(document.querySelectorAll('.map-prompt button') ?? [])]
  const measured = {
    reachable: true,
    options: options.length,
    coveredByLog: log ? options.filter((option) => {
      const box = option.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return Boolean(hit && (hit === log || log.contains(hit)))
    }).length : 0,
  }
  if (log) log.open = false
  debug.setRun(before)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  return measured
})
await page.setViewportSize({ width: 1440, height: 900 })
check('a phone Wing Boots prompt stays clear of the open run log', () => {
  assert(wingPromptPhone.reachable, 'the phone map fixture offered no off-path room')
  assert(wingPromptPhone.options >= 1, 'the phone prompt offered no destination')
  assertEqual(wingPromptPhone.coveredByLog, 0,
    `${wingPromptPhone.coveredByLog} of ${wingPromptPhone.options} destination(s) sat under the open run log`)
})

check('the Wing Boots prompt is a strip that leaves the map usable', () => {
  assert(wingPrompt.reachable, 'the map fixture offered no off-path room to walk to')
  assert(wingPrompt.rendered, 'the Wing Boots prompt did not render')
  assert(wingPrompt.options >= 2,
    `the prompt offered ${wingPrompt.options} destination(s); two are needed to tell a strip from a stack`)
  assert(wingPrompt.hittable, 'a Wing Boots destination was not clickable at its own centre')
  assertEqual(wingPrompt.coveredByLog, 0,
    `${wingPrompt.coveredByLog} Wing Boots destination(s) sat under the open run log`)
  assertEqual(wingPrompt.rows, 1, `the prompt stacked its ${wingPrompt.options} options over ${wingPrompt.rows} rows`)
  assert(wingPrompt.height <= 80, `the prompt is ${wingPrompt.height}px tall, which is a panel rather than a strip`)
  assertEqual(wingPrompt.unreachableNodes, 0, `${wingPrompt.unreachableNodes} map node(s) became unreachable`)
})

const stackedRoomScreens = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const run = structuredClone(before)
  run.phase = 'room'
  run.neow = null
  const roomId = run.map.rows[0][0]
  run.map.position = roomId
  run.map.rooms[roomId].kind = 'campfire'
  run.roomState = { kind: 'merchant', relics: ['anchor', 'happy_flower', 'akabeko'],
    potions: ['fire_potion', 'swift_potion', 'blood_potion'], colorless: [],
    cards: Object.fromEntries(run.players.map((player) => [player.id,
      { choices: ['twin_strike', 'second_wind', 'limit_break'], cardsDrawn: [], raresDrawn: [] }])),
    removalUsed: [], purchasedCards: {} }
  debug.setRun(run)
  const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  // NOT `.room-screen`: the relic-resolve panel uses that class too, so counting
  // it hid the blank room this assertion exists to catch. Only the three things a
  // room branch can actually mount.
  const roomScreens = () => document.querySelectorAll('.campfire, .room-stage, .merchant-arrival').length
  return (async () => {
    await settle()
    const counts = {
      campfire: document.querySelectorAll('.campfire').length,
      merchant: document.querySelectorAll('.merchant-stage, .merchant-arrival').length,
      mounted: roomScreens(),
    }
    // A pending Relic has its own resolver. No underlying room action may remain
    // mounted: resolveCampfire does not guard pending acquisitions and could move
    // the run back to the map while leaving the Relic unresolved.
    const pending = structuredClone(run)
    // What `hasPendingRelicAcquisition` actually reads: a relic awaiting its
    // owner's choice. Setting an invented `pendingAcquisition` field instead left
    // this assertion unable to fail.
    pending.players[0].relics = [...pending.players[0].relics, { defId: 'akabeko', pending: true }]
    debug.setRun(pending)
    await settle()
    counts.whilePendingAcquisition = roomScreens()
    counts.relicResolvers = [...document.querySelectorAll('.room-screen > h2')]
      .filter((heading) => /^Resolve /.test(heading.textContent ?? '')).length
    debug.setRun(before)
    await settle()
    return counts
  })()
})
// The boss-relic picker is its own markup (`.reward-boss`) and moved out of
// `.reward-screen__relic`, which is what the other reward checks select — so
// until now no browser suite touched it at all.
const bossRelicShape = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const run = structuredClone(before)
  run.phase = 'reward'
  run.neow = null
  run.roomState = null
  run.rewardDestination = 'map'
  run.rewards = [{ playerId: run.players[0].id, cardReward: false, choices: null, upgraded: false,
    potion: false, bossRelics: ['snecko_eye', 'pandoras_box', 'tiny_house'] }]
  debug.setRun(run)
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const picks = [...document.querySelectorAll('.reward-boss__pick')]
    const widths = picks.map((pick) => Math.round(pick.getBoundingClientRect().width))
    const screen = document.querySelector('.reward-screen')?.getBoundingClientRect()
    const result = {
      picks: picks.length,
      // A boss-relic screen offers no card, so the card-reward instruction must
      // not be printed on it.
      cardInstructions: [...document.querySelectorAll('.reward-screen > p.muted')]
        .filter((line) => /revealed card/i.test(line.textContent ?? '')).length,
      spread: widths.length ? Math.max(...widths) - Math.min(...widths) : -1,
      // Each pick must name the relic AND its rules, since the art carries neither.
      named: picks.every((pick) => /\w/.test(pick.querySelector(':scope > strong')?.textContent ?? '')
        && (pick.querySelector(':scope > .room-item-text')?.textContent ?? '').length > 8),
      inside: screen ? picks.every((pick) => {
        const box = pick.getBoundingClientRect()
        return box.left >= screen.left - 1 && box.right <= screen.right + 1
      }) : false,
      hittable: picks.every((pick) => {
        const box = pick.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return Boolean(hit && (pick === hit || pick.contains(hit)))
      }),
      // The art has to be sized for THIS tile. The picker draws bare icons, and
      // the app's global icon size is 1.8rem — which left a 28px relic adrift in
      // a 218px pick until the picker sized it itself.
      art: Math.round(Math.min(...picks.map((pick) =>
        pick.querySelector('.item-icon-image')?.getBoundingClientRect().width ?? 0), Infinity)),
    }
    debug.setRun(before)
    done(result)
  })))
})
check('the boss relic picker offers three readable, hittable choices', () => {
  assertEqual(bossRelicShape.picks, 3, 'the boss relic picker did not render three choices')
  assert(bossRelicShape.spread <= 2, `boss relic picks differ in width by ${bossRelicShape.spread}px`)
  assert(bossRelicShape.named, 'a boss relic pick omitted its name or its rules')
  assert(bossRelicShape.inside, 'a boss relic pick escaped the reward screen')
  assert(bossRelicShape.hittable, 'a boss relic pick was not clickable at its own centre')
  assert(bossRelicShape.art >= 56, `boss relic art is only ${bossRelicShape.art}px wide`)
  assertEqual(bossRelicShape.cardInstructions, 0,
    'a boss-relic screen printed card-reward instructions with no cards on it')
})
// The merchant fixtures all passed `colorless: []`, so no check ever rendered the
// Colorless pile — which is how card faces painting over the row beneath stayed
// invisible to this suite. THREE cards, because that is what `createMerchant`
// draws; a two-card fixture also hid the pile's own track being one short, which
// wrapped the third card onto a row of its own and put it under the Leave banner.
// A Sold relic and a Sold potion are stocked here too: with all six slots filled
// the `.room-item-icon` half of the shelf-icon selector never rendered, so the
// rule giving a Sold glyph the icon module was never measured by anything.
await openMerchantShop()
const colorlessOverlap = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const run = structuredClone(before)
  run.phase = 'room'
  run.neow = null
  run.players = run.players.map((player) => ({ ...player, gold: 40 }))
  // Slot 0 STOCKED and slot 1 Sold, on both shelves. Both halves are needed for
  // the icon-spread assertion to be able to fail at all: slot 0 is the discounted
  // one, and its price chip is what makes a tile's min-content wider than the
  // icon module — which is the only condition under which a percentage-sized
  // glyph diverges from a module-sized one. Sold in slot 1 renders the
  // `.room-item-icon` half of the shelf-icon selector, which a fully stocked
  // fixture never produced.
  run.roomState = { kind: 'merchant', relics: ['anchor', '', 'akabeko'],
    potions: ['fire_potion', '', 'blood_potion'],
    // One CARD slot empty as well: a Sold plate only renders for an empty card
    // slot, so a shelf-only sold fixture never produced one and never measured it.
    colorless: ['dramatic_entrance', '', 'finesse'],
    cards: Object.fromEntries(run.players.map((player) => [player.id,
      { choices: ['twin_strike', 'second_wind', 'limit_break'], cardsDrawn: [], raresDrawn: [] }])),
    removalUsed: [], purchasedCards: {} }
  debug.setRun(run)
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const boxes = [...document.querySelectorAll(
      '.merchant-board h3, .merchant-board .room-price, .merchant-board .card, .merchant-board .merchant-card__sold, .merchant-board .item-icon-image')]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((entry) => entry.box.width > 2 && entry.box.height > 2)
    const pairs = []
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j]
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue
      if (!(a.box.right <= b.box.left + 1 || b.box.right <= a.box.left + 1
        || a.box.bottom <= b.box.top + 1 || b.box.bottom <= a.box.top + 1)) {
        pairs.push(`${(a.element.className || a.element.tagName).toString().split(' ')[0]}/${(b.element.className || b.element.tagName).toString().split(' ')[0]}`)
      }
    }
    // Two faces and one Sold plate, since the fixture empties a card slot on
    // purpose — the pile is still three slots wide.
    const colorlessCards = document.querySelectorAll('.merchant-cards--colorless .card').length
    const colorlessSlots = document.querySelectorAll(
      '.merchant-cards--colorless .card, .merchant-cards--colorless .merchant-card__sold').length
    const board = document.querySelector('.merchant-board')
    const boardBox = board.getBoundingClientRect()
    const stage = document.querySelector('.merchant-stage')
    // The rug is the window's width and cannot scroll sideways, so anything
    // past its content box is cut off rather than reachable.
    const clipped = [...board.querySelectorAll('.card, .item-icon-image, .room-item-icon, .room-price')]
      .reduce((worst, element) => {
        const box = element.getBoundingClientRect()
        return box.width > 2
          ? Math.max(worst, Math.round(box.right - boardBox.right), Math.round(boardBox.left - box.left))
          : worst
      }, 0)
    const sideways = Math.round(board.scrollWidth - board.clientWidth)
      + Math.round(stage.scrollWidth - stage.clientWidth)
    // A price can be buried while its own tile's centre is still clear, so a
    // hit-test on the buttons alone does not cover it.
    const buried = [...board.querySelectorAll('.room-price, .card')].filter((element) => {
      const box = element.getBoundingClientRect()
      if (box.width < 3 || box.height < 3) return false
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return !(hit && (hit === element || element.contains(hit) || hit.contains(element)))
    }).length
    // Only the COUNT here. Icon widths are asserted in the pointerless pass
    // instead: at this viewport the icon module is wider than a tile's prose and
    // price, so every track pins to the module and a spread assertion here could
    // not fail however the icons were sized.
    const soldGlyphs = board.querySelectorAll('.merchant-shelf .merchant-item > .room-item-icon').length
    // A sold CARD slot used to say "Sold" twice — once on the plate, once as the
    // price beneath it, which `Price` prints for a null value.
    const soldWordsPerSlot = [...board.querySelectorAll('.merchant-cards .merchant-card')]
      .map((slot) => (slot.textContent ?? '').match(/Sold/g)?.length ?? 0)
    // Restore the shop the checks below expect — an explicit fixture, not the
    // captured snapshot, which could be mid-transition and left them without the
    // Anchor relic they hover.
    debug.setRun({ ...before, phase: 'room', neow: null,
      players: before.players.map((player) => ({ ...player, gold: 40 })),
      roomState: { kind: 'merchant', relics: ['anchor', 'happy_flower', 'akabeko'],
        potions: ['fire_potion', 'swift_potion', 'blood_potion'], colorless: [],
        cards: Object.fromEntries(before.players.map((player) => [player.id,
          { choices: ['twin_strike', 'second_wind', 'limit_break'], cardsDrawn: [], raresDrawn: [] }])),
        removalUsed: [], purchasedCards: {} } })
    done({ colorlessCards, colorlessSlots, soldWordsPerSlot, pairs: pairs.slice(0, 4), count: pairs.length,
      clipped, sideways, buried, soldGlyphs })
  })))
})
// The hover tip is the ONLY way a pointer user reads a bare-icon relic, and the
// stage scrolls — so the stage clips. A tip centred on a tile is far wider than
// the tile, and on an edge column it was cut off mid-sentence, losing the item's
// name and the start of its rules. Every column on both shelves, at three widths:
// the shelves move from hard left to right of centre depending on whether a
// Colorless pile is in stock, so one viewport does not exercise the placement.
const shelfTips = []
for (const [tipWidth, tipHeight] of [[1024, 600], [900, 620], [1440, 900]]) {
  await page.setViewportSize({ width: tipWidth, height: tipHeight })
  for (const shelf of ['relics', 'potions']) {
  for (let column = 0; column < 3; column += 1) {
    const tile = page.locator(`.merchant-shelf--${shelf} .merchant-item`).nth(column)
    if (await tile.count() === 0) continue
    // Guarded: if the rug ever overflows onto the Leave banner again, the banner
    // intercepts this hover and a 30s timeout kills the process before `report()`
    // — losing every check, including the ones that name that exact regression.
    try {
      await tile.hover({ timeout: 5_000 })
    } catch {
      shelfTips.push({ label: `${tipWidth}x${tipHeight} ${shelf}#${column}`, shown: false, past: 0 })
      continue
    }
    shelfTips.push(await tile.evaluate((element, label) => {
      const tip = element.querySelector('.merchant-tooltip')
      const stage = element.closest('.merchant-stage').getBoundingClientRect()
      if (!tip || getComputedStyle(tip).display === 'none') return { label, shown: false, past: 0 }
      const box = tip.getBoundingClientRect()
      return {
        label,
        shown: box.width > 0 && box.height > 0,
        // How far the tip escapes the stage on either side.
        past: Math.max(0, Math.round(stage.left - box.left), Math.round(box.right - stage.right)),
        // The tip must not be the thing under its own centre — it covers the
        // tiles around it, and while it was hittable it ate their clicks.
        swallows: (() => {
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return Boolean(hit && (hit === tip || tip.contains(hit)))
        })(),
        // Wherever the tip overlaps another SECTION of the rug, the tip must be
        // on top. A hovered tile is a stacking context (its own `filter`), so the
        // tip's `z-index` counts for nothing against the TILE's siblings — an
        // opaque later section, the removal plaque or the shelf below, paints
        // straight over the text a player is reading. Which section it reaches
        // depends on the seat count, so this takes whichever one it overlaps
        // rather than naming the plaque. Pointer events are briefly restored
        // because paint order is the question, not hittability.
        neighbour: (() => {
          const own = element.closest('.merchant-shelf, .merchant-cards, .merchant-removal')
          const sections = [...document.querySelectorAll(
            '.merchant-board > .merchant-shelf, .merchant-board > .merchant-cards, .merchant-board > .merchant-removal')]
            .filter((section) => section !== own)
          for (const section of sections) {
            const other = section.getBoundingClientRect()
            const overlapX = Math.min(box.right, other.right) - Math.max(box.left, other.left)
            const overlapY = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top)
            if (overlapX <= 4 || overlapY <= 4) continue
            const previous = tip.style.pointerEvents
            tip.style.pointerEvents = 'auto'
            const hit = document.elementFromPoint(
              Math.max(box.left, other.left) + overlapX / 2,
              Math.max(box.top, other.top) + overlapY / 2)
            tip.style.pointerEvents = previous
            return { over: (section.className || '').toString().split(' ')[0],
              onTop: Boolean(hit && (hit === tip || tip.contains(hit))) }
          }
          return null
        })(),
        where: `tip ${Math.round(box.left)}..${Math.round(box.right)} tile ${Math.round(element.getBoundingClientRect().left)}..${Math.round(element.getBoundingClientRect().right)} stage ${Math.round(stage.left)}..${Math.round(stage.right)}`,
      }
    }, `${tipWidth}x${tipHeight} ${shelf}#${column}`))
    }
  }
}
await page.mouse.move(0, 0)
await page.setViewportSize({ width: 1440, height: 900 })
check('every shelf hover tip stays inside the stage that clips it', () => {
  assertEqual(shelfTips.length, 18, `only ${shelfTips.length} shelf tiles were hovered`)
  // At least one tip must actually reach the plaque, or the paint-order assertion
  // above is vacuous.
  assert(shelfTips.some((tip) => tip.neighbour),
    'no hover tip overlapped another section of the rug, so paint order went untested')
  for (const tip of shelfTips) {
    assert(tip.shown, `the ${tip.label} tile showed no hover tip on a pointer device`)
    assertEqual(tip.past, 0, `the ${tip.label} hover tip escaped the stage by ${tip.past}px — ${tip.where}`)
    assert(!tip.swallows, `the ${tip.label} hover tip took the hit-test at its own centre`)
    assert(!tip.neighbour || tip.neighbour.onTop,
      `the ${tip.label} hover tip was painted over by the ${tip.neighbour?.over} it overlaps`)
  }
})
// ONE check per viewport, not one for all twelve. `assert` throws on the first
// failure, so a single bundled check reported the first bad case and hid the
// other eleven — and every later assertion within that case too.
check('the shop reports a measurement for every stocked state', () => {
  assertEqual(shopCases.length, SHOP_CASES.length, 'a shop case did not report its measurements')
})
for (const shopCase of shopCases) {
  const where = `${shopCase.width}x${shopCase.height}${shopCase.touch ? ' touch' : ''}${shopCase.belt ? ' belt' : ''}${shopCase.colorless ? ' colorless' : ''}`
  check(`the shop keeps ${where} reachable, aligned and legible`, () => {
    assertEqual(shopCase.buriedControls, 0, `${where}: ${shopCase.buriedControls} shop control(s) buried`)
    assertEqual(shopCase.buriedPrices, 0, `${where}: ${shopCase.buriedPrices} price(s) buried`)
    assertEqual(shopCase.buriedCards, 0, `${where}: ${shopCase.buriedCards} card face(s) buried`)
    assert(shopCase.leaveOwns, `${where}: Leave merchant was not clickable across its width`)
    assert(shopCase.rugIntoLeave <= 4,
      `${where}: the rug reached ${shopCase.rugIntoLeave}px into the Leave banner's row`)
    assert(shopCase.leaveReachable, `${where}: Leave merchant could not be scrolled fully into the stage`)
    if (shopCase.width <= 760) {
      // 844 less the 4rem header, less the belt's reserved band when one is held.
      // Both arms are exercised: SHOP_CASES carries a phone case with and without
      // a potion, so the no-belt figure is not dead.
      const expected = shopCase.belt ? 730 : 780
      assert(shopCase.stageHeight >= expected - 2,
        `${where}: the phone stage took only ${shopCase.stageHeight}px of the ${expected}px below the header`)
    }
    if (shopCase.width >= 761) {
      assertEqual(shopCase.buriedByOpenLog, 0,
        `${where}: ${shopCase.buriedByOpenLog} control(s) unreachable with the run log open`)
    }
    assert(shopCase.stageScrolls,
      `${where}: the rug cannot be scrolled, so anything below the fold is lost`)
    // A pointer desktop window tall enough for the rug must not scroll AT ALL —
    // that is what the height trims buy, and asserting only "it CAN scroll" left
    // them unmeasured. The genuinely tight cases are excluded by name, so a new
    // overflow somewhere roomy cannot hide behind them.
    // Touch included. Excluding it left the pointerless regime's fixed cost
    // undefendable — it could be moved from 355 to 100 with every check green.
    if (shopCase.width >= 761 && shopCase.height >= 700) {
      assertEqual(shopCase.stageOverflow, 0, `${where}: the rug overflowed its stage by ${shopCase.stageOverflow}px`)
    }
    assert(shopCase.lastPriceBelow <= 0,
      `${where}: the last potion price stayed ${shopCase.lastPriceBelow}px below the fold even scrolled to the end`)
    assert(shopCase.clipped <= 1, `${where}: stock hung ${shopCase.clipped}px past the rug's edge`)
    assertEqual(shopCase.sideways, 0, `${where}: the rug overflowed sideways by ${shopCase.sideways}px`)
    assertEqual(shopCase.overlapCount, 0,
      `${where}: ${shopCase.overlapCount} overlapping rug element(s): ${shopCase.overlaps.join(' ')}`)
    if (shopCase.colorless) {
      assert(Math.abs(shopCase.colorlessCardWidth - shopCase.cardFaceWidth) <= 2,
        `${where}: Colorless cards are ${shopCase.colorlessCardWidth}px against ${shopCase.cardFaceWidth}px for the character row`)
    }
    assert(shopCase.discountMarked,
      `${where}: the discounted relic's price is not distinguished from a full-price one`)
    assertEqual(shopCase.cardRulesClipped, 0,
      `${where}: ${shopCase.cardRulesClipped} card face(s) clipped their own rules text`)
    // Tied to the card's width rather than a flat pixel bar: a 76px card on a
    // cramped window cannot carry 10px type, but the RAMP must still be the
    // shop's own and not the 0.49rem-capped shared one.
    // Bounded by the ramp's own cap as well as the card's width: the cap is
    // deliberate — above it the wordiest card in the pool clips its panel — so a
    // pure ratio bar contradicted it the moment the module reached its ceiling.
    // A roomy pointer window must not leave the cards on their clamp FLOOR: that
    // is what a regime re-using the untrimmed fixed cost looks like, and nothing
    // else here bounds unused rug height.
    if (!shopCase.touch && shopCase.width >= 1280 && shopCase.height >= 700) {
      assert(shopCase.cardFaceWidth > 76,
        `${where}: card faces sat on their ${shopCase.cardFaceWidth}px floor on a window with room to spare`)
    }
    // A phone has its own module, and it too was bounded only from ABOVE: the rule
    // could be shrunk to a 44px ceiling, or moved back onto the stage where the
    // board's own declaration shadows it, with every check still green.
    // The widest case exists to reach the module's 176px ceiling, so it has to
    // assert the module actually GOT there — the ceiling could be cut to 96px with
    // every other bound still satisfied.
    if (!shopCase.touch && shopCase.width >= 1900 && shopCase.height >= 1100) {
      assert(shopCase.cardFaceWidth >= 160,
        `${where}: card faces reached only ${shopCase.cardFaceWidth}px on the widest window`)
    }
    if (shopCase.width <= 430) {
      assert(shopCase.cardFaceWidth >= 92,
        `${where}: phone card faces are only ${shopCase.cardFaceWidth}px wide`)
    }
    // Below 830px the rug stacks one section per row, which is what lets a narrow
    // window keep a readable card: squeezed into three columns instead, the same
    // window draws them at about 92px.
    if (shopCase.width > 430 && shopCase.width <= 830) {
      assert(shopCase.cardFaceWidth >= 100,
        `${where}: narrow-window card faces are only ${shopCase.cardFaceWidth}px wide`)
    }
    assert(shopCase.cardRulesFont >= Math.min(shopCase.cardFaceWidth * 0.068, 11.2),
      `${where}: card rules text is ${shopCase.cardRulesFont.toFixed(2)}px on a ${shopCase.cardFaceWidth}px card`)
    assert(shopCase.shelfTileSpread <= 2,
      `${where}: shelf tiles differ in width by ${shopCase.shelfTileSpread}px, so the stock rows do not line up`)
  })
}
check('the shop lays out a full Colorless pile without overlapping or clipping', () => {
  assertEqual(colorlessOverlap.colorlessSlots, 3, 'the Colorless pile did not render three slots')
  assertEqual(colorlessOverlap.colorlessCards, 2,
    'the fixture should leave exactly one Colorless slot sold, so its plate is measured too')
  assertEqual(colorlessOverlap.count, 0,
    `${colorlessOverlap.count} overlapping rug elements: ${colorlessOverlap.pairs.join(' ')}`)
  assert(colorlessOverlap.clipped <= 1, `stock hung ${colorlessOverlap.clipped}px past the rug's edge`)
  assertEqual(colorlessOverlap.sideways, 0, `the rug overflowed sideways by ${colorlessOverlap.sideways}px`)
  assertEqual(colorlessOverlap.buried, 0, `${colorlessOverlap.buried} price(s) or card face(s) were buried`)
  assertEqual(colorlessOverlap.soldGlyphs, 2, 'the Sold-slot glyphs did not render, so nothing measured them')
  assert(colorlessOverlap.soldWordsPerSlot.every((count) => count <= 1),
    `a sold card slot printed "Sold" ${Math.max(...colorlessOverlap.soldWordsPerSlot)} times`)
})
check('a campfire tile with an open room interaction mounts exactly one screen', () => {
  assertEqual(stackedRoomScreens.merchant, 1, 'the open Merchant did not render')
  assertEqual(stackedRoomScreens.campfire, 0, 'the campfire screen rendered on top of an open Merchant')
  assertEqual(stackedRoomScreens.mounted, 1, 'exactly one room screen must mount')
  assertEqual(stackedRoomScreens.whilePendingAcquisition, 0,
    'a pending acquisition left an underlying room action mounted')
  assertEqual(stackedRoomScreens.relicResolvers, 1,
    'a pending acquisition did not mount exactly one Relic resolver')
})
check('a pointerless shopper reads shelf rules without hovering', () => {
  for (const [label, shelf] of [['tall', touchShelf], ['short with a belt', touchShelfShort]]) {
    assert(shelf.coarse, `touch context (${label}) still reports a hover-capable pointer`)
    assert(shelf.nameVisible, `touch shelf tile hides its item name (${label})`)
    assert(shelf.rulesVisible, `touch shelf tile hides its item rules (${label})`)
    assert(/gain 2 Block/i.test(shelf.rulesText), `touch shelf rules read "${shelf.rulesText}" (${label})`)
    assert(shelf.focusVisible, `focusing the shelf tile did not reach :focus-visible (${label})`)
    assert(shelf.tipHidden, `the tooltip still shows on a touch device (${label})`)
    assert(shelf.lastPriceBelow <= 0,
      `the last potion price sat ${shelf.lastPriceBelow}px below the stage on a pointerless device (${label})`)
    // The prose these tiles print is paid for by shrinking the stock, so both
    // floors are asserted here: an icon shrank to 23px unnoticed, and the card
    // faces — which print no fallback text at all — to 38px.
    assert(shelf.smallestIcon >= 30, `pointerless shelf icons shrank to ${shelf.smallestIcon}px (${label})`)
    assertEqual(shelf.soldGlyphs, 2, `the Sold-slot glyphs did not render, so their sizing is untested (${label})`)
    assert(shelf.headingOffset <= 2,
      `a shelf heading sat ${shelf.headingOffset}px from its first item (${label})`)
    assert(shelf.priceSpread <= 2,
      `pointerless shelf prices differ in baseline by ${shelf.priceSpread}px (${label})`)
    assert(shelf.tileSpread <= 2,
      `pointerless shelf tiles differ in width by ${shelf.tileSpread}px (${label})`)
    assert(shelf.iconSpread <= 2,
      `pointerless shelf icons — Sold glyphs included — differ by ${shelf.iconSpread}px (${label})`)
    assert(shelf.smallestCardFace >= 72,
      `pointerless card faces shrank to ${shelf.smallestCardFace}px (${label})`)
    assertEqual(shelf.spill, 0, `a shelf tile printed its text outside its own track (${label})`)
  }
})
const merchantAnchorNamed = await page.getByLabel('Relics')
  .getByRole('button', { name: /Anchor.*gain 2 Block/i }).count()
const merchantAnchorPriced = await page.getByLabel('Relics')
  .getByRole('button', { name: /Anchor.*5 Gold, on sale/i }).count()
await page.getByLabel('Relics').getByRole('button', { name: /^Anchor/ }).hover()
const merchantAnchorTip = await page.locator('.merchant-shelf--relics .merchant-item').first().evaluate((tile) => {
  const tip = tile.querySelector('.merchant-tooltip')
  if (!tip) return { shown: false, text: '' }
  const box = tip.getBoundingClientRect()
  return {
    shown: getComputedStyle(tip).display !== 'none' && box.width > 0 && box.height > 0
      && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1,
    text: tip.textContent ?? '',
  }
})
await page.screenshot({ path: join(outDir, 'merchant-shelf-tooltip.png'), fullPage: true })
await page.mouse.move(0, 0)
const accessibleGoldPrices = await page.getByLabel('Relics').getByRole('button', { name: /Gold/ }).count()
const merchantShape = await page.evaluate(() => {
  const board = document.querySelector('.merchant-board')
  const shelfItems = [...document.querySelectorAll('.merchant-shelf .merchant-item > :is(.item-icon-image, .room-item-icon)')]
  const boardStyle = board ? getComputedStyle(board) : null
  return {
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    boardScrollable: !boardStyle || ['auto', 'scroll'].includes(boardStyle.overflowX) || ['auto', 'scroll'].includes(boardStyle.overflowY),
    buttons: document.querySelectorAll('.merchant-board button').length,
    oldFigures: document.querySelectorAll('.merchant-figure').length,
    shelfIconCount: shelfItems.length,
    shelfWidth: Math.min(...shelfItems.map((item) => item.getBoundingClientRect().width)),
    shelfIconSpread: Math.max(...shelfItems.map((item) => item.getBoundingClientRect().width))
      - Math.min(...shelfItems.map((item) => item.getBoundingClientRect().width)),
    cardWidth: document.querySelector('.merchant-card .card')?.getBoundingClientRect().width ?? 0,
    exposedTooltips: document.querySelectorAll('.merchant-tooltip:not([aria-hidden="true"])').length,
  }
})
check('four-player Merchant is game-framed, responsive, and keyboard reachable', () => {
  assert(!merchantShape.overflow, 'merchant overflows the viewport')
  assert(!merchantShape.boardScrollable, 'merchant inventory rug is scrollable')
  assert(merchantShape.buttons >= 9, `merchant exposes only ${merchantShape.buttons} actions`)
  assertEqual(merchantShape.oldFigures, 0, 'the old merchant figure is still rendered')
  assertEqual(merchantShape.shelfIconCount, 6, 'the shelves did not render six icons')
  assert(merchantShape.shelfWidth >= 34, `merchant shelf icons are only ${merchantShape.shelfWidth}px wide`)
  assert(merchantShape.shelfIconSpread <= 2, `merchant shelf icons differ by ${merchantShape.shelfIconSpread}px`)
  assert(merchantShape.shelfWidth < merchantShape.cardWidth,
    `shelf icons (${merchantShape.shelfWidth}px) should read smaller than card faces (${merchantShape.cardWidth}px)`)
  assertEqual(merchantShape.exposedTooltips, 0, 'merchant tooltips duplicate their button accessible names')
})
check('shop shelf items stay readable without a card face', () => {
  // The icons print no rules, so this is the guarantee that replaces the card
  // face: the rules are in the button's accessible name, the price and its sale
  // state are too, and a pointer gets a tip that is fully on screen.
  assertEqual(merchantAnchorNamed, 1, 'shop relic button does not name its rules')
  assertEqual(merchantAnchorPriced, 1, 'shop relic button does not name its price and sale state')
  assert(merchantAnchorTip.shown, 'hovering a shop relic showed no tooltip')
  assert(/Anchor/.test(merchantAnchorTip.text) && /gain 2 Block/i.test(merchantAnchorTip.text),
    `shop relic tooltip reads "${merchantAnchorTip.text}"`)
})
check('Merchant prices expose their Gold unit', () => assert(accessibleGoldPrices > 0))
check('Merchant keeps its fixed rug and Leave action inside a 1280×720 desktop', () => {
  assert(merchant720.bottom <= merchant720.viewport + 1, `merchant ends at ${merchant720.bottom}px in ${merchant720.viewport}px`)
  assert(merchant720.leaveBottom <= merchant720.viewport + 1, `Leave merchant ends at ${merchant720.leaveBottom}px`)
})
check('Merchant keeps uniform shelf icons and every shelf price visible at 1024×600', () => {
  assert(merchant600.stageBottom <= merchant600.viewport + 1, `merchant ends at ${merchant600.stageBottom}px in ${merchant600.viewport}px`)
  assertEqual(merchant600.iconCount, 6, 'the shelves did not render six icons at 1024x600')
  assert(merchant600.itemWidth >= 30, `merchant shelf icons are only ${merchant600.itemWidth}px wide`)
  assert(merchant600.iconSpread <= 2, `merchant shelf icons differ by ${merchant600.iconSpread}px`)
  assert(merchant600.iconsSmallerThanCards,
    `shelf icons (${merchant600.itemWidth}px) should read smaller than card faces (${merchant600.cardWidth}px)`)
  // The regression this locks down: a short window used to push the potion row
  // past the stage, and `overflow: clip` then made those prices unreachable.
  assert(merchant600.lastPriceBelow <= 0,
    `the last potion price stayed ${merchant600.lastPriceBelow}px below the fold at 1024×600 even scrolled to the end`)
})
check('Merchant keeps legible shelf icons without horizontal overflow at 390×844', () => {
  assert(merchant390.itemWidth >= 30, `merchant shelf icons are only ${merchant390.itemWidth}px wide`)
  assert(merchant390.iconsSmallerThanCards, 'mobile shelf art grew back to card size')
  assert(!merchant390.overflow, 'merchant overflows a 390px viewport')
  assert(merchant390.removalRatio > 0.9, `card removal uses only ${merchant390.removalRatio * 100}% of the mobile rug`)
  assert(merchant390.detailVisible, 'touch shoppers cannot read item descriptions')
})
check('Merchant hand stays attached to a purchased item after mobile scrolling', () => {
  assert(mobileMerchantHand?.scrolled, 'mobile purchase did not exercise a scrolled Merchant')
  assertEqual(mobileMerchantHand?.position, 'absolute')
  assert((mobileMerchantHand?.yError ?? Infinity) < 3, `Merchant hand missed the scrolled item by ${mobileMerchantHand?.yError}px`)
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
await openMerchantShop()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => ({ ...player, gold: 0 }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /Card Removal Service/ }).click()
await page.getByRole('group', { name: 'Card to remove' }).getByRole('button').first().click()
const brokePartyControlsDisabled = await page.waitForFunction(() => {
  const buttons = [...document.querySelectorAll('button')]
  return buttons.some((button) => button.textContent?.includes('Anchor') && button.disabled) &&
    buttons.some((button) => button.textContent?.includes('Remove') && button.disabled)
}).then((handle) => handle.jsonValue())
check('Merchant disables purchases and removal when the whole party is broke', () => assert(brokePartyControlsDisabled))
await page.getByRole('button', { name: 'Cancel' }).click()

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player, index) => ({ ...player, gold: index === 1 ? 5 : 0 }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /Anchor/ }).click()
await page.locator('.merchant-hand').evaluate((image) => image.decode())
const merchantHand = await page.locator('.merchant-hand').evaluate((image) => ({
  src: image.getAttribute('src'),
  loaded: image.naturalWidth > 0,
  height: image.getBoundingClientRect().height,
}))
await page.screenshot({ path: join(outDir, 'merchant-purchase-hand.png'), fullPage: true })
await page.getByRole('button', { name: /Sold/ }).first().waitFor()
const sharedPurchaseRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
check('local co-op Merchant spends an exact shared-Gold payment', () => {
  assert(sharedPurchaseRun.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(sharedPurchaseRun.players[1].gold, 0)
  assertEqual(merchantHand.src, '/assets/noncombat/merchant/merchant-hand.webp')
  assert(merchantHand.loaded && merchantHand.height > 500, 'the Merchant hand cannot reach the inventory')
})

await setRoom('merchant')
await openMerchantShop()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player, index) => ({ ...player, gold: index === 1 ? 3 : 0 }))
  debug.setRun(run)
})
const localDeckSize = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].deck.length)
await page.getByRole('button', { name: /Card Removal Service/ }).click()
await page.getByRole('group', { name: 'Card to remove' }).getByRole('button').first().click()
await page.getByRole('button', { name: /Remove/ }).click()
await page.waitForFunction((size) => window.__STS_DEBUG__.getRun().players[0].deck.length === size - 1, localDeckSize)
const removalHand = await page.locator('.merchant-hand').evaluate((hand) => {
  const stage = hand.closest('.merchant-shop-stage')
  const target = stage?.querySelector('[data-merchant-target="removal"]')
  if (!stage || !target) return null
  const frame = stage.getBoundingClientRect()
  const item = target.getBoundingClientRect()
  return Math.abs(Number.parseFloat(hand.style.getPropertyValue('--merchant-point-y'))
    - (item.top - frame.top + stage.scrollTop + item.height * 0.55))
})
await page.screenshot({ path: join(outDir, 'merchant-removal-hand.png'), fullPage: true })
const removalPayerGold = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[1].gold)
check('local co-op card removal can use shared Gold and triggers the Merchant hand', () => {
  assertEqual(removalPayerGold, 0)
  assert((removalHand ?? Infinity) < 3, `Merchant hand missed card removal by ${removalHand}px`)
})

await page.getByRole('button', { name: /Leave shop/ }).click()
for (const id of ['p1', 'p2', 'p3']) {
  await page.evaluate((playerId) => window.__STS_DEBUG__.setViewer(playerId), id)
  await page.getByRole('button', { name: /Proceed/ }).click()
  await page.getByRole('heading', { name: 'The Merchant' }).waitFor()
}
const waitingReady = await page.getByRole('button', { name: /Waiting for party/ }).textContent()
await page.evaluate(() => window.__STS_DEBUG__.setViewer('p4'))
await page.getByRole('button', { name: /Proceed/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
check('leaving the shop returns to the arrival scene and local play waits for every traveler', () => assert(waitingReady?.includes('3/4')))

await page.evaluate(() => window.__STS_DEBUG__.setViewer('p1'))
await setRoom('treasure')
await page.getByRole('heading', { name: 'Choose a Relic' }).waitFor()
await page.screenshot({ path: join(outDir, 'treasure-4p-desktop.png'), fullPage: true })
const treasureName = await page.locator('.treasure-relic > strong').textContent()
const takeRelicButtons = await page.getByRole('button', { name: /Take relic/ }).count()
// `public/assets/cards/` is gitignored, so on a fresh checkout `ItemImage`'s
// GENERATED face is the only renderer a relic or potion card ever gets. Treasure
// is where that face is still drawn at a size a player reads it at — the shop and
// the reward rows draw bare icons now, and the reward "Replace" keys draw a 1.4rem
// icon, which is far too small to prove anything about a card face.
const treasureFallback = page.locator('.treasure-relic > .item-card-fallback')
if (await treasureFallback.count() === 0) {
  await page.locator('.treasure-relic > .item-card-image')
    .evaluate((image) => { image.src = '/missing-item-card.webp' })
}
await treasureFallback.waitFor()
const treasureFallbackShape = await treasureFallback.evaluate((node) => ({
  name: node.querySelector('strong')?.textContent?.trim() ?? '',
  kind: node.querySelector('small')?.textContent?.trim() ?? '',
  rules: node.querySelector('span')?.textContent?.trim() ?? '',
  icon: node.querySelector('.item-card-image')?.getAttribute('src') ?? '',
  hidden: node.getAttribute('aria-hidden'),
  width: Math.round(node.getBoundingClientRect().width),
}))
check('Treasure gives the active seat one dominant face-up relic choice', () => {
  assertEqual(treasureName, 'Anchor')
  assertEqual(takeRelicButtons, 1)
})
check('a missing item scan falls back to a generated card face that still prints the item', () => {
  assert(treasureFallbackShape.name.length > 0, 'generated face printed no name')
  assert(treasureFallbackShape.rules.length > 0, 'generated face printed no rules')
  assertEqual(treasureFallbackShape.kind, 'Relic')
  assert(treasureFallbackShape.icon.startsWith('/assets/relic-icons/'),
    `generated face used icon "${treasureFallbackShape.icon}"`)
  // Drawn at a size the printed text can actually be read at, not as a thumbnail.
  assert(treasureFallbackShape.width >= 96,
    `generated face rendered only ${treasureFallbackShape.width}px wide`)
  // The surrounding panel already names the relic, so the drawn face is decorative.
  assertEqual(treasureFallbackShape.hidden, 'true')
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
await page.mouse.move(0, 0)
await page.locator('.card-morph').waitFor({ state: 'detached' })
const draftedEventCard = page.locator('.event-cards--deck .card').first()
await draftedEventCard.click()
const draftedEventCardBeforeCompendium = await draftedEventCard.getAttribute('aria-pressed')
const eventRunBeforeCompendium = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
await page.keyboard.press('Escape')
const eventPause = page.getByRole('dialog', { name: 'Slay the Spire' })
await eventPause.waitFor()
const eventPauseActions = await eventPause.getByRole('button').allTextContents()
await eventPause.getByRole('button', { name: 'Compendium' }).click()
await page.locator('.compendium').waitFor()
const draftedEventCardDuringCompendium = await draftedEventCard.getAttribute('aria-pressed')
await page.getByRole('button', { name: 'Back to run' }).click()
await page.getByRole('heading', { name: 'Big Fish' }).waitFor()
await page.waitForFunction(() => document.activeElement?.matches('.app-shell'))
const eventRunAfterCompendium = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
const draftedEventCardPreserved = await draftedEventCard.getAttribute('aria-pressed')
await page.screenshot({ path: join(outDir, 'event-4p-compact-desktop.png'), fullPage: true })
const eventShape = await page.evaluate(() => {
  const panel = document.querySelector('.event-panel')
  if (panel) panel.scrollTop = panel.scrollHeight
  const stage = panel?.getBoundingClientRect()
  const last = [...document.querySelectorAll('.event-options button')].at(-1)?.getBoundingClientRect()
  const picker = document.querySelector('.event-cards--deck')
  const card = picker?.querySelector('.card')
  return {
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    options: document.querySelectorAll('.event-options button').length,
    contained: Boolean(stage && last && stage.bottom >= last.bottom - 1),
    cardHeight: card?.getBoundingClientRect().height ?? 0,
    pickerHeight: picker?.getBoundingClientRect().height ?? 0,
    pickerScrollsVertically: Boolean(picker && picker.scrollHeight > picker.clientHeight + 1),
  }
})
check('Event hierarchy remains usable on compact desktop and does not demand irrelevant cards', () => {
  assertDeepEqual(eventRunAfterCompendium, eventRunBeforeCompendium)
  assertEqual(draftedEventCardBeforeCompendium, 'true', 'the Event card was not staged before opening Compendium')
  assertEqual(draftedEventCardDuringCompendium, 'true', 'opening Compendium unmounted the staged Event card')
  assertEqual(draftedEventCardPreserved, 'true', 'opening Compendium cleared the staged Event card')
  assert(eventPauseActions.some((label) => label.trim() === 'Compendium'), 'the Event pause menu hid the Compendium')
  assert(!eventShape.overflow)
  assertEqual(eventShape.options, 4)
  assert(eventShape.contained, 'the final Event choice escaped the compact desktop room frame')
  assert(eventShape.cardHeight > 0 && eventShape.pickerHeight >= eventShape.cardHeight,
    `the Event picker is shorter than one card: ${JSON.stringify(eventShape)}`)
  assertEqual(eventShape.pickerScrollsVertically, false, 'the Event deck is trapped in a nested vertical scroller')
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
await page.locator('fieldset[aria-label="Replace"] .item-card-image').evaluateAll((images) => Promise.all(images.map((image) => image.decode())))
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
// Icons, not card faces: a 1.4rem card face was a 22px thumbnail whose own
// printed name clipped to two letters, so these keys draw bare art like the row.
const localRewardReplacementCards = await page.locator('.reward-screen__players > :first-child .reward-screen__potion button .item-icon-image')
  .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
// The potion belt is a STRIP, and this is the surface that proves it: the reward
// panel sizes to its content, so the shell's tall row used to land on the belt
// and stretch a 62px band to fill the window, pushing the panel down with it.
// The shop cannot show this — its stage has a definite height either way.
// Reward rows share their columns, so a relic row's keys and a potion row's keys
// (which carry a Replace key per held potion) line up. Each row used to be its own
// grid sized against its own text, which put them up to 263px apart.
const rewardColumns = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const staged = structuredClone(before)
  // A relic row AND a potion row, with potions held so the potion row carries an
  // extra Replace key per potion — that asymmetry is what pulled the rows apart.
  staged.players = staged.players.map((player) => ({ ...player, potions: ['swift_potion', 'blood_potion'] }))
  staged.rewards = [{ playerId: staged.players[0].id, cardReward: false, choices: null, upgraded: false,
    potion: 'fire_potion', relic: 'akabeko' }]
  debug.setRun(staged)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const actions = [...document.querySelectorAll('.reward-item__actions')].map((box) => {
    const rect = box.getBoundingClientRect()
    return { left: Math.round(rect.left), width: Math.round(rect.width) }
  })
  const first = document.querySelector('.reward-item')
  const art = first?.querySelector('.item-icon-image, .reward-item__facedown')?.getBoundingClientRect()
  const body = first?.querySelector('.reward-item__body')?.getBoundingClientRect()
  const firstActions = first?.querySelector('.reward-item__actions')?.getBoundingClientRect()
  const measured = {
    rows: actions.length,
    artWidth: art ? Math.round(art.width) : 0,
    actionsRightOfBody: Boolean(body && firstActions && firstActions.left >= body.right - 1),
    leftSpread: actions.length ? Math.max(...actions.map((a) => a.left)) - Math.min(...actions.map((a) => a.left)) : 0,
    widthSpread: actions.length ? Math.max(...actions.map((a) => a.width)) - Math.min(...actions.map((a) => a.width)) : 0,
  }
  debug.setRun(before)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  return measured
})
const beltGeometry = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const run = structuredClone(before)
  // The bar renders the VIEWER's potions, so every seat gets one — which seat is
  // being viewed here depends on everything above. `betweenCombat` is the phase
  // that exposes the shell's row assignment: its panel sizes to its content, so a
  // tall row landing on the belt has somewhere to stretch into.
  run.players = run.players.map((player) => ({ ...player, potions: ['fire_potion'] }))
  run.phase = 'betweenCombat'
  run.rewards = []
  run.roomState = null
  debug.setRun(run)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const belt = document.querySelector('.outside-potions')
  const panel = document.querySelector('.room-screen, .reward-screen, .room-stage')
  const measured = {
    belt: belt ? Math.round(belt.getBoundingClientRect().height) : 0,
    panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : 0,
    viewport: window.innerHeight,
  }
  debug.setRun(before)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  return measured
})
// The only control that finishes the reward screen. `.reward-screen` is its own
// scroller, so on a reward carrying two items AND a card choice this sat below
// the panel's fold with no affordance — the run read as stuck.
// Measured at a SHORT window: at 1440x900 this reward fits well enough that the
// sticky bar never parks on a card, so the check could not fail there.
await page.setViewportSize({ width: 1024, height: 600 })
const rewardCollect = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const before = structuredClone(debug.getRun())
  const staged = structuredClone(before)
  staged.players = staged.players.map((player) => ({ ...player, potions: ['swift_potion', 'blood_potion'] }))
  staged.rewards = [{ playerId: staged.players[0].id, cardReward: true,
    choices: ['twin_strike', 'second_wind', 'limit_break'], upgraded: true,
    potion: 'fire_potion', relic: 'akabeko' }]
  debug.setRun(staged)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const panel = document.querySelector('.reward-screen')
  const collect = document.querySelector('.reward-screen__collect')
  const measured = collect && panel ? (() => {
    const panelBox = panel.getBoundingClientRect()
    const box = collect.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return {
      rendered: true,
      // Without scrolling first: it has to be reachable the moment the screen opens.
      inside: box.bottom <= panelBox.bottom + 1 && box.top >= panelBox.top - 1,
      // And the FIRST child must not be above the panel's top edge. A panel that
      // overflows and is centred rather than `safe center`-ed pushes its own title
      // out of the scrollport, where no scroll position can reach it.
      firstChildAbove: (() => {
        const first = panel.firstElementChild?.getBoundingClientRect()
        return first ? Math.round(panelBox.top - first.top) : 0
      })(),
      hittable: Boolean(hit && (hit === collect || collect.contains(hit))),
      scrolls: panel.scrollHeight - panel.clientHeight,
      barOffBottom: Math.round(panelBox.bottom - box.bottom),
      choices: document.querySelectorAll('.reward-screen__cards .card').length,
      // The reward screen shares the shop's card-text ramp but feeds a different
      // card width through it, and no check selected it: deleting the reward half
      // of the override left every check green.
      cardRulesFont: (() => {
        const rules = document.querySelector('.reward-screen__cards .card-face__rules')
        return rules ? parseFloat(getComputedStyle(rules).fontSize) : 0
      })(),
      cardWidth: Math.round(document.querySelector('.reward-screen__cards .card')?.getBoundingClientRect().width ?? 0),
      cardRulesClipped: [...document.querySelectorAll('.reward-screen__cards .card-face__rules')]
        .filter((panel) => panel.scrollHeight > panel.clientHeight + 1).length,
    }
  })() : { rendered: false }
  debug.setRun(before)
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  return measured
})
await page.setViewportSize({ width: 1440, height: 900 })
check('the reward screen keeps its collect control on screen', () => {
  assert(rewardCollect.rendered, 'the collect control did not render')
  assert(rewardCollect.scrolls > 0, 'this reward fits without scrolling, so the check proves nothing')
  assert(rewardCollect.inside, 'the collect control sat outside the reward panel on load')
  assert(rewardCollect.hittable, 'the collect control was not clickable at its own centre')
  assert(rewardCollect.choices >= 3, `only ${rewardCollect.choices} card choice(s) rendered to test against`)
  assertEqual(rewardCollect.cardRulesClipped, 0,
    `${rewardCollect.cardRulesClipped} reward card face(s) clipped their own rules text`)
  assert(rewardCollect.cardRulesFont >= Math.min(rewardCollect.cardWidth * 0.068, 11.2),
    `reward card rules text is ${rewardCollect.cardRulesFont.toFixed(2)}px on a ${rewardCollect.cardWidth}px card`)
  // The collect bar sits ON the panel's bottom edge, not floating above the rows:
  // a `padding-bottom` on the scroller lifts a sticky inset by that much.
  assert(rewardCollect.barOffBottom <= 4,
    `the collect bar floated ${rewardCollect.barOffBottom}px above the panel's bottom edge`)
  assert(rewardCollect.firstChildAbove <= 1,
    `the reward panel's first row sat ${rewardCollect.firstChildAbove}px above its own top edge, out of reach`)
})

check('reward rows share one set of columns', () => {
  // Shape first. Deleting `subgrid` collapses each row to a single stacked column,
  // which lines every action box up at the same left edge and the same width — so
  // the spreads below read 0 for the worst regression there is.
  // A LOWER bound too, set between the two: the art fills its column at 39px, and
  // without `width: 100%` it falls back to the app's global 1.8rem icon at 29px,
  // which the upper bound alone happily allowed.
  assert(rewardColumns.artWidth >= 34 && rewardColumns.artWidth <= 72,
    `the row's art column is ${rewardColumns.artWidth}px, so the row is not laid out in columns`)
  assert(rewardColumns.actionsRightOfBody,
    'a row put its actions below its name instead of beside it')
  assert(rewardColumns.rows >= 2, `only ${rewardColumns.rows} reward row(s) to compare`)
  assertEqual(rewardColumns.leftSpread, 0, `reward action columns start ${rewardColumns.leftSpread}px apart`)
  assertEqual(rewardColumns.widthSpread, 0, `reward action columns differ in width by ${rewardColumns.widthSpread}px`)
})
check('the potion belt stays a strip instead of taking the shell\'s tall row', () => {
  assert(beltGeometry.belt > 0, 'the potion belt did not render for a party holding potions')
  assert(beltGeometry.belt <= 96, `the potion belt stretched to ${beltGeometry.belt}px`)
  assert(beltGeometry.panelTop < beltGeometry.viewport / 2,
    `the reward panel started ${beltGeometry.panelTop}px down a ${beltGeometry.viewport}px window`)
})
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
// Cursor parked first: left where a previous screen put it, the map slides under
// it during scroll-into-view, a row-1 node takes `:hover`, and its tooltip covers
// the row-0 node this clicks — a 30s timeout that kills the run before `report()`.
await page.mouse.move(0, 0)
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
await page.getByRole('complementary', { name: 'The Courier offer' })
  .getByText('The Courier · Anchor', { exact: true }).waitFor()
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
  await openMerchantShop(onlinePage)
  onlineContexts.push(context)
  onlinePages.push(onlinePage)
}
const [ann, bo] = onlinePages
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, gold: index === 0 ? 1 : 0 }))
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await openMerchantShop(ann)
const insufficientMerchantDisabled = await ann.getByRole('button', { name: /Anchor/ }).isDisabled()
liveRoom.run.players = liveRoom.run.players.map((player, index) => ({ ...player, gold: [1, 4, 12, 12][index] }))
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await openMerchantShop(ann)
await ann.getByRole('button', { name: /Anchor/ }).click()
await ann.getByRole('button', { name: 'Cancel relic purchase and return all contributions' }).waitFor()
await ann.getByRole('button', { name: /Leave shop/ }).click()
const pendingMerchantLeaveDisabled = await ann.getByRole('button', { name: /Proceed/ }).isDisabled()
const pendingMerchantLeaveFrame = await ann.getByRole('button', { name: /Proceed/ }).evaluate((button) => {
  const frame = button.closest('.merchant-arrival')?.getBoundingClientRect()
  const bounds = button.getBoundingClientRect()
  return Boolean(frame && bounds.width > 120 && bounds.left >= frame.left && bounds.right <= frame.right)
})
await openMerchantShop(ann)
await ann.screenshot({ path: join(outDir, 'merchant-4p-funded-online.png'), fullPage: true })
const competingBuyerDisabled = await bo.getByRole('button', { name: /Anchor/ }).isDisabled()
await bo.getByLabel('Shopping for').selectOption(onlineSeats[0].playerId)
const teammateRemovalDisabled = await bo.getByRole('button', { name: /Card Removal Service/ }).isDisabled()
await bo.getByRole('button', { name: /Anchor/ }).click()
await ann.getByRole('button', { name: /Sold/ }).first().waitFor()
await ann.reload({ waitUntil: 'networkidle' })
await openMerchantShop(ann)
await ann.getByRole('heading', { name: 'The Merchant' }).waitFor()
await ann.getByRole('button', { name: /Sold/ }).first().waitFor()
await bo.setViewportSize({ width: 1280, height: 800 })
await bo.screenshot({ path: join(outDir, 'merchant-4p-reconnect-compact-desktop.png'), fullPage: true })
const compactOnline = await bo.evaluate(() => {
  const leave = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Leave shop'))
  const stage = document.querySelector('.room-stage')?.getBoundingClientRect()
  return { width: document.documentElement.scrollWidth, viewport: innerWidth, leave: Boolean(leave), contained: Boolean(stage && leave && stage.bottom >= leave.getBoundingClientRect().bottom - 1), wide: [...document.querySelectorAll('*')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map((element) => `${element.tagName}.${element.className}:${Math.round(element.getBoundingClientRect().right)}`) }
})
const privateSnapshot = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[0].token } }).then((response) => response.json())
check('four-seat shared funding is buyer-authorized, atomic, and reconnect-stable', () => {
  assert(insufficientMerchantDisabled, 'Merchant accepted a new pledge the party could not complete')
  assert(competingBuyerDisabled, 'shared Merchant offer remained enabled for a competing buyer')
  assert(teammateRemovalDisabled, 'a teammate could open an empty redacted-deck removal picker')
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
await openMerchantShop(ann)
await ann.getByRole('button', { name: /Happy Flower/ }).click()
await cyMerchant.reload({ waitUntil: 'networkidle' })
await openMerchantShop(cyMerchant)
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
await openMerchantShop(ann)
await ann.setViewportSize({ width: 1280, height: 720 })
await ann.getByRole('button', { name: /Fire Potion/ }).click()
const merchantReplacement = ann.getByRole('group', { name: 'Replace potion' })
await merchantReplacement.getByRole('button', { name: /Swift Potion/ }).click()
const selectedReplacement = merchantReplacement.getByRole('button', { name: /Swift Potion/, pressed: true })
await selectedReplacement.waitFor()
const replacementSelectedColor = await selectedReplacement.evaluate((button) => getComputedStyle(button).color)
const firePotionConfirm = ann.getByRole('button', { name: 'Confirm Fire Potion' })
const competingPotionKey = `${onlineSeats[1].playerId}/potion/0`
liveRoom.merchantPledges = { [competingPotionKey]: {
  buyerId: onlineSeats[1].playerId, section: 'potion', slot: 0, payments: { [onlineSeats[1].playerId]: 0 },
} }
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.waitForFunction(() => document.querySelector('.merchant-potion-dialog__confirm')?.disabled)
const reservedPotionConfirmDisabled = await firePotionConfirm.isDisabled()
liveRoom.merchantPledges = undefined
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.waitForFunction(() => !document.querySelector('.merchant-potion-dialog__confirm')?.disabled)
liveRoom.run.roomState.potions[0] = null
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.getByRole('dialog', { name: 'Choose a potion to replace' }).waitFor({ state: 'hidden' })
const completedPotionClosedReplacement = await merchantReplacement.count()
liveRoom.run.roomState.potions[0] = 'fire_potion'
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.getByRole('button', { name: /Fire Potion/ }).click()
await merchantReplacement.getByRole('button', { name: /Swift Potion/ }).click()
await merchantReplacement.getByRole('button', { name: /Swift Potion/, pressed: true }).waitFor()
// Icons, not card faces: the replacement tiles print the potion's name beside
// the art, so a generated card face repeated that name in unreadable type.
const merchantReplacementCards = await merchantReplacement.locator('.item-icon-image')
  .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
const replacementGeometry = await ann.evaluate(() => {
  const stage = document.querySelector('.merchant-shop-stage')
  const title = document.querySelector('#merchant-title')?.getBoundingClientRect()
  const leave = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Leave shop'))?.getBoundingClientRect()
  return { stageScroll: stage?.scrollTop ?? -1, titleTop: title?.top ?? -1, leaveBottom: leave?.bottom ?? Infinity, viewport: innerHeight }
})
await ann.screenshot({ path: join(outDir, 'merchant-potion-replacement.png'), fullPage: true })
await firePotionConfirm.click()
await ann.setViewportSize({ width: 1280, height: 800 })
const potionContributor = onlinePages[2]
await potionContributor.reload({ waitUntil: 'networkidle' })
await openMerchantShop(potionContributor)
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
  assert(reservedPotionConfirmDisabled, 'a competing buyer reservation left potion confirmation enabled')
  assertEqual(completedPotionClosedReplacement, 0, 'a completed competing purchase left a dead replacement dialog open')
  assertEqual(replacementSelectedColor, 'rgb(42, 28, 7)', 'selected potion text is low contrast on the gold plate')
  assertEqual(replacementGeometry.stageScroll, 0, 'potion replacement scrolled the Merchant stage')
  assert(replacementGeometry.titleTop >= 0, 'potion replacement hid the Merchant title')
  assert(replacementGeometry.leaveBottom <= replacementGeometry.viewport + 1, 'potion replacement clipped Leave shop')
  assert(liveRoom.run.players[0].potions.includes('fire_potion'))
  assert(!liveRoom.run.players[0].potions.includes('swift_potion'))
})
await ann.waitForFunction(() => document.querySelectorAll('.merchant-potion-discard button[aria-pressed="true"]').length === 0)
await ann.getByRole('button', { name: /Swift Potion/ }).click()
const stalePotionReplacement = await merchantReplacement.getByRole('button', { pressed: true }).count()
const replacementConfirm = ann.getByRole('button', { name: 'Confirm Swift Potion' })
const consecutivePotionDisabled = await replacementConfirm.isDisabled()
await merchantReplacement.getByRole('button', { name: /Blood Potion/ }).click()
const consecutivePotionEnabled = await replacementConfirm.isEnabled()
await ann.getByRole('dialog', { name: 'Choose a potion to replace' }).getByRole('button', { name: 'Cancel' }).click()
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
await openMerchantShop(ann)
await ann.locator('.connection--connected').waitFor()
const removalContributor = onlinePages[2]
await removalContributor.reload({ waitUntil: 'networkidle' })
await openMerchantShop(removalContributor)
await removalContributor.locator('.connection--connected').waitFor()
await removalContributor.getByLabel('Shopping for').selectOption(onlineSeats[0].playerId)
const pendingRemovalServiceEnabled = await removalContributor.getByRole('button', { name: /Card Removal Service/ }).isEnabled()
await removalContributor.getByRole('button', { name: /Card Removal Service/ }).click()
const pendingRemovalPledgeEnabled = await removalContributor.getByRole('button', { name: /Pledge/ }).isEnabled()
await removalContributor.getByRole('dialog', { name: 'Choose a card to remove' }).getByRole('button', { name: 'Cancel' }).click()
await ann.getByRole('button', { name: /Card Removal Service/ }).click()
const removalGroup = ann.getByRole('group', { name: 'Card to remove' })
const restoredRemovalSelectedCount = await removalGroup.getByRole('button', { pressed: true }).count()
const restoredRemovalPledgedPressed = await removalGroup.getByRole('button').nth(pendingRemovalIndex).getAttribute('aria-pressed')
const restoredRemovalLocked = await removalGroup.getByRole('button').nth(pendingRemovalIndex).getAttribute('aria-disabled')
check('Merchant reconnect restores and locks the removal owner’s authorized card', () => {
  assert(pendingRemovalServiceEnabled, 'a contributor could not open a funded removal')
  assert(pendingRemovalPledgeEnabled, 'a contributor could not fund the pending removal')
  assertEqual(restoredRemovalSelectedCount, 1, 'exactly one card is marked selected')
  assertEqual(restoredRemovalPledgedPressed, 'true', 'the SPECIFIC pledged card (by position, not just by name) is the one selected')
  assertEqual(restoredRemovalLocked, 'true')
})
liveRoom.run.roomState.removalUsed.push(onlineSeats[0].playerId)
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.getByRole('dialog', { name: 'Choose a card to remove' }).waitFor({ state: 'hidden' })
const completedRemovalServiceDisabled = await ann.getByRole('button', { name: /Card Removal Service/ }).isDisabled()
check('Merchant closes a stale removal picker when another client completes the service', () => {
  assert(completedRemovalServiceDisabled)
})
liveRoom.run.roomState.removalUsed = liveRoom.run.roomState.removalUsed.filter((id) => id !== onlineSeats[0].playerId)
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
liveRoom.merchantPledges = undefined
liveRoom.version += 1

liveRoom.run.players[0] = { ...liveRoom.run.players[0], relics: [...liveRoom.run.players[0].relics, { defId: 'sozu', spent: false }] }
liveRoom.version += 1
await ann.reload({ waitUntil: 'networkidle' })
await openMerchantShop(ann)
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

liveRoom.seats[3].connected = false
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.getByRole('button', { name: /Leave shop/ }).click()
await ann.getByRole('button', { name: /0\/3 ready/ }).waitFor()
const disconnectedMerchantCharacters = await ann.locator('.merchant-arrival__party img').count()
liveRoom.seats[3].connected = true
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await ann.getByRole('button', { name: /0\/4 ready/ }).waitFor()
await openMerchantShop(ann)
check('online Merchant arrival matches its connected-player quorum', () => {
  assertEqual(disconnectedMerchantCharacters, 3)
})

await ann.getByRole('button', { name: /Leave shop/ }).click()
liveRoom.merchantReady = [onlineSeats[0].playerId]
liveRoom.version += 1
const staleResume = ann.waitForResponse((response) =>
  response.url().endsWith(`/api/rooms/${create.snapshot.code}/action`) && response.request().postData()?.includes('merchantResume'))
await Promise.all([staleResume, ann.getByRole('button', { name: 'Enter merchant shop' }).click()])
const staleMerchantReadyCleared = !liveRoom.merchantReady?.includes(onlineSeats[0].playerId)
check('online Merchant re-entry clears readiness even before the finish snapshot arrives', () => {
  assert(staleMerchantReadyCleared, 'stale arrival state skipped the idempotent Merchant resume')
})

await ann.getByRole('button', { name: /Leave shop/ }).click()
const pendingVotePledgeKey = `${onlineSeats[1].playerId}/relic/0`
liveRoom.merchantReady = [onlineSeats[0].playerId]
liveRoom.merchantPledges = { [pendingVotePledgeKey]: {
  buyerId: onlineSeats[1].playerId, section: 'relic', slot: 0, payments: { [onlineSeats[1].playerId]: 1 },
} }
liveRoom.giveUpVote = {
  runId: liveRoom.run.campaign.runId,
  deadlineAt: Date.now() + 750,
  eligiblePlayerIds: liveRoom.run.players.map((player) => player.id),
  votes: {},
}
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
const merchantGiveUp = ann.getByRole('dialog', { name: 'Give up this run?' })
await merchantGiveUp.waitFor()
await merchantGiveUp.waitFor({ state: 'hidden' })
await ann.waitForTimeout(300)
const merchantExpiryError = await ann.locator('.online-error').allTextContents()
check('Merchant Give Up expiry preserves pending contributions without a retry error', () => {
  assertEqual(liveRoom.run.phase, 'room')
  assert(liveRoom.merchantPledges?.[pendingVotePledgeKey], 'Give Up expiry lost a pending Merchant contribution')
  assertDeepEqual(merchantExpiryError, [])
})
liveRoom.giveUpVote = undefined
liveRoom.merchantPledges = undefined
liveRoom.merchantReady = undefined
liveRoom.version += 1
rooms.publishRoom(create.snapshot.code)
await openMerchantShop(ann)

await ann.getByRole('button', { name: /Leave shop/ }).click()
await ann.getByRole('button', { name: /Proceed/ }).click()
await ann.getByRole('button', { name: /Waiting for party/ }).waitFor()
await ann.getByRole('button', { name: 'Enter merchant shop' }).click()
await ann.getByLabel('Shopping for').waitFor()
await ann.getByRole('button', { name: /Leave shop/ }).click()
await ann.getByRole('button', { name: /Proceed/ }).waitFor()
const resumedMerchant = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[0].token } }).then((response) => response.json())
await ann.getByRole('button', { name: /Proceed/ }).click()
await ann.getByRole('button', { name: /Waiting for party/ }).waitFor()
for (const voter of onlinePages.slice(1, 3)) {
  await voter.getByRole('button', { name: /Leave shop/ }).click()
  await voter.getByRole('button', { name: /Proceed/ }).click()
  await voter.getByRole('button', { name: /Waiting for party/ }).waitFor()
}
const onlineMerchantReady = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}`, { headers: { 'x-room-token': onlineSeats[0].token } }).then((response) => response.json())
await onlinePages[3].getByRole('button', { name: /Leave shop/ }).click()
await onlinePages[3].getByRole('button', { name: /Proceed/ }).click()
await onlinePages[3].locator('.map').waitFor()
check('online Merchant proceed is unanimous and reconnect-visible', () => {
  assert(!resumedMerchant.merchantReady.includes(onlineSeats[0].playerId), 'resuming the shop kept Ann ready')
  assertDeepEqual(onlineMerchantReady.merchantReady, onlineSeats.slice(0, 3).map((seat) => seat.playerId))
  assertEqual(liveRoom.run.phase, 'map')
})

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
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByText('Campaign journal').waitFor()
page.once('dialog', (dialog) => dialog.accept())
await page.keyboard.press('Escape')
await page.getByRole('dialog', { name: 'Slay the Spire' }).getByRole('button', { name: 'Return to main menu' }).click()
await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Embark' }).click()
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
await page.getByRole('button', { name: 'Embark' }).click()
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
