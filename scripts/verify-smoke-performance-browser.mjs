import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const results = {}
try {
 for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch()
  try {
   const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
   await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
   await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js')
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { SmokeTrail, warmSmokeTrails } = await import('/src/ui/combat-screen/SmokeTrail.tsx')
    const { cardFlightPath } = await import('/src/ui/combat-screen/card-flight.ts')
    const host = document.createElement('div'); host.className='card-flight-effect card-flight--defect'; document.body.append(host)
    for (const [destination, right] of [['discard', 30], ['draw', 110], ['exhaust', 190]]) {
      const pile = document.createElement('div'); pile.dataset.pile = destination; pile.style.cssText = `position:fixed;right:${right}px;bottom:20px;width:60px;height:80px`; document.body.append(pile)
    }
    window.smokeRoutes = Object.fromEntries(['discard', 'draw', 'exhaust'].map(destination => [destination, cardFlightPath(destination)]))
    warmSmokeTrails('defect')
    const root = createRoot(host)
    new MutationObserver(() => {
      if (window.smokeReadyMs === undefined && host.querySelector('[data-texture-ready="true"]')) window.smokeReadyMs = performance.now() - window.smokeStarted
    }).observe(host, { childList: true, subtree: true, attributes: true })
    let previousFrame
    function monitor(time) {
      if (previousFrame !== undefined && window.smokeStarted && time - window.smokeStarted < 650) window.startupGaps.push(time - previousFrame)
      previousFrame = time
      requestAnimationFrame(monitor)
    }
    requestAnimationFrame(monitor)
    window.mountSmoke = (destination, key) => {
      window.startupGaps = []
      window.smokeStarted = performance.now(); window.smokeReadyMs = undefined
      const route = window.smokeRoutes[destination]
      root.render(React.createElement(SmokeTrail, { path: route.trailPath, bounds: route.trailBounds, key }))
    }
    window.mountSmokeBatch = () => root.render(Array.from({ length: 13 }, (_, index) => React.createElement(SmokeTrail, {
      path: `M 0 ${index} L ${100 + index} 100`, bounds: { x: 0, y: 0, width: 120, height: 120 }, key: index,
    })))
   })
   await page.waitForTimeout(400)
   results[name] = []
   for (const destination of ['discard', 'draw', 'exhaust']) {
    await page.evaluate(destination => window.mountSmoke(destination, destination), destination)
    await page.locator('.card-flight-trail').waitFor()
    const metrics = await page.evaluate(() => new Promise(resolve => {
     const trail = document.querySelector('.card-flight-trail')
     const reveal = trail.querySelector('path')
     const gaps=[], progress=[]; let previous, start
     function sample(time) {
      start ??= time
      if (previous !== undefined && time-start<1100) gaps.push(time-previous)
      previous=time
      progress.push(1-parseFloat(getComputedStyle(reveal).strokeDashoffset))
      if (time-start<1800) requestAnimationFrame(sample)
      else { const sorted=[...gaps].sort((a,b)=>a-b); resolve({ readyAt: window.smokeReadyMs, startupMax: Math.max(...window.startupGaps), p95: sorted[Math.floor(sorted.length*.95)], max:Math.max(...gaps), maxRevealStep:Math.max(...progress.slice(1).map((p,i)=>p-progress[i])) }) }
     }
     requestAnimationFrame(sample)
    }))
    metrics.destination = destination
    assert(metrics.readyAt < 30, `${name} ${destination}: texture was not predecoded ${JSON.stringify(metrics)}`)
    assert(metrics.startupMax < 60, `${name} ${destination}: first-render stall ${JSON.stringify(metrics)}`)
    assert(metrics.p95 < 50, `${name} ${destination}: dropped frames ${JSON.stringify(metrics)}`)
    assert(metrics.maxRevealStep < .3, `${name} ${destination}: trail jumped ${JSON.stringify(metrics)}`)
    results[name].push(metrics)
   }
   await page.evaluate(() => window.mountSmokeBatch())
   await page.waitForFunction(() => document.querySelectorAll('.card-flight-trail[data-texture-ready="true"]').length === 13)
   assert(await page.locator('.card-flight-trail image').first().evaluate(image => fetch(image.getAttribute('href')).then(response => response.ok).catch(() => false)), `${name}: cache eviction revoked a mounted texture`)
  } finally { await browser.close() }
 }
} finally { await server.close() }
mkdirSync(`${root}artifacts/card-trails`, { recursive: true })
writeFileSync(`${root}artifacts/card-trails/restored-smoke-performance.json`, JSON.stringify(results,null,2))
console.log(results)
