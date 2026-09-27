import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/hermit-chamber-audit'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    async function load(enemyCount = 1, defId = 'hermit_strike') {
      const run = createRun(908, [{ id: viewerId, name: 'Hermit', character: 'hermit' }])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      run.combat = createCombat({ seed: 908, calls: 0 }, run.players,
        Array.from({ length: enemyCount }, (_, i) => ({ ...enemy, uid: `e${i}` })), 'audit')
      run.combat.pendingHermitSetupLoads = []
      run.combat.die = 1
      Object.assign(run.combat.players[0], { hand: [], chamber: [{ uid: 'card', defId, upgraded: false }],
        energy: 3 })
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForTimeout(1200)
      const intentsClearArt = await page.locator('.enemy').evaluateAll(enemies => enemies.every(enemy => {
        const image = enemy.querySelector('.enemy__art--cutout')
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let firstPixel = 0
        while (firstPixel < canvas.width * canvas.height && pixels[firstPixel * 4 + 3] <= 96) firstPixel++
        const box = image.getBoundingClientRect()
        const fit = Math.min(box.width / canvas.width, box.height / canvas.height)
        const paintedTop = box.bottom - (canvas.height - Math.floor(firstPixel / canvas.width)) * fit
        return enemy.querySelector('.enemy__intent').getBoundingClientRect().bottom <= paintedTop
      }))
      assert(intentsClearArt, `${name}: enemy intent overlaps painted body`)
      const chamber = page.getByRole('button', { name: /^Chamber,/ })
      if (await chamber.getAttribute('aria-expanded') !== 'true') await chamber.click()
    }
    for (const [defId, damage] of [['hermit_strike', 1], ['hermit_snapshot', 2], ['hermit_headshot', 5], ['hermit_golden_bullet', 2], ['hermit_roulette', 1]]) {
      await load(1, defId)
      const card = page.locator('.hand .card--chamber-drawn')
      if (defId === 'hermit_snapshot') assert.match(await card.getAttribute('aria-label'), /Gain Block equal to the damage dealt/)
      await card.click()
      await page.waitForTimeout(100)
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber.length), 1,
        'Clicking a Chamber attack must wait for a target even with one enemy')
      assert.equal(await card.getAttribute('aria-pressed'), 'true')
      assert(await card.evaluate(e => e.getBoundingClientRect().bottom <=
        document.querySelector('.app-shell').getBoundingClientRect().bottom + 1), `${name}: selected Chamber card is clipped`)
      await page.screenshot({ path: `${out}/${name}-${defId}-target.png` })
      await card.click() // Cancel without spending energy or moving the card.
      assert.equal(await card.getAttribute('aria-pressed'), 'false')
      await card.click()
      await page.locator('.enemy:not(.enemy--dead) .enemy__head').first().click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber.length === 0)
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp), 40 - damage)
      if (defId === 'hermit_snapshot') {
        await page.waitForFunction(expected => window.__STS_DEBUG__.getRun().combat.players[0].block === expected, damage)
        const result = await page.evaluate(() => ({
          block: window.__STS_DEBUG__.getRun().combat.players[0].block,
          log: window.__STS_DEBUG__.getRun().combat.log.slice(-8),
        }))
        assert.equal(result.block, damage, JSON.stringify(result.log))
      }
      await load(2, defId)
      await card.focus()
      await page.waitForTimeout(250)
      const source = await card.boundingBox()
      const target = await page.locator('.enemy:not(.enemy--dead) .enemy__head').last().boundingBox()
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
      await page.mouse.down()
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 })
      await page.screenshot({ path: `${out}/${name}-${defId}-drag.png` })
      await page.mouse.up()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber.length === 0)
      assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(e => e.hp)), [40, 40 - damage])
    }
    await load(1, 'hermit_covet')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      const hermit = run.combat.players[0]
      hermit.chamber = [
        { uid: 'card', defId: 'hermit_covet', upgraded: true },
        { uid: 'kept', defId: 'hermit_snapshot', upgraded: false },
      ]
      hermit.hand = [
        { uid: 'first', defId: 'hermit_defend', upgraded: false },
        { uid: 'second', defId: 'hermit_strike', upgraded: false },
      ]
      window.__STS_DEBUG__.setRun(run)
    })
    await page.locator('.hand .card--chamber-drawn').first().click()
    const loadChoice = page.getByRole('dialog', { name: 'Choose up to 2 to Load' })
    await loadChoice.getByRole('button', { name: /^Defend,/ }).click()
    await loadChoice.getByRole('button', { name: /^Strike,/ }).click()
    await loadChoice.getByRole('button', { name: 'Load 2 cards' }).click()
    assert.deepEqual(await page.locator('.prompt__mode').allTextContents(), ['Snapshot', 'Defend'],
      `${name}: the played Chamber card cannot be replaced after it leaves the Chamber`)
    await page.screenshot({ path: `${out}/${name}-covet-load-replacement.png` })
    await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber
      .some(card => card.uid === 'second'))
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber
      .map(card => card.uid)), ['second', 'first'])
    await load(1, 'hermit_pistol_whip')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.combat.players[0].hand = [{ uid: 'load-target', defId: 'hermit_defend', upgraded: false }]
      window.__STS_DEBUG__.setRun(run)
    })
    await page.locator('.hand .card--chamber-drawn').click()
    const targetLoadChoice = page.getByRole('dialog', { name: 'Choose 1 to Load' })
    await targetLoadChoice.getByRole('button', { name: /^Defend,/ }).click()
    await targetLoadChoice.getByRole('button', { name: 'Load 1 card' }).click()
    await targetLoadChoice.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.prompt').innerText(), 'Choose an enemy',
      `${name}: confirmed Load must prompt for the remaining enemy target`)
    await page.locator('.enemy:not(.enemy--dead) .enemy__head').first().click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber[0]?.uid === 'load-target')
    await load(1, 'hermit_tracking_shots')
    await page.locator('.hand .card--chamber-drawn').click()
    assert.equal(await page.locator('.prompt').innerText(), 'Choose an enemy',
      `${name}: a Chamber card cannot Load itself again`)
    await page.locator('.enemy:not(.enemy--dead) .enemy__head').first().click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber.length === 0)
    await load(1, 'hermit_strike')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.combat.players[0].hand = [{ uid: 'tracking-hand', defId: 'hermit_tracking_shots', upgraded: false }]
      window.__STS_DEBUG__.setRun(run)
    })
    await page.locator('.hand .card[title="Tracking Shots"]').click()
    assert.match(await page.locator('.prompt').innerText(), /Load Tracking Shots after playing it\?/,
      `${name}: a hand-played Tracking Shots must still offer Load self`)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Hermit Chamber browser audit passed: click targeting, cancellation and drag on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
