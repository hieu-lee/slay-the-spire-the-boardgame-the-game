#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'


async function checkSlimeLayout(page) {
  const parties = await page.evaluate(() => {
    const paintedEdge = image => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let left = canvas.width
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < left; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 32) { left = x; break }
      }
      const box = image.getBoundingClientRect()
      const width = Math.min(box.width, box.height * canvas.width / canvas.height)
      return box.x + (box.width - width) / 2 + width * left / canvas.width
    }
    return [...document.querySelectorAll('.slime-party')].map(party => {
      const owner = party.closest('.seat__interactive')
      const actors = [...party.children].map(e => e.getBoundingClientRect())
      const board = party.closest('.board').getBoundingClientRect()
      const energy = document.querySelector('.pip--energy').getBoundingClientRect()
      const enemies = [...document.querySelectorAll('.enemy:not(.enemy--dead) .enemy__portrait')].map(enemy => enemy.getBoundingClientRect())
      return { enemyOverlap: actors.some(r => enemies.some(enemy => r.left < enemy.right && r.right > enemy.left && r.top < enemy.bottom && r.bottom > enemy.top)),
        energy: energy.toJSON(), first: actors[0].toJSON(), energyOverlap: actors.some(r=>r.left<energy.right&&r.right>energy.left&&r.top<energy.bottom&&r.bottom>energy.top), left: actors[0].left, right: actors.at(-1).right, delta: paintedEdge(party.querySelector('img')) - owner.querySelector('.bar').getBoundingClientRect().left,
        gaps: actors.slice(1).map((r,i) => r.left - actors[i].right),
        top: actors[0].top, bottom: actors[0].bottom, boardBottom: board.bottom,
        hpBottom: owner.querySelector('.bar').getBoundingClientRect().bottom }
    })
  })
  const ordered = parties.toSorted((a,b)=>a.left-b.left)
  for (let i=1;i<ordered.length;i++) assert(ordered[i].left >= ordered[i-1].right, 'neighboring slime parties overlap')
  for (const party of parties) {
    assert(Math.abs(party.delta) < 3, `HP bar left alignment: ${JSON.stringify(party)}`)
    assert(party.gaps.every(gap => gap > 0 && Math.abs(gap - party.gaps[0]) < .1), 'slimes must run left to right with constant spacing')
    assert(!party.energyOverlap, `slimes overlap the energy orb: ${JSON.stringify(party)}`)
    assert(!party.enemyOverlap, `idle slimes overlap a live enemy: ${JSON.stringify(party)}`)
    assert(party.top >= party.hpBottom, 'foreground slimes overlap owner HP')
    assert(party.bottom <= party.boardBottom, 'foreground slimes clipped by stage')
  }
}

const root = resolve(import.meta.dirname, '..')
const engine = process.argv.includes('--webkit') ? webkit : chromium
const output = resolve(root, 'artifacts/slime-animation-browser', process.argv.includes('--webkit') ? 'webkit' : 'chromium')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await engine.launch({ headless: true })
const errors = []
try {
  for (const [name, viewport, reducedMotion = 'no-preference'] of [['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
    ['small-horizontal-phone', { width: 568, height: 320 }],
    ['horizontal-phone-os-reduced', { width: 844, height: 390 }, 'reduce']]) {
    const page = await browser.newPage({ viewport, reducedMotion, recordVideo: { dir: output, size: viewport } })
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(() => {
      document.querySelector('#root').style.display = 'none'
      document.documentElement.dataset.mobilePerformance = String(innerWidth < 900)
      document.documentElement.dataset.reducedMotion = 'false'
      const container = document.createElement('div')
      container.id = 'test'
      container.className = 'app-shell app-shell--combat sts-scope'
      document.body.append(container)
    })
    await page.evaluate(async () => {
      const [React, ReactDomClient, { CombatScreen }, { createPlayer },
        { createCombat }, { createRng }, { bruiserSlime }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
        import('/src/game/downfall/slime-boss.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      const createElement = React.createElement ?? React.default.createElement
      const createRoot = ReactDomClient.createRoot ?? ReactDomClient.default.createRoot
      const rng = createRng(47)
      const player = createPlayer(rng, 'p1', 'Slime Boss', 'slime_boss', 0)
      player.slimes = [bruiserSlime('x'), bruiserSlime('y')]
      player.hand = []; player.draw = []; player.relics = []
      const state = createCombat(rng, [player], [{
        uid: 'boss', defId: 'guardian_attack', row: 0, isBoss: true,
        hp: 100, maxHp: 100, block: 0, strength: 0, vulnerable: 0, weak: 0,
        poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
      }])
      state.phase = 'player'; state.presentationEvents = []
      const reactRoot = createRoot(document.querySelector('#test'))
      window.fixture = { state, restoration: 0, connected: true, actions: [], events: [] }
      const f = window.fixture
      f.render = () => reactRoot.render(createElement(CombatScreen, {
        state: structuredClone(f.state), act: 1, viewerId: 'p1', autoAdvance: true,
        authoritativeRestoration: f.restoration, authoritativeConnected: f.connected,
        onAction: (action) => { f.actions.push(action) },
      }))
      f.summon = count => {
        f.state.players[0].slimes = Array.from({ length: count }, (_, i) => bruiserSlime(i === 0 ? 'x' : i === 1 ? 'y' : `extra-${i}`))
        f.render()
      }
      f.command = (seq, slimeUid = 'x', animationIndex = 0) => ({
        kind: 'slime', seq, actorId: 'p1', sourceId: 'slime_boss_bruiser_slime',
        slimeUid, upgraded: false, animationIndex, enemyIds: ['boss'], playerIds: [],
      })
      for (const type of ['animationstart', 'animationend']) document.addEventListener(type, (event) => {
        if (event.animationName === 'slime-party-command') f.events.push({
          type, seq: Number(event.target.querySelector('[data-command-seq]')?.dataset.commandSeq),
          transform: getComputedStyle(event.target).transform,
        })
      }, true)
      f.render()
    })
    const x = page.locator('[data-slime-uid="x"]')
    await x.waitFor()
    await page.waitForFunction(()=>[...document.querySelectorAll('.slime-party__art')].every(i=>i.complete&&i.naturalWidth>0))
    let firstSize
    for (const count of [1, 2, 3, 5, 8, 10, 4, 2]) {
      await page.evaluate(count => window.fixture.summon(count), count)
      await page.waitForFunction(count => document.querySelectorAll('.slime-party__art').length === count &&
        [...document.querySelectorAll('.slime-party__art')].every(i => i.complete && i.naturalWidth), count)
      const sizes = await page.locator('.slime-party__art').evaluateAll(images => images.map(i => {
        const r = i.getBoundingClientRect(); return { width: r.width, height: r.height }
      }))
      firstSize ??= sizes[0]
      for (const size of sizes) for (const dimension of ['width', 'height']) assert(Math.abs(size[dimension] - firstSize[dimension]) < .1,
        `${name}: ${count} summoned slimes changed ${dimension} from ${firstSize[dimension]} to ${size[dimension]}`)
      await checkSlimeLayout(page)
      if (count === 8) await page.screenshot({path:resolve(output,`${name}-eight-slimes.png`)})
    }
    await checkSlimeLayout(page)
    await page.screenshot({path:resolve(output,`${name}-slime-idle.png`)})
    const idleBox=await x.locator('.slime-party__art').boundingBox()

    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'enemy'
      f.state.presentationEvents = [f.command(1), f.command(2, 'x', 1)]
      f.render()
    })
    await page.locator('[data-command-seq="1"]').waitFor()
    // Pause the actual CSS animation longer than its nominal duration. The
    // queue and enemy barrier must follow completion, not elapsed wall time.
    await x.evaluate((node) => {
      const animation = node.getAnimations().find((item) => item.animationName === 'slime-party-command')
      animation.pause(); animation.currentTime = 600
    })
    const art=await x.locator('.slime-party__command').getAttribute('src')
    assert.equal(art,await x.locator('.slime-party__art').getAttribute('src'),'command must keep the canonical body')
    const geometry=await x.evaluate(node=>{
      const command=node.querySelector('.slime-party__command'),idle=node.querySelector('.slime-party__art')
      return [idle,command].map(i=>({width:i.clientWidth,height:i.clientHeight}))
    })
    assert.deepEqual(geometry[0],geometry[1],'command image changed physical size')
    const scales=await x.evaluate(node=>{
      const animation=node.getAnimations().find(a=>a.animationName==='slime-party-command')
      const saved=animation.currentTime
      const result=[0,136,391,600,850,1100,1360,1700].map(t=>{
        animation.currentTime=t
        const m=new DOMMatrix(getComputedStyle(node).transform)
        return [m.a,m.d]
      })
      animation.currentTime=saved
      return result
    })
    assert(scales.every(([x,y])=>x===1&&y===1),'command grew or squashed the whole actor')
    const path = await x.getAttribute('style')
    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents.push(f.command(3, 'y'))
      f.render()
    })
    await page.locator('[data-command-seq="3"]').waitFor()
    assert.equal(await x.getAttribute('style'), path, 'another slime must not change an in-flight path')
    await page.waitForTimeout(2000)
    assert.equal(await page.locator('[data-command-seq="1"]').count(), 1, 'first command must finish before second starts')
    assert.equal(await page.locator('[data-command-seq="2"]').count(), 0, 'second command must remain queued')
    assert.equal(await page.locator('.enemy[data-animation="attack"]').count(), 0, 'boss must wait for queued slimes')
    assert.equal(await page.evaluate(() => window.fixture.actions.length), 0, 'enemy resolution must wait too')
    await page.screenshot({ path: resolve(output, `${name}-slime-contact.png`) })
    await x.evaluate((node) => node.getAnimations().find((item) => item.animationName === 'slime-party-command').finish())
    await page.locator('[data-command-seq="2"]').waitFor()
    assert.equal(await page.locator('.enemy[data-animation="attack"]').count(), 0, 'boss must wait for second return')
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    const returned=await x.locator('.slime-party__art').boundingBox()
    for(const key of ['x','y','width','height'])assert(Math.abs(returned[key]-idleBox[key])<.6,`slime return changed ${key}`)
    await page.locator('.enemy[data-animation="attack"]').waitFor()
    await page.screenshot({ path: resolve(output, `${name}-boss-after-slimes.png`) })
    const events = await page.evaluate(() => window.fixture.events)
    assert(events.findIndex((event) => event.seq === 1 && event.type === 'animationend') <
      events.findIndex((event) => event.seq === 2 && event.type === 'animationstart'), 'second starts only after first returns')
    assert.equal(events.find((event) => event.seq === 2 && event.type === 'animationend')?.transform,
      'matrix(1, 0, 0, 1, 0, 0)', 'slime must return to its home position')
    await page.waitForFunction(() => window.fixture.actions.some((action) => action.kind === 'resolveEnemies'))

    // Reconnect establishes a baseline and drops both active and queued history.
    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'player'; f.state.presentationEvents.push(f.command(4), f.command(5))
      f.render()
    })
    await page.locator('[data-command-seq="4"]').waitFor()
    await page.evaluate(() => { window.fixture.restoration++; window.fixture.render() })
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    await page.waitForTimeout(1800)
    assert.equal(await page.locator('[data-command-seq="5"]').count(), 0, 'restored queue must not replay')

    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents.push(f.command(6), f.command(7))
      f.render()
    })
    await page.locator('[data-command-seq="6"]').waitFor()
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'enemy'; f.actions = []; f.render()
    })
    await page.waitForFunction(() => window.fixture.actions.some((action) => action.kind === 'resolveEnemies'))
    // Removing an actor cannot strand its queue; a killed boss cannot retaliate.
    await page.evaluate(() => {
      const f = window.fixture
      document.documentElement.dataset.reducedMotion = 'false'
      f.state.phase = 'player'; f.render()
    })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents.push(f.command(8), f.command(9))
      f.render()
    })
    await page.locator('[data-command-seq="8"]').waitFor()
    await page.evaluate(() => {
      const f = window.fixture
      f.state.players[0].slimes = []
      f.state.enemies[0].hp = 0; f.state.enemies[0].dead = true
      f.state.phase = 'enemy'; f.actions = []; f.render()
    })
    await page.waitForFunction(() => window.fixture.actions.some((action) => action.kind === 'resolveEnemies'))
    assert.equal(await page.locator('.enemy[data-animation="attack"]').count(), 0, 'dead boss cannot attack')
    // Foreground minions must also fit beside the HUD in a full co-op party.
    await page.evaluate(()=>{
      const f=window.fixture, base=f.state.players[0]
      f.state.phase='player';f.state.presentationEvents=[];f.restoration++
      f.state.players=Array.from({length:4},(_,i)=>({...structuredClone(base),id:`p${i+1}`,row:i,name:`Slime ${i+1}`,
        slimes:['massive','psychic','bruiser','royal','bruiser'].map((slug,j)=>({card:{uid:`party-${i}-${j}`,defId:`slime_boss_${slug}_slime`,upgraded:false},
          level:1,vigor:0,commandsThisTurn:0,vigorLossAtEndOfTurn:0}))}))
      f.render()
    })
    await page.waitForFunction(()=>document.querySelectorAll('.slime-party__art').length===20&&
      [...document.querySelectorAll('.slime-party__art')].every(i=>i.complete&&i.naturalWidth>0))
    await page.waitForTimeout(350)
    await checkSlimeLayout(page)
    await page.screenshot({path:resolve(output,`${name}-slime-party.png`)})
    assert(await page.locator('.seat--viewer').evaluate(seat => {
      const r = seat.getBoundingClientRect(), board = seat.closest('.board').getBoundingClientRect()
      return r.left >= board.left && r.right <= board.right
    }), 'growing co-op parties moved the viewer off screen')
    // Explicit inspection of another lane must survive a later party resize.
    await page.locator('.board').evaluate(board => {
      board.dispatchEvent(new WheelEvent('wheel', { deltaX: -500 }))
      board.scrollLeft = 0
    })
    await page.waitForTimeout(100)
    const fullPartySizes = await page.locator('.slime-party__actor').evaluateAll(actors => Object.fromEntries(actors.map(actor => {
      const r = actor.getBoundingClientRect(); return [actor.dataset.slimeUid, { width: r.width, height: r.height }]
    })))
    await page.evaluate(()=>{
      const f=window.fixture
      f.state.players.forEach(player=>player.slimes.shift())
      f.render()
    })
    await page.waitForFunction(()=>document.querySelectorAll('.slime-party__art').length===16&&
      [...document.querySelectorAll('.slime-party__art')].every(i=>i.complete&&i.naturalWidth>0))
    await checkSlimeLayout(page)
    assert.equal(await page.locator('.board').evaluate(board => board.scrollLeft), 0, 'party resize overrode manual board scrolling')
    for (const actor of await page.locator('.slime-party__actor').all()) {
      const uid = await actor.getAttribute('data-slime-uid'), size = await actor.boundingBox()
      for (const dimension of ['width', 'height']) assert(Math.abs(size[dimension] - fullPartySizes[uid][dimension]) < .1,
        `${name}: removing a co-op slime changed ${dimension}`)
    }
    await page.evaluate(()=>{
      const f=window.fixture
      f.state.presentationEvents=[{kind:'card',seq:999,actorId:'p1',sourceId:'slime_boss_bruiser_slime',
        enemyIds:[],playerIds:[],upgraded:false,copied:false,energy:1}]
      f.render()
    })
    await page.waitForFunction(()=>document.querySelector('.seat__portrait > img[data-static-art]')?.complete)
    await checkSlimeLayout(page)

    // Growing/removing a party during contact must keep the attack on its
    // target without restarting it. Newcomer contact feedback stays concurrent.
    await page.evaluate(() => {
      const f = window.fixture
      f.state.players.forEach(player => { player.slimes = player.slimes.slice(0, 2) })
      f.state.enemies[0].hp = 100; f.state.enemies[0].dead = false
      f.state.presentationEvents = []; f.restoration++; f.render()
    })
    await page.waitForFunction(() => document.querySelectorAll('.slime-party__art').length === 8)
    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents = [f.command(1000, 'party-0-2')]; f.render()
    })
    const attacker = page.locator('[data-slime-uid="party-0-2"]')
    await page.locator('[data-command-seq="1000"]').waitFor()
    await attacker.evaluate(node => {
      const animation = node.getAnimations().find(a => a.animationName === 'slime-party-command')
      animation.pause(); animation.currentTime = 600
    })
    const targetGeometry = () => attacker.evaluate(node => {
      const actor = node.getBoundingClientRect()
      const enemy = document.querySelector('.enemy__portrait').getBoundingClientRect()
      return { x: enemy.left - (actor.right - actor.width * .22), y: enemy.bottom - actor.bottom,
        time: node.getAnimations().find(a => a.animationName === 'slime-party-command').currentTime }
    })
    const beforeGrowth = await targetGeometry()
    await page.evaluate(() => {
      const f = window.fixture, player = f.state.players[0]
      for (let i = 0; i < 3; i++) {
        const slime = structuredClone(player.slimes[0]); slime.card.uid = `new-${i}`
        player.slimes.push(slime)
      }
      player.slimes.shift()
      f.state.enemies[0].hp = 80
      f.state.presentationEvents.push(f.command(1001, 'new-0')); f.render()
    })
    await page.waitForFunction(() => window.fixture.state.players[0].slimes.length === 4 &&
      !document.querySelector('[data-slime-uid="party-0-1"]'))
    await page.locator('[data-command-seq="1001"]').waitFor()
    const afterGrowth = await targetGeometry()
    assert.equal(afterGrowth.time, beforeGrowth.time, 'party changes restarted the active command')
    assert(Math.abs(afterGrowth.x) < 1 && Math.abs(afterGrowth.y) < 1,
      `party changes pulled the command off its target: ${JSON.stringify(afterGrowth)}`)
    const newcomer = page.locator('[data-slime-uid="new-0"]')
    await newcomer.evaluate(node => {
      const animation = node.getAnimations().find(a => a.animationName === 'slime-party-command')
      animation.pause(); animation.currentTime = 0
    })
    const newSize = await newcomer.boundingBox(), oldSize = await attacker.boundingBox()
    for (const dimension of ['width', 'height']) assert(Math.abs(newSize[dimension] - oldSize[dimension]) < .1,
      `a newcomer changed ${dimension} during an existing command`)
    assert(await page.locator('.enemy .bar').innerText().then(text => text.includes('100/100')),
      'newcomer damage appeared before its contact phase')
    await newcomer.evaluate(node => node.getAnimations().find(a => a.animationName === 'slime-party-command').play())
    await page.waitForFunction(() => document.querySelector('.enemy .bar').textContent.includes('80/100'))
    assert.equal(await page.locator('[data-command-seq="1001"]').count(), 1, 'newcomer damage must accompany its visible command')
    await page.screenshot({ path: resolve(output, `${name}-summoned-during-command.png`) })
    await attacker.evaluate(node => node.getAnimations().find(a => a.animationName === 'slime-party-command').finish())
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    await page.waitForFunction(() => document.querySelectorAll('.slime-party__art').length === 10 &&
      [...document.querySelectorAll('.slime-party__art')].every(i => i.complete && i.naturalWidth))
    await checkSlimeLayout(page)
    await page.screenshot({ path: resolve(output, `${name}-party-after-command-growth.png`) })
    await page.close()
    console.log(`${name}: constant summon size, co-op spacing, commands, reconnect and reduced motion passed`)
  }
  assert.deepEqual(errors, [], 'browser runtime errors')
} finally {
  await browser.close()
  await server.close()
}
