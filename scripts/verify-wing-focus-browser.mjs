// Wing Boots rooms are ordinary reachable map nodes, so the map's keyboard
// focus has to choose between them. When a mandatory Relic stops blocking the
// map, focus must land on a room the party can walk to: one stray Enter on a
// winged room would spend a Wing Boots use nobody asked for. Behind the Relic
// no winged room may be reachable at all.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('wing boots focus browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/wing-focus-browser')
mkdirSync(output, { recursive: true })
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()
const errors = []

try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['landscape-phone', { width: 844, height: 390 }]]) {
    const page = await browser.newPage({ viewport })
    page.on('pageerror', (error) => errors.push(`${screen}: ${error.message}`))
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'wing-focus'))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
    const staged = await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      // The next row's FIRST room is off the paths, so in document order a winged
      // node comes before every walkable one and a plain "first reachable" rule
      // would focus it.
      const from = Object.values(run.map.rooms).find((room) => room.exits.length > 0 &&
        (run.map.rows[room.row + 1] ?? []).length > 0 && !room.exits.includes(run.map.rows[room.row + 1][0]))
      run.phase = 'map'
      run.neow = null
      run.map = { ...run.map, position: from.id, rooms: { ...run.map.rooms, [from.id]: { ...from, visited: true } } }
      run.players = run.players.map((player, index) => ({
        ...player, row: from.row,
        relics: [...player.relics, ...(index === 0
          ? [{ defId: 'wing_boots', spent: false, uses: 3 }, { defId: 'astrolabe', spent: false, pending: true }]
          : [])],
      }))
      debug.setRun(run)
      debug.setViewer(run.players[0].id)
      return { offPath: (run.map.rows[from.row + 1] ?? []).filter((id) => !from.exits.includes(id)).length }
    })
    await page.getByRole('heading', { name: 'Resolve Astrolabe' }).waitFor()
    await page.locator('.map[hidden][inert]').waitFor({ state: 'attached' })
    const wingsWhileBlocked = await page.locator('.room--wing').count()
    const choices = page.locator('.campfire__deck button')
    for (let index = 0; index < 3; index += 1) await choices.nth(index).click()
    await page.getByRole('button', { name: 'Confirm Astrolabe' }).click()
    await page.locator('.map:not([inert]) .room--wing').first().waitFor()
    await page.waitForFunction(() => document.activeElement?.classList.contains('room--reachable'))
    const focus = await page.evaluate(() => ({
      wing: document.activeElement?.classList.contains('room--wing'),
      wings: document.querySelectorAll('.map:not([inert]) .room--wing').length,
    }))
    await page.screenshot({ path: join(output, `${screen}-focus.png`) })
    check(`${screen}: a released map focuses a walkable room, never a Wing Boots jump`, () => {
      assert(staged.offPath > 0, 'the fixture found no Wing Boots detour')
      assertEqual(wingsWhileBlocked, 0, 'a Wing Boots room stayed reachable behind the mandatory Relic')
      assertEqual(focus.wings, staged.offPath, 'the released map did not offer every Wing Boots room')
      assertEqual(focus.wing, false, 'keyboard focus landed on a Wing Boots room')
    })
    await page.close()
  }
  check('the Wing Boots focus flow raised no page errors', () => assertEqual(errors.join('\n'), ''))
} finally {
  await browser.close()
  await vite.close()
}
report('wing boots focus browser')
