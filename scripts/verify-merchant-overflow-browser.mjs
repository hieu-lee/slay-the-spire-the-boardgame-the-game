import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/merchant-overflow-browser`
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
const errors = []
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const page = await browser.newPage({ viewport })
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => (errors.push(String(error)), console.error(String(error))))
    await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const fixture = postNeowRun('merchant-overflow', [
      { id: 'p1', name: 'Silent', character: 'silent' },
      { id: 'p2', name: 'Ironclad', character: 'ironclad' },
    ])
    fixture.players.forEach((player) => { player.gold = 30 })
    fixture.phase = 'room'
    fixture.roomState = {
      kind: 'merchant', relics: ['wing_boots', 'toxic_egg', 'anchor'],
      potions: ['weak_potion', 'fire_potion', 'swift_potion'],
      colorless: ['trip', 'hand_of_greed', 'mayhem'],
      cards: Object.fromEntries(fixture.players.map((player) => [player.id, {
        choices: player.cardRewards.slice(0, 3), cardsDrawn: player.cardRewards.slice(0, 3), raresDrawn: [],
      }])), removalUsed: [], purchasedCards: {},
    }
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fixture)
    await page.getByRole('button', { name: 'Enter merchant shop' }).click()
    const stage = page.locator('.merchant-shop-stage')
    await stage.waitFor()
    await page.evaluate(() => document.fonts.ready)
    const dimensions = () => stage.evaluate((element) => ({
      width: element.scrollWidth, height: element.scrollHeight,
      clientWidth: element.clientWidth, clientHeight: element.clientHeight,
    }))
    const before = await dimensions()
    const deckSize = fixture.players[0].deck.length
    await page.getByRole('button', { name: /Card Removal Service/ }).click()
    await page.getByRole('group', { name: 'Card to remove' }).getByRole('button').first().click()
    await page.getByRole('button', { name: /Remove selected card/ }).click()
    await page.waitForFunction((size) => window.__STS_DEBUG__.getRun().players[0].deck.length === size - 1, deckSize)
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
  console.log('✓ Merchant overflow: removal animation and settled layout passed on desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
