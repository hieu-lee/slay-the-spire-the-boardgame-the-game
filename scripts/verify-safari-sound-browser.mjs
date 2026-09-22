#!/usr/bin/env node
// Failure cases: rapid voices create media-player stalls; wrong gain/rate;
// delayed impacts drift; cancellation/mute/reconnect replays pending sounds;
// the voice cap leaks nodes; a failed decode removes audio; Chrome changes path.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/safari-sound')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const report = []
try {
  for (const [name, engine] of Object.entries({ webkit, chromium })) {
    const browser = await engine.launch()
    try {
      const page = await browser.newPage()
      await page.addInitScript(() => {
        window.soundStarts = []; window.soundStops = []; window.mediaStarts = []
        const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop
        const connect = AudioNode.prototype.connect, play = HTMLMediaElement.prototype.play
        AudioNode.prototype.connect = function (...args) {
          if (this instanceof AudioBufferSourceNode) this.testGain = args[0]
          return connect.apply(this, args)
        }
        AudioBufferSourceNode.prototype.start = function (...args) {
          window.soundStarts.push({ at: performance.now(), rate: this.playbackRate.value,
            gain: this.testGain?.gain.value, duration: this.buffer?.duration, state: this.context.state })
          return start.apply(this, args)
        }
        AudioBufferSourceNode.prototype.stop = function (...args) {
          window.soundStops.push(performance.now()); return stop.apply(this, args)
        }
        HTMLMediaElement.prototype.play = function () {
          if (this instanceof HTMLAudioElement) window.mediaStarts.push(new URL(this.src).pathname)
          return play.call(this)
        }
      })
      await page.route('**/__sound-test', async route => route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__sound-test', '<!doctype html><html><head></head><body></body></html>') }))
      await page.goto(`http://localhost:${server.httpServer.address().port}/__sound-test`)
      await page.evaluate(async () => {
        const sfx = await import('/src/ui/sfx.ts')
        const { useGameSettings } = await import('/src/ui/game-settings.ts')
        const [React, ReactDOM] = await Promise.all([import('/@id/react'), import('/@id/react-dom/client')])
        const settingsNode = document.createElement('div'); document.body.append(settingsNode)
        function Settings() { const [, setSettings] = useGameSettings(); window.setSoundSettings = setSettings; return null }
        (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(settingsNode).render((React.createElement ?? React.default.createElement)(Settings))
        window.sfx = sfx
        window.cleanupSound = sfx.installSoundEffects()
        const button = document.createElement('button'); button.textContent = 'Play'; button.dataset.sfx = 'none'
        button.onclick = () => {
          window.soundStarts = []; window.soundStops = []; window.mediaStarts = []
          window.soundAt = performance.now()
          window.cancelSound = sfx.playCombatSound({ cue: 'test', layers: [
            { sound: 'block', volume: .28, rate: .94, delayMs: 0 },
            { sound: 'magic', volume: .1, rate: .9, delayMs: 80 },
          ] })
        }
        document.body.append(button)
      })
      await page.waitForTimeout(1500)
      await page.getByRole('button', { name: 'Play', exact: true }).click()
      await page.waitForTimeout(200)
      const plays = await page.evaluate(() => ({ starts: window.soundStarts, media: window.mediaStarts, at: window.soundAt }))
      if (name === 'webkit') {
        assert.equal(plays.starts.length, 2, 'Safari must use decoded buffers')
        assert.equal(plays.media.length, 0, 'Safari must not create a media pipeline for each effect')
        for (const [index, expected] of [[0, [.94, .28]], [1, [.9, .1]]]) {
          assert(Math.abs(plays.starts[index].rate - expected[0]) < .001)
          assert(Math.abs(plays.starts[index].gain - expected[1]) < .001)
          assert(plays.starts[index].duration > 0)
          assert.equal(plays.starts[index].state, 'running')
        }
        assert(Math.abs(plays.starts[1].at - plays.starts[0].at - 80) < 40)
        await page.evaluate(() => window.cancelSound())
        assert.equal(await page.evaluate(() => window.soundStops.length), 2)
        await page.evaluate(() => {
          window.soundStarts = []
          const cancel = window.sfx.playCombatSound({ cue: 'cancel', layers: [{sound:'block',volume:.2,rate:1,delayMs:80}] })
          cancel()
        })
        await page.waitForTimeout(150)
        assert.equal(await page.evaluate(() => window.soundStarts.length), 0)
        await page.evaluate(() => {
          for (let i=0; i<30; i++) window.sfx.playSoundEffect('magic')
        })
        await page.waitForTimeout(100)
        assert.equal(await page.evaluate(() => window.soundStarts.length), 24, 'voice cap must cancel pending starts')
        await page.evaluate(() => window.cleanupSound())
        const stopped = await page.evaluate(() => window.soundStops.length)
        assert(stopped >= 26, 'unmount must release every live voice')
        await page.evaluate(() => {
          window.setSoundSettings(settings => ({...settings, sfxVolume: 0})); window.soundStarts = []
        })
        await page.waitForTimeout(100)
        await page.evaluate(() => window.sfx.playSoundEffect('block'))
        await page.waitForTimeout(100)
        assert.equal(await page.evaluate(() => window.soundStarts.length), 0)
      } else {
        assert.equal(plays.starts.length, 0, 'Chrome retains its existing media playback')
        assert.deepEqual(plays.media.map(path => path.split('/').at(-1)), ['block.ogg', 'magic.ogg'])
      }
      if (name === 'webkit') {
        const fallback = await browser.newPage()
        await fallback.route('**/__sound-test', async route => route.fulfill({ contentType: 'text/html',
          body: await server.transformIndexHtml('/__sound-test', '<!doctype html><html><head></head><body></body></html>') }))
        await fallback.route('**/assets/sfx/*.wav', route => route.abort())
        await fallback.goto(`http://localhost:${server.httpServer.address().port}/__sound-test`)
        await fallback.evaluate(async () => {
          const { installSoundEffects, playCombatSound } = await import('/src/ui/sfx.ts')
          window.mediaPlays = []; window.bufferPlays = 0
          const play = HTMLMediaElement.prototype.play, start = AudioBufferSourceNode.prototype.start
          HTMLMediaElement.prototype.play = function () { window.mediaPlays.push(this.src); return play.call(this) }
          AudioBufferSourceNode.prototype.start = function (...args) { window.bufferPlays++; return start.apply(this, args) }
          window.cleanupSound = installSoundEffects(false)
          const button = document.createElement('button'); button.textContent = 'Play'; button.dataset.sfx = 'none'
          button.onclick = () => { window.cancelSound = playCombatSound({cue:'fallback', layers:[{sound:'block',volume:.28,rate:1,delayMs:0}]}) }
          document.body.append(button)
        })
        await fallback.getByRole('button', { name: 'Play', exact: true }).click()
        await fallback.waitForFunction(() => window.mediaPlays.length === 1)
        assert.match(await fallback.evaluate(() => window.mediaPlays[0]), /block\.ogg$/)
        await fallback.evaluate(() => { window.cancelSound(); window.cancelSound(); window.cleanupSound() })
        await fallback.unroute('**/assets/sfx/*.wav')
        await fallback.getByRole('button', { name: 'Play', exact: true }).click()
        await fallback.waitForFunction(() => window.bufferPlays === 1)
        await fallback.evaluate(() => window.cancelSound())
        await fallback.close()
      }
      report.push({ name, ...plays })
      console.log(`PASS ${name}: sound playback, timing and lifecycle`)
    } finally { await browser.close() }
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
} finally { await server.close() }
