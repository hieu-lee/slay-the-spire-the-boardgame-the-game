import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

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
    for (const [defId, name, targeted, drawCount] of [
      ['third_eye', 'Third Eye', false, 0],
      ['just_lucky', 'Just Lucky', true, 0],
      ['cut_through_fate', 'Cut Through Fate', true, 0],
      ['secret_technique', 'Secret Technique', false, 0],
      ['third_eye', 'Third Eye', false, 1],
    ]) {
      const run = postNeowRun(47, [{ id: 'p1', name: 'Watcher', character: 'watcher' }])
      const room = run.map.rows[0][0]
      run.map.rooms[room].kind = 'encounter'
      const next = enterRoom(run, room)
      next.combat.combatId = `empty-scry-${defId}-${drawCount}`
      Object.assign(next.combat, { phase: 'player', die: 1, pendingTriggers: [], startTurnProgress: undefined })
      Object.assign(next.combat.players[0], {
        energy: 9, block: 0, relics: [], powers: [{ uid: 'nirvana', defId: 'nirvana', upgraded: false }],
        hand: [{ uid: 'play', defId, upgraded: false }, { uid: 'hold', defId: 'strike_watcher', upgraded: false }],
        draw: drawCount ? [{ uid: 'revealed', defId: 'defend_watcher', upgraded: false }] : [],
        discard: [{ uid: 'discarded', defId: 'defend_watcher', upgraded: false }],
      })
      next.combat.enemies = [{ ...next.combat.enemies[0], uid: 'target', hp: 30, maxHp: 30, block: 0, dead: false }]
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), next)
      await page.locator(`.hand .card[title="${name}"]`).click()
      if (targeted) await page.locator('[data-enemy-id="target"] .enemy__hit-area').click()
      if (drawCount) {
        const dialog = page.getByRole('dialog', { name: 'Scry 3', exact: true })
        await dialog.waitFor()
        assert.equal(await dialog.locator('.card').count(), 1)
        await dialog.getByRole('button', { name: 'Keep all', exact: true }).click()
      }
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.players[0].hand.some(card => card.uid === 'play'))
      assert.equal(await page.getByRole('dialog', { name: /^Scry / }).count(), 0)
      const state = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
      if (defId === 'third_eye') assert.equal(state.players[0].block, drawCount ? 3 : 2)
      if (targeted) assert.equal(state.enemies[0].hp, 29)
      if (defId === 'cut_through_fate') assert(state.players[0].hand.some(card => card.uid === 'discarded'))
    }
    await page.close()
    console.log(`PASS ${screen}: empty Scry skips confirmation, other effects and nonempty choices remain`)
  }
} finally {
  await browser.close()
  await server.close()
}
