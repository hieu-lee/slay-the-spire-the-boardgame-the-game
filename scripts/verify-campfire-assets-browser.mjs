import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/campfire-assets-browser')
mkdirSync(output, { recursive: true })
const cdn = 'https://cdn.example/public/assets'
const backup = 'https://raw.example/public/assets'
process.env.VITE_ASSET_CDN_ORIGIN = cdn
process.env.VITE_CAMPFIRE_BACKUP_ORIGIN = backup
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const port = server.httpServer.address().port
const browser = await chromium.launch()

try {
  for (const scenario of [
    { name: 'cdn', width: 1440, height: 900, cdnStatus: 200, backupStatus: 200, expected: cdn },
    { name: 'backup', width: 1440, height: 900, cdnStatus: 403, backupStatus: 200, expected: backup },
    { name: 'stalled', width: 1440, height: 900, cdnStatus: 'stall', backupStatus: 200, expected: backup },
    { name: 'local', width: 844, height: 390, cdnStatus: 403, backupStatus: 429, expected: '/assets/noncombat/campfire/empty_firecamp.webp' },
  ]) {
    const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } })
    const serveScene = (status) => (route) => status === 200
      ? route.fulfill({ path: join(root, 'public/assets/noncombat/campfire', route.request().url().split('/').pop()) })
      : status === 'stall' ? new Promise(() => undefined) : route.fulfill({ status })
    await page.route(`${cdn}/noncombat/campfire/*`, serveScene(scenario.cdnStatus))
    await page.route(`${backup}/noncombat/campfire/*`, serveScene(scenario.backupStatus))
    const failedResponses = scenario.name === 'local' ? [
      page.waitForResponse((response) => response.url().startsWith(`${cdn}/noncombat/campfire/`) && response.status() === 403),
      page.waitForResponse((response) => response.url().startsWith(`${backup}/noncombat/campfire/`) && response.status() === 429),
    ] : []
    await page.goto(`http://localhost:${port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Daily', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      const roomId = run.map.rows[0][0]
      run.phase = 'room'
      run.neow = null
      run.map.position = roomId
      run.map.rooms[roomId].kind = 'campfire'
      debug.setRun(run)
    })
    await page.locator('.campfire').waitFor()
    if (scenario.name === 'stalled') {
      const interim = await page.locator('.campfire').evaluate(async (campfire) => {
        const url = getComputedStyle(campfire).backgroundImage.match(/url\(["']?([^"')]+)/)[1]
        const image = new Image()
        image.src = url
        await image.decode()
        return { url, width: image.naturalWidth, height: image.naturalHeight }
      })
      assert(interim.url.endsWith('/assets/noncombat/campfire/empty_firecamp.webp'), interim.url)
      assert.deepEqual([interim.width, interim.height], [3840, 2161])
      await page.screenshot({ path: join(output, 'stalled-interim.png') })
    }
    await Promise.all(failedResponses)
    if (failedResponses.length) await page.evaluate(() => new Promise(requestAnimationFrame))
    await page.waitForFunction((expected) => getComputedStyle(document.querySelector('.campfire')).backgroundImage.includes(expected), scenario.expected)
    const scene = await page.locator('.campfire').evaluate(async (campfire) => {
      const url = getComputedStyle(campfire).backgroundImage.match(/url\(["']?([^"')]+)/)[1]
      const image = new Image()
      image.src = url
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight, icons: [...campfire.querySelectorAll('.campfire__choices img')]
        .map((icon) => icon.complete && icon.naturalWidth > 0 && icon.src.startsWith(location.origin)) }
    })
    assert.deepEqual([scene.width, scene.height], [3840, 2161], scenario.name)
    assert.equal(scene.icons.length, 2, scenario.name)
    assert(scene.icons.every(Boolean), `${scenario.name}: Rest/Smith icons must remain local`)
    await page.screenshot({ path: join(output, `${scenario.name}.png`) })
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}

console.log('✓ campfire CDN, backup, and local artwork render')
