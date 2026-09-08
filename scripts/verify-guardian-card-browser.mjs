import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/guardian-card-audit'
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
    async function load(id, upgraded = false, gem) {
      const run = createRun(908, [
        { id: viewerId, name: 'Guardian', character: 'guardian' },
        { id: 'ally', name: 'Ally', character: 'ironclad' },
      ])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      run.combat = createCombat({ seed: 908, calls: 0 }, run.players, [enemy, { ...enemy, uid: 'e1' }], 'audit')
      Object.assign(run.combat.players[0], { hand: [{ uid: 'card', defId: id, upgraded, attachedGemId: gem }],
        energy: 3, vigor: 0, vigorSpentThisTurn: id === 'guardian_refracted_beam' ? 1 : 0 })
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForTimeout(1200) // Let the previous card's presentation finish before capturing the next fixture.
    }
    for (const upgraded of [false, true]) {
      await load('guardian_stasis_field', upgraded)
      await page.getByRole('button', { name: /^Stasis Field\+?,/ }).click()
      const count = upgraded ? 5 : 4
      await page.getByText(`Choose Block recipient 1/${count}`, { exact: true }).waitFor()
      await page.screenshot({ path: `${out}/${name}-stasis${upgraded ? '-upgraded' : ''}.png` })
      await page.locator('button.seat--viewer').click()
      for (let i = 1; i < count; i++) await page.locator('button.seat:not(.seat--viewer)').click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
      assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players.map(p => p.block)), [1, count - 1])
    }
    await load('guardian_prismatic_barrier', false, 'guardian_sapphire')
    await page.getByRole('button', { name: /^Prismatic Barrier,/ }).click()
    await page.locator('button.seat--targetable:not(.seat--viewer)').waitFor()
    await page.screenshot({ path: `${out}/${name}-prismatic.png` })
    await page.locator('button.seat--targetable:not(.seat--viewer)').click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players.map(p => p.block)), [1, 1])
    await load('guardian_refracted_beam')
    await page.getByRole('button', { name: /^Refracted Beam,/ }).click()
    assert(!/whole row/.test(await page.locator('.prompt').textContent()))
    await page.screenshot({ path: `${out}/${name}-refracted.png` })
    await page.locator('.enemy:not(.enemy--dead)').first().click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(e => e.hp)).then(hp => hp.sort()), [37, 40])
    const keywords = await page.evaluate(async () => {
      const { cardKeywordTips } = await import('/src/ui/Card.tsx')
      const { cardDef } = await import('/src/game/cards.ts')
      return cardKeywordTips(cardDef('guardian_prismatic_barrier')).map(t => t.name)
    })
    assert(keywords.includes('Block'))
    assert(!keywords.includes('Hit') && !keywords.includes('Weak') && !keywords.includes('Vulnerable'))
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Guardian browser audit passed: desktop and horizontal phone; Stasis Field, Prismatic Barrier, Refracted Beam and keywords.')
} finally {
  await browser.close()
  await server.close()
}
