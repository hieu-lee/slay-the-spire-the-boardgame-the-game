// Public menus, real run creation/result recording and the online lobby.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/kratos-release')
mkdirSync(output, { recursive: true })
process.env.VITE_LEADERBOARD = 'true'
const rooms = createRoomServer({ classifierEnabled: false })
const { port } = await rooms.listen(0)
const target = `http://127.0.0.1:${port}`
const vite = await createServer({ root, logLevel: 'silent', server: {
  host: '127.0.0.1', port: 0, proxy: { '/api': { target }, '/ws': { target, ws: true } },
} })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const errors = []
async function assertCardFaces(page, selector, label, full = false) {
  const fits = await page.locator(selector).evaluateAll((cards, full) =>
    cards.length > 0 && cards.every(card => {
      const box = card.getBoundingClientRect()
      if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return true
      const image = card.querySelector('img')
      if (!image || image.naturalWidth !== (full ? 744 : 448) || image.naturalHeight !== (full ? 1039 : 626) ||
        getComputedStyle(image).visibility !== 'visible' ||
        getComputedStyle(card.querySelector('.card-face')).visibility !== 'hidden') return false
      const art = image.getBoundingClientRect()
      return art.height > 0 && art.top >= box.top - 1 && art.bottom <= box.bottom + 1 &&
        art.left >= box.left - 1 && art.right <= box.right + 1
    }), full)
  assert(fits, `${label}: full card face is missing, hidden or outside its frame`)
}

try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
        ['horizontal-phone', { width: 844, height: 390 }]]) {
        rooms.store.leaderboardRuns = []
        rooms.store.statsRuns = []
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: screen !== 'desktop', hasTouch: screen !== 'desktop' })
        const username = `KLaunch-${engine[0]}-${screen === 'desktop' ? 'D' : 'P'}`
        await context.addInitScript(profile => localStorage.setItem('sts-profile', JSON.stringify(profile)),
          { username, token: randomUUID() })
        try {
          const page = await context.newPage()
          const activate = async locator => {
            if (engine !== 'webkit' || screen === 'desktop') return locator.click()
            await locator.scrollIntoViewIfNeeded()
            assert(await locator.isEnabled(), 'touch target is disabled')
            // WebKit sends touch points in the scaled visual viewport.
            const point = await locator.evaluate(element => {
              const r = element.getBoundingClientRect(), v = visualViewport
              return { x: (r.left + r.width / 2 - v.offsetLeft) * v.scale,
                y: (r.top + r.height / 2 - v.offsetTop) * v.scale }
            })
            assert(point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height,
              'touch target leaves the physical viewport')
            await page.touchscreen.tap(point.x, point.y)
          }
          page.on('pageerror', error => errors.push(String(error)))
          page.on('response', response => {
            if (response.status() >= 400 && /\/assets\//.test(response.url())) errors.push(`${response.status()} ${response.url()}`)
          })
          await page.goto(origin)
          await activate(page.getByRole('button', { name: 'Single Player', exact: true }))
          await activate(page.getByRole('button', { name: 'Standard', exact: true }))
          await page.getByRole('button', { name: 'Embark', exact: true }).waitFor()
          assert.equal(await page.getByRole('button', { name: 'Kratos', exact: true }).count(), 1,
            'public character select does not offer Kratos')
          await activate(page.getByRole('button', { name: 'Kratos', exact: true }))
          await page.locator('.start-menu__character-wallpaper[data-decoded]').waitFor()
          await page.waitForFunction(() => ['.start-menu__character-wallpaper', '.start-menu__character-copy'].every(selector => {
            const element = document.querySelector(selector)
            return element && Number(getComputedStyle(element).opacity) > .99 &&
              element.getAnimations().every(animation => animation.playState === 'finished')
          }))
          assert((await page.locator('.start-menu__character-wallpaper').getAttribute('src'))
            .endsWith('/character-kratos-wallpaper.webp'))
          assert((await page.locator('.start-menu__character-copy').innerText()).includes('Rage'))
          const rosterFits = await page.locator('.start-menu__character-roster button').evaluateAll(buttons =>
            buttons.every(button => { const r = button.getBoundingClientRect();
              return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }))
          assert(rosterFits,
            `${engine}/${screen}: public roster leaves the viewport`)
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-select.png`) })
          await activate(page.getByRole('button', { name: 'Embark', exact: true }))
          await activate(page.getByRole('button', { name: 'Start standard campaign', exact: true }))
          await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.players[0].character === 'kratos')
          const started = await page.evaluate(() => {
            const run = window.__STS_DEBUG__.getRun()
            return { character: run.players[0].character, maxHp: run.players[0].maxHp,
              relic: run.players[0].relics[0].defId, cards: run.players[0].deck.length, ruleset: run.meta.ruleset }
          })
          assert.deepEqual(started, { character: 'kratos', maxHp: 10, relic: 'ashes_of_sparta', cards: 10, ruleset: 'base' })
          // Terminal state fixture: the production result button sends the real
          // run/deck to this task's local server, never to the human leaderboard.
          await page.evaluate(() => {
            const run = structuredClone(window.__STS_DEBUG__.getRun())
            run.phase = 'defeat'; run.neow = null; run.combatsFinished = 2; run.floorsCleared = 3
            run.players[0].damageStats = { attack: 12, poison: 0, special: 0, taken: 10, blocked: 4 }
            window.__STS_DEBUG__.setRun(run)
          })
          await activate(page.getByRole('button', { name: 'Record campaign result', exact: true }))
          await page.getByText('Run recorded on the leaderboard.', { exact: true }).waitFor()
          assert.equal(rooms.store.leaderboardRuns.length, 1)
          const recorded = rooms.store.leaderboardRuns[0]
          assert(recorded && recorded.character === 'kratos' && recorded.finalDeck.length === 10)
          await page.reload()
          await activate(page.getByRole('button', { name: 'Compendium', exact: true }))
          await activate(page.getByRole('button', { name: 'Kratos', exact: true }))
          assert.equal(await page.locator('.compendium-card').count(), 64, 'public Kratos pool is incomplete')
          await page.waitForFunction(() => Array.from(document.querySelectorAll('.compendium-card')).every(card => {
            const box = card.getBoundingClientRect()
            if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return true
            const art = card.querySelector('img')
            return art && art.complete && art.naturalWidth > 0 && art.style.visibility === 'visible'
          }))
          await assertCardFaces(page, '.compendium-card', `${engine}/${screen} grid`)
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-compendium.png`) })
          await activate(page.getByRole('checkbox', { name: 'View upgrades', exact: true }))
          assert(await page.getByRole('checkbox', { name: 'View upgrades', exact: true }).isChecked())
          await page.getByRole('searchbox', { name: 'Search cards', exact: true }).fill('Rage of Sparta')
          await activate(page.locator('.compendium-card').first())
          await page.locator('.compendium__detail[open]').waitFor()
          await page.waitForFunction(() => {
            const art = document.querySelector('.compendium__detail-card > img')
            return art && art.complete && art.naturalWidth > 0 && art.style.visibility === 'visible'
          })
          await assertCardFaces(page, '.compendium__detail-card', `${engine}/${screen} detail`, true)
          const detailTextFits = await page.locator('.compendium__detail-card').evaluate(card => {
            const rules = card.querySelector('.card-face__rules')
            return parseFloat(getComputedStyle(rules).fontSize) >= Math.max(12, card.clientWidth * .035) &&
              rules.scrollHeight <= rules.clientHeight + 1 && rules.scrollWidth <= rules.clientWidth + 1
          })
          assert(detailTextFits, `${engine}/${screen}: enlarged card rules are too small or clipped`)
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-upgraded-detail.png`) })
          await activate(page.getByRole('button', { name: 'Close card detail', exact: true }))
          await activate(page.getByRole('button', { name: 'Back to main menu', exact: true }))
          await activate(page.getByRole('button', { name: 'Stats', exact: true }))
          await activate(page.getByRole('group', { name: 'Filter by hero' }).getByRole('button', { name: 'Kratos', exact: true }))
          await page.locator('.stats__metric').first().locator('strong').getByText('1', { exact: true }).waitFor()
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-stats.png`) })
          const search = page.getByRole('searchbox', { name: 'Find a card for All of these', exact: true })
          await search.fill('Plume of Prometheus')
          const suggestion = page.getByRole('listbox', { name: 'All of these suggestions' }).getByRole('option').first()
          assert((await suggestion.locator('img').getAttribute('src')).includes('/cards-sm/kratos__'),
            'Stats suggestions do not use the complete Kratos card')
          await activate(suggestion)
          const chip = page.getByRole('button', { name: 'Remove Plume of Prometheus from All of these', exact: true })
          await chip.waitFor()
          await page.waitForFunction(() => {
            const image = document.querySelector('.stats__chip img')
            return image && image.complete && image.naturalWidth > 0
          })
          await page.locator('.stats__metric').first().locator('strong').getByText('1', { exact: true }).waitFor()
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-stats-card-filter.png`) })
          await activate(chip)
          // Three local archive fixtures provide a with/without-card comparison.
          const archived = rooms.store.statsRuns[0]
          rooms.store.statsRuns.push({ ...structuredClone(archived), id: `${archived.id}:with` },
            { ...structuredClone(archived), id: `${archived.id}:without`,
              finalDeck: archived.finalDeck.filter(card => card.defId !== 'kratos_plume_of_prometheus') })
          await activate(page.getByRole('group', { name: 'Filter by hero' }).getByRole('button', { name: 'All heroes', exact: true }))
          await activate(page.getByRole('group', { name: 'Filter by hero' }).getByRole('button', { name: 'Kratos', exact: true }))
          const impact = page.locator('.stats__next-card').filter({ hasText: 'Plume of Prometheus' })
          await impact.scrollIntoViewIfNeeded()
          assert((await impact.locator('img').getAttribute('src')).includes('/cards-sm/kratos__'),
            'Stats card impact does not use the complete Kratos card')
          await page.waitForFunction(() => {
            const image = document.querySelector('.stats__next-card img')
            return image && image.complete && image.naturalWidth > 0
          })
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-stats-card-impact.png`) })
          await activate(page.getByRole('button', { name: 'Back to main menu', exact: true }))
          await activate(page.getByRole('button', { name: 'Leaderboard', exact: true }))
          await activate(page.getByRole('group', { name: 'Filter by character' }).getByRole('button', { name: 'Kratos', exact: true }))
          await page.getByRole('rowheader', { name: 'Kratos', exact: true }).waitFor()
          await activate(page.getByRole('button', { name: 'Back to main menu', exact: true }))
          await activate(page.getByRole('button', { name: 'Play online', exact: true }))
          const entryRoster = page.locator('.online-character-roster')
          await entryRoster.waitFor()
          assert.equal(await entryRoster.getByRole('button').count(), 9)
          const entryRows = await entryRoster.getByRole('button').evaluateAll(buttons =>
            new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size)
          assert.equal(entryRows, 1, 'online entry wraps the public roster onto a second row')
          await activate(page.getByRole('button', { name: 'Kratos', exact: true }))
          await activate(page.getByRole('button', { name: 'Create room', exact: true }))
          await page.locator('.online-lobby').waitFor()
          assert(await page.locator('.online-character-roster button').evaluateAll(buttons =>
            buttons.every(button => { const r = button.getBoundingClientRect();
              return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })),
            `${engine}/${screen}: online roster leaves the viewport`)
          const kratos = page.locator('.online-character-roster').getByRole('button', { name: 'Kratos', exact: true })
          assert.equal(await kratos.getAttribute('aria-pressed'), 'true', 'online room loses Kratos selection')
          await page.reload()
          await page.locator('.online-lobby').waitFor()
          assert.equal(await kratos.getAttribute('aria-pressed'), 'true', 'online reconnect loses Kratos')
          await page.screenshot({ path: resolve(output, `${engine}-${screen}-online.png`) })
          console.log(`PASS ${engine}/${screen}: Kratos public selection, starter run, recorded deck, Compendium, stats, leaderboard and online reconnect`)
        } finally { await context.close() }
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [], 'public release has browser errors or missing assets')
} finally { await vite.close(); await rooms.close() }
