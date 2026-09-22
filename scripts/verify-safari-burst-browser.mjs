#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'

// Real combat input: three Defends at 80ms intervals, with all effects overlapping.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/safari-bursts')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel:'silent', server:{port:0} })
await server.listen()
const results=[]
const recording=process.argv.includes('--record')
try {
 for (const [engineName, engine] of Object.entries({ webkit, chromium })) {
  const browser=await engine.launch({ headless: !process.argv.includes('--headed') })
  try { for (const phone of [false,true]) {
   const label=`${engineName}-${phone?'horizontal-phone':'desktop'}`
   const viewport=phone?{width:844,height:390}:{width:1512,height:776}
   const context=await browser.newContext({ ...(phone?{ ...devices[engineName === 'webkit' ? 'iPhone 13 landscape' : 'Pixel 7 landscape'], viewport }:{viewport,deviceScaleFactor:2}),
     ...(recording ? {recordVideo:{dir:output,size:viewport}} : {}) })
   const page=await context.newPage(), errors=[]
   page.on('pageerror', e=>errors.push(String(e)))
   await context.addInitScript(() => {
     window.soundVoices = 0
     const start = AudioBufferSourceNode.prototype.start, play = HTMLMediaElement.prototype.play
     AudioBufferSourceNode.prototype.start = function (...args) { window.soundVoices++; return start.apply(this, args) }
     HTMLMediaElement.prototype.play = function () {
       if (this instanceof HTMLAudioElement) window.soundVoices++
       return play.call(this)
     }
   })
   await page.goto(`http://localhost:${server.httpServer.address().port}`)
   for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
     await page.getByRole('button', { name, exact: true }).click()
   await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
   await page.evaluate(async () => {
     const [{ createCombat }, { createRng }] = await Promise.all([
       import('/src/game/combat.ts'), import('/src/game/rng.ts'),
     ])
     const rng = createRng(47), run = window.__STS_DEBUG__.getRun()
     // Preserve the campaign deck so setup does not trigger card-transform overlays.
     const player = structuredClone(run.players[0])
     Object.assign(player, { hp: 99, maxHp: 99,
       hand: ['defend_ironclad', 'defend_ironclad', 'defend_ironclad', 'strike_ironclad', 'bash']
         .map((defId, i) => ({ uid: 'card-'+i, defId, upgraded:false })),
       draw: [], discard: [], relics: [], energy: 9 })
     const enemy = { uid:'enemy-0', defId:'blue_slaver', row:0, hp:999, maxHp:999,
       block:0, strength:0, vulnerable:0, weak:0, poison:0, actionIndex:0, abilityUsed:false, dead:false }
     const state = createCombat(rng, [player], [enemy])
     state.phase = 'player'; state.presentationEvents = []; state.die = 1
     window.__STS_DEBUG__.setRun({ ...run, players:[player], phase:'combat', neow:null, combat:state })
   })
   await page.locator('.hand .card').first().waitFor()
   await page.waitForTimeout(3000)
   await page.evaluate(()=>{
     window.soundVoices = 0
     const resolve = value => { window.burstResult = value }
     const gaps=[], clicks=[]; let start, previous, peakFlights=0, peakVfx=0
     function frame(time){
       start??=time;if(previous!==undefined)gaps.push(time-previous);previous=time
       peakFlights=Math.max(peakFlights,document.querySelectorAll('.card-flight').length)
       peakVfx=Math.max(peakVfx,document.querySelectorAll('.combat-vfx').length)
       if(time-start<2500)requestAnimationFrame(frame)
       else {
         const sorted=gaps.toSorted((a,b)=>a-b)
         resolve({ audioVoices: window.soundVoices, clicks:clicks.slice(1).map((t,i)=>t-clicks[i]), peakFlights, peakVfx,
           block:window.__STS_DEBUG__.getRun().combat.players[0].block, discard:window.__STS_DEBUG__.getRun().combat.players[0].discard.length,
           p95:sorted[Math.floor(sorted.length*.95)], max:Math.max(...gaps), fps:gaps.length/2.5 })
       }
     }
     requestAnimationFrame(frame)
     for(const delay of [80,160,240])setTimeout(()=>{
       clicks.push(performance.now());document.querySelector('.hand .card').click()
     },delay)
   })
   await page.waitForFunction(()=>document.querySelectorAll('.card-flight').length===3)
   if(recording) await page.screenshot({path:resolve(output,`${label}-overlap.png`),scale:'css'})
   await page.waitForFunction(()=>window.burstResult, null, { polling:100 })
   const result={label,...await page.evaluate(()=>window.burstResult)}
   console.log(JSON.stringify(result))
   assert(result.audioVoices >= 6, `${label}: sounds were not exercised`)
   assert.equal(result.block,3,`${label}: rapid cards were lost`)
   assert.equal(result.discard,3)
   assert.equal(result.peakFlights,3)
   assert.equal(result.peakVfx,3)
   assert(result.clicks.every(gap=>gap<130),`${label}: input blocked ${JSON.stringify(result)}`)
   // Safari owns the frame-budget regression; Chrome also runs the full visual/input checks.
   if(!recording) assert((engineName === 'webkit' ? result.p95<35 : result.fps>=50) && result.max<100,`${label}: overlapping effects stalled ${JSON.stringify(result)}`)
   await page.evaluate(() => {
     window.attackFrames = []
     const end = performance.now() + 3500
     function sample() {
       const enemy = document.querySelector('.enemy')
       window.attackFrames.push({ phase: enemy.dataset.animation,
         visible: [...enemy.querySelectorAll('.enemy__art--cutout')]
           .filter(art => Number(getComputedStyle(art).opacity) >= .001).length })
       if (performance.now() < end) requestAnimationFrame(sample)
       else window.attackComplete = true
     }
     requestAnimationFrame(sample)
   })
   await page.getByRole('button', { name: 'End turn', exact: true }).click()
   await page.waitForFunction(() => window.attackComplete)
   const attackFrames = await page.evaluate(() => window.attackFrames)
   assert(attackFrames.some(frame => frame.phase === 'attack'), `${label}: Slaver never attacked`)
   assert.equal(attackFrames.at(-1).phase, 'idle')
   assert(attackFrames.every(frame => frame.visible === 1), `${label}: enemy artwork overlapped or disappeared`)
   writeFileSync(resolve(output, `${label}-attack-frames.json`), JSON.stringify(attackFrames, null, 2))
   if (recording) await page.screenshot({ path: resolve(output, `${label}-returned.png`), scale: 'css' })
   assert.deepEqual(errors,[])
   results.push(result);writeFileSync(resolve(output,recording?'recording-report.json':'report.json'),JSON.stringify(results,null,2))
   await context.close();if(recording) await page.video().saveAs(resolve(output,`${label}.webm`))
   console.log(`PASS ${label}: three cards at 80ms intervals, p95=${result.p95.toFixed(1)}ms max=${result.max.toFixed(1)}ms`)
  }} finally { await browser.close() }
 }
} finally { await server.close() }
