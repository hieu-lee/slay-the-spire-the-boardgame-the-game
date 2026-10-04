#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit, devices } from './lib/profile-browser.mjs'
import { ENEMIES } from '../src/game/enemies.ts'
import { bossAttackMotionFor, bossProjectileImagePath, enemyProjectileImpactPath, enemyProjectileOriginFor, enemyArtScaleFor } from '../src/ui/combat-vfx.ts'

const hostedAttacks = process.argv.includes('--hosted-attacks')
if (hostedAttacks) {
  process.env.VITE_ASSET_CDN_ORIGIN = 'https://cdn.animation.example/assets'
  process.env.VITE_CAMPFIRE_BACKUP_ORIGIN = 'https://raw.animation.example/assets'
}
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/rig-animation/browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch({ headless: true })
const errors = []
const heroes = {
  ironclad: 'strike_ironclad', silent: 'predator', defect: 'strike_defect', watcher: 'strike_watcher',
  guardian: 'guardian_strike', 'guardian-defense': 'guardian_strike', hermit: 'hermit_strike', slime_boss: 'slime_boss_strike', hexaghost: 'strike_hexaghost',
}
const normalsOnly = process.argv.includes('--normal-only')
const bossesOnly = process.argv.includes('--boss-only')
const elitesOnly = process.argv.includes('--elites-only')
const attackParityOnly = process.argv.includes('--attack-parity-only')
const webpBaseline = attackParityOnly && process.argv.includes('--webp-baseline')
const eliteArt = e => e.elite || ['sentry_a','sentry_b','red_slaver','blue_slaver'].includes(e.id)
const onlyEnemyIds = process.argv.filter(arg => arg.startsWith('--only=')).map(arg => arg.slice('--only='.length))
const rigs = JSON.parse(readFileSync(resolve(root, 'scripts/animation/rigs.json'), 'utf8'))
const enemies = [...new Map(Object.values(ENEMIES).filter((e) => attackParityOnly ? eliteArt(e) || ['looter', 'mugger'].includes(e.artId ?? e.id) : bossesOnly ? e.isBoss : elitesOnly ? eliteArt(e) : normalsOnly ? !e.isBoss && !e.elite : e.isBoss || eliteArt(e)).map((e) => [e.artId ?? e.id,e])).values()]
  .filter(e=>!process.argv.some(a=>a.startsWith('--only='))||process.argv.includes(`--only=${e.id}`)||process.argv.includes(`--only=${e.artId ?? e.id}`))
try {
  if (attackParityOnly) assert(enemies.length > 0, 'No attacks selected; check --only enemy/art IDs')
  for (const [screen,viewport] of [['desktop',{width:1440,height:900}],['horizontal-phone',{width:844,height:390}]]) {
    if(process.argv.includes('--phone-only') && screen!=='horizontal-phone')continue
    const context = await browser.newContext({ viewport, isMobile: screen==='horizontal-phone', hasTouch: screen==='horizontal-phone', recordVideo: { dir: output, size: viewport },
      ...(process.argv.includes('--crios') && screen === 'horizontal-phone' ? { userAgent: devices['iPhone 13 landscape'].userAgent.replace(/Version\/[\d.]+/, 'CriOS/147.0.0.0') } : {}) })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(String(e)))
    page.on('response', r => { if (r.status()>=400 && /\/assets\/combat\/rigged\//.test(r.url())) errors.push(`${r.status()} ${r.url()}`) })
    if (hostedAttacks) {
      await page.route('https://cdn.animation.example/assets/**', route => route.fulfill({ status: 403 }))
      await page.route('https://raw.animation.example/assets/**', route => route.fulfill({
        path: resolve(root, 'public', new URL(route.request().url()).pathname.slice(1)),
        contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' },
      }))
    }
    if (attackParityOnly && process.argv.includes('--cold-attack')) await page.route(/\/assets\/combat\/.*-attack\.png$/, async route => {
      await new Promise(resolve => setTimeout(resolve, 1200))
      await route.continue()
    })
    if (webpBaseline) await page.route(/\/assets\/combat\/.*-attack\.png$/, route => route.fulfill({
      path: resolve(root, 'public', new URL(route.request().url()).pathname.slice(1).replace(/\.png$/, '.webp')),
      contentType: 'image/webp',
    }))
    if (process.argv.includes('--sfx-only')) await page.addInitScript(() => {
      window.audioPlays = []; window.audioBeats = []; window.audioPauses = []
      HTMLMediaElement.prototype.play = function () {
        window.audioPlays.push({ cue: this.dataset.combatSfx, path: new URL(this.src).pathname,
          time: performance.now(), volume: this.volume, rate: this.playbackRate })
        return Promise.resolve()
      }
      HTMLMediaElement.prototype.pause = function () { window.audioPauses.push(this.dataset.combatSfx) }
      document.addEventListener('animationstart', event => {
        window.audioBeats.push({ name: event.animationName, time: performance.now() })
      })
    })
    // Native video behavior has its own focused matrix; this verifier owns
    // deterministic rig choreography and geometry across engines.
    await page.goto(`http://localhost:${server.httpServer.address().port}${process.argv.includes('--webkit') ? '?combat-webp=1' : ''}`)
    await page.evaluate(async () => {
      document.querySelector('#root').style.display='none'
      document.documentElement.dataset.mobilePerformance=String(matchMedia('(pointer: coarse)').matches || innerWidth<900)
      document.documentElement.dataset.reducedMotion='false'
      const node=document.createElement('div');node.className='app-shell app-shell--combat sts-scope';document.body.append(node)
      node.style.gridTemplateRows='minmax(0, 1fr)'
      const [R,D,{CombatScreen},{createPlayer},{createCombat},{createRng},{actionsForEnemy},] = await Promise.all([
        import('/@id/react'),import('/@id/react-dom/client'),import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'),import('/src/game/combat.ts'),import('/src/game/rng.ts'),import('/src/game/enemies.ts'),
        import('/src/ui/styles.css'),import('/src/ui/chrome.css'),
      ])
      const reactRoot=(D.createRoot??D.default.createRoot)(node)
      const reactDom = await import('/@id/react-dom')
      const flushSync = reactDom.flushSync ?? reactDom.default.flushSync
      const f=window.fixture={seq:1000,restoration:0}
      f.render=()=>flushSync(()=>reactRoot.render((R.createElement??R.default.createElement)(CombatScreen,{
        state:structuredClone(f.state),act:1,viewerId:'p1',autoAdvance:false,
        authoritativeRestoration:f.restoration,authoritativeConnected:f.connected,onAction:()=>{},
      })))
      f.install=(character,defId='guardian_attack',isBoss=true,count=1,hp=999)=>{
        const rng=createRng(47);const player=createPlayer(rng,'p1',character,character==='guardian-defense'?'guardian':character,0)
        player.hp=player.maxHp=999;player.hand=[];player.draw=[];player.relics=[]
        const enemy={uid:'enemy-0',defId,row:0,isBoss,hp,maxHp:999,block:0,strength:0,vulnerable:0,weak:0,poison:0,actionIndex:0,abilityUsed:false,dead:false}
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
    if (attackParityOnly) {
      const engine = (process.argv.includes('--webkit') ? 'webkit' : 'chromium') + (webpBaseline ? '-webp-baseline' : '') +
        (process.argv.includes('--crios') ? '-crios' : '') + (process.argv.includes('--cold-attack') ? '-cold' : '') + (hostedAttacks ? '-hosted' : '')
      const directory = resolve(output, 'attack-parity', engine, screen)
      mkdirSync(directory, { recursive: true })
      const samples = []
      for (const enemy of enemies) {
        const actor = enemy.artId ?? enemy.id
        await page.evaluate(id => window.fixture.install('defect', id, false), enemy.id)
        await page.waitForFunction(() => [...document.querySelectorAll('.enemy img')].every(image => image.complete && image.naturalWidth > 0))
        await page.waitForTimeout(200)
        await page.evaluate(() => { const f = window.fixture; f.state.phase = 'enemy'; f.render() })
        const art = page.locator('.enemy--acting img[data-animation-layer="attack"]')
        await art.waitFor()
        if (hostedAttacks) assert((await art.getAttribute('data-animation-asset')).startsWith('https://raw.animation.example/'),
          `${actor}: hosted APNG still uses the size-limited CDN`)
        const firstReplay = await art.getAttribute('src')
        assert(!firstReplay.includes('-idle.webp'), `${actor}: cold attack mounted idle art instead of its timed weapon poses`)
        const waitForBeat = async time => {
          try {
            await page.waitForFunction(({ image, time }) => image.getAnimations()[0]?.currentTime >= time,
              { image: await art.elementHandle(), time }, { timeout: 5000 })
          } catch (error) {
            throw new Error(`${actor}: attack clock did not reach ${time}ms`, { cause: error })
          }
        }
        await waitForBeat(730)
        await page.locator('.board').screenshot({ path: resolve(directory, `${actor}-contact-board.png`), scale: 'css' })
        await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
        await page.evaluate(() => { window.fixture.state.phase = 'player'; window.fixture.render() })
        await page.locator('.combat__phase--player').waitFor()
        await page.evaluate(() => { window.fixture.state.phase = 'enemy'; window.fixture.render() })
        await art.waitFor()
        assert.notEqual(await art.getAttribute('src'), firstReplay, `${actor}: repeated attack reused its one-shot URL`)
        // Keep the live image and combat clock, isolating only filters and
        // root motion. A clone can restart APNG's own decoder/timeline; a
        // changing hash of a moving silhouette cannot prove weapon timing.
        await art.evaluate((image, phone) => {
          const width = phone ? 120 : 240
          image.closest('.enemy').style.filter = 'none'
          Object.assign(image.style, { width: `${width}px`, height: `${Math.round(width * image.naturalHeight / image.naturalWidth)}px`,
            position: 'fixed', left: '100px', top: phone ? '100px' : '150px', bottom: 'auto', marginLeft: '0', scale: '1',
            background: '#17222d', objectFit: 'fill', filter: 'none', zIndex: '100' })
          image.style.setProperty('translate', '0', 'important')
          image.style.setProperty('transform', 'none', 'important')
        }, screen === 'horizontal-phone')
        for (const time of [730, 1550]) {
          await waitForBeat(time)
          // Portrait alignment can leave the fixed image at fractional pixels;
          // snap its capture box, not the native animation, to the pixel grid.
          await art.evaluate(image => {
            const rect = image.getBoundingClientRect()
            image.style.left = `${parseFloat(image.style.left) + Math.round(rect.left) - rect.left}px`
            image.style.top = `${parseFloat(image.style.top) + Math.round(rect.top) - rect.top}px`
          })
          const before = await art.evaluate(image => image.getAnimations()[0].currentTime)
          const path = resolve(directory, `${actor}-${time}.png`)
          await art.screenshot({ path, scale: 'css' })
          const after = await art.evaluate(image => image.getAnimations()[0].currentTime)
          samples.push({ actor, before, after, path })
        }
        await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
      }
      const manifest = resolve(directory, 'samples.json')
      writeFileSync(manifest, JSON.stringify(samples, null, 2) + '\n')
      const poses = spawnSync('python3', [resolve(root, 'scripts/animation/check-attack-parity.py'), manifest], { cwd: root, encoding: 'utf8' })
      console.log(poses.stdout.trim())
      assert.equal(poses.status, 0, poses.stderr || poses.stdout)
      await context.close()
      console.log(`PASS ${engine}/${screen}: painted enemy contact and recovery agree with the combat clock`)
      continue
    }
    if (process.argv.includes('--sfx-only')) {
      await page.evaluate(async () => {
        const [R, D, { useGameSettings }, { installSoundEffects }] = await Promise.all([import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/game-settings.ts'), import('/src/ui/sfx.ts')])
        const controls = document.createElement('div'); document.body.append(controls)
        function SettingsControl() {
          const [settings, setSettings] = useGameSettings()
          ;(R.useEffect ?? R.default.useEffect)(() => settings.sfxVolume > 0 ? installSoundEffects() : undefined, [settings.sfxVolume])
          window.fixture.setVolume = value => setSettings({ ...settings, sfxVolume: value })
          return null
        }
        ;(D.createRoot ?? D.default.createRoot)(controls).render((R.createElement ?? R.default.createElement)(SettingsControl))
      })
      await page.evaluate(async () => {
        const { ANIMATION_SOUND_VOLUMES } = await import('/src/ui/combat-sfx.ts')
        const context = new AudioContext()
        try {
          for (const sound of Object.keys(ANIMATION_SOUND_VOLUMES)) {
            const response = await fetch(`/assets/sfx/${sound}.mp3`)
            if (!response.ok) throw Error(`${sound}: missing audio`)
            const buffer = await context.decodeAudioData(await response.arrayBuffer())
            const samples = buffer.getChannelData(0)
            const peak = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
            const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
            if (buffer.duration < .1 || buffer.duration > 1 || peak > 1 || rms < .01) throw Error(`${sound}: invalid audio levels/duration`)
          }
        } finally { await context.close() }
      })
      const sounds = () => page.evaluate(() => window.audioPlays.filter(play => play.cue?.startsWith('animation:')))
      const clear = () => page.evaluate(() => { window.audioPlays = []; window.audioBeats = []; window.audioPauses = [] })
      for (const [hero, card, expected] of [
        ['hermit', 'hermit_strike', { gunshot: 5, 'bullet-impact': 5 }],
        ['watcher', 'strike_watcher', { 'meteor-fall': 3, 'meteor-impact': 3 }],
        ['ironclad', 'strike_ironclad', { 'sword-swing': 1, 'sword-clash': 1 }],
        ['hexaghost', 'strike_hexaghost', { 'flame-burst': 1 }],
        ['guardian', 'guardian_strike', { 'sword-clash': 1 }],
        ['silent', 'predator', { 'sword-swing': 3 }],
        ['silent', 'deadly_poison', { 'poison-hiss': 1 }],
        ['slime_boss', 'slime_boss_strike', { 'slime-splat': 1 }],
      ]) {
        await page.evaluate(hero => window.fixture.install(hero, 'jaw_worm', false, 3), hero)
        await page.waitForFunction(hero => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= (hero === 'hermit' ? 3 : hero === 'hexaghost' ? 1 : ['watcher', 'ironclad', 'guardian'].includes(hero) ? 2 : 1), hero)
        await clear()
        await page.evaluate(card => window.fixture.attack(card), card)
        await page.waitForTimeout(1900)
        const plays = await sounds()
        for (const [sound, count] of Object.entries(expected)) {
          assert.equal(plays.filter(play => play.cue === `animation:${sound}`).length, count, `${hero}: ${sound} beat count`)
        }
        const beats = await page.evaluate(() => window.audioBeats)
        const names = { gunshot: 'hermit-bullet-flight', 'bullet-impact': 'hermit-bullet-impact',
          'meteor-fall': 'watcher-meteor-fall', 'meteor-impact': 'watcher-meteor-impact', 'sword-swing': 'attack-swing' }
        for (const play of plays) {
          const name = hero === 'silent' && play.cue === 'animation:sword-swing' ? 'attack-dagger-round-trip' : names[play.cue.slice(10)]
          if (name) assert(beats.some(beat => beat.name === name && Math.abs(beat.time - play.time) < 50), `${hero}: sound missed its animation`)
          assert(play.volume > 0 && play.volume <= .3, 'mix must stay bounded')
        }
      }
      await page.evaluate(() => window.fixture.install('defect', 'jaw_worm', false, 3))
      await page.waitForTimeout(250)
      for (const [orb, sound] of [['lightning', 'lightning-burst'], ['dark', 'dark-beam'], ['frost', 'frost-bloom']]) {
        await clear()
        await page.evaluate(orb => {
          const f = window.fixture
          f.state.presentationEvents = [{ kind: 'orb', orb, seq: ++f.seq, actorId: 'p1', sourceId: 'orb-evoke',
            enemyIds: orb === 'frost' ? [] : f.state.enemies.map(enemy => enemy.uid), playerIds: [] }]
          f.render()
        }, orb)
        await page.waitForTimeout(900)
        assert.equal((await sounds()).filter(play => play.cue === `animation:${sound}`).length, 1, `${orb}: evoke must not multiply audio by target count`)
      }
      await clear()
      await page.evaluate(() => {
        const f = window.fixture
        f.state.presentationEvents = ['lightning', 'frost', 'lightning'].map(orb => ({ kind: 'orb', orb,
          seq: ++f.seq, actorId: 'p1', sourceId: 'orb-end-turn',
          enemyIds: orb === 'frost' ? [] : ['enemy-0'], playerIds: orb === 'frost' ? ['p1'] : [] }))
        f.render()
      })
      await page.waitForTimeout(1200)
      const passive = await sounds()
      assert.deepEqual(passive.map(play => play.cue), ['animation:lightning-burst', 'animation:frost-bloom', 'animation:lightning-burst'])
      assert(passive[1].time - passive[0].time > 200 && passive[2].time - passive[1].time > 300, 'passive orb sounds lost their stagger')
      for (const stop of ['restore', 'disconnect', 'mute', 'reduced']) {
        await page.evaluate(() => window.fixture.install('hermit', 'jaw_worm', false))
        await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= 3)
        await clear()
        await page.evaluate(() => window.fixture.attack('hermit_strike'))
        await page.waitForFunction(() => window.audioPlays.some(play => play.cue === 'animation:gunshot'))
        const before = (await sounds()).length
        await page.evaluate(stop => {
          if (stop === 'restore') window.fixture.restoration++
          if (stop === 'disconnect') window.fixture.connected = false
          if (stop === 'mute') window.fixture.setVolume(0)
          if (stop === 'reduced') document.documentElement.dataset.reducedMotion = 'true'
          window.fixture.render()
        }, stop)
        await page.waitForTimeout(1000)
        assert.equal((await sounds()).length, before, `${stop}: later gunshots leaked`)
        assert((await page.evaluate(() => window.audioPauses)).includes('animation:gunshot'), `${stop}: active audio was not stopped`)
        await page.evaluate(() => { window.fixture.setVolume(100); window.fixture.connected = true; document.documentElement.dataset.reducedMotion = 'false'; window.fixture.render() })
      }
      await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true'; window.fixture.render() })
      await page.waitForTimeout(100)
      await clear()
      await page.evaluate(() => {
        const f = window.fixture
        f.state.presentationEvents = ['lightning', 'frost', 'dark'].map(orb => ({ kind: 'orb', orb,
          seq: ++f.seq, actorId: 'p1', sourceId: 'orb-end-turn', enemyIds: ['enemy-0'], playerIds: ['p1'] }))
        f.render()
      })
      // The authoritative sound stream still releases passive orbs 380ms apart.
      await page.waitForTimeout(1000)
      assert.deepEqual((await sounds()).map(play => play.cue), ['animation:lightning-burst', 'animation:frost-bloom', 'animation:dark-beam'], 'reduced motion must retain orb audio feedback')
      await page.evaluate(async () => {
        const [{ playCombatSound }, { animationSfxRecipe }] = await Promise.all([import('/src/ui/sfx.ts'), import('/src/ui/combat-sfx.ts')])
        const before = window.audioPauses.length
        const stops = Array.from({ length: 32 }, () => playCombatSound(animationSfxRecipe('frost-bloom')))
        if (window.audioPauses.length - before < 8) throw Error('simultaneous effect voices were not bounded')
        stops.forEach(stop => stop())
      })
      assert.deepEqual(errors, [])
      console.log(`PASS ${screen}: animation-synchronized SFX, AoE mixing, orb stagger, mute and restoration`)
      await context.close()
      continue
    }
    for (const [character,source] of (bossesOnly||normalsOnly||elitesOnly?[]:Object.entries(heroes))
      .filter(([id])=>!process.argv.some(a=>a.startsWith('--hero='))||process.argv.includes(`--hero=${id}`))) {
      await page.evaluate(c=>window.fixture.install(c),character)
      await page.waitForFunction(()=>document.querySelector('.seat__portrait > img')?.complete)
      await page.waitForTimeout(100)
      await page.waitForFunction(c=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=(c==='hexaghost'?1:c.startsWith('guardian')||c==='watcher'||c==='ironclad'?2:1),character)
      await page.waitForFunction(()=>[...document.querySelectorAll('.seat__portrait > img')].every(i=>i.complete&&!i.dataset.guardianTransition))
      await page.waitForTimeout(100)
      const before=await page.locator('.seat__portrait > img').boundingBox()
      const seq=await page.evaluate(id=>window.fixture.attack(id),source)
      const poseSelector=character==='ironclad'?'.character-attack__pose--ironclad-ready':character==='watcher'?'.character-attack__pose--watcher-charge':'.character-attack__pose--rig.is-loaded:not(.is-fallback)'
      const pose=page.locator(`[data-attack-seq="${seq}"] ${poseSelector}`)
      await pose.waitFor()
      if(character==='ironclad') {
        assert((await pose.locator(':scope > img').getAttribute('src')).endsWith('/ironclad-ready.webp'))
        const impact=page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--ironclad-impact img`)
        assert((await impact.getAttribute('src')).endsWith('/ironclad-impact.webp'))
        assert.equal(await page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--rig`).count(),0)
      } else if(character==='watcher') {
        assert((await pose.locator(':scope > img').getAttribute('src')).endsWith('/watcher-ready.webp'))
        assert.equal(await pose.evaluate(e=>getComputedStyle(e).opacity),'1','Watcher must raise her staff before casting')
        assert.equal(await page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--rig`).count(),0)
      } else assert.equal(await pose.locator(':scope > img').evaluate(i=>i.naturalWidth),rigs[character==='hexaghost'?'hero-hexaghost-heat-0':`hero-${character}`].size,character)
      if (character !== 'hermit') {
        const overlay = await page.locator(`.combat-vfx--attack-impact[data-vfx-seq="${seq}"]`).first().evaluate(node => ({
          image: getComputedStyle(node).backgroundImage, blend: getComputedStyle(node).mixBlendMode,
          before: getComputedStyle(node, '::before').content, after: getComputedStyle(node, '::after').content,
        }))
        assert(overlay.image.includes('/combat/vfx/actions/'), 'attack has no painted impact sprite')
        assert.equal(overlay.blend, 'normal', 'painted impact must retain its colors')
        assert.equal(overlay.before, 'none', 'procedural ring obscures painted impact')
        assert.equal(overlay.after, 'none', 'procedural streak obscures painted impact')
      }
      if(character!=='watcher') await page.waitForTimeout(character==='hexaghost'?1400:character==='ironclad'?850:600)
      if(character==='watcher') {
        const cast=page.locator(`[data-attack-seq="${seq}"] .character-attack__pose--watcher-cast`)
        assert((await cast.locator('img').getAttribute('src')).endsWith('/watcher-thrust.webp'))
        // Sample in-page on the meteor clock: protocol round trips can outlast
        // the 550ms cast window. The pose must be casting in that same frame.
        const cast_=await cast.evaluate((e,seq)=>new Promise(resolve=>{
          const startedAt=performance.now()
          const sample=()=>{
            const meteor=document.querySelector(`[data-attack-seq="${seq}"] .character-attack__meteor`)
            const fall=meteor?.getAnimations().find(a=>a.animationName==='watcher-meteor-fall')
            const progress=fall&&typeof fall.currentTime==='number'?(fall.currentTime-fall.effect.getTiming().delay)/500:NaN
            if(progress>=.1) resolve({progress,opacity:getComputedStyle(e).opacity})
            else if(performance.now()-startedAt>3000) resolve({progress,opacity:'missing meteor clock'})
            else requestAnimationFrame(sample)
          }
          sample()
        }),seq)
        assert(cast_.progress<1,`Watcher meteor sample missed the fall (${cast_.progress})`)
        assert.equal(cast_.opacity,'1','Watcher must cast downward while the meteor falls')
        assert(await page.locator(`[data-attack-seq="${seq}"] .character-attack__meteor`).count()>0,'Watcher lost the meteor')
        // Measure the decoded sprite rather than repeating CSS anchors: replacing
        // its artwork must not make the visible nose miss the ground or slide sideways.
        const geometry = await page.locator(`[data-attack-seq="${seq}"]`).evaluate(layer => {
          const meteor = layer.querySelector('.character-attack__meteor')
          const image = meteor.querySelector('.character-attack__meteor-art')
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
          const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          let mass = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const weight = rgba[(y * canvas.width + x) * 4 + 3] / 255
            mass += weight; sx += x * weight; sy += y * weight
            sxx += x * x * weight; syy += y * y * weight; sxy += x * y * weight
          }
          const xx = sxx / mass - (sx / mass) ** 2
          const yy = syy / mass - (sy / mass) ** 2
          const xy = sxy / mass - sx * sy / mass ** 2
          const angle = Math.atan2(2 * xy, xx - yy) / 2
          const axis = [Math.cos(angle), Math.sin(angle)]
          const painted = []
          let end = -Infinity
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            if (rgba[(y * canvas.width + x) * 4 + 3] < 204) continue
            const projection = x * axis[0] + y * axis[1]
            painted.push({ x, y, projection }); end = Math.max(end, projection)
          }
          const tip = painted.filter(point => point.projection >= end - 2)
          const nose = tip.reduce((sum, point) => [sum[0] + point.x, sum[1] + point.y], [0, 0])
            .map(value => value / tip.length)
          const animations = layer.getAnimations({ subtree: true })
          const saved = animations.map(animation => animation.currentTime)
          const samples = [550, 1050].map(time => {
            animations.forEach(animation => { animation.pause(); animation.currentTime = time })
            const rect = image.getBoundingClientRect()
            const impact = meteor.querySelector('.character-attack__meteor-impact').getBoundingClientRect()
            return { impactGroundY: impact.top + impact.height * .7890625, x: rect.left + nose[0] * rect.width / canvas.width,
              y: rect.top + nose[1] * rect.height / canvas.height,
              bottom: rect.bottom, impact: Number(getComputedStyle(meteor.querySelector('.character-attack__meteor-impact')).opacity) }
          })
          animations.forEach((animation, i) => { animation.currentTime = saved[i]; animation.play() })
          const target = document.querySelector(`[data-enemy-id="${meteor.dataset.attackTargetId}"] .enemy__portrait`).getBoundingClientRect()
          return { angle, samples, ground: target.bottom, left: target.left, right: target.right,
            boardTop: document.querySelector('.board').getBoundingClientRect().top }
        })
        const [sky, contact] = geometry.samples
        const flightAngle = Math.atan2(contact.y - sky.y, contact.x - sky.x)
        assert(Math.abs(flightAngle - geometry.angle) < .2 * Math.PI / 180,
          `${screen}: meteor flight diverged from its painted axis ${JSON.stringify(geometry)}`)
        assert(sky.bottom <= geometry.boardTop + .5, `${screen}: meteor must enter from the sky`)
        assert(Math.abs(contact.y - geometry.ground) < .5 && contact.x >= geometry.left && contact.x <= geometry.right,
          `${screen}: painted meteor nose missed ground contact ${JSON.stringify(geometry)}`)
        assert.equal(sky.impact, 0, 'Meteor impact appears before contact')
        assert(contact.impact >= .9, 'Meteor impact is missing at contact')
        assert(Math.abs(contact.impactGroundY - geometry.ground) < .5,
          `${screen}: painted meteor impact is below the ground`)
      }
      await page.locator('.board').screenshot({path:resolve(output,`${screen}-${character}-attack.png`)})
      await page.waitForTimeout(1800)
      const after=await page.locator('.seat__portrait > img').boundingBox()
      if(character==='guardian-defense')assert.equal(await page.locator('.seat__portrait > img').getAttribute('data-guardian-mode'),'defense')
      for(const key of ['x','y','width','height'])assert(Math.abs(before[key]-after[key])<.6,
        `${screen}/${character}: layout jumped ${key} ${JSON.stringify({ before, after })}`)
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
              const sourceScale=art.naturalWidth/400
              const mouthX=image.left+(image.width-art.naturalWidth*fit)/2+222*sourceScale*fit
              const mouthY=image.bottom-(art.naturalHeight-89*sourceScale)*fit
              return [...node.querySelectorAll('.defect-evoke__ray')].map(ray=>{
                const portrait=document.querySelector(`.enemy[data-enemy-id="${ray.dataset.evokeTarget}"] .enemy__portrait`)
                const targetArt=portrait.querySelector(':scope > img')
                const target=targetArt.getBoundingClientRect()
                const targetFit=Math.min(target.width/targetArt.naturalWidth,target.height/targetArt.naturalHeight)
                // Jaw Worm's painted torso in the canonical 400 x 250 idle rig.
                const targetScale=targetArt.naturalWidth/400
                const targetX=target.left+(target.width-targetArt.naturalWidth*targetFit)/2+170.3*targetScale*targetFit
                const targetY=target.bottom-(targetArt.naturalHeight-181*targetScale)*targetFit
                const impact=portrait.querySelector(`.combat-vfx--target[data-vfx-seq="${node.dataset.evokeSeq}"]`).getBoundingClientRect()
                const length=parseFloat(ray.style.getPropertyValue('--beam-length'))
                const angle=parseFloat(ray.style.getPropertyValue('--beam-angle'))*Math.PI/180
                return {x:origin.x+length*Math.cos(angle),y:origin.y+length*Math.sin(angle),
                  targetX,targetY,impactX:impact.left+impact.width/2,impactY:impact.top+impact.height/2,
                  originX:origin.x,originY:origin.y,mouthX,mouthY,
                  delay:ray.querySelector('.defect-evoke__beam').getAnimations()[0].effect.getTiming().delay}
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
    if (process.argv.includes('--hero=hermit')) {
      // Real impact events, rather than wall-clock sleeps, must drive HP and numbers.
      for (const lethal of [false, true]) {
        // A cold replay may decode after the event's wall-clock deadline starts.
        // Exercise visible HP/numbers against that delay, using real CSS impacts.
        await page.evaluate(lethal => {
          if (!lethal) {
            window.originalImageDecode = HTMLImageElement.prototype.decode
            HTMLImageElement.prototype.decode = async function () {
              await window.originalImageDecode.call(this)
              if (this.closest('.character-attack__pose--rig[data-attack-asset*="hero-hermit-attack"]')) {
                await new Promise(resolve => setTimeout(resolve, 1200))
              }
            }
          }
          const f = window.fixture
          f.install('hermit', 'jaw_worm', false, lethal ? 1 : 3, lethal ? 3 : 999)
        }, lethal)
        await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= 3)
        await page.waitForFunction(lethal => document.querySelectorAll('.enemy').length === (lethal ? 1 : 3) &&
          Number(document.querySelector('.enemy .bar__label').textContent.split('/')[0]) === (lethal ? 3 : 999), lethal)
        // Install can replace the previous fixture's board during React's commit.
        // Observe real bubbling impacts on the stable document after it has rendered.
        await page.evaluate(() => {
          window.hermitImpactSamples = []
          if (window.hermitDamageListener) document.removeEventListener('hermit-impact', window.hermitDamageListener)
          window.hermitDamageListener = event => {
            const card = event.target.closest('.enemy')
            queueMicrotask(() => window.hermitImpactSamples.push({
              seq: event.detail.seq, target: card.dataset.enemyId, hp: Number(card.querySelector('.bar__label').textContent.split('/')[0]),
              dead: card.classList.contains('enemy--dead'),
            }))
          }
          document.addEventListener('hermit-impact', window.hermitDamageListener)
          window.hermitDamageNumbers = []
          window.hermitDamageObserver?.disconnect()
          window.hermitDamageObserver = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (node instanceof HTMLElement && node.matches('.hermit-damage-number')) {
                window.hermitDamageNumbers.push({ target: record.target.closest('.enemy').dataset.enemyId,
                  amount: Number(node.dataset.damage) })
              }
            }
          })
          window.hermitDamageObserver.observe(document.querySelector('.board'), { childList: true, subtree: true })
        })
        await page.evaluate(lethal => {
          const f = window.fixture
          f.state.enemies.forEach((enemy, index) => { enemy.hp -= [3, 7, 0][index]; enemy.dead = enemy.hp === 0 })
          f.attack('hermit_strike')
        }, lethal)
        await page.locator('.hermit-shot').last().waitFor({ state: 'attached' })
        assert.equal(await page.locator('.enemy .hit-vfx').count(), 0, `Hermit still shows the old lump damage burst (${screen}, lethal=${lethal}): ${JSON.stringify(await page.locator('.enemy .hit-vfx').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, html: n.outerHTML }))))}`)
        await page.waitForFunction(count => window.hermitImpactSamples.length >= count &&
          window.hermitDamageNumbers.length >= (count === 5 ? 5 : 10), lethal ? 5 : 15).catch(async error => {
          const diagnostic = JSON.stringify(await page.evaluate(() => ({ impacts: window.hermitImpactSamples,
            numbers: window.hermitDamageNumbers, events: window.fixture.state.presentationEvents,
            hp: [...document.querySelectorAll('.enemy .bar__label')].map(node => node.textContent) })))
          throw new Error(`${error.message}: ${diagnostic}`, { cause: error })
        })
        const result = await page.locator('.enemy').evaluateAll(cards => cards.map(card => ({
          id: card.dataset.enemyId, hp: Number(card.querySelector('.bar__label').textContent.split('/')[0]),
          dead: card.classList.contains('enemy--dead'),
          // Numbers fade independently; collect their real insertions rather than
          // requiring the first volley's number to survive a final protocol round trip.
          numbers: window.hermitDamageNumbers.filter(number => number.target === card.dataset.enemyId)
            .map(number => number.amount),
        })))
        for (const [index, target] of result.entries()) {
          const total = [3, 7, 0][index]
          assert.equal(target.hp, (lethal ? 3 : 999) - total, 'final displayed HP differs from authoritative HP')
          assert.equal(target.numbers.length, total ? 5 : 0, 'expected one damage number per damaging volley impact')
          assert(target.numbers.every(amount => Math.abs(amount - total / 5) < 1e-8), 'damage was not divided equally over impacts')
        }
        const samples = await page.evaluate(() => window.hermitImpactSamples)
        for (const [index, target] of result.entries()) {
          const targetSamples = samples.filter(sample => sample.target === target.id)
          assert.equal(targetSamples.length, 5, 'expected exactly five impact events per target')
          targetSamples.forEach((sample, volley) => {
            const expected = (lethal ? 3 : 999) - [3, 7, 0][index] * (volley + 1) / 5
            assert(Math.abs(sample.hp - expected) < 1e-8, `volley ${volley + 1} HP did not match its damage share`)
            if (lethal && volley < 4) assert(!sample.dead, 'target died before the final volley')
          })
        }
        if (lethal) assert(result[0].dead, 'lethal target did not fall after the final impact')
        await page.locator('.board').screenshot({ path: resolve(output, `${screen}-hermit-damage-${lethal ? 'lethal' : 'aoe'}.png`) })
        if (!lethal) await page.evaluate(() => { HTMLImageElement.prototype.decode = window.originalImageDecode })
      }
    }
    if (process.argv.includes('--hero=hermit')) {
      for (const count of [1, 3]) {
        await page.evaluate(count => window.fixture.install('hermit', 'jaw_worm', false, count), count)
        await page.waitForFunction(()=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=3)
        const seq = await page.evaluate(()=>window.fixture.attack('hermit_strike'))
        const shots = page.locator(`[data-hermit-seq="${seq}"] .hermit-shot`)
        await shots.last().waitFor({state:'attached'})
        assert.equal(await shots.count(), count * 10, 'each flash must fire at every authoritative target')
        assert.equal(await page.locator(`[data-hermit-impact-seq="${seq}"]`).count(), count * 5, 'each target must receive one impact per two-barrel volley')
        assert.equal(await page.locator(`.combat-vfx--target[data-vfx-seq="${seq}"]`).count(), 0, 'old impact still renders')
        await page.waitForTimeout(680)
        const geometry = await shots.evaluateAll(nodes => nodes.map(node => {
          const origin = node.getBoundingClientRect()
          const [volley, gun] = node.dataset.shot.split('-').map(Number)
          const muzzle = [[[328,218],[272,253]],[[337,218],[275,246]],[[295,218],[226,246]],[[303,218],[226,244]],[[313,218],[243,244]]][volley][gun]
          const source = node.closest('[data-hermit-seq]').parentElement.querySelector(':scope > img')
          const sourceRect = source.getBoundingClientRect()
          const sourceFit = Math.min(sourceRect.width/source.naturalWidth, sourceRect.height/source.naturalHeight)
          const sourceScale = source.naturalWidth / 400
          const muzzleX = sourceRect.left + (sourceRect.width-source.naturalWidth*sourceFit)/2 + muzzle[0]*sourceScale*sourceFit
          const muzzleY = sourceRect.bottom - (source.naturalHeight-muzzle[1]*sourceScale)*sourceFit
          const dx = parseFloat(node.style.getPropertyValue('--shot-dx'))
          const dy = parseFloat(node.style.getPropertyValue('--shot-dy'))
          const targetId = node.dataset.shot.split('-').slice(2).join('-')
          const target = document.querySelector(`.enemy[data-enemy-id="${targetId}"] .enemy__portrait > img`)
          const rect = target.getBoundingClientRect()
          const fit = Math.min(rect.width / target.naturalWidth, rect.height / target.naturalHeight)
          const flight = node.querySelector('.hermit-shot__flight').getAnimations()[0]
          const impact = document.querySelector(`[data-hermit-impact-seq="${node.closest('[data-hermit-seq]').dataset.hermitSeq}"][data-volley="${node.dataset.volley}"]`).getAnimations()[0]
          impact.pause(); impact.currentTime = impact.effect.getTiming().delay + 80
          const impactRect = impact.effect.target.getBoundingClientRect()
          flight.pause(); flight.currentTime = 0
          const before = getComputedStyle(flight.effect.target).opacity
          flight.currentTime = flight.effect.getTiming().delay + 90
          return { x: origin.x + dx, y: origin.y + dy, originX: origin.x, originY: origin.y, muzzleX, muzzleY,
            targetX: rect.left + (rect.width - target.naturalWidth * fit) / 2 + 170.3 * (target.naturalWidth / 400) * fit,
            targetY: rect.bottom - (target.naturalHeight - 181 * (target.naturalWidth / 400)) * fit,
            before, during: getComputedStyle(flight.effect.target).opacity,
            delay: flight.effect.getTiming().delay, duration: flight.effect.getTiming().duration,
            impactDelay: impact.effect.getTiming().delay,
            impactX: impactRect.left + impactRect.width / 2, impactY: impactRect.top + impactRect.height / 2,
            impactOnTarget: impact.effect.target.parentElement === target.parentElement,
            impactAboveArt: Number(getComputedStyle(impact.effect.target).zIndex) > Number(getComputedStyle(target).zIndex),
            trail: getComputedStyle(node.querySelector('.hermit-shot__bullet'), '::before').backgroundImage }
        }))
        assert.equal(geometry.length, count * 10, 'gunfire expired before geometry was sampled')
        for (const shot of geometry) {
          assert(Math.abs(shot.originX-shot.muzzleX)<1 && Math.abs(shot.originY-shot.muzzleY)<1, 'bullet detached from barrel')
          assert(Math.abs(shot.x-shot.targetX)<3 && Math.abs(shot.y-shot.targetY)<3, 'bullet misses torso')
          assert.equal(shot.before, '0', 'bullet visible before muzzle flash')
          assert.equal(shot.during, '1', 'bullet invisible in flight')
          assert([611,733,856,978,1100].includes(shot.delay), 'flash clock mismatch')
          assert(Math.abs(shot.impactDelay - shot.delay - shot.duration)<.01, 'impact precedes arrival')
          assert(shot.trail.includes('speed-trail.webp'), 'missing painted tracer')
          assert(shot.impactOnTarget && shot.impactAboveArt, 'impact is behind target artwork')
          assert(Math.abs(shot.impactX-shot.targetX)<3 && Math.abs(shot.impactY-shot.targetY)<3, `impact misses torso: ${JSON.stringify(shot)}`)
        }
        await page.locator('.board').screenshot({path:resolve(output,`${screen}-hermit-bullets-${count}.png`)})
        await page.evaluate(()=>{window.fixture.restoration++;window.fixture.render()})
        await page.waitForTimeout(100)
        assert.equal(await page.locator('.hermit-shots').count(),0,'reconnect replayed gunfire')
        await page.evaluate(()=>{document.documentElement.dataset.reducedMotion='true';window.fixture.attack('hermit_strike')})
        await page.waitForTimeout(100)
        assert.equal(await page.locator('.hermit-shots').count(),0,'reduced motion renders gunfire')
        await page.evaluate(()=>{document.documentElement.dataset.reducedMotion='false';window.fixture.render()})
      }
    }
    if (process.argv.includes('--hero=hermit')) {
      for (const interruptMs of [100, 850]) {
        await page.evaluate(() => {
          const f = window.fixture
          f.install('hermit', 'jaw_worm', false)
          window.hermitNumberTotal = 0
          window.hermitNumberObserver?.disconnect()
          window.hermitNumberObserver = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (node instanceof HTMLElement && node.matches('.hermit-damage-number')) window.hermitNumberTotal += Number(node.dataset.damage)
            }
          })
          window.hermitNumberObserver.observe(document.querySelector('.board'), { childList: true, subtree: true })
        })
        await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= 3)
        await page.evaluate(() => { const f=window.fixture; f.state.enemies[0].hp -= 3; f.attack('hermit_strike') })
        await page.locator('.hermit-shot').last().waitFor({ state: 'attached' })
        await page.waitForTimeout(interruptMs)
        await page.evaluate(() => { const f=window.fixture; f.state.enemies[0].hp -= 7; f.attack('hermit_strike') })
        await page.waitForFunction(() => document.querySelector('.enemy .bar__label')?.textContent.trim() === '989/999')
        const numberTotal = await page.evaluate(() => window.hermitNumberTotal)
        assert(Math.abs(numberTotal - 10) < 1e-8,
          `interrupted attack lost or duplicated displayed damage at ${interruptMs}ms: ${numberTotal}`)
      }
      // A single network update may include another character's damage as well.
      await page.evaluate(() => {
        const f = window.fixture
        f.install('hermit', 'jaw_worm', false)
        f.state.players.push({ ...structuredClone(f.state.players[0]), id: 'p2', name: 'Ironclad', character: 'ironclad', row: 1 })
        f.render()
      })
      await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= 5)
      await page.evaluate(() => {
        const f = window.fixture
        f.state.enemies[0].hp -= 10
        f.state.presentationEvents.push(
          { seq: ++f.seq, kind: 'card', actorId: 'p1', sourceId: 'hermit_strike', enemyIds: ['enemy-0'],
            enemyHpLoss: { 'enemy-0': 3 }, playerIds: [], upgraded: false, copied: false, energy: 1 },
          { seq: ++f.seq, kind: 'card', actorId: 'p2', sourceId: 'strike_ironclad', enemyIds: ['enemy-0'],
            enemyHpLoss: { 'enemy-0': 7 }, playerIds: [], upgraded: false, copied: false, energy: 1 },
        )
        f.render()
      })
      // Read the other character's short-lived number while it is on screen,
      // before waiting for Hermit's last volley.
      assert.equal(await page.locator('.enemy .hit-vfx strong').textContent(), '7', 'another character lost their damage number')
      await page.waitForFunction(() => document.querySelectorAll('.hermit-damage-number').length === 5)
      assert((await page.locator('.hermit-damage-number').evaluateAll(nodes => nodes.map(node => Number(node.dataset.damage))))
        .every(amount => Math.abs(amount - .6) < 1e-8), 'Hermit absorbed another character’s damage from a batched update')
      assert.equal((await page.locator('.enemy .bar__label').textContent()).trim(), '989/999')
      // A same-update heal can restore the exact original HP despite real card damage.
      await page.evaluate(() => {
        const f = window.fixture
        f.install('hermit', 'jaw_worm', false)
        f.state.enemies[0].hp = 3
        f.render()
        window.hermitImpactSamples = []
      })
      await page.waitForFunction(() => document.querySelector('.enemy .bar__label')?.textContent.trim() === '3/999')
      await page.evaluate(() => {
        const f = window.fixture
        f.state.enemies[0].hp = 3
        f.state.presentationEvents.push({ seq: ++f.seq, kind: 'card', actorId: 'p1', sourceId: 'hermit_strike',
          enemyIds: ['enemy-0'], enemyHpLoss: { 'enemy-0': 3 }, playerIds: [], upgraded: false, copied: false, energy: 1 })
        f.render()
      })
      await page.waitForFunction(() => window.hermitImpactSamples.length === 5)
      assert((await page.evaluate(() => window.hermitImpactSamples)).some(sample => sample.hp === 2.4),
        'same-update recovery erased the visible HP loss')
      assert.equal((await page.locator('.enemy .bar__label').textContent()).trim(), '3/999')
      assert((await page.locator('.hermit-damage-number').evaluateAll(nodes => nodes.map(node => Number(node.dataset.damage))))
        .every(amount => Math.abs(amount - .6) < 1e-8), 'revival lost actual damage attribution')
      for (const reset of ['restore', 'reduced']) {
        await page.evaluate(() => window.fixture.install('hermit', 'jaw_worm', false))
        await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= 3)
        await page.evaluate(() => { const f=window.fixture; f.state.enemies[0].hp -= 3; f.attack('hermit_strike') })
        await page.locator('.hermit-shot').last().waitFor({ state: 'attached' })
        await page.evaluate(reset => {
          if (reset === 'restore') window.fixture.restoration++
          else document.documentElement.dataset.reducedMotion = 'true'
          window.fixture.render()
        }, reset)
        await page.waitForFunction(() => document.querySelector('.enemy .bar__label')?.textContent.trim() === '996/999')
        await page.waitForTimeout(1400)
        assert.equal(await page.locator('.hermit-damage-number').count(), 0, `${reset} replayed bullet damage`)
        assert.equal((await page.locator('.enemy .bar__label').textContent()).trim(), '996/999', `${reset} changed authoritative HP`)
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false'; window.fixture.render() })
      }
    }
    if (process.argv.includes('--hero=hermit')) {
      await page.evaluate(()=>window.fixture.install('hermit','jaw_worm',false))
      await page.waitForFunction(()=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=3)
      for (const followup of ['hermit_strike', 'hermit_defend']) {
        const first = await page.evaluate(()=>{ window.hermitImpactSamples=[]; return window.fixture.attack('hermit_strike') })
        const oldShots = page.locator(`[data-hermit-seq="${first}"] .hermit-shot`)
        await oldShots.last().waitFor({state:'attached'})
        await page.waitForTimeout(650)
        const second = await page.evaluate(source=> {
          const f = window.fixture
          if (source !== 'hermit_defend') return f.attack(source)
          f.state.presentationEvents.push({seq:++f.seq,kind:'card',actorId:'p1',sourceId:source,
            enemyIds:[],playerIds:['p1'],upgraded:false,copied:false,energy:1})
          f.render(); return f.seq
        }, followup)
        assert.equal(await oldShots.count(), 10, 'a new card interrupted the committed ten-round burst')
        if (followup === 'hermit_defend') {
          await page.waitForTimeout(30)
          assert.equal(await page.locator('.seat').evaluate(e=>getComputedStyle(e).filter), 'none',
            'WebKit clips block VFX to the seat filter surface')
        }
        await page.waitForFunction(seq => window.hermitImpactSamples.filter(sample => sample.seq === seq).length === 5, first)
        if (followup === 'hermit_strike') await page.locator(`[data-hermit-seq="${second}"] .hermit-shot`).last().waitFor({state:'attached'})
        await page.locator('.board').screenshot({path:resolve(output,`${screen}-hermit-overlap-${followup}.png`)})
        await page.evaluate(()=>{window.fixture.restoration++;window.fixture.render()})
        await page.waitForTimeout(100)
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
        await page.waitForFunction(()=>Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady)>=1)
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
      await page.waitForFunction(()=>[...document.querySelectorAll('.enemy__art--cutout:not([data-inactive])')].every(i=>i.complete&&i.naturalWidth>0))
      assert.equal(await card.getAttribute('data-animation'),'idle',enemy.id)
      if (enemy.isBoss || eliteArt(enemy)) assert.equal(await card.locator('.enemy__art--cutout:not([data-inactive])').evaluate(i => i.naturalWidth), rigs[enemy.artId ?? enemy.id].size, `${enemy.id}: idle resolution`)
      const before=await card.locator('.enemy__art--cutout:not([data-inactive])').boundingBox()
      const silhouette=await card.locator('.enemy__art--cutout:not([data-inactive])').evaluate(image=>{
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
          const image=e.querySelector('.enemy__art--cutout:not([data-inactive])')
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
            viewport:[innerWidth,innerHeight],bossLane:!!e.closest('.board__bosses')}
        })
        assert(bands.intentTop>=bands.boardTop,`${screen}/${enemy.id}: intent clipped by board ${JSON.stringify(bands)}`)
        assert(bands.intentBottom<=(bands.effectTop??bands.artTop)+1,`${screen}/${enemy.id}: intent overlaps effect/art ${JSON.stringify(bands)}`)
        assert(!bands.effectBottom||bands.effectBottom<=bands.artTop+1,`${screen}/${enemy.id}: effect overlaps art ${JSON.stringify(bands)}`)
      }
      if(normalsOnly) {
        const art = card.locator('.enemy__art--cutout:not([data-inactive])')
        const first = await art.screenshot()
        await page.waitForTimeout(250)
        assert.notDeepEqual(first, await art.screenshot(), `${enemy.id}: idle texture frozen`)
      }
      await page.waitForTimeout(1000) // Allow encounter attack preloads before the synthetic end-turn.
      if(normalsOnly||eliteArt(enemy)||enemy.isBoss)await page.locator('.board').screenshot({path:resolve(output,`${screen}-${enemy.id}-idle.png`)})
      const attacks=await page.evaluate(()=>{const f=window.fixture;f.state.phase='enemy';f.render();return f.attacks})
      if(attacks){
        await page.waitForFunction(()=>document.querySelector('.enemy')?.classList.contains('enemy--acting'))
        assert((await card.locator('.enemy__art--cutout:not([data-inactive])').getAttribute('src')).startsWith('blob:'),`${enemy.id}: recording captured the unloaded idle fallback`)
        if (enemy.isBoss || eliteArt(enemy)) assert.equal(await card.locator('.enemy__art--cutout:not([data-inactive])').evaluate(i => i.naturalWidth), rigs[enemy.artId ?? enemy.id].size, `${enemy.id}: attack resolution`)
        if (bossProjectileImagePath(enemy.artId ?? enemy.id)) {
          // Reload through a fresh blob URL after the initial resize delivery.
          // Native load dispatch can run microtasks between ancestor listeners;
          // synthetic dispatchEvent would hide that ordering bug.
          const originError = await card.evaluate(async (card, { origin, scale }) => {
            const image = card.querySelector('.enemy__art--cutout:not([data-inactive])')
            await new Promise(requestAnimationFrame)
            const source = URL.createObjectURL(await (await fetch(image.src)).blob())
            const loaded = new Promise(resolve => image.addEventListener('load', resolve, { once: true }))
            image.style.marginLeft = '0px'
            image.src = source
            await loaded
            URL.revokeObjectURL(source)
            const r = image.getBoundingClientRect(), parent = card.getBoundingClientRect()
            const fit = Math.min(r.width / image.naturalWidth, r.height / image.naturalHeight)
            const expected = origin ? r.left + (r.width - image.naturalWidth * fit) / 2 + origin[0] * fit
              : r.left + r.width / 2 - image.naturalWidth * fit / scale * .16
            const projectile = card.querySelector('.boss-projectile')
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
            return Math.abs(parent.left + parseFloat(projectile.style.getPropertyValue('--boss-projectile-start-x')) * rem - expected)
          }, { origin: enemyProjectileOriginFor(enemy.artId ?? enemy.id), scale: enemyArtScaleFor(enemy.artId ?? enemy.id) })
          assert(originError < 1, `${enemy.id}: projectile was measured before loaded art alignment (${originError}px)`)
        }
        await page.waitForTimeout(760)
        const after=await card.locator('.enemy__art--cutout:not([data-inactive])').boundingBox()
        assert(Math.abs(before.width-after.width)<1&&Math.abs(before.height-after.height)<1,`${enemy.id}: attack scale changed`)
        if(enemyProjectileImpactPath(enemy.artId??enemy.id)) {
          const cultist = (enemy.artId ?? enemy.id) === 'cultist'
          const launch = 500
          const arrival = cultist ? launch + 500 : 730
          const effect = card.locator('.enemy-projectile-impact')
          assert.equal(await effect.count(),1,`${enemy.id}: missing targeted impact`)
          const timing = await effect.locator('img').evaluate(image=>{
            const anim=image.getAnimations()[0]
            const {delay,duration}=anim.effect.getTiming()
            return {delay,duration,loaded:image.complete&&image.naturalWidth>0}
          })
          assert.deepEqual(timing,{delay:arrival,duration:480,loaded:true},`${enemy.id}: impact clock or asset`)
          const flight = await card.locator('.boss-projectile').evaluate(e=>{
            const {delay,duration}=e.getAnimations()[0].effect.getTiming()
            return {delay,duration}
          })
          assert.deepEqual(flight,{delay:launch,duration:arrival-launch},`${enemy.id}: projectile arrival misses impact`)
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
              // Canonical Defect torso coordinates are measured on the original 400px canvas.
              const sourceScale = art.naturalWidth / 400
              return {x:impact.left+impact.width/2,y:impact.top+impact.height/2,
                bodyX:image.left+(image.width-art.naturalWidth*fit)/2+195.4*sourceScale*fit,
                bodyY:image.bottom-(art.naturalHeight-149.4*sourceScale)*fit}
            })
            assert(Math.abs(anchor.x-anchor.bodyX)<3&&Math.abs(anchor.y-anchor.bodyY)<3,`${enemy.id}: damage impact misses painted torso ${JSON.stringify(anchor)}`)
          }
        }
        if(!enemy.isBoss&&bossAttackMotionFor(enemy.artId??enemy.id)==='melee'){
          const dash=await card.evaluate(e=>parseFloat(e.style.getPropertyValue('--boss-dash-x')))
          assert(Number.isFinite(dash)&&dash<0,`${enemy.id}: melee has no measured target travel`)
          assert(after.x<before.x-20,`${enemy.id}: physical attack stayed in its origin lane`)
        }
        if(normalsOnly||eliteArt(enemy)||enemy.isBoss)await page.locator('.board').screenshot({path:resolve(output,`${screen}-${enemy.id}-attack.png`)})
        await page.waitForTimeout(1250)
        assert.equal(await card.getAttribute('data-animation'),'idle',`${enemy.id}: return`)
      }else assert.equal(await card.getAttribute('data-animation'),'idle',`${enemy.id}: nonattack intent`)
    }
    // Sample the rendered texture, with CSS travel disabled so it cannot hide a frozen rig.
    for (const [id,isBoss] of (elitesOnly ? [['gremlin_nob',false]] : normalsOnly ? ['looter','gremlin_wizard','byrd'].map(artId=>[Object.values(ENEMIES).find(e=>(e.artId??e.id)===artId).id,false]) : [['gremlin_nob',false],['guardian_attack',true],['downfall_demon',true]])
      .filter(([id]) => onlyEnemyIds.length === 0 || onlyEnemyIds.includes(id))) {
      await page.evaluate(([id,isBoss])=>window.fixture.install('defect',id,isBoss),[id,isBoss])
      await page.waitForTimeout(2400) // Longer than a decoded one-shot preload's entire timeline.
      let previousSrc
      for (let repeat=0;repeat<2;repeat++) {
        await page.evaluate(()=>{const f=window.fixture;f.state.phase='enemy';f.render()})
        await page.locator('.enemy--acting').waitFor()
        const art=page.locator('.enemy[data-animation="attack"] .enemy__art--cutout:not([data-inactive])')
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
          assert.equal(await grounded.evaluate(i => i.naturalWidth), rigs.downfall_demon.size, 'Demon landing resolution')
          assert.equal(await art.evaluate(i => i.naturalWidth), rigs.downfall_demon.size, 'Demon airborne resolution')
        }
        // Demon uses two static painted poses, already checked above; it has
        // no texture animation to sample before its pose switch recovers.
        if (id !== 'downfall_demon') {
          const frames=[]
          for(let sample=0;sample<3;sample++) {
            await page.waitForTimeout(100)
            frames.push(createHash('sha256').update(await art.screenshot()).digest('hex'))
          }
          assert(new Set(frames).size>1,`${screen}/${id}: attack ${repeat+1} texture is frozen`)
        }
        await page.waitForTimeout(1100)
        await page.evaluate(()=>{const f=window.fixture;f.state.phase='player';f.render()})
        await page.waitForFunction(()=>document.querySelector('.enemy')?.dataset.animation==='idle')
      }
    }
    if(normalsOnly) for(const [id,expected] of [['acid_slime',1],['gremlin_wizard',2]]
      .filter(([id]) => onlyEnemyIds.length === 0 || onlyEnemyIds.includes(id))) {
      await page.evaluate(id=>{
        const f=window.fixture;f.install('defect',id,false)
        f.state.players.push({...structuredClone(f.state.players[0]),id:'p2',name:'Second player',row:1,facingEnemyUid:undefined})
        f.render()
      },id)
      await page.waitForTimeout(1000)
      await page.evaluate(()=>{const f=window.fixture;f.state.phase='enemy';f.render()})
      await page.locator('.enemy--acting').waitFor()
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
