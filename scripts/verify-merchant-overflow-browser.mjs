import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { SKIN_IDS, skinsOf } from '../src/game/skins.ts'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { CHARACTER_LABEL } from '../src/ui/run-summary-data.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/merchant-overflow-browser`
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } })
await server.listen()
const browser = await chromium.launch()
const errors = []
// A hero with several skins needs several rounds: round N seats every base hero in its Nth skin (a hero with fewer
// skins keeps its last look), so the arrival party stands as every registered skin in some round. A skinned hero of
// another ruleset (Slime Boss) joins three plain base heroes, once per skin.
const BASE_HEROES = ['silent', 'ironclad', 'watcher', 'defect']
const seat = (character, index, skin) => ({ id: `p${index + 1}`, name: CHARACTER_LABEL[character], character, ...(skin ? { skin } : {}) })
const guests = CHARACTER_IDS.filter((character) => !BASE_HEROES.includes(character) && skinsOf(character).length > 0)
const rounds = [
  ...Array.from({ length: Math.max(...BASE_HEROES.map((character) => skinsOf(character).length)) }, (_, round) =>
    BASE_HEROES.map((character, index) => {
      const skins = skinsOf(character)
      return seat(character, index, skins[Math.min(round, skins.length - 1)])
    })),
  ...guests.flatMap((guest) => skinsOf(guest).map((skin) => [seat(guest, 0, skin), ...BASE_HEROES.slice(0, 3).map((character, index) => seat(character, index + 1))])),
]
const [seats] = rounds
const standingParties = [
  ...rounds,
  ['ironclad', 'guardian', 'hermit', 'watcher'].map((character, index) => ({ id: `p${index + 1}`, name: CHARACTER_LABEL[character], character })),
  ['silent', 'defect'].map((character, index) => ({ id: `p${index + 1}`, name: CHARACTER_LABEL[character], character })),
  [rounds[0][3], rounds[0][2], rounds[0][0]],
  [rounds[0][3]],
]
const visualOf = (seat) => seat.skin ?? seat.character
assert.deepEqual(SKIN_IDS.filter((skin) => !rounds.flat().some((seat) => seat.skin === skin)), [],
  'every registered skin needs a seat in some round')
/** Measure painted bounds, including the transparent padding that differs between standing assets. */
const feetAgainstFloor = (page) => page.locator('.merchant-arrival__party').evaluate(async (party) => {
  const floor = party.getBoundingClientRect().bottom
  return Promise.all([...party.querySelectorAll('[data-character] img')].map(async (image) => {
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let bottom = 0, top = canvas.height
    for (let y = canvas.height - 1; y >= 0 && !bottom; y--) {
      for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3] > 32) { bottom = y + 1; break }
    }
    for (let y = 0; y < canvas.height && top === canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3] > 32) { top = y; break }
    }
    const rect = image.getBoundingClientRect()
    const slot = image.closest('figure').getBoundingClientRect()
    const height = (bottom - top) * rect.height / canvas.height
    const id = image.closest('[data-character]').getAttribute('data-character')
    if (Math.abs(height - slot.width * 1.5) > 1) throw new Error(`${id}: painted height ${height} must match the common standing height ${slot.width * 1.5}`)
    if (rect.top + top * rect.height / canvas.height < 0 || rect.bottom > document.documentElement.clientHeight || rect.left < 0 || rect.right > document.documentElement.clientWidth) {
      throw new Error(`${id}: standing sprite extends outside the viewport`)
    }
    const feet = rect.bottom - (canvas.height - bottom) * (rect.height / canvas.height)
    return [image.closest('[data-character]').getAttribute('data-character'), Math.round((feet - floor) * 10) / 10]
  }))
})
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const page = await browser.newPage({ viewport, ...(name === 'horizontal-phone' ? { isMobile: true, hasTouch: true } : {}) })
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => (errors.push(String(error)), console.error(String(error))))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const arrivalChecks = async (partySeats, label) => {
      await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), merchantRun(partySeats))
      await page.locator('.merchant-arrival__party [data-character] img').first().waitFor()
      // A skinned seat stands as its skin; every other seat keeps its own hero's figure.
      for (const seat of partySeats.filter((candidate) => candidate.skin)) {
        const skinned = page.locator(`.merchant-arrival__party [data-character="${seat.skin}"] img`)
        await skinned.evaluate(async (image) => { await image.decode() })
        assert(await skinned.isVisible(), `${label}: the ${seat.skin} skin must appear in the merchant arrival party`)
        assert.match(await skinned.getAttribute('src'), new RegExp(`/noncombat/merchant/characters/${seat.skin}-standing\\.webp$`),
          `${label}: the skinned ${seat.character} uses the ${seat.skin} standing figure`)
      }
      assert.deepEqual(await page.locator('.merchant-arrival__party [data-character] img').evaluateAll((images) => images.map((image) =>
        [image.closest('[data-character]').getAttribute('data-character'), image.getAttribute('src').split('/').pop()])),
      partySeats.map((seat) => [visualOf(seat), `${visualOf(seat)}-standing.webp`]),
      `${label}: every merchant arrival seat stands as its own visual id`)
      await page.locator('[data-webmcp-pending="true"]').waitFor({ state: 'detached' })
      await page.waitForFunction(() => !document.documentElement.dataset.mapTransition)
      const feet = await feetAgainstFloor(page)
      assert.deepEqual(feet.filter(([, offset]) => Math.abs(offset) > 2), [], `${label}: every figure's feet sit within 2px of the party's floor line`)
      return feet
    }
    const merchantRun = (partySeats) => {
      const fixture = postNeowRun('merchant-overflow', partySeats)
      fixture.campaign.runId = `merchant-overflow-${partySeats.map(visualOf).join('-')}`
      fixture.players.forEach((player) => { player.gold = 30 })
      Object.assign(fixture.players[0], { hp: 6, maxHp: 9 })
      fixture.players[0].deck[0] = { ...fixture.players[0].deck[0], defId: 'parasite' }
      fixture.phase = 'room'
      fixture.roomState = {
        kind: 'merchant', relics: ['wing_boots', 'toxic_egg', 'anchor'],
        potions: ['weak_potion', 'fire_potion', 'swift_potion'],
        colorless: ['trip', 'hand_of_greed', 'mayhem'],
        cards: Object.fromEntries(fixture.players.map((player) => [player.id, {
          choices: player.cardRewards.slice(0, 3), cardsDrawn: player.cardRewards.slice(0, 3), raresDrawn: [],
        }])), removalUsed: [], purchasedCards: {},
      }
      return fixture
    }
    for (const [round, partySeats] of standingParties.entries()) {
      const feet = await arrivalChecks(partySeats, `${name} round ${round + 1}`)
      console.log(`${name} round ${round + 1} feet vs floor px:`, JSON.stringify(feet))
      if (round > 0) await page.screenshot({ path: `${output}/${name}-skins-arrival-${round + 1}.png` })
    }
    await arrivalChecks(seats, `${name} round 1 again`)
    await page.screenshot({ path: `${output}/${name}-skins-arrival.png` })
    await page.getByRole('button', { name: 'Enter merchant shop' }).click()
    const stage = page.locator('.merchant-shop-stage')
    await stage.waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.players.forEach((player) => { player.gold = 0 })
      window.__STS_DEBUG__.setRun(run)
    })
    const removal = page.getByRole('button', { name: /Card Removal Service/ })
    assert(await removal.isDisabled(), 'card removal must be disabled without Gold')
    await removal.evaluate(button => button.click())
    assert.equal(await page.locator('.merchant-removal-dialog').isVisible(), false,
      'an unaffordable removal must not open the card picker')
    for (const [ascension, gold, affordable] of [
      [0, [2, 0, 0, 0], false],
      [0, [1, 2, 0, 0], true],
      [8, [1, 2, 0, 0], false],
      [8, [1, 3, 0, 0], true],
    ]) {
      await page.evaluate(({ ascension, gold }) => {
        const run = structuredClone(window.__STS_DEBUG__.getRun())
        run.ascension = ascension
        run.players.forEach((player, index) => { player.gold = gold[index] })
        window.__STS_DEBUG__.setRun(run)
      }, { ascension, gold })
      assert.equal(await removal.isEnabled(), affordable,
        `removal affordability at Ascension ${ascension} with ${gold.join('+')} Gold`)
    }
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.ascension = 0
      run.players.forEach((player) => { player.gold = 30 })
      window.__STS_DEBUG__.setRun(run)
    })
    const dimensions = () => stage.evaluate((element) => ({
      width: element.scrollWidth, height: element.scrollHeight,
      clientWidth: element.clientWidth, clientHeight: element.clientHeight,
    }))
    const before = await dimensions()
    const deckSize = merchantRun(seats).players[0].deck.length
    await page.getByRole('button', { name: /Card Removal Service/ }).click()
    await page.getByRole('group', { name: 'Card to remove' }).getByRole('button', { name: /Parasite/ }).click()
    await page.getByRole('button', { name: /Remove selected card/ }).click()
    await page.waitForFunction((size) => window.__STS_DEBUG__.getRun().players[0].deck.length === size - 1, deckSize)
    await page.getByRole('img', { name: 'Health 4 of 9', exact: true }).waitFor()
    const hand = stage.locator('.merchant-hand')
    await hand.evaluate(async (element) => {
      for (const animation of element.getAnimations()) { animation.pause(); animation.currentTime = 400 }
      await element.decode()
    })
    await page.locator('.card-morph').waitFor({ state: 'detached' })
    const during = await dimensions()
    assert.deepEqual(during, before, 'the pointing animation grew the merchant scroll area')
    await page.screenshot({ path: `${output}/${name}-removal-animation.png` })
    await hand.evaluate((element) => element.getAnimations().forEach((animation) => animation.play()))
    await hand.waitFor({ state: 'detached' })
    assert.deepEqual(await dimensions(), before, 'completed removal left overflow behind')
    assert(await page.getByRole('button', { name: /Card Removal Service/ }).isDisabled())
    await page.mouse.move(0, 0)
    await page.locator('.merchant-tooltip:visible').waitFor({ state: 'hidden' })
    await page.screenshot({ path: `${output}/${name}-after-removal.png` })
    await page.getByRole('button', { name: /Leave shop/ }).scrollIntoViewIfNeeded()
    assert(await page.getByRole('button', { name: /Leave shop/ }).isVisible())
    // Purchases share this effect. Replacing an in-flight hand must clean up the latest one.
    await page.getByRole('button', { name: /Wing Boots/ }).click()
    const firstHand = await hand.elementHandle()
    await page.getByRole('button', { name: /Anchor/ }).click()
    assert.equal(await firstHand.evaluate((element) => element.isConnected), false)
    await hand.evaluate((element) => {
      const layer = element.parentElement
      const targetY = Number.parseFloat(element.style.getPropertyValue('--merchant-point-y'))
      if (targetY > layer.clientHeight) throw new Error('scrolled merchandise lies outside the pointing layer')
      element.getAnimations().forEach((animation) => animation.finish())
    })
    await hand.waitFor({ state: 'detached' })
    assert.equal((await dimensions()).width, before.width)
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
    await page.getByRole('button', { name: /Weak Potion/ }).click()
    await hand.waitFor({ state: 'detached' })
    assert(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].potions.includes('weak_potion')))
    assert.equal(await stage.locator('.merchant-hand-layer').count(), 0)
    assert.equal((await dimensions()).width, before.width)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('✓ Merchant equal standing heights, aligned feet and overflow: removal animation and settled layout passed on desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
