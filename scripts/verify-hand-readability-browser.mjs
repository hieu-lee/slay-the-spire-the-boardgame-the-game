import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const out = resolve('artifacts/hand-readability')
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    const page = await browser.newPage({ viewport, hasTouch: screen === 'horizontal-phone', isMobile: screen === 'horizontal-phone' })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(async () => {
      const [R, D, { Card }, { CARDS }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/Card.tsx'), import('/src/game/cards.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      document.querySelector('#root').remove()
      const host = document.createElement('div')
      host.className = 'app-shell app-shell--combat sts-scope'
      document.body.append(host)
      const h = R.createElement ?? R.default.createElement
      const defs = ['Defend', 'Defend', 'Floatwork', 'Nightmare Guise', 'Strike'].map(name =>
        Object.values(CARDS).find(card => card.owner === 'hexaghost' && card.name === name))
      if (defs.some(def => !def)) throw Error('Missing Hexaghost hand fixture')
      ;(D.createRoot ?? D.default.createRoot)(host).render(h('div', { className: 'combat', style: { height: '100dvh' } },
        h('div', { className: 'hand-area', style: { position: 'absolute', bottom: 0, width: '100%' } },
          h('div', { className: 'hand-scroll' }, h('div', { className: 'hand', 'data-count': 5 },
            ...defs.map((def, index) => h(Card, { key: index, card: { uid: `read-${index}`, defId: def.id, upgraded: false }, fan: (index - 2) / 2, immediateArt: true })))))))
    })
    await page.locator('.hand .card').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.card__readable').count(), 0, 'keep original card faces without text overlays')
    const cards = page.locator('.hand .card')
    const dimensions = () => cards.evaluateAll(cards => cards.map(card => {
      const { width, height } = getComputedStyle(card)
      return { width: parseFloat(width), height: parseFloat(height) }
    }))
    const enlarged = await dimensions()
    const bounds = await cards.evaluateAll(cards => cards.map(card => {
      const rect = card.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }))
    const visible = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert(bounds.every(rect => rect.left >= 0 && rect.right <= visible.width && rect.top >= 0 && rect.bottom <= visible.height), `${screen}: card faces clipped ${JSON.stringify(bounds)}`)
    await page.screenshot({ path: resolve(out, `${screen}.png`) })
    await page.addStyleTag({ content: '.hand-area { --hand-card-width: calc(var(--card-width) * .66); }' })
    const original = await dimensions()
    enlarged.forEach((size, index) => {
      assert(Math.abs(size.width / original[index].width - 1.15) < .002, 'hand width must increase by 15%')
      assert(Math.abs(size.height / original[index].height - 1.15) < .002, 'hand height must increase by 15%')
    })
    console.log(`PASS ${screen}: original faces, 15% larger cards, no clipping`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
