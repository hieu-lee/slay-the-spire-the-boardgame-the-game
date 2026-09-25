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

      if (engine === chromium && options.isMobile) {
        const network = await page.context().newCDPSession(page)
        await network.send('Network.enable')
        await network.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        })
      }
      const mountBossFixture = async (fetchScenario = '') => {
        await page.goto(`http://localhost:${server.httpServer.address().port}/__bgm-test`)
        await page.evaluate(async (fetchScenario) => {
          const { useCombatMusic } = await import('/src/ui/sfx.ts')
          const [React, ReactDOM] = await Promise.all([import('/@id/react'), import('/@id/react-dom/client')])
          const react = React.default ?? React
          if (fetchScenario) {
            const originalFetch = window.fetch.bind(window)
            window.fetch = (input, options) => {
              if (!String(input).endsWith('/bgm/the-awakened-one.mp3')) return originalFetch(input, options)
              window.bossFetchCount = (window.bossFetchCount ?? 0) + 1
              if (fetchScenario === 'fail' && window.bossFetchCount === 1) {
                window.bossFetchFailed = true
                return Promise.reject(new Error('Simulated preload failure'))
              }
              if (fetchScenario !== 'hold' || window.bossFetchCount > 2) return originalFetch(input, options)
              window.bossFetchPending = true
              return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
                window.bossFetchAborted = true
                reject(new DOMException('Preload aborted', 'AbortError'))
              }, { once: true }))
            }
          }
          const createObjectURL = URL.createObjectURL.bind(URL)
          const revokeObjectURL = URL.revokeObjectURL.bind(URL)
          URL.createObjectURL = (blob) => {
            if (blob.type.startsWith('audio/')) window.bossPreloaded = true
            return createObjectURL(blob)
          }
          URL.revokeObjectURL = (url) => { window.bossRevoked = url; revokeObjectURL(url) }
          const play = HTMLMediaElement.prototype.play
          HTMLMediaElement.prototype.play = function () {
            window.music = this
            if (window.blockBossAutoplay) {
              window.musicAttempts = (window.musicAttempts ?? 0) + 1
              return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'))
            }
            if (window.rejectBossBlob && this.src.startsWith('blob:')) return Promise.reject(new DOMException('Blob playback failed', 'NotSupportedError'))
            this.addEventListener('playing', () => { window.musicStartedAt = performance.now() }, { once: true })
            return play.call(this)
          }
          function Game() {
            const [run, setRun] = react.useState({ act: 3, phase: 'map' })
            const [connected, setConnected] = react.useState(true)
            const [keepAcrossDisconnect, setKeepAcrossDisconnect] = react.useState(true)
            window.leaveBoss = () => setRun({ act: 3, phase: 'map' })
            window.betweenBosses = () => setRun({ act: 3, phase: 'betweenCombat' })
            window.setConnected = setConnected
            window.setKeepAcrossDisconnect = setKeepAcrossDisconnect
            useCombatMusic(run, connected, 20, keepAcrossDisconnect)
            return react.createElement(react.Fragment, null,
              react.createElement('button', { onClick: () => {
                window.combatEnteredAt = performance.now()
                setRun({ ...run, phase: 'combat',
                  combat: { combatId: 'act-3-boss', phase: 'player', enemies: [{ defId: 'awakened_one_phase_1', isBoss: true }] } })
              } }, 'Face Act 3 boss'),
              react.createElement('button', { onClick: () => {
                window.combatEnteredAt = performance.now()
                setRun({ act: 3, phase: 'combat', combat: { combatId: 'act-3-hallway', phase: 'player', enemies: [] } })
              } }, 'Enter Act 3 hallway'))
          }
          const mount = document.createElement('div')
          document.body.append(mount)
          const createRoot = ReactDOM.createRoot ?? ReactDOM.default.createRoot
          window.bossRoot = createRoot(mount)
          window.bossRoot.render(react.createElement(Game))
        }, fetchScenario)
      }
      await mountBossFixture()
      await page.waitForFunction(() => window.bossPreloaded, null, { timeout: 5000 })
      await page.route('**/bgm/the-awakened-one.mp3', (route) => route.abort())
      await page.getByRole('button', { name: 'Face Act 3 boss' }).click()
      await page.waitForFunction(() => window.musicStartedAt, null, { timeout: 3000 })
      const boss = await page.evaluate(() => ({ source: window.music.src, delayMs: window.musicStartedAt - window.combatEnteredAt }))
      assert(boss.source.startsWith('blob:'), `${name} downloaded the boss theme again after prefetch`)
      assert(boss.delayMs < 1500, `${name} started the boss theme ${boss.delayMs.toFixed(0)} ms late`)
      console.log(`PASS ${name}: preloaded Act 3 boss theme starts in ${boss.delayMs.toFixed(0)} ms`)

      await page.evaluate(() => { window.setConnected(false); window.musicStartedAt = undefined })
      await page.waitForFunction(() => window.music?.paused)
      await page.evaluate(() => window.setConnected(true))
      await page.waitForFunction(() => window.musicStartedAt, null, { timeout: 3000 })
      assert.equal(await page.evaluate(() => window.music.src), boss.source, `${name} re-downloaded the boss theme after reconnect`)
      console.log(`PASS ${name}: boss music resumes from the preloaded theme after reconnect`)

      await page.unroute('**/bgm/the-awakened-one.mp3')
      await page.evaluate(() => { window.leaveBoss(); window.rejectBossBlob = true; window.musicStartedAt = undefined })
      await page.waitForFunction(() => window.music?.paused)
      await page.getByRole('button', { name: 'Face Act 3 boss' }).click()
      await page.waitForFunction(() => window.musicStartedAt, null, { timeout: 3000 })
      const fallback = await page.evaluate(() => new URL(window.music.src).pathname)
      assert.equal(fallback, '/assets/bgm/the-awakened-one.mp3', `${name} did not stream the boss theme after Blob rejection`)
      console.log(`PASS ${name}: boss theme falls back to its streamed MP3`)
      await page.evaluate(() => { window.leaveBoss(); window.rejectBossBlob = false; window.blockBossAutoplay = true })
      await page.waitForFunction(() => window.music?.paused)
      await page.getByRole('button', { name: 'Face Act 3 boss' }).click()
      await page.waitForFunction(() => window.musicAttempts === 1)
      assert((await page.evaluate(() => window.music.src)).startsWith('blob:'), `${name} streamed despite autoplay denial`)
      console.log(`PASS ${name}: autoplay denial does not discard preloaded music`)
      await page.evaluate(() => { window.leaveBoss(); window.setKeepAcrossDisconnect(false); window.setConnected(false) })
      await page.waitForFunction((source) => window.bossRevoked === source, boss.source)
      console.log(`PASS ${name}: closing the game releases the preloaded boss theme`)
      await page.evaluate(() => window.bossRoot.unmount())
      assert.equal(await page.evaluate(() => window.bossRevoked), boss.source, `${name} retained the boss theme after unmount`)

      await mountBossFixture('hold')
      await page.waitForFunction(() => window.bossFetchPending)
      await page.evaluate(() => { window.setKeepAcrossDisconnect(false); window.setConnected(false) })
      await page.waitForFunction(() => window.bossFetchAborted)
      await page.evaluate(() => { window.bossFetchAborted = false; window.bossFetchPending = false; window.setConnected(true) })
      await page.waitForFunction(() => window.bossFetchPending)
      if (engine === chromium && options.isMobile) {
        const network = await page.context().newCDPSession(page)
        await network.send('Network.enable')
        await network.send('Network.setCacheDisabled', { cacheDisabled: true })
        await network.send('Network.emulateNetworkConditions', {
          offline: false, latency: 80, downloadThroughput: 256 * 1024, uploadThroughput: 256 * 1024,
        })
      }
      await page.getByRole('button', { name: 'Face Act 3 boss' }).click()
      await page.waitForFunction(() => window.bossFetchAborted && window.musicStartedAt, null, { timeout: 3000 })
      const streaming = await page.evaluate(() => ({
        path: new URL(window.music.src).pathname, delayMs: window.musicStartedAt - window.combatEnteredAt,
      }))
      assert.equal(streaming.path, '/assets/bgm/the-awakened-one.mp3')
      assert(streaming.delayMs < 1500, `${name} streamed boss theme ${streaming.delayMs.toFixed(0)} ms late`)
      console.log(`PASS ${name}: boss entry cancels the unfinished preload and streams in ${streaming.delayMs.toFixed(0)} ms`)
      if (engine === chromium && options.isMobile) {
        const network = await page.context().newCDPSession(page)
        await network.send('Network.enable')
        await network.send('Network.setCacheDisabled', { cacheDisabled: false })
        await network.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        })
      }
      await page.evaluate(() => { window.betweenBosses(); window.musicStartedAt = undefined })
      await page.waitForFunction(() => window.bossFetchCount === 3 && window.bossPreloaded, null, { timeout: 5000 })
      await page.route('**/bgm/the-awakened-one.mp3', (route) => route.abort())
      await page.getByRole('button', { name: 'Face Act 3 boss' }).click()
      await page.waitForFunction(() => window.musicStartedAt, null, { timeout: 3000 })
      assert((await page.evaluate(() => window.music.src)).startsWith('blob:'), `${name} did not preload the second boss theme`)
      console.log(`PASS ${name}: the second Act 3 boss uses a restarted preload`)
      await page.evaluate(() => window.bossRoot.unmount())
      await page.unroute('**/bgm/the-awakened-one.mp3')

      await mountBossFixture('hold')
      await page.waitForFunction(() => window.bossFetchPending)
      if (engine === chromium && options.isMobile) {
        const network = await page.context().newCDPSession(page)
        await network.send('Network.enable')
        await network.send('Network.setCacheDisabled', { cacheDisabled: true })
        await network.send('Network.emulateNetworkConditions', {
          offline: false, latency: 80, downloadThroughput: 256 * 1024, uploadThroughput: 256 * 1024,
        })
      }
      await page.getByRole('button', { name: 'Enter Act 3 hallway' }).click()
      await page.waitForFunction(() => window.bossFetchAborted && window.musicStartedAt, null, { timeout: 3000 })
      const hallway = await page.evaluate(() => ({
        path: new URL(window.music.src).pathname, delayMs: window.musicStartedAt - window.combatEnteredAt,
      }))
      assert(['/assets/bgm/dramatic-entrance.mp3', '/assets/bgm/the-beyond.mp3'].includes(hallway.path), `${name} lost hallway music`)
      assert(hallway.delayMs < 1500, `${name} started hallway music ${hallway.delayMs.toFixed(0)} ms late`)
      await page.evaluate(() => { window.leaveBoss(); window.bossFetchPending = false })
      await page.waitForFunction(() => window.bossFetchCount === 2 && window.bossFetchPending)
      console.log(`PASS ${name}: hallway music interrupts the preload, which restarts after combat`)
      await page.evaluate(() => window.bossRoot.unmount())
      if (engine === chromium && options.isMobile) {
        const network = await page.context().newCDPSession(page)
        await network.send('Network.enable')
        await network.send('Network.setCacheDisabled', { cacheDisabled: false })
        await network.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        })
      }

      await mountBossFixture('fail')
      await page.waitForFunction(() => window.bossFetchFailed)
      await page.waitForFunction(() => window.bossFetchCount === 2 && window.bossPreloaded, null, { timeout: 5000 })
      await page.route('**/bgm/the-awakened-one.mp3', (route) => route.abort())
      await page.getByRole('button', { name: 'Face Act 3 boss' }).click()
      await page.waitForFunction(() => window.musicStartedAt, null, { timeout: 3000 })
      assert((await page.evaluate(() => window.music.src)).startsWith('blob:'), `${name} did not retry a failed preload`)
      console.log(`PASS ${name}: failed preloads retry without a phase change`)
      await page.evaluate(() => window.bossRoot.unmount())
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
