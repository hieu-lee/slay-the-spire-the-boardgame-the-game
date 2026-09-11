import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { chromium, webkit } from './lib/profile-browser.mjs'
const asset = `data:image/webp;base64,${readFileSync(new URL('../public/assets/combat/card-smoke.webp', import.meta.url)).toString('base64')}`
const css = readFileSync(new URL('../src/ui/styles/feedback.css', import.meta.url), 'utf8').replace('/assets/combat/card-smoke.webp', asset)
const results = {}
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
 const browser = await engine.launch()
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.setContent(`<style>${css}</style><div class="card-flight-effect card-flight--defect" style="--smoke-duration:900ms"></div>`)
  await page.evaluate(async src => { const image = new Image(); image.src = src; await image.decode() }, asset)
  results[name] = await page.evaluate(() => new Promise(resolve => {
   const root = document.querySelector('.card-flight-effect')
   for(let i=0;i<32;i++) {
    const t=i/31, p=document.createElement('span'); p.className='card-smoke'
    p.style.cssText=`left:${720+610*(2*t-t*t)}px;top:${387-180*t+653*t*t}px;--smoke-delay:${720+780*t}ms;--smoke-turn:${i*137.5}deg`
    root.append(p)
   }
   const intervals=[], emissions=[]; let previous, start
   function sample(time) {
    start ??= time
    if(previous !== undefined && time-start>700 && time-start<1800) intervals.push(time-previous)
    previous=time
    emissions.push([...root.children].filter(el => {const a=el.getAnimations()[0]; return a.currentTime>=a.effect.getTiming().delay}).length/32)
    if(time-start<2450) requestAnimationFrame(sample)
    else {const sorted=[...intervals].sort((a,b)=>a-b); resolve({frames:intervals.length,p95:sorted[Math.floor(sorted.length*.95)],max:Math.max(...intervals),maxRevealStep:Math.max(...emissions.slice(1).map((p,i)=>p-emissions[i]))})}
   } requestAnimationFrame(sample)
  }))
  assert(results[name].p95 < 50, `${name}: smoke frame p95 ${results[name].p95}ms`)
  assert(results[name].maxRevealStep <= .2, `${name}: smoke jumped ${results[name].maxRevealStep}`)
 } finally { await browser.close() }
}
mkdirSync(new URL('../artifacts/card-trails/', import.meta.url), { recursive: true })
writeFileSync(new URL('../artifacts/card-trails/smoke-after-perf.json', import.meta.url), JSON.stringify(results,null,2))
console.log(results)
