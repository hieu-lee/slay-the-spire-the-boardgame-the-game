import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'
import { bruiserSlime } from '../src/game/downfall/slime-boss.ts'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const bruiser = bruiserSlime('bruiser')
    const taunting = { ...bruiserSlime('taunting'),
      card: { uid: 'taunting', defId: 'slime_boss_taunting_slime', upgraded: false } }
    for (const [label, slimes, enemyCount, optional] of [
      ['sole', [bruiser], 1, false],
      ['support', [taunting], 1, false],
      ['slime-choice', [bruiser, taunting], 1, false],
      ['enemy-choice', [bruiser], 2, false],
      ['optional', [bruiser], 1, true],
    ]) {
      const run = postNeowRun(47, [{ id: 'p1', name: 'Slime Boss', character: 'slime_boss' }])
      const room = run.map.rows[0][0]
      run.map.rooms[room].kind = 'encounter'
      const next = enterRoom(run, room)
      Object.assign(next.combat, { phase: 'player', combatId: `${screen}-${label}`,
        pendingTriggers: [], startTurnProgress: undefined })
      Object.assign(next.combat.players[0], { slimes, energy: 9, block: 0, relics: [], powers: [],
        hand: [{ uid: 'lick', defId: 'slime_boss_lick', upgraded: optional },
          { uid: 'strike', defId: 'slime_boss_strike', upgraded: false }] })
      next.combat.enemies = Array.from({ length: enemyCount }, (_, index) =>
        ({ ...next.combat.enemies[0], uid: `target-${index}`, hp: 30, maxHp: 30, block: 0, dead: false }))
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), next)
      await page.locator(`.hand .card[title="${optional ? 'Lick+' : 'Lick'}"]`).click()
      if (optional) {
        await page.getByRole('button', { name: 'Confirm 0', exact: true }).click()
      } else if (slimes.length > 1) {
        assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(enemy => enemy.hp)), [30])
        await page.getByRole('button', { name: 'Bruiser Slime · level 1', exact: true }).click()
      }
      if (enemyCount > 1) {
        assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(enemy => enemy.hp)), [30, 30])
        await page.locator('[data-enemy-id="target-1"] .enemy__hit-area').click()
      }
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.players[0].hand.some(card => card.uid === 'lick'))
      const state = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
      assert.equal(state.players[0].energy, 8)
      assert.equal(state.players[0].slimes[0].commandsThisTurn, optional ? 0 : 1)
      if (slimes.length > 1) assert.equal(state.players[0].slimes[1].commandsThisTurn, 0)
      if (label === 'support') assert.equal(state.players[0].block, 1)
      else assert.equal(state.enemies.at(-1).hp, optional ? 30 : 29)
      if (enemyCount > 1) assert.equal(state.enemies[0].hp, 30)
    }
    await page.close()
    console.log(`PASS ${screen}: mandatory singleton choices resolve; optional and multiple choices remain`)
  }
} finally {
  await browser.close()
  await server.close()
}
