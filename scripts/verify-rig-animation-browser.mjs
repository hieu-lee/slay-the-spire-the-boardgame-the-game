#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { ENEMIES } from '../src/game/enemies.ts'
import { bossAttackMotionFor, bossProjectileImagePath, enemyProjectileImpactPath } from '../src/ui/combat-vfx.ts'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/rig-animation/browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const errors = []
const heroes = {
  ironclad: 'strike_ironclad', silent: 'predator', defect: 'strike_defect', watcher: 'strike_watcher',
  guardian: 'guardian_strike', 'guardian-defense': 'guardian_strike', hermit: 'hermit_strike', slime_boss: 'slime_boss_strike', hexaghost: 'strike_hexaghost',
}
const normalsOnly = process.argv.includes('--normal-only')
const enemies = [...new Map(Object.values(ENEMIES).filter((e) => normalsOnly ? !e.isBoss && !e.elite : e.isBoss || e.elite ||
  ['sentry_a','sentry_b','red_slaver','blue_slaver'].includes(e.id)).map((e) => [e.artId ?? e.id,e])).values()]
  .filter(e=>!process.argv.some(a=>a.startsWith('--only='))||process.argv.includes(`--only=${e.id}`))
try {
  for (const [screen,viewport] of [['desktop',{width:1440,height:900}],['horizontal-phone',{width:844,height:390}]]) {
    if(process.argv.includes('--phone-only') && screen!=='horizontal-phone')continue
    const context = await browser.newContext({ viewport, isMobile: screen==='horizontal-phone', hasTouch: screen==='horizontal-phone', recordVideo: { dir: output, size: viewport } })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(String(e)))
    page.on('response', r => { if (r.status()>=400 && /\/assets\/combat\/rigged\//.test(r.url())) errors.push(`${r.status()} ${r.url()}`) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(async () => {
      document.querySelector('#root').style.display='none'
      document.documentElement.dataset.mobilePerformance=String(matchMedia('(pointer: coarse)').matches || innerWidth<900)
      document.documentElement.dataset.reducedMotion='false'
      const node=document.createElement('div');node.className='app-shell app-shell--combat sts-scope';document.body.append(node)
      const [R,D,{CombatScreen},{createPlayer},{createCombat},{createRng},{actionsForEnemy},] = await Promise.all([
        import('/@id/react'),import('/@id/react-dom/client'),import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'),import('/src/game/combat.ts'),import('/src/game/rng.ts'),import('/src/game/enemies.ts'),
        import('/src/ui/styles.css'),import('/src/ui/chrome.css'),
      ])
      const reactRoot=(D.createRoot??D.default.createRoot)(node)
      const f=window.fixture={seq:1000,restoration:0}
      f.render=()=>reactRoot.render((R.createElement??R.default.createElement)(CombatScreen,{
        state:structuredClone(f.state),act:1,viewerId:'p1',autoAdvance:false,
        authoritativeRestoration:f.restoration,onAction:()=>{},
      }))
      f.install=(character,defId='guardian_attack',isBoss=true,count=1)=>{
        const rng=createRng(47);const player=createPlayer(rng,'p1',character,character==='guardian-defense'?'guardian':character,0)
        player.hp=player.maxHp=999;player.hand=[];player.draw=[];player.relics=[]
        const enemy={uid:'enemy-0',defId,row:0,isBoss,hp:999,maxHp:999,block:0,strength:0,vulnerable:0,weak:0,poison:0,actionIndex:0,abilityUsed:false,dead:false}
        f.state=createCombat(rng,[player],Array.from({length:count},(_,i)=>({...enemy,uid:`enemy-${i}`})))
        if(character==='guardian-defense')f.state.players[0].guardianMode='defense'
        f.state.players[0].facingEnemyUid='enemy-0'
        f.state.phase='player';f.state.presentationEvents=[]
        f.attacks=false
        for(let die=1;die<=6&&!f.attacks;die++)for(let actionIndex=0;actionIndex<8&&!f.attacks;actionIndex++){
          const actions=actionsForEnemy({...enemy,actionIndex},die)
          if(actions.some(a=>a.kind==='attack'||a.kind==='attackSequence')){
            f.state.die=die;f.state.enemies.forEach(e=>e.actionIndex=actionIndex);f.attacks=true
          }
        }
        f.restoration++;f.render()
      }
      f.attack=sourceId=>{
        f.state.presentationEvents.push({seq:++f.seq,kind:'card',actorId:'p1',sourceId,
          enemyIds:f.state.enemies.map(e=>e.uid),playerIds:[],upgraded:false,copied:false,energy:1})
        f.render();return f.seq
      }
      f.install('ironclad')
    })
    for (const [character,source] of (normalsOnly||process.argv.includes('--elites-only')?[]:Object.entries(heroes))
      .filter(([id])=>!process.argv.some(a=>a.startsWith('--hero='))||process.argv.includes(`--hero=${id}`))) {
      await page.evaluate(c=>window.fixture.install(c),character)
      await page.waitForFunction(()=>document.querySelector('.seat__portrait > img')?.complete)
      await page.waitForTimeout(100)
      await page.waitForFunction(c=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=(c==='hexaghost'?7:c.startsWith('guardian')||c==='watcher'||c==='ironclad'?2:1),character)
      await page.waitForFunction(()=>[...document.querySelectorAll('.seat__portrait > img')].every(i=>i.complete&&!i.dataset.guardianTransition))
      await page.waitForTimeout(100)
      const before=await page.locator('.seat__portrait > img').boundingBox()
      const seq=await page.evaluate(id=>window.fixture.attack(id),source)
      const poseSelector=character==='ironclad'?'.character-attack__pose--ironclad-ready':character==='watcher'?'.character-attack__pose--watcher-charge':'.character-attack__pose--rig.is-loaded:not(.is-fallback)'
      const pose=page.locator(`[data-attack-seq="${seq}"] ${poseSelector}`)
      await pose.waitFor()
      if(character==='ironclad') {
        assert((await pose.locator('img').getAttribute('src')).endsWith('/ironclad-ready.webp'))
        const impact=page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--ironclad-impact img`)
        assert((await impact.getAttribute('src')).endsWith('/ironclad-impact.webp'))
        assert.equal(await page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--rig`).count(),0)
      } else if(character==='watcher') {
        assert((await pose.locator('img').getAttribute('src')).endsWith('/watcher-ready.webp'))
        assert.equal(await pose.evaluate(e=>getComputedStyle(e).opacity),'1','Watcher must raise her staff before casting')
        assert.equal(await page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--rig`).count(),0)
      } else assert.equal(await pose.locator('img').evaluate(i=>i.naturalWidth),400,character)
      await page.waitForTimeout(character==='hexaghost'?1400:character==='ironclad'?850:600)
      if(character==='watcher') {
        const cast=page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--watcher-cast`)
        assert((await cast.locator('img').getAttribute('src')).endsWith('/watcher-thrust.webp'))
        assert.equal(await cast.evaluate(e=>getComputedStyle(e).opacity),'1','Watcher must cast downward while the meteor falls')
        assert(await page.locator(`[data-attack-seq="${seq}"] .character-attack__meteor`).count()>0,'Watcher lost the meteor')
      }
      await page.locator('.board').screenshot({path:resolve(output,`${screen}-${character}-attack.png`)})
      await page.waitForTimeout(1800)
      const after=await page.locator('.seat__portrait > img').boundingBox()
      if(character==='guardian-defense')assert.equal(await page.locator('.seat__portrait > img').getAttribute('data-guardian-mode'),'defense')
      for(const key of ['x','y','width','height'])assert(Math.abs(before[key]-after[key])<.6,`${screen}/${character}: layout jumped`)
      // A second attack must replay the poses and return to the same resting geometry.
      const firstSrc=await page.evaluate(()=>window.fixture.seq)
      const next=await page.evaluate(id=>window.fixture.attack(id),source)
      assert(next>firstSrc)
      await page.locator(`[data-attack-seq="${next}"] ${poseSelector}`).waitFor()
      if(character.startsWith('guardian')) {
        const travel=await page.locator(`[data-attack-seq="${next}"] .character-attack__pose--rig`).evaluate(pose=>{
          const layer=pose.parentElement
          const animation=layer.getAnimations()[0]
          const saved=animation.currentTime
          const samples=[0,630,1400,1430,1640].map(time=>{
            animation.pause();animation.currentTime=time
            const m=new DOMMatrixReadOnly(getComputedStyle(layer).transform)
            return {time,x:m.e,y:m.f,scaleX:m.a,scaleY:m.d}
          })
          animation.currentTime=saved;animation.play()
          return {mode:layer.dataset.guardianMode,name:animation.animationName,samples,
            x:parseFloat(layer.style.getPropertyValue('--attack-x')),
            y:parseFloat(layer.style.getPropertyValue('--attack-y'))}
        })
        const defense=character==='guardian-defense'
        assert.equal(travel.mode,defense?'defense':'attack')
        assert.equal(travel.name,defense?'guardian-roll-travel':'guardian-punch-travel')
        assert(travel.x>0,'Guardian must travel to its target')
        for(const sample of travel.samples.filter(s=>s.time!==1400||defense)) {
          assert(Math.abs(sample.x-(sample.time===630?travel.x:0))<.1,JSON.stringify(sample))
          assert(Math.abs(sample.y-(sample.time===630?travel.y:0))<.1,JSON.stringify(sample))
          assert.equal(sample.scaleX,1)
          assert.equal(sample.scaleY,1)
        }
      }
      if(character==='ironclad') {
        const clock=await page.locator(`[data-attack-seq="${next}"]`).evaluate(layer=>{
          const rest=layer.parentElement.querySelector(':scope > img')
          const ready=layer.querySelector('.character-attack__pose--ironclad-ready')
          const impact=layer.querySelector('.character-attack__pose--ironclad-impact')
          const animations=[...layer.getAnimations({subtree:true}),...rest.getAnimations()]
          const swing=animations.find(a=>a.animationName==='attack-swing').effect.getTiming()
          const saved=animations.map(a=>a.currentTime)
          const samples=[0,540,630,850,1130,1170,1260,1700].map(time=>{
            animations.forEach(a=>{a.pause();a.currentTime=time})
            const m=new DOMMatrixReadOnly(getComputedStyle(layer).transform)
            return {time,x:m.e,y:m.f,scaleX:m.a,scaleY:m.d,
              poses:[ready,impact,rest].map(e=>Number(getComputedStyle(e).opacity))}
          })
          animations.forEach((a,i)=>{a.currentTime=saved[i];a.play()})
          return {duration:swing.duration,delay:swing.delay,samples,
            x:parseFloat(layer.style.getPropertyValue('--attack-x')),
            y:parseFloat(layer.style.getPropertyValue('--attack-y'))}
        })
        assert.equal(clock.duration,500,'Ironclad sword swing must last 500ms')
        assert.equal(clock.delay,630,'Ironclad sword swing starts after the dash')
        assert(clock.x>0,'Ironclad must dash to the target')
        for(const sample of clock.samples){
          const atTarget=sample.time>=630&&sample.time<=1170
          assert(Math.abs(sample.x-(atTarget?clock.x:0))<.1,JSON.stringify(sample))
          assert(Math.abs(sample.y-(atTarget?clock.y:0))<.1,JSON.stringify(sample))
          assert.equal(sample.scaleX,1,'Ironclad grew during travel')
          assert.equal(sample.scaleY,1,'Ironclad squashed during travel')
          assert.deepEqual(sample.poses,sample.time<630?[1,0,0]:sample.time<1260?[0,1,0]:[0,0,1],JSON.stringify(sample))
        }
      }
      await page.waitForTimeout(2100)
      if(character==='defect') {
        await page.evaluate(()=>window.fixture.install('defect','jaw_worm',false,2))
        await page.waitForTimeout(300)
        for(const orb of ['lightning','dark','frost']) for(const count of (orb==='frost'?[0]:[1,2])) {
          const seq=await page.evaluate(({orb,count})=>{
            const f=window.fixture
            const seq=++f.seq
            f.state.presentationEvents=[{kind:'orb',orb,seq,actorId:'p1',sourceId:'orb-evoke',
              enemyIds:f.state.enemies.slice(0,count).map(e=>e.uid),playerIds:[]}]
            f.render();return seq
          },{orb,count})
          const effect=page.locator(`.defect-evoke[data-evoke-seq="${seq}"]`)
          await effect.waitFor({state:'attached'})
          assert.equal(await page.locator('.character-attack__bolt').count(),0,`${orb}: evoke fired a blue orb`)
          if(orb==='frost') {
            assert.equal(await effect.locator('.defect-evoke__ray').count(),0,'Frost must stay on Defect')
            await effect.locator('img').waitFor()
          } else {
            await page.waitForFunction(({seq,count})=>document.querySelectorAll(`.defect-evoke[data-evoke-seq="${seq}"] .defect-evoke__ray`).length===count,{seq,count})
            const geometry=await effect.evaluate(node=>{
              const origin=node.getBoundingClientRect()
              const art=node.closest('.seat__portrait').querySelector(':scope > img')
              const image=art.getBoundingClientRect()
              const fit=Math.min(image.width/art.naturalWidth,image.height/art.naturalHeight)
              const mouthX=image.left+(image.width-art.naturalWidth*fit)/2+222*fit
              const mouthY=image.bottom-(art.naturalHeight-89)*fit
              return [...node.querySelectorAll('.defect-evoke__ray')].map(ray=>{
                const portrait=document.querySelector(`.enemy[data-enemy-id="${ray.dataset.evokeTarget}"] .enemy__portrait`)
                const targetArt=portrait.querySelector(':scope > img')
                const target=targetArt.getBoundingClientRect()
                const targetFit=Math.min(target.width/targetArt.naturalWidth,target.height/targetArt.naturalHeight)
                // Jaw Worm's painted torso in the canonical 400 x 250 idle rig.
                const targetX=target.left+(target.width-targetArt.naturalWidth*targetFit)/2+170.3*targetFit
                const targetY=target.bottom-(targetArt.naturalHeight-181)*targetFit
                const impact=portrait.querySelector(`.combat-vfx--target[data-vfx-seq="${node.dataset.evokeSeq}"]`).getBoundingClientRect()
                const length=parseFloat(ray.style.getPropertyValue('--beam-length'))
                const angle=parseFloat(ray.style.getPropertyValue('--beam-angle'))*Math.PI/180
                return {x:origin.x+length*Math.cos(angle),y:origin.y+length*Math.sin(angle),
                  targetX,targetY,impactX:impact.left+impact.width/2,impactY:impact.top+impact.height/2,
                  originX:origin.x,originY:origin.y,mouthX,mouthY,
                  delay:ray.querySelector('svg').getAnimations()[0].effect.getTiming().delay}
              })
            })
            for(const ray of geometry) {
              assert(Math.abs(ray.x-ray.targetX)<3&&Math.abs(ray.y-ray.targetY)<3,`${orb}: beam misses painted torso`)
              assert(Math.abs(ray.impactX-ray.targetX)<3&&Math.abs(ray.impactY-ray.targetY)<3,`${orb}: damage impact misses painted torso`)
              assert(Math.abs(ray.originX-ray.mouthX)<1&&Math.abs(ray.originY-ray.mouthY)<1,`${orb}: beam detached from mouth`)
              assert.equal(ray.delay,240,`${orb}: beam and impact clock differ`)
            }
          }
          await page.waitForTimeout(350)
          await page.locator('.board').screenshot({path:resolve(output,`${screen}-defect-evoke-${orb}-${count}.png`)})
          await page.waitForTimeout(550)
        }
        await page.evaluate(()=>{window.fixture.restoration++;window.fixture.render()})
        await page.waitForTimeout(100)
        assert.equal(await page.locator('.defect-evoke').count(),0,'reconnect replayed old evokes')
      }
    }
    if (process.argv.includes('--hero=hexaghost')) {
      for (let heat = 1; heat <= 6; heat++) {
        await page.evaluate(heat => {
          const f = window.fixture; f.install('hexaghost')
          f.state.players[0].heat = heat; f.render()
        }, heat)
        const idle = page.locator('.seat__portrait > img')
        await page.waitForFunction(heat => {
          const image = document.querySelector('.seat__portrait > img')
          return image?.complete && image.src.endsWith(`hero-hexaghost-heat-${heat}-idle.webp`)
        }, heat)
        const first = await idle.screenshot()
        await page.waitForTimeout(170)
        assert.notDeepEqual(first, await idle.screenshot(), `heat ${heat}: idle flames must burn`)
        await page.screenshot({path:resolve(output,`${screen}-heat-${heat}-idle.png`)})
        await page.waitForFunction(()=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=7)
        const seq = await page.evaluate(()=>window.fixture.attack('strike_hexaghost'))
        await page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--rig.is-loaded:not(.is-fallback)`).waitFor()
        await page.waitForTimeout(1000)
        await page.screenshot({path:resolve(output,`${screen}-heat-${heat}-attack.png`)})
        await page.waitForTimeout(1300)
        await page.evaluate(()=>{document.documentElement.dataset.reducedMotion='true';window.fixture.render()})
        await page.waitForFunction(heat=>document.querySelector('.seat__portrait > img')?.src.endsWith(`characters/hexaghost-heat-${heat}.webp`),heat)
        await page.evaluate(()=>{document.documentElement.dataset.reducedMotion='false';window.fixture.render()})
      }
    }
    for (const enemy of enemies) {
      await page.evaluate(e=>window.fixture.install('defect',e.id,!!e.isBoss),enemy)
      const card=page.locator(`.enemy[data-enemy-def="${enemy.id}"]`)
      await card.waitFor()
      await page.waitForFunction(()=>[...document.querySelectorAll('.enemy__art--cutout')].every(i=>i.complete&&i.naturalWidth>0))
      assert.equal(await card.getAttribute('data-animation'),'idle',enemy.id)
      const before=await card.locator('.enemy__art--cutout').boundingBox()
      const silhouette=await card.locator('.enemy__art--cutout').evaluate(image=>{
        const rect=image.getBoundingClientRect(), canvas=document.createElement('canvas')
        canvas.width=image.naturalWidth;canvas.height=image.naturalHeight
        const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0)
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
        let left=canvas.width,top=canvas.height,right=0,bottom=0
        for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]>32){
          left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)
        }
        const fit=Math.min(rect.width/canvas.width,rect.height/canvas.height)
        const ox=rect.left+(rect.width-canvas.width*fit)/2,oy=rect.bottom-canvas.height*fit
        return {left:ox+left*fit,right:ox+right*fit,top:oy+top*fit,bottom:oy+bottom*fit}
      })
      if(enemy.elite||enemy.isBoss){
        const bands=await card.evaluate(e=>{
          const image=e.querySelector('.enemy__art--cutout')
          const art=image.getBoundingClientRect()
          const canvas=document.createElement('canvas')
          canvas.width=image.naturalWidth;canvas.height=image.naturalHeight
          const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0)
          const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
          let visibleTop=canvas.height
          for(let y=0;y<canvas.height&&visibleTop===canvas.height;y++)
            for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]>32){visibleTop=y;break}
          const fit=Math.min(art.width/canvas.width,art.height/canvas.height)
          // Transparent weapon overscan does not obscure the UI. Measure the
          // actual composited silhouette, including CSS scale/object-fit.
          const artTop=art.bottom-(canvas.height-visibleTop)*fit
          const intent=e.querySelector('.enemy__intent').getBoundingClientRect()
          const effect=e.querySelector('.enemy__ability')?.getBoundingClientRect()
          return {boardTop:e.closest('.board').getBoundingClientRect().top,artTop,intentTop:intent.top,intentBottom:intent.bottom,effectTop:effect?.top,effectBottom:effect?.bottom,
            viewport:[innerWidth,innerHeight],floor:getComputedStyle(e).getPropertyValue('--elite-floor-offset'),bossLane:!!e.closest('.board__bosses')}
        })
        assert(bands.intentTop>=bands.boardTop,`${screen}/${enemy.id}: intent clipped by board ${JSON.stringify(bands)}`)
        assert(bands.intentBottom<=(bands.effectTop??bands.artTop)+1,`${screen}/${enemy.id}: intent overlaps effect/art ${JSON.stringify(bands)}`)
        assert(!bands.effectBottom||bands.effectBottom<=bands.artTop+1,`${screen}/${enemy.id}: effect overlaps art ${JSON.stringify(bands)}`)
      }
      if(normalsOnly) {
        const art = card.locator('.enemy__art--cutout')
        const first = await art.screenshot()
        await page.waitForTimeout(250)
        assert.notDeepEqual(first, await art.screenshot(), `${enemy.id}: idle texture frozen`)
      }
      await page.waitForTimeout(1000) // Allow encounter attack preloads before the synthetic end-turn.
      if(normalsOnly||enemy.elite||enemy.isBoss)await page.locator('.board').screenshot({path:resolve(output,`${screen}-${enemy.id}-idle.png`)})
      const attacks=await page.evaluate(()=>{const f=window.fixture;f.state.phase='enemy';f.render();return f.attacks})
      if(attacks){
        await page.waitForFunction(()=>document.querySelector('.enemy')?.dataset.animation==='attack')
        assert((await card.locator('.enemy__art--cutout').getAttribute('src')).startsWith('blob:'),`${enemy.id}: recording captured the unloaded idle fallback`)
        await page.waitForTimeout(760)
        const after=await card.locator('.enemy__art--cutout').boundingBox()
        assert(Math.abs(before.width-after.width)<1&&Math.abs(before.height-after.height)<1,`${enemy.id}: attack scale changed`)
        if(bossProjectileImagePath(enemy.artId??enemy.id)){
          const origin=await card.evaluate(e=>{
            const p=e.querySelector('.boss-projectile'),r=e.getBoundingClientRect()
            const rem=parseFloat(getComputedStyle(document.documentElement).fontSize)
            return p?{x:r.left+parseFloat(p.style.getPropertyValue('--boss-projectile-start-x'))*rem,
              y:r.top+parseFloat(p.style.getPropertyValue('--boss-projectile-start-y'))*rem}:null
          })
          assert(origin&&origin.x>=silhouette.left&&origin.x<=silhouette.right&&origin.y>=silhouette.top&&origin.y<=silhouette.bottom,
            `${enemy.id}: projectile detached from body ${JSON.stringify({origin,silhouette})}`)
        }
        if(enemyProjectileImpactPath(enemy.artId??enemy.id)) {
          const effect = card.locator('.enemy-projectile-impact')
          assert.equal(await effect.count(),1,`${enemy.id}: missing targeted impact`)
          const timing = await effect.locator('img').evaluate(image=>{
            const anim=image.getAnimations()[0]
            const {delay,duration}=anim.effect.getTiming()
            return {delay,duration,loaded:image.complete&&image.naturalWidth>0}
          })
          assert.deepEqual(timing,{delay:730,duration:480,loaded:true},`${enemy.id}: impact clock or asset`)
          const flight = await card.locator('.boss-projectile').evaluate(e=>{
            const {delay,duration}=e.getAnimations()[0].effect.getTiming()
            return {delay,duration}
          })
          assert.deepEqual(flight,{delay:500,duration:230},`${enemy.id}: projectile arrival misses impact`)
          if(await effect.getAttribute('data-impact-anchor')==='feet') {
            const anchor=await effect.evaluate(e=>{
              const image=e.querySelector('img').getBoundingClientRect()
              const ground=image.bottom-image.height*66/512
              const feet=document.querySelector(`.seat[data-player-id="${e.dataset.targetPlayer}"] .seat__portrait`).getBoundingClientRect().bottom
              return {ground,feet}
            })
            assert(Math.abs(anchor.ground-anchor.feet)<1,`${enemy.id}: acid splash is not grounded at the feet ${JSON.stringify(anchor)}`)
          } else {
            const anchor=await effect.evaluate(e=>{
              const impact=e.getBoundingClientRect()
              const art=document.querySelector(`.seat[data-player-id="${e.dataset.targetPlayer}"] .seat__portrait > img`)
              const image=art.getBoundingClientRect()
              const fit=Math.min(image.width/art.naturalWidth,image.height/art.naturalHeight)
              // Defect's torso is below his mouth at (222, 89), at stable rig scale.
              return {x:impact.left+impact.width/2,y:impact.top+impact.height/2,
                bodyX:image.left+(image.width-art.naturalWidth*fit)/2+195.4*fit,
                bodyY:image.bottom-(art.naturalHeight-149.4)*fit}
            })
            assert(Math.abs(anchor.x-anchor.bodyX)<3&&Math.abs(anchor.y-anchor.bodyY)<3,`${enemy.id}: damage impact misses painted torso ${JSON.stringify(anchor)}`)
          }
        }
        if(!enemy.isBoss&&bossAttackMotionFor(enemy.artId??enemy.id)==='melee'){
          const dash=await card.evaluate(e=>parseFloat(e.style.getPropertyValue('--boss-dash-x')))
          assert(Number.isFinite(dash)&&dash<0,`${enemy.id}: melee has no measured target travel`)
          assert(after.x<before.x-20,`${enemy.id}: physical attack stayed in its origin lane`)
        }
        if(normalsOnly||enemy.elite||enemy.isBoss)await page.locator('.board').screenshot({path:resolve(output,`${screen}-${enemy.id}-attack.png`)})
        await page.waitForTimeout(1250)
        assert.equal(await card.getAttribute('data-animation'),'idle',`${enemy.id}: return`)
      }else assert.equal(await card.getAttribute('data-animation'),'idle',`${enemy.id}: nonattack intent`)
    }
    // Sample the rendered texture, with CSS travel disabled so it cannot hide a frozen rig.
    for (const [id,isBoss] of (normalsOnly ? ['looter','gremlin_wizard','byrd'].map(artId=>[Object.values(ENEMIES).find(e=>(e.artId??e.id)===artId).id,false]) : [['gremlin_nob',false],['guardian_attack',true],['downfall_demon',true]])) {
      await page.evaluate(([id,isBoss])=>window.fixture.install('defect',id,isBoss),[id,isBoss])
      await page.waitForTimeout(2400) // Longer than a decoded one-shot preload's entire timeline.
      let previousSrc
      for (let repeat=0;repeat<2;repeat++) {
        await page.evaluate(()=>{const f=window.fixture;f.state.phase='enemy';f.render()})
        const art=page.locator('.enemy[data-animation="attack"] .enemy__art--cutout')
        await art.waitFor()
        const src=await art.getAttribute('src')
        assert(src.startsWith('blob:') && src!==previousSrc,`${screen}/${id}: attack did not get a fresh replay URL`)
        previousSrc=src
        await art.evaluate(i=>{i.style.animation='none';i.style.translate='0';i.style.opacity='1';i.style.backgroundColor='#17222d'})
        if(id==='downfall_demon'){
          const grounded=page.locator('.boss-demon-grounded')
          assert((await grounded.getAttribute('src')).endsWith('/downfall_demon-ground-slam.webp'),'Demon lost its crouched landing pose')
          assert((await art.getAttribute('data-animation-asset')).endsWith('/downfall_demon-airborne.webp'),'Demon lost its airborne pose')
          assert.notEqual(await grounded.getAttribute('src'),src,'Demon must use distinct airborne and grounded drawings')
        }
        const frames=[]
        for(let sample=0;sample<3;sample++) {
          await page.waitForTimeout(300)
          frames.push(createHash('sha256').update(await art.screenshot()).digest('hex'))
        }
        if(id!=='downfall_demon')assert(new Set(frames).size>1,`${screen}/${id}: attack ${repeat+1} texture is frozen`)
        await page.waitForTimeout(1100)
        await page.evaluate(()=>{const f=window.fixture;f.state.phase='player';f.render()})
        await page.waitForTimeout(100)
      }
    }
    if(normalsOnly) for(const [id,expected] of [['acid_slime',1],['gremlin_wizard',2]]) {
      await page.evaluate(id=>{
        const f=window.fixture;f.install('defect',id,false)
        f.state.players.push({...structuredClone(f.state.players[0]),id:'p2',name:'Second player',row:1,facingEnemyUid:undefined})
        f.render()
      },id)
      await page.waitForTimeout(1000)
      await page.evaluate(()=>{const f=window.fixture;f.state.phase='enemy';f.render()})
      await page.waitForFunction(()=>document.querySelector('.enemy')?.dataset.animation==='attack')
      assert.equal(await page.locator('.boss-projectile').count(),expected,`${id}: multiplayer projectile targets`)
      assert.equal(await page.locator('.enemy-projectile-impact').count(),expected,`${id}: multiplayer impact targets`)
      await page.waitForTimeout(780)
      await page.locator('.board').screenshot({path:resolve(output,`${screen}-${id}-multiplayer.png`)})
      await page.waitForTimeout(1200)
    }
    await page.evaluate(normal=>window.fixture.install('defect',normal?'gremlin_wizard':'sentry_a',false,3),normalsOnly)
    await page.waitForTimeout(500)
    await page.locator('.board').screenshot({path:resolve(output,`${screen}-three-${normalsOnly?'normal-casters':'sentries'}.png`)})
    await page.evaluate(()=>{const f=window.fixture;f.state.players[0].dead=true;f.state.players[0].hp=0;f.render()})
    await page.waitForTimeout(100)
    assert(!await page.locator('.seat__portrait > img').getAttribute('src').then(s=>s.includes('/rigged/')), 'dead hero still breathes')
    await page.evaluate(()=>{document.documentElement.dataset.reducedMotion='true';window.fixture.install('defect')})
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.enemy').getAttribute('data-animation'),'static')
    assert(!await page.locator('.seat__portrait > img').getAttribute('src').then(s=>s.includes('/rigged/')))
    await page.evaluate(()=>{
      const f=window.fixture
      f.state.presentationEvents=[{kind:'orb',orb:'lightning',seq:++f.seq,actorId:'p1',sourceId:'orb-evoke',enemyIds:['enemy-0'],playerIds:[]}]
      f.render()
    })
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.defect-evoke').count(),0,'reduced motion still renders evoke beams')
    await context.close()
    console.log(`PASS ${screen}: heroes, enemy rigs, return geometry, repeat attacks, reduced motion`)
  }
  assert.deepEqual(errors,[])
}finally{await browser.close();await server.close()}
