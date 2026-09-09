#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { ENEMIES } from '../src/game/enemies.ts'
import { bossAttackMotionFor, bossProjectileImagePath } from '../src/ui/combat-vfx.ts'

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
const enemies = [...new Map(Object.values(ENEMIES).filter((e) => e.isBoss || e.elite ||
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
    for (const [character,source] of (process.argv.includes('--elites-only')?[]:Object.entries(heroes))
      .filter(([id])=>!process.argv.some(a=>a.startsWith('--hero='))||process.argv.includes(`--hero=${id}`))) {
      await page.evaluate(c=>window.fixture.install(c),character)
      await page.waitForFunction(()=>document.querySelector('.seat__portrait > img')?.complete)
      await page.waitForTimeout(100)
      await page.waitForFunction(c=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=(c==='hexaghost'?7:c.startsWith('guardian')||c==='watcher'?2:1),character)
      await page.waitForFunction(()=>[...document.querySelectorAll('.seat__portrait > img')].every(i=>i.complete&&!i.dataset.guardianTransition))
      await page.waitForTimeout(100)
      const before=await page.locator('.seat__portrait > img').boundingBox()
      const seq=await page.evaluate(id=>window.fixture.attack(id),source)
      const poseSelector=character==='watcher'?'.character-attack__pose--watcher-charge':'.character-attack__pose--rig.is-loaded:not(.is-fallback)'
      const pose=page.locator(`[data-attack-seq="${seq}"] ${poseSelector}`)
      await pose.waitFor()
      if(character==='watcher') {
        assert((await pose.locator('img').getAttribute('src')).endsWith('/watcher-ready.webp'))
        assert.equal(await pose.evaluate(e=>getComputedStyle(e).opacity),'1','Watcher must raise her staff before casting')
        assert.equal(await page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--rig`).count(),0)
      } else assert.equal(await pose.locator('img').evaluate(i=>i.naturalWidth),400,character)
      await page.waitForTimeout(character==='hexaghost'?1400:600)
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
      // A second attack must get a fresh replay URL rather than reuse the ended WebP timeline.
      const firstSrc=await page.evaluate(()=>window.fixture.seq)
      const next=await page.evaluate(id=>window.fixture.attack(id),source)
      assert(next>firstSrc)
      await page.locator(`[data-attack-seq="${next}"] ${poseSelector}`).waitFor()
      await page.waitForTimeout(2100)
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
      await page.waitForTimeout(1000) // Allow encounter attack preloads before the synthetic end-turn.
      if(enemy.elite||enemy.isBoss)await page.locator('.board').screenshot({path:resolve(output,`${screen}-${enemy.id}-idle.png`)})
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
        if(!enemy.isBoss&&bossAttackMotionFor(enemy.artId??enemy.id)==='melee'){
          const dash=await card.evaluate(e=>parseFloat(e.style.getPropertyValue('--boss-dash-x')))
          assert(Number.isFinite(dash)&&dash<0,`${enemy.id}: melee has no measured target travel`)
          assert(after.x<before.x-20,`${enemy.id}: physical attack stayed in its origin lane`)
        }
        if(enemy.elite||enemy.isBoss)await page.locator('.board').screenshot({path:resolve(output,`${screen}-${enemy.id}-attack.png`)})
        await page.waitForTimeout(1250)
        assert.equal(await card.getAttribute('data-animation'),'idle',`${enemy.id}: return`)
      }else assert.equal(await card.getAttribute('data-animation'),'idle',`${enemy.id}: nonattack intent`)
    }
    // Sample the rendered texture, with CSS travel disabled so it cannot hide a frozen rig.
    for (const [id,isBoss] of [['gremlin_nob',false],['guardian_attack',true],['downfall_demon',true]]) {
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
    await page.evaluate(()=>window.fixture.install('defect','sentry_a',false,3))
    await page.waitForTimeout(500)
    await page.locator('.board').screenshot({path:resolve(output,`${screen}-three-sentries.png`)})
    await page.evaluate(()=>{const f=window.fixture;f.state.players[0].dead=true;f.state.players[0].hp=0;f.render()})
    await page.waitForTimeout(100)
    assert(!await page.locator('.seat__portrait > img').getAttribute('src').then(s=>s.includes('/rigged/')), 'dead hero still breathes')
    await page.evaluate(()=>{document.documentElement.dataset.reducedMotion='true';window.fixture.install('defect')})
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.enemy').getAttribute('data-animation'),'static')
    assert(!await page.locator('.seat__portrait > img').getAttribute('src').then(s=>s.includes('/rigged/')))
    await context.close()
    console.log(`PASS ${screen}: heroes, enemy rigs, return geometry, repeat attacks, reduced motion`)
  }
  assert.deepEqual(errors,[])
}finally{await browser.close();await server.close()}
