#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/ui-sfx')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const report = []
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch()
    try {
      for (const [screen, viewport, phone] of [
        ['desktop', { width: 1440, height: 900 }, false],
        ['horizontal-phone', { width: 844, height: 390 }, true],
      ]) {
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
        const page = await context.newPage()
        const errors = [], requests = []
        page.on('pageerror', error => errors.push(String(error)))
        page.on('response', response => {
          if (/\/sfx\/ui\.(ogg|wav)$/.test(response.url())) requests.push({ path: new URL(response.url()).pathname, status: response.status() })
        })
        await page.addInitScript(() => {
          window.uiSounds = []
          const play = HTMLMediaElement.prototype.play, start = AudioBufferSourceNode.prototype.start
          HTMLMediaElement.prototype.play = function () {
            if (this instanceof HTMLAudioElement && this.src.endsWith('/sfx/ui.ogg')) window.uiSounds.push({ kind: 'media', volume: this.volume })
            return play.call(this)
          }
          AudioBufferSourceNode.prototype.start = function (...args) {
            if (this.buffer?.duration < .15) window.uiSounds.push({ kind: 'buffer', duration: this.buffer.duration })
            return start.apply(this, args)
          }
        })
        await page.goto(`http://localhost:${server.httpServer.address().port}/`)
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.waitForFunction(() => window.uiSounds.length > 0)
        assert.equal((await page.evaluate(() => window.uiSounds[0].kind)), engineName === 'webkit' ? 'buffer' : 'media')
        await page.getByRole('button', { name: 'audio', exact: true }).click()
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}.png`) })
        const count = () => page.evaluate(() => window.uiSounds.length)
        const slider = page.getByRole('slider', { name: 'Sound effects volume' })
        await slider.focus()
        await slider.press('Home')
        await page.waitForFunction(() => document.querySelector('[aria-label="Sound effects volume"]')?.value === '0')
        const mutedCount = await count()
        await page.getByRole('button', { name: 'video', exact: true }).click()
        assert.equal(await count(), mutedCount, 'muted buttons still click')
        await page.getByRole('button', { name: 'audio', exact: true }).click()
        await slider.focus()
        await slider.press('End')
        await page.waitForFunction(() => document.querySelector('[aria-label="Sound effects volume"]')?.value === '100')
        await page.getByRole('button', { name: 'video', exact: true }).click()
        await page.waitForFunction(expected => window.uiSounds.length > expected, mutedCount)
        const beforeRole = await count()
        await page.evaluate(() => {
          const control = document.createElement('span')
          control.role = 'button'; control.tabIndex = 0; control.textContent = 'Custom action'
          control.onclick = event => event.stopPropagation()
          document.querySelector('.settings-dialog__panel').append(control)
        })
        await page.getByRole('button', { name: 'Custom action' }).click()
        await page.waitForFunction(expected => window.uiSounds.length > expected, beforeRole)
        const beforeDisabled = await count()
        await page.getByRole('button', { name: 'Custom action' }).evaluate(node => node.setAttribute('aria-disabled', 'true'))
        await page.getByRole('button', { name: 'Custom action' }).click({ force: true })
        assert.equal(await count(), beforeDisabled, 'aria-disabled custom control clicked')
        assert(requests.some(request => request.path.endsWith(engineName === 'webkit' ? 'ui.wav' : 'ui.ogg') && [200, 206].includes(request.status)), JSON.stringify(requests))
        assert.deepEqual(errors, [])
        report.push({ engineName, screen, sounds: await page.evaluate(() => window.uiSounds), requests })
        await context.close()
        console.log(`PASS ${engineName} ${screen}: click, mute, custom and disabled controls`)
      }
    } finally { await browser.close() }
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
} finally { await server.close() }
