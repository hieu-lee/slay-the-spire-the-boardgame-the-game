#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from 'playwright'

const server = await createServer({ root: resolve(import.meta.dirname, '..'), logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  const phoneEngine = process.argv.includes('--webkit') ? webkit : chromium
  for (const [name, engine, options] of [
    [phoneEngine === webkit ? 'WebKit landscape phone' : 'Chromium landscape phone', phoneEngine,
      { ...devices['iPhone 13 landscape'], viewport: { width: 844, height: 390 } }],
    ['Chromium desktop', chromium, { viewport: { width: 1440, height: 900 } }],
  ]) {
    const browser = await engine.launch()
    try {
      const page = await browser.newPage(options)
      await page.route('**/__bgm-test', async (route) => route.fulfill({
        contentType: 'text/html',
        body: await server.transformIndexHtml('/__bgm-test', '<!doctype html><html><body></body></html>'),
      }))
      await page.goto(`http://localhost:${server.httpServer.address().port}/__bgm-test`)
      await page.evaluate(async () => {
        const { useCombatMusic } = await import('/src/ui/sfx.ts')
        const [React, ReactDOM] = await Promise.all([import('/@id/react'), import('/@id/react-dom/client')])
        const react = React.default ?? React
        const play = HTMLMediaElement.prototype.play
        HTMLMediaElement.prototype.play = function () {
          window.music = this
          this.addEventListener('playing', () => { window.musicStartedAt = performance.now() }, { once: true })
          return play.call(this)
        }
        function Game() {
          const [run, setRun] = react.useState()
          useCombatMusic(run)
          return react.createElement('button', { onClick: () => {
            window.combatEnteredAt = performance.now()
            setRun({ act: 1, combat: { combatId: 'hallway-1-1', phase: 'player', enemies: [] } })
          } }, 'Enter combat')
        }
        const mount = document.createElement('div')
        document.body.append(mount)
        const createRoot = ReactDOM.createRoot ?? ReactDOM.default.createRoot
        createRoot(mount).render(react.createElement(Game))
      })
      if (engine === chromium && options.isMobile) {
        const network = await page.context().newCDPSession(page)
        await network.send('Network.enable')
        await network.send('Network.emulateNetworkConditions', {
          offline: false, latency: 80, downloadThroughput: 256 * 1024, uploadThroughput: 256 * 1024,
        })
      }
      await page.getByRole('button', { name: 'Enter combat' }).click()
      await page.waitForFunction(() => window.musicStartedAt, null, { timeout: 3000 })
      const music = await page.evaluate(() => ({
        path: new URL(window.music.src).pathname, loop: window.music.loop,
        delayMs: window.musicStartedAt - window.combatEnteredAt,
      }))
      assert.equal(music.path, '/assets/bgm/exordium.mp3')
      assert.equal(music.loop, true)
      assert(music.delayMs < 1500, `${name} started combat music ${music.delayMs.toFixed(0)} ms late`)
      console.log(`PASS ${name}: combat theme starts in ${music.delayMs.toFixed(0)} ms`)
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
