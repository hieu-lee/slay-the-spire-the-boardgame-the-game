#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { assert, check, report, suite } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'artifacts/enemy-effects-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

async function readHelp(defId) {
  const card = page.locator(`[data-enemy-def="${defId}"]`)
  await card.locator('.enemy__hit-area').hover()
  const help = page.locator('.card-keyword-tips[data-open]')
  await help.waitFor()
  return {
    label: await card.getAttribute('aria-label'),
    help: await help.innerText(),
    bounds: await help.boundingBox(),
  }
}

try {
  suite('enemy effects browser')
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    debug.reset(1, 'enemy-effects')
    const run = structuredClone(debug.getRun())
    debug.setRun({ ...run, phase: 'map', neow: null })
  })
  await page.locator('.room--reachable').first().click()
  await page.locator('.combat').waitFor()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const enemy = run.combat.enemies[0]
    run.combat.phase = 'player'
    run.combat.enemies = [
      { ...enemy, uid: 'time', defId: 'time_eater', isBoss: true, hp: 60, maxHp: 60,
        actionIndex: 1, abilityUsed: false, abilityCubes: undefined, dead: false },
      { ...enemy, uid: 'heart', defId: 'corrupt_heart', isBoss: true, hp: 100, maxHp: 100,
        actionIndex: 0, abilityUsed: false, abilityCubes: 2, dead: false },
      { ...enemy, uid: 'spiker', defId: 'spiker_add', isBoss: false, row: 0, hp: 10, maxHp: 10,
        actionIndex: 0, abilityUsed: false, abilityCubes: 3, dead: false },
    ]
    debug.setRun(run)
  })
  await page.locator('[data-enemy-id="spiker"]').waitFor()

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'horizontal-phone', width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport)
    const time = await readHelp('time_eater')
    await page.screenshot({ path: join(output, `${viewport.name}-time-warp.png`) })
    const heart = await readHelp('corrupt_heart')
    const thorns = await readHelp('spiker_add')
    check(`${viewport.name} shows concrete enemy effect consequences`, () => {
      assert(time.label?.includes('each player can play at most 4 cards this turn'))
      assert(time.help.includes('each player can play at most 4 cards this turn'))
      assert(heart.label?.includes('every player takes 2 damage'))
      assert(heart.help.includes('every player takes 2 damage'))
      assert(thorns.label?.includes('the attacking player takes 3 damage'))
      assert(thorns.help.includes('the attacking player takes 3 damage'))
      for (const result of [time, heart, thorns]) assert(result.bounds &&
        result.bounds.x >= 0 && result.bounds.y >= 0 &&
        result.bounds.x + result.bounds.width <= viewport.width &&
        result.bounds.y + result.bounds.height <= viewport.height,
      `effect help is clipped at ${viewport.name}: ${JSON.stringify(result.bounds)}`)
    })
  }
  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join('\n')}`)
} finally {
  await browser.close()
  await server.close()
}

report('enemy effects browser')
