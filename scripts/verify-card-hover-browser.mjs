import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const engine = process.argv.includes('--webkit') ? webkit : chromium
const output = resolve(root, 'artifacts/card-hover-browser', process.argv.includes('--webkit') ? 'webkit' : 'chromium')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await engine.launch({ headless: true })
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    if (process.argv.includes('--phone-only') && name !== 'horizontal-phone') continue
    const page = await browser.newPage({ viewport, recordVideo: { dir: output, size: viewport } })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(async () => {
      const [React, ReactDOM, { CardRewardPicker }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CardRewardPicker.tsx'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      document.querySelector('#root').style.display = 'none'
      const host = document.createElement('div'); host.className = 'sts-scope'; document.body.append(host)
      window.choices = []
      ;(ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host).render((React.createElement ?? React.default.createElement)(CardRewardPicker, {
        choices: ['buffer', 'melter', 'skim'],
        onChoose: index => window.choices.push(index), onSkip: () => window.choices.push('skip'),
      }))
    })
    const cards = page.locator('.reward-screen__cards > .card')
    await cards.first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    // The recording leaves the pointer just inside the bottom edge. Exercise
    // both bottom corners too: the resting hit area must survive enlargement.
    for (const card of await cards.all()) for (const fraction of [.08, .5, .92]) {
      await page.mouse.move(2, 2)
      await page.waitForTimeout(200)
      const resting = await card.boundingBox()
      await page.mouse.move(resting.x + resting.width * fraction, resting.y + resting.height - 2)
      await page.waitForTimeout(250)
      const samples = await card.evaluate(async node => {
        const samples = []
        for (let i = 0; i < 40; i++) {
          await new Promise(requestAnimationFrame)
          const box = node.getBoundingClientRect()
          samples.push({ hover: node.matches(':hover'), width: box.width, bottom: box.bottom })
        }
        return samples
      })
      assert(samples.every(s => s.hover), `${name}: card repeatedly loses stationary edge hover`)
      assert(Math.max(...samples.map(s => s.width)) - Math.min(...samples.map(s => s.width)) < .5,
        `${name}: stationary pointer makes the card oscillate`)
      assert(samples[0].width > resting.width * 1.05, 'hover must still enlarge the card')
      assert(Math.abs(samples[0].bottom - resting.y - resting.height) < .5, 'hover must keep its bottom edge anchored')
    }
    await page.screenshot({ path: resolve(output, `${name}-stable-hover.png`) })
    await cards.nth(1).click()
    assert.deepEqual(await page.evaluate(() => window.choices), [1], 'stable hovered card selected the wrong reward')
    await page.mouse.move(2, 2)
    await page.locator('.reward-screen--card-choice').focus()
    await page.keyboard.press('Tab')
    await cards.first().focus()
    assert(await cards.first().evaluate(node => node.matches(':focus-visible')), 'keyboard card selection lost focus feedback')
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.choices), [1, 0])
    // The hand shares Card but has a rotated, overlapping fan. Exercise exposed
    // bottom edges in small and full hands, including both outer fan angles.
    for (const count of [5, 10]) {
      await page.evaluate(async count => {
        const [R, D, { Card }] = await Promise.all([
          import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/Card.tsx'),
        ])
        document.querySelector('.reward-screen--card-choice').parentElement.style.display = 'none'
        document.querySelector('#hand-fixture')?.remove()
        const host = document.createElement('div'); host.id = 'hand-fixture'; host.className = 'sts-scope'; document.body.append(host)
        const h = R.createElement ?? R.default.createElement
        window.choices = []
        ;(D.createRoot ?? D.default.createRoot)(host).render(h('div', { className: 'hand-area' },
          h('div', { className: 'hand-scroll' }, h('div', { className: 'hand' },
            Array.from({ length: count }, (_, i) => h(Card, { key: i,
              card: { uid: `hand-${i}`, defId: 'strike_defect', upgraded: false },
              fan: (i - (count - 1) / 2) / Math.max(1, (count - 1) / 2),
              playable: true, onClick: () => window.choices.push(i),
            }))))))
      }, count)
      const hand = page.locator('#hand-fixture .card')
      await hand.first().waitFor()
      for (let index = 0; index < count; index++) {
        const card = hand.nth(index)
        await page.mouse.move(2, 2)
        await card.scrollIntoViewIfNeeded()
        await page.waitForTimeout(200)
        const point = await card.evaluate(node => {
          const r = node.getBoundingClientRect()
          // WebKit rounds native pointer coordinates. Require an interior pixel,
          // not a fractional point just across the card's slanted silhouette.
          for (let y = Math.floor(Math.min(innerHeight - 2, r.bottom - 2)); y > r.top + r.height * .6; y -= 2)
            for (let x = Math.ceil(Math.max(2, r.left + 2)); x < Math.min(innerWidth - 2, r.right - 2); x += 2)
              if ([[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dy]) =>
                document.elementFromPoint(x + dx, y + dy)?.closest('.card') === node)) return { x, y }
          return null
        })
        assert(point, `${name}: hand ${count}, card ${index} has no exposed hit area`)
        await page.mouse.move(point.x, point.y)
        await page.waitForTimeout(250)
        const stable = await card.evaluate(async (node, point) => {
          const widths = [], hovered = [], scrollTops = [], targets = []
          for (let i = 0; i < 30; i++) {
            await new Promise(requestAnimationFrame)
            widths.push(node.getBoundingClientRect().width); hovered.push(node.matches(':hover'))
            scrollTops.push(node.closest('.hand-scroll').scrollTop)
            targets.push(document.elementFromPoint(point.x, point.y)?.closest('.card') === node)
          }
          return { hovered, widths, scrollTops, targets }
        }, point)
        assert(stable.hovered.every(Boolean) && stable.targets.every(Boolean) &&
          Math.max(...stable.widths) - Math.min(...stable.widths) < .5,
          `${name}: hand ${count}, card ${index} oscillates at ${JSON.stringify(point)}: ${JSON.stringify(stable)}`)
        assert(stable.scrollTops.every(top => top === 0), 'hover must not scroll the hidden vertical axis')
        await page.mouse.click(point.x, point.y)
        assert.equal(await page.evaluate(() => window.choices.at(-1)), index)
      }
      await page.screenshot({ path: resolve(output, `${name}-hand-${count}.png`) })
    }
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${name}: stationary card-edge hover and selection passed`)
  }
} finally {
  await browser.close()
  await server.close()
}
