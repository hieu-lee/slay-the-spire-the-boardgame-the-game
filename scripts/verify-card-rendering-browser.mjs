import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/card-rendering')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        const page = await browser.newPage({ viewport, hasTouch: screen === 'horizontal-phone' })
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          const [React, ReactDOM, ReactDOMMain, { Card }, { CARDS }, { IconValue, StatusIcon }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/@id/react-dom'),
            import('/src/ui/Card.tsx'), import('/src/game/cards.ts'), import('/src/ui/Icon.tsx'),
          ])
          document.querySelector('#root').style.display = 'none'
          const host = document.createElement('div')
          host.className = 'sts-scope'
          host.style.cssText = 'display:flex;justify-content:center;padding:30px'
          document.body.append(host)
          const renderRoot = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host)
          const createElement = React.createElement ?? React.default.createElement
          const flushSync = ReactDOMMain.flushSync ?? ReactDOMMain.default.flushSync
          const ruby = Object.values(CARDS).find(def => def.owner === 'guardian' && def.name === 'Ruby')
          window.renderCard = props => flushSync(() => renderRoot.render(createElement(Card, {
            card: { uid: 'same-mounted-card', defId: 'guardian_strike', upgraded: false }, ...props,
          })))
          window.rubyId = ruby.id
          window.renderCard({ cost: 1 })
          const icons = document.createElement('div')
          icons.id = 'rendered-icons'
          icons.className = 'sts-scope'
          document.body.append(icons)
          const iconRoot = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(icons)
          window.renderIcons = (name, size, value) => flushSync(() => iconRoot.render(createElement('div', null,
            createElement(IconValue, { name, size, value, prefix: '+' }), createElement(StatusIcon, { name, size }))))
          window.renderIcons('attack', 20, 1)
        })
        const card = page.locator('.card')
        await card.waitFor()
        const initial = await card.getAttribute('aria-label')
        assert(initial.includes('cost 1') && initial.includes('1 damage'), initial)
        await page.evaluate(() => window.renderCard({
          card: { uid: 'same-mounted-card', defId: 'guardian_strike', upgraded: true },
          cost: 0, selected: true, playable: false,
        }))
        const upgraded = await card.getAttribute('aria-label')
        assert(upgraded.includes('Strike+') && upgraded.includes('cost 0') && upgraded.includes('2 damage'), upgraded)
        assert.equal(await card.getAttribute('aria-pressed'), 'true')
        assert.equal(await card.getAttribute('aria-disabled'), 'true')
        assert.equal(await card.locator('.card-face__cost').textContent(), '0')
        assert.equal(await card.locator('.card-face__title').textContent(), 'Strike+')
        const rubyId = await page.evaluate(() => window.rubyId)
        const gemProps = { card: { uid: 'same-mounted-card', defId: 'guardian_strike', upgraded: false, attachedGemId: rubyId }, cost: 2 }
        await page.evaluate(props => window.renderCard(props), gemProps)
        assert((await card.getAttribute('aria-label')).includes('socketed with Ruby'))
        const description = () => card.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')).textContent)
        assert((await description()).includes('Ruby'))
        await page.evaluate(props => window.renderCard({ ...props, gemPowerDamage: true }), gemProps)
        assert((await description()).includes('Gem Power damage'))
        await page.evaluate(props => window.renderCard({ ...props, gemPowerDamage: false }), gemProps)
        assert(!(await description()).includes('Gem Power damage'))
        await page.evaluate(() => window.renderCard({ cost: 1 }))
        assert.equal(await card.getAttribute('aria-label'), initial)
        assert(!(await description()).includes('Ruby'))
        assert.equal(await card.getAttribute('aria-pressed'), 'false')
        assert.equal(await card.getAttribute('aria-disabled'), 'false')
        assert.equal(await card.locator('.card-face__cost').textContent(), '1')
        assert.equal(await card.locator('.card-face__title').textContent(), 'Strike')
        // Full scans must expose temporary costs above their printed cost.
        const scannedProps = { card: { uid: 'same-mounted-card', defId: 'strike_kratos', upgraded: false }, cost: 1 }
        await page.evaluate(props => window.renderCard(props), scannedProps)
        await card.locator('.card__art').evaluate(image => image.decode())
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.card__art')).visibility === 'visible')
        assert.equal(await card.locator('.card__live-cost').count(), 0)
        assert.equal(await card.locator('.card-face').evaluate(face => getComputedStyle(face).visibility), 'hidden',
          'transparent scans must not show duplicate fallback text')
        await page.evaluate(props => window.renderCard({ ...props, cost: 0 }), scannedProps)
        assert.equal(await card.locator('.card__live-cost').count(), 1, 'discounted scanned card must expose its live cost')
        assert.equal(await card.locator('.card__live-cost').textContent(), '0')
        const costVisible = await card.locator('.card__live-cost').evaluate(badge => {
          const box = badge.getBoundingClientRect()
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === badge
        })
        assert(costVisible, 'live cost must paint above the full scan')
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-discounted-kratos.png`) })
        await page.evaluate(props => window.renderCard(props), scannedProps)
        assert.equal(await card.locator('.card__live-cost').count(), 0)
        await page.route('**/cards-sm/kratos__starter__defend.webp', route => route.abort())
        await page.evaluate(() => window.renderCard({ card: { uid: 'same-mounted-card', defId: 'defend_kratos', upgraded: false }, cost: 1 }))
        await page.waitForFunction(() => document.querySelector('.card__art').style.visibility === 'hidden')
        assert.equal(await card.locator('.card-face').evaluate(face => getComputedStyle(face).visibility), 'visible',
          'failed scans must restore the native fallback')
        assert.equal(await card.locator('.card-face__rules').textContent(), 'Gain 1 Block.')
        await card.locator('.card-face__illustration').evaluate(image => image.decode())
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-kratos-scan-fallback.png`) })
        const icon = page.locator('#rendered-icons .icon-value .icon')
        const previousSource = await icon.getAttribute('src')
        await page.evaluate(() => window.renderIcons('block', 28, 4))
        assert.notEqual(await icon.getAttribute('src'), previousSource)
        assert.equal(await icon.getAttribute('width'), '28')
        assert.equal(await page.locator('#rendered-icons .icon-value__number').textContent(), '+4')
        assert.equal(await page.locator('#rendered-icons .icon--status').getAttribute('width'), '28')
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}.png`) })
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`PASS ${engineName} ${screen}: repeated card renders retain live costs, upgrades, selection and socket help`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
