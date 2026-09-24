#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, devices, webkit } from 'playwright'
import { preview } from 'vite'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/ios-install')
mkdirSync(output, { recursive: true })
const server = await preview({ root, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } })
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browsers = []

try {
  for (const [name, engine, device] of [
    ['landscape-phone', webkit, devices['iPhone 13 landscape']],
    ['desktop', chromium, { viewport: { width: 1440, height: 900 } }],
  ]) {
    const browser = await engine.launch()
    browsers.push(browser)
    const page = await browser.newPage(device)
    await page.goto(`${origin}/ios/`)
    await page.getByRole('heading', { name: 'Play on iPhone' }).waitFor()
    const install = page.getByRole('link', { name: 'Try installing in SideStore' })
    const url = new URL(await install.getAttribute('href'))
    assert.equal(url.protocol, 'sidestore:')
    assert.equal(url.hostname, 'install')
    assert.equal(url.searchParams.get('url'),
      'https://github.com/hieu-lee/slay-the-spire-the-boardgame-the-game/releases/latest/download/SlayTheSpireBoardGame.ipa')
    assert(await install.isVisible())
    assert(await page.getByText('has not yet been installed through SideStore on a physical iPhone', { exact: false }).isVisible())
    assert((await install.boundingBox()).height >= 44, 'install target is too small')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'install page clips horizontally')
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
  }
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  writeFileSync(`${output}/report.json`, JSON.stringify({
    pageSha256: digest(resolve(root, 'dist/ios/index.html')),
    screenshotsSha256: Object.fromEntries(['landscape-phone', 'desktop'].map((name) =>
      [name, digest(`${output}/${name}.png`)])),
    install: 'SideStore receives the latest GitHub release IPA URL',
  }, null, 2))
  console.log(`iOS install page E2E verified: ${output}/report.json`)
} finally {
  await Promise.all(browsers.map((browser) => browser.close()))
  await new Promise((done) => server.httpServer.close(done))
}
