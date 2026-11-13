import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/slime-hover-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
const installFixture = async ({ partySize }) => {
  const [React, ReactDOM, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }, { bruiserSlime }] = await Promise.all([
    import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
    import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
    import('/src/game/downfall/slime-boss.ts'), import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
  ])
  document.querySelector('#root').style.display = 'none'
  const host = document.createElement('div')
  host.id = 'slime-hover-fixture'
  host.className = 'app-shell app-shell--combat sts-scope'
  host.style.gridTemplateRows = 'minmax(0, 1fr)'
  document.body.append(host)
  const rng = createRng(47)
  const player = createPlayer(rng, 'p1', 'Slime Boss', 'slime_boss', 0)
  player.slimes = ['bruiser', 'armored', 'taunting'].map((name, index) => ({
    ...bruiserSlime('hover-' + name),
    card: { uid: 'hover-' + name, defId: 'slime_boss_' + name + '_slime', upgraded: index === 1 },
  }))
  player.hand = ['slime_boss_strike', 'slime_boss_defend', 'slime_boss_lick', 'slime_boss_strike', 'slime_boss_defend']
    .map((defId, index) => ({ uid: 'hover-hand-' + index, defId, upgraded: false }))
  player.relics = []
  player.powers = [{ uid: 'hover-power', defId: 'inflame', upgraded: false }]
  const players = [player, ...Array.from({ length: partySize - 1 }, (_, i) => {
    const other = createPlayer(rng, 'p' + (i + 2), 'Slime ally ' + (i + 2), 'slime_boss', 0)
    other.row = i + 1
    other.slimes = player.slimes.map((slime, n) => ({ ...slime, card: { ...slime.card, uid: 'ally-' + i + '-' + n } }))
    other.relics = []; other.powers = [{ uid: 'ally-power-' + i, defId: 'inflame', upgraded: false }]
    other.hand = []; return other
  })]
  const state = createCombat(rng, players, [{
    uid: 'hover-enemy', defId: 'cultist', row: 0, hp: 100, maxHp: 100, block: 0, strength: 0,
    vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
  }])
  state.presentationEvents = []
  const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host)
  root.render((React.createElement ?? React.default.createElement)(CombatScreen, {
    state, act: 1, viewerId: 'p1', autoAdvance: false, onAction: () => {},
  }))
}

try {
  for (const [name, viewport, phone, partySize] of [
    ['desktop', { width: 1440, height: 900 }, false, 1],
    ['short-desktop-party', { width: 1280, height: 650 }, false, 4],
    ['horizontal-phone', { width: 844, height: 390 }, true, 1],
    ['horizontal-phone-party', { width: 844, height: 390 }, true, 4],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(60_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'text/javascript', body: '' }))
      await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })
      await page.evaluate(installFixture, { partySize })
      await page.locator('.slime-party__art').first().waitFor()
      assert.equal(await page.locator('.slime-party').count(), partySize, name + ': every player has a visible slime party')
      await page.waitForFunction(() => [...document.querySelectorAll('.slime-party__art')]
        .every(image => image.complete && image.naturalWidth > 0))
      await page.evaluate(() => document.fonts.ready)
      for (const actor of await page.locator('.slime-party__actor').all()) {
        await actor.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        await page.mouse.move(0, 0)
        const point = await actor.evaluate(element => {
          const image = element.querySelector('.slime-party__art')
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
          const ctx = canvas.getContext('2d')
          ctx.drawImage(image, 0, 0)
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          let left = canvas.width, right = 0, top = canvas.height, bottom = 0
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            if (pixels[(y * canvas.width + x) * 4 + 3] > 128) {
              left = Math.min(left, x); right = Math.max(right, x + 1)
              top = Math.min(top, y); bottom = Math.max(bottom, y + 1)
            }
          }
          const box = image.getBoundingClientRect()
          const scale = Math.min(box.width / canvas.width, box.height / canvas.height)
          const x = box.left + (box.width - canvas.width * scale) / 2 + (left + right) * scale / 2
          const y = box.bottom - (canvas.height - (top + bottom) / 2) * scale
          const hit = document.elementFromPoint(x, y)
          return { x, y, reachable: hit?.closest('.slime-party__actor') === element,
            blockedBy: hit?.className, slime: element.dataset.slimeUid }
        })
        assert(point.reachable, `${name}: painted slime is obstructed: ${JSON.stringify(point)}`)
        const expected = await actor.getAttribute('data-slime-def')
        const label = {
          slime_boss_bruiser_slime: 'Bruiser Slime',
          slime_boss_armored_slime: 'Armored Slime+',
          slime_boss_taunting_slime: 'Taunting Slime',
        }[expected]
        if (phone) await actor.tap()
        else await page.mouse.move(point.x, point.y)
        await page.locator('.slime-party__zoom .card').waitFor()
        assert.equal(await page.locator('.slime-party__zoom .card').getAttribute('data-card-name'), label)
        const zoom = await page.locator('.slime-party__zoom').boundingBox()
        const viewportSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        assert(zoom.x >= 0 && zoom.y >= 0 && zoom.x + zoom.width <= viewportSize.width + 1 &&
          zoom.y + zoom.height <= viewportSize.height + 1, `${name}: slime card leaves the viewport`)
        await actor.evaluate(element => element.blur())
        await page.mouse.move(0, 0)
      }
      const first = page.locator('.slime-party__actor').first()
      await first.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
      await first.focus()
      assert.equal(await page.locator('.slime-party__zoom .card').getAttribute('data-card-name'), 'Bruiser Slime')
      await page.screenshot({ path: resolve(output, name + '-card.png') })
      await first.evaluate(element => element.blur())
      await page.mouse.move(0, 0)
      await page.locator('.slime-party__zoom').waitFor({ state: 'detached' })
      const power = page.locator('.row__seat .power').first()
      await power.click()
      await page.locator('.power__zoom:not(.slime-party__zoom)').waitFor()
      await first.focus()
      assert.equal(await page.locator('.slime-party__zoom').count(), 0, 'a pinned Power keeps its preview')
      await power.click()
      await first.evaluate(element => element.blur())
      await first.focus()
      assert.equal(await page.locator('.slime-party__zoom .card').getAttribute('data-card-name'), 'Bruiser Slime')
      assert.deepEqual(errors, [], name + ': browser errors')
      console.log(name + ': visible slime artwork, card preview, keyboard/touch and Power coexistence passed')
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  await server.close()
}
