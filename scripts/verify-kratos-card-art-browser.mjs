import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

// Protect the user-visible original DLC faces: missing art, lost clauses,
// stale upgrade costs/types, unmarked mechanics and clipped rules. Existing
// card-rendering coverage owns mounted-card updates; no production test seam.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/kratos-card-art')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          const [React, ReactDOM, { Card }, { ItemImage }, { CARDS }, { RELICS }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/Card.tsx'),
            import('/src/ui/ItemImage.tsx'), import('/src/game/cards.ts'), import('/src/game/relics.ts'),
          ])
          document.querySelector('#root').style.display = 'none'
          const host = document.createElement('div')
          host.id = 'kratos-audit'; host.className = 'sts-scope'
          host.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,180px);justify-content:center;gap:14px;padding:18px;--card-width:180px'
          document.body.append(host)
          const el = React.createElement ?? React.default.createElement
          const nodes = []
          window.expectedFaces = []
          for (const def of Object.values(CARDS).filter(def => def.owner === 'kratos')) {
            for (const upgraded of [false, true]) {
              const cost = upgraded ? def.upgrade?.cost ?? def.cost : def.cost
              const type = upgraded ? def.upgrade?.type ?? def.type : def.type
              const rules = (upgraded ? def.upgrade?.printedText ?? def.printedText : def.printedText)
                ?? (def.id === 'strike_kratos' ? `Deal ${upgraded ? 2 : 1} damage.` : `Gain ${upgraded ? 2 : 1} Block.`)
              const uid = `${def.id}-${upgraded}`
              window.expectedFaces.push({ uid, id: def.id, name: def.name + (upgraded ? '+' : ''), cost, type, rules })
              nodes.push(el('div', { key: uid, 'data-face': uid }, el(Card, { card: { uid, defId: def.id, upgraded } })))
            }
          }
          nodes.push(el('div', { key: 'menu-icon', id: 'kratos-menu-icon' },
            ...[24, 36, 64].map(size => el('img', { key: size, src: '/assets/menu/compendium-icons/kratos.webp', width: size, height: size, alt: '' }))))
          nodes.push(el('div', { key: 'relic', id: 'kratos-relic', style: { width: 180 } },
            el(ItemImage, { kind: 'relic', id: 'ashes_of_sparta', card: true })))
          window.expectedRelicText = RELICS.ashes_of_sparta.text
          ;(ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host).render(el(React.Fragment ?? React.default.Fragment, null, ...nodes))
        })
        await page.waitForFunction(() => document.querySelectorAll('[data-face] .card-face').length === 128)
        await page.evaluate(async () => {
          for (const img of document.querySelectorAll('#kratos-audit img')) img.loading = 'eager'
          await Promise.all([...document.querySelectorAll('#kratos-audit img')].map(img => img.decode()))
          await document.fonts.ready
        })
        for (const cardWidth of [180, screen === 'desktop' ? 132 : 76]) {
          await page.evaluate(width => document.querySelector('#kratos-audit').style.setProperty('--card-width', `${width}px`), cardWidth)
          const audit = await page.evaluate(() => {
            const faults = []
            const faces = window.expectedFaces.map(expected => {
              const card = document.querySelector(`[data-face="${expected.uid}"]`)
              const text = selector => card.querySelector(selector).textContent.trim()
              for (const [selector, value] of [['.card-face__title', expected.name], ['.card-face__cost', String(expected.cost)],
                ['.card-face__type', expected.type], ['.card-face__rules', expected.rules]]) {
                if (text(selector) !== value) faults.push(`${expected.uid} ${selector}: ${text(selector)} != ${value}`)
              }
              const art = card.querySelector('.card-face__illustration')
              if (art?.naturalWidth !== 748 || art?.naturalHeight !== 420 || !art.src.endsWith(`/kratos/${expected.id}.webp`)) faults.push(`${expected.uid}: missing/wrong art`)
              const artBox = art.getBoundingClientRect()
              const frameBox = art.closest('.card-face').getBoundingClientRect()
              const rulesBox = card.querySelector('.card-face__rules').getBoundingClientRect()
              if (artBox.height <= 0 || artBox.height > frameBox.height * .4 + 1 || artBox.bottom > rulesBox.top + 1)
                faults.push(`${expected.uid}: art escapes illustration row`)
              const rules = card.querySelector('.card-face__rules')
              const range = document.createRange(); range.selectNodeContents(rules)
              const content = range.getBoundingClientRect(), box = rules.getBoundingClientRect()
              if (content.bottom > box.bottom + 1 || content.right > box.right + 1 || content.left < box.left - 1) faults.push(`${expected.uid}: clipped rules`)
              const highlighted = [...rules.querySelectorAll('strong')].map(el => el.textContent)
              for (const keyword of ['Rage', 'Unleash', 'Godslayer', 'Brutal Kill', 'Block', 'Weak', 'Vulnerable', 'Strength', 'Exhaust', 'Retain']) {
                if (expected.rules.includes(keyword) && !highlighted.some(text => text.toLowerCase() === keyword.toLowerCase())) faults.push(`${expected.uid}: unmarked ${keyword}`)
              }
              return { ...expected, highlighted }
            })
            for (const icon of document.querySelectorAll('#kratos-menu-icon img')) {
              if (icon.naturalWidth !== 256 || icon.naturalHeight !== 256) faults.push('shared menu icon missing or wrong size')
            }
            const relic = document.querySelector('#kratos-relic')
            if (!relic.textContent.includes(window.expectedRelicText)) faults.push('starter relic lost rules')
            if (relic.querySelector('img').naturalWidth !== 256) faults.push('starter relic missing icon')
            return { faults, faces }
          })
          assert.deepEqual(audit.faults, [], `${engineName} ${screen} ${cardWidth}px`)
          writeFileSync(resolve(output, `${engineName}-${screen}-${cardWidth}px-faces.json`), JSON.stringify(audit.faces, null, 2) + '\n')
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-${cardWidth}px-faces.png`), fullPage: cardWidth === 180 })
        }
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`PASS ${engineName} ${screen}: all 128 Kratos faces and Ashes of Sparta art, rules, costs, types, keywords and text fit`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
