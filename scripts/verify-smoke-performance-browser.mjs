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
    const { animateCardFlight, cardFlightPath } = await import('/src/ui/combat-screen/card-flight.ts')
    const host = document.createElement('div'); host.className='card-flight-effect card-flight--defect'; document.body.append(host)
    for (const [destination, right] of [['discard', 30], ['draw', 110], ['exhaust', 190]]) {
      const pile = document.createElement('div'); pile.dataset.pile = destination; pile.style.cssText = `position:fixed;right:${right}px;bottom:20px;width:60px;height:80px`; document.body.append(pile)
    }
    window.smokeRoutes = Object.fromEntries(['discard', 'draw', 'exhaust'].map(destination => [destination, cardFlightPath(destination)]))
    await warmSmokeTrails('defect').ready
    const root = createRoot(host)
    new MutationObserver(() => {
      if (window.smokeReadyMs === undefined && host.querySelector('[data-texture-ready="true"]')) window.smokeReadyMs = performance.now() - window.smokeStarted
    }).observe(host, { childList: true, subtree: true, attributes: true })
    let previousFrame
    function monitor(time) {
      const firstAfterMount = window.smokeStarted && (previousFrame ?? 0) < window.smokeStarted
      if (firstAfterMount || window.smokeStarted && time - window.smokeStarted < 650) window.startupGaps.push(time - Math.max(previousFrame ?? window.smokeStarted, window.smokeStarted))
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
    window.measureFlight = async destination => {
      const route = window.smokeRoutes[destination]
      const flight = document.createElement('div')
      flight.className = 'card-flight'
      const card = document.createElement('img')
      card.className = 'card'
      card.src = '/assets/cards-sm/silent__starter__defend.webp'
      flight.append(card); host.append(flight)
      await card.decode()
      const gaps = []
      let start, previous
      const frames = new Promise(resolve => {
        const sample = time => {
          start ??= time
          if (previous !== undefined) gaps.push(time - previous)
          previous = time
          if (time - start < 980) requestAnimationFrame(sample)
          else resolve()
        }
        requestAnimationFrame(sample)
      })
      const animation = animateCardFlight(flight, route.motionFrames)
      await Promise.all([frames, animation.finished])
      const rect = flight.getBoundingClientRect()
      const pile = document.querySelector(`[data-pile="${destination}"]`).getBoundingClientRect()
      const style = getComputedStyle(flight), cardStyle = getComputedStyle(card)
      const sorted = gaps.toSorted((a, b) => a - b)
      const result = {
        p95: sorted[Math.floor(sorted.length * .95)], max: Math.max(...gaps),
        distance: Math.hypot(rect.x + rect.width / 2 - pile.x - pile.width / 2,
          rect.y + rect.height / 2 - pile.y - pile.height / 2),
        offsetPath: style.offsetPath, willChange: style.willChange,
        filter: cardStyle.filter, boxShadow: cardStyle.boxShadow,
      }
      flight.remove()
      return result
    }
   })
   results[name] = []
   for (const destination of ['discard', 'draw', 'exhaust']) {
    await page.evaluate(destination => window.mountSmoke(destination, destination), destination)
    await page.waitForFunction(() => window.smokeReadyMs !== undefined)
    const metrics = await page.evaluate(() => new Promise(resolve => {
     const trail = document.querySelector('.card-flight-trail')
     const reveal = trail.querySelector('path')
     const gaps=[], progress=[]; let previous, start
     function sample(time) {
      start ??= time
      if (previous !== undefined && time-start<1100) gaps.push(time-previous)
      previous=time
      progress.push({ time, value: 1-parseFloat(getComputedStyle(reveal).strokeDashoffset) })
      if (time-start<1800) requestAnimationFrame(sample)
      else { const sorted=[...gaps].sort((a,b)=>a-b); const steps=progress.slice(1).map((p,i)=>({ step:p.value-progress[i].value, elapsed:p.time-progress[i].time })); resolve({ readyAt: window.smokeReadyMs, startupMax: Math.max(...window.startupGaps), p95: sorted[Math.floor(sorted.length*.95)], max:Math.max(...gaps), maxRevealStep:Math.max(...steps.map(p=>p.step)), maxRevealRate:Math.max(...steps.map(p=>p.step/p.elapsed)) }) }
     }
     requestAnimationFrame(sample)
    }))
    const mask = await page.locator('.card-flight-trail mask').evaluate(mask => {
      const image = mask.closest('svg').querySelector('image')
      return { area: Number(mask.getAttribute('width')) * Number(mask.getAttribute('height')),
        textureArea: Number(image.getAttribute('width')) * Number(image.getAttribute('height')) }
    })
    if (name === 'webkit') assert(mask.area <= mask.textureArea, `${name}: smoke mask allocates beyond its painted texture: ${JSON.stringify(mask)}`)
    metrics.destination = destination
    assert(metrics.readyAt < 30, `${name} ${destination}: texture was not predecoded ${JSON.stringify(metrics)}`)
    assert(metrics.startupMax < 60, `${name} ${destination}: first-render stall ${JSON.stringify(metrics)}`)
    assert(metrics.p95 < 50, `${name} ${destination}: dropped frames ${JSON.stringify(metrics)}`)
    assert(metrics.maxRevealRate < .006, `${name} ${destination}: trail jumped ${JSON.stringify(metrics)}`)
    const flight = await page.evaluate(destination => window.measureFlight(destination), destination)
    assert(flight.p95 < 35 && flight.max < 80, `${name} ${destination}: card flight dropped frames ${JSON.stringify(flight)}`)
    assert(flight.distance < 20, `${name} ${destination}: card flight missed its pile ${JSON.stringify(flight)}`)
    assert.equal(flight.offsetPath, 'none', `${name} ${destination}: CSS Motion Path returned`)
    assert.match(flight.willChange, /transform/, `${name} ${destination}: flight was not compositor-promoted`)
    assert.equal(flight.filter, 'none', `${name} ${destination}: moving card retained a repainting filter`)
    assert.notEqual(flight.boxShadow, 'none', `${name} ${destination}: card shadow was lost`)
    if (destination === 'discard') {
      await page.evaluate(() => {
        document.querySelector('#root').style.visibility = 'hidden'
        const trail = document.querySelector('.card-flight-trail'), image = trail.querySelector('image')
        const path = trail.querySelector('path')
        const old = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        old.id = 'legacy-smoke'; old.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;overflow:visible'
        old.innerHTML = `<defs><mask id="legacy-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${innerWidth}" height="${innerHeight}">
          <path d="${path.getAttribute('d')}" pathLength="1" fill="none" stroke="white" stroke-width="84" stroke-linecap="round" stroke-dasharray="1" style="animation:legacy-reveal 1800ms linear both" />
          </mask></defs><g style="transform-origin:center;animation:card-smoke-drift 1800ms ease-out both">${image.outerHTML.replace(/mask="[^"]*"/, 'mask="url(#legacy-mask)"')}</g>`
        trail.parentElement.append(old)
        const style=document.createElement('style');style.id='legacy-smoke-style'
        style.textContent='@keyframes legacy-reveal {0%,41.38%{opacity:0;stroke-dashoffset:1}44%{opacity:1}54.45%{opacity:.95;stroke-dashoffset:0}70%{opacity:.55;stroke-dashoffset:0}100%{opacity:0;stroke-dashoffset:0}}'
        document.head.append(style)
      })
      mkdirSync(`${root}artifacts/card-trails`, { recursive: true })
      for (const time of [810, 930, 1200, 1600]) {
        const shots=[]
        for (const legacy of [false,true]) {
          await page.evaluate(({time,legacy})=>{
            const current=document.querySelector('.card-flight-trail'), old=document.querySelector('#legacy-smoke')
            for(const root of [current,old]) for(const animation of root.getAnimations({subtree:true})) {animation.pause();animation.currentTime=time}
            current.style.visibility=legacy?'hidden':'visible';old.style.visibility=legacy?'visible':'hidden'
          },{time,legacy})
          shots.push(await page.screenshot({path:`${root}artifacts/card-trails/${name}-smoke-${time}-${legacy?'before':'after'}.png`}))
        }
        const difference=await page.evaluate(async sources=>{
          const canvases=await Promise.all(sources.map(async source=>{
            const img=new Image();img.src=source;await img.decode()
            const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height
            const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data
          }))
          let changed=0,total=0
          for(let i=0;i<canvases[0].length;i+=4) for(let c=0;c<3;c++) {
            const diff=Math.abs(canvases[0][i+c]-canvases[1][i+c]);total+=diff;if(diff>8)changed++
          }
          return {mean:total/(canvases[0].length*.75),changed:changed/(canvases[0].length*.75)}
        },shots.map(shot=>`data:image/png;base64,${shot.toString('base64')}`))
        assert(difference.mean<.2 && difference.changed<.003, `${name}: smoke changed at ${time}ms: ${JSON.stringify(difference)}`)
      }
      await page.evaluate(()=>{
        document.querySelector('#legacy-smoke').remove();document.querySelector('#legacy-smoke-style').remove()
        document.querySelector('#root').style.visibility=''
      })
    }
    metrics.flight = flight
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
