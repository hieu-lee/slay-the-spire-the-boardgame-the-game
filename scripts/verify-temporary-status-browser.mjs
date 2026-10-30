import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const output = 'artifacts/temporary-status'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    await page.mouse.move(2, 2)
    for (const character of ['watcher', 'defect']) {
      const run = postNeowRun(47, [{ id: 'p1', name: character, character }])
      const room = run.map.rows[0][0]
      run.map.rooms[room].kind = 'encounter'
      const next = enterRoom(run, room)
      next.combat.combatId = `statuses-${character}`
      next.combat.phase = 'player'
      Object.assign(next.combat.players[0], {
        skin: character === 'watcher' ? 'monogatari_watcher' : undefined,
        energy: 3, relics: [], powers: [], potions: [], strengthLossAtEndOfTurn: 0, drawLocked: false,
        orbs: character === 'defect' ? ['lightning', 'frost', 'dark'] : [null, null, null],
      })
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), next)
      await page.waitForFunction(id => window.__STS_DEBUG__.getRun().combat?.combatId === id, next.combat.combatId)
      const seat = page.locator('.seat[data-player-id="p1"]')
      await seat.locator('.seat__portrait > img').first().evaluate(image => image.decode())
      await page.waitForFunction(() => !document.querySelector('.combat').getAnimations({ subtree: true })
        .some(animation => animation instanceof CSSTransition && animation.transitionProperty.startsWith('--stage-') &&
          animation.playState === 'running'))
      const portrait = seat.locator('.seat__portrait')
      const before = await portrait.boundingBox()
      await page.evaluate(() => {
        const run = structuredClone(window.__STS_DEBUG__.getRun())
        Object.assign(run.combat.players[0], { strengthLossAtEndOfTurn: 1, drawLocked: true })
        window.__STS_DEBUG__.setRun(run)
      })
      const statuses = seat.locator('.seat__meta')
      await statuses.getByText('Cannot draw more cards this turn', { exact: true }).waitFor()
      await page.waitForFunction(() => {
        const meta = document.querySelector('.seat__meta')
        return Number.parseFloat(meta.parentElement.style.getPropertyValue('--temporary-status-height')) === meta.offsetHeight
      })
      const geometry = await statuses.evaluate(meta => {
        const box = meta.getBoundingClientRect()
        const board = meta.closest('.board').getBoundingClientRect()
        return {
          overflow: getComputedStyle(meta).overflowX,
          width: meta.clientWidth, scrollWidth: meta.scrollWidth,
          height: meta.clientHeight, scrollHeight: meta.scrollHeight,
          top: box.top, bottom: box.bottom, boardTop: board.top, boardBottom: board.bottom,
          visible: box.left >= Math.max(0, board.left) && box.right <= Math.min(innerWidth, board.right) &&
            box.top >= Math.max(0, board.top) && box.bottom <= Math.min(innerHeight, board.bottom),
          chipsFit: [...meta.children].every(chip => {
            const rect = chip.getBoundingClientRect()
            return rect.left >= box.left - 1 && rect.right <= box.right + 1 &&
              rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 &&
              chip.scrollWidth <= chip.clientWidth + 1 && chip.scrollHeight <= chip.clientHeight + 1
          }),
          orbsClear: [...meta.parentElement.querySelectorAll('.orbs .token--orb')].every(orb => {
            const rect = orb.getBoundingClientRect()
            return rect.bottom + rect.height * 0.16 + 4 <= box.top && rect.top >= board.top
          }),
        }
      })
      await page.screenshot({ path: `${output}/${screen}-${character}.png` })
      assert(!['auto', 'scroll'].includes(geometry.overflow), 'temporary statuses must not create a scroll container')
      assert(geometry.scrollWidth <= geometry.width + 1 && geometry.scrollHeight <= geometry.height + 1 &&
        geometry.chipsFit && geometry.visible && geometry.orbsClear,
      `${screen}/${character}: statuses must remain readable without clipping or covering Orbs: ${JSON.stringify(geometry)}`)
      const after = await portrait.boundingBox()
      for (const key of ['x', 'y', 'width', 'height']) {
        assert(Math.abs(before[key] - after[key]) < 1, 'wrapping statuses must not move or resize the hero')
      }
      await page.evaluate(() => {
        const run = structuredClone(window.__STS_DEBUG__.getRun())
        Object.assign(run.combat.players[0], { strengthLossAtEndOfTurn: 0, drawLocked: false })
        window.__STS_DEBUG__.setRun(run)
      })
      await statuses.waitFor({ state: 'hidden' })
      await page.waitForFunction(() => document.querySelector('.seat__meta').parentElement.style
        .getPropertyValue('--temporary-status-height') === '0px')
    }
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${screen}: wrapped temporary statuses, no scrollbar, stable hero and clear Orbs`)
  }
} finally {
  await browser.close()
  await server.close()
}
