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
    const { SmokeTrail } = await import('/src/ui/combat-screen/SmokeTrail.tsx')
    const host = document.createElement('div'); host.className='card-flight-effect card-flight--defect'; document.body.append(host)
    const root = createRoot(host)
    new MutationObserver(() => {
      if (window.smokeReadyMs === undefined && host.querySelector('[data-texture-ready="true"]')) window.smokeReadyMs = performance.now() - window.smokeStarted
    }).observe(host, { childList: true, subtree: true, attributes: true })
    window.mountSmoke = key => {
      window.smokeStarted = performance.now(); window.smokeReadyMs = undefined
      root.render(React.createElement(SmokeTrail, { path: 'M 720 387 Q 1330 297 1330 860', key }))
    }
   })
   results[name] = []
   for (const phase of ['cold','cached']) {
    await page.evaluate(phase => window.mountSmoke(phase), phase)
    await page.locator('.card-flight-trail').waitFor()
    const metrics = await page.evaluate(() => new Promise(resolve => {
     const trail = document.querySelector('.card-flight-trail')
     const reveal = trail.querySelector('path')
     const gaps=[], progress=[]; let previous, start, readyAt
     function sample(time) {
      start ??= time
      if (trail.dataset.textureReady === 'true') readyAt ??= time-start
      if (previous !== undefined && time-start>650 && time-start<1100) gaps.push(time-previous)
      previous=time
      progress.push(1-parseFloat(getComputedStyle(reveal).strokeDashoffset))
      if (time-start<1800) requestAnimationFrame(sample)
      else { const sorted=[...gaps].sort((a,b)=>a-b); resolve({ phase, readyAt: window.smokeReadyMs, p95: sorted[Math.floor(sorted.length*.95)], max:Math.max(...gaps), maxRevealStep:Math.max(...progress.slice(1).map((p,i)=>p-progress[i])) }) }
     }
     const phase = trail.dataset.textureReady === 'true' ? 'ready' : 'preparing'
     requestAnimationFrame(sample)
    }))
    assert(metrics.readyAt < 500, `${name} ${phase}: texture missed preparation window ${JSON.stringify(metrics)}`)
    assert(metrics.p95 < 50, `${name} ${phase}: dropped frames ${JSON.stringify(metrics)}`)
    assert(metrics.maxRevealStep < .3, `${name} ${phase}: trail jumped ${JSON.stringify(metrics)}`)
    results[name].push(metrics)
   }
  } finally { await browser.close() }
 }
} finally { await server.close() }
mkdirSync(`${root}artifacts/card-trails`, { recursive: true })
writeFileSync(`${root}artifacts/card-trails/restored-smoke-performance.json`, JSON.stringify(results,null,2))
console.log(results)
