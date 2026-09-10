#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/character-size')
mkdirSync(output, { recursive: true })
const heroes = {
  ironclad: 'strike_ironclad', silent: 'predator', defect: 'strike_defect', watcher: 'strike_watcher',
  guardian: 'guardian_strike', 'guardian-defense': 'guardian_strike', hermit: 'hermit_strike',
  slime_boss: 'slime_boss_strike', hexaghost: 'strike_hexaghost',
}
const contexts = [
  ['desktop', { width: 1440, height: 900 }],
  ['horizontal-phone', { width: 844, height: 390 }],
]
const engines = [['chromium', chromium], ['webkit', webkit]]
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const errors = []

function assertScaled(base, scaled, factor, label) {
  assert.equal(base.length, scaled.length, `${label}: image count changed`)
  for (let index = 0; index < base.length; index++) {
    for (const axis of ['width', 'height']) {
      assert(Math.abs(scaled[index][axis] / base[index][axis] - factor) < 0.02,
        `${label}: ${axis} did not scale ${factor}x ${JSON.stringify({ base: base[index], scaled: scaled[index] })}`)
    }
  }
}

function assertRestored(base, restored, label) {
  assert.equal(base.length, restored.length, `${label}: restored image count changed`)
  for (let index = 0; index < base.length; index++) {
    for (const axis of ['width', 'height']) {
      assert(Math.abs(base[index][axis] - restored[index][axis]) < 0.6,
        `${label}: ${axis} did not restore ${JSON.stringify({ base: base[index], restored: restored[index] })}`)
    }
  }
}

async function measure(page, selector) {
  const values = await page.evaluate((selector) => {
    const combat = document.querySelector('.combat')
    for (const animation of combat?.getAnimations({ subtree: true }) ?? []) {
      animation.pause()
      animation.currentTime = 0
    }
    return [...document.querySelectorAll(selector)].map((image) => {
      const rect = image.getBoundingClientRect()
      return { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
    })
  }, selector)
  assert(values.length > 0, `missing measurable images: ${selector}`)
  assert(values.every(({ width, height }) => width > 0 && height > 0), `empty image bounds: ${selector}`)
  return values
}

async function setSize(page, value) {
  await page.locator('.combat').evaluate(async (combat, value) => {
    combat.style.setProperty('--stage-actor-width', `${10 * value}rem`)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, value)
}

async function waitForImage(page, selector) {
  await page.locator(selector).first().waitFor()
  await page.waitForFunction((selector) => {
    const image = document.querySelector(selector)
    return image?.complete && image.naturalWidth > 0
  }, selector)
}

async function waitForIdle(page) {
  await waitForImage(page, '.seat__portrait > img')
  await page.waitForFunction(() => !document.querySelector('.seat__portrait > img[data-guardian-transition]'))
}

async function checkTransition(page, mode, label) {
  const direction = mode === 'defense' ? 'to-defense' : 'to-attack'
  const selector = `.seat__portrait > img[data-guardian-transition="${direction}"]`
  await page.locator(selector).waitFor()
  await waitForImage(page, selector)
  await setSize(page, 1)
  const base = await measure(page, selector)
  await setSize(page, 1.25)
  assertScaled(base, await measure(page, selector), 1.25, `${label} transition`)
  await setSize(page, 1)
}

async function checkHero(page, character, sourceId, heat, screen, browserName) {
  const renderCharacter = character === 'guardian-defense' ? 'guardian' : character
  const idleSelector = '.seat__portrait > img'
  const attackSelector = `.character-attack--${renderCharacter}[data-attack-seq="`
  const readyCount = character === 'hexaghost' ? 7
    : character === 'guardian' || character === 'guardian-defense' || character === 'ironclad' || character === 'watcher' ? 2 : 1

  await page.evaluate(({ character, heat }) => {
    document.documentElement.dataset.reducedMotion = 'false'
    window.fixture.install(character, heat)
  }, { character, heat })
  await page.waitForTimeout(100)
  await waitForIdle(page)
  await setSize(page, 1)
  const idleBase = await measure(page, idleSelector)
  if (character === 'guardian' || character === 'guardian-defense') {
    const initialMode = character === 'guardian-defense' ? 'defense' : 'attack'
    const nextMode = initialMode === 'attack' ? 'defense' : 'attack'
    await page.evaluate((mode) => {
      window.fixture.state.players[0].guardianMode = mode
      window.fixture.render()
    }, nextMode)
    await checkTransition(page, nextMode, `${screen}/${character}`)
    await page.evaluate((mode) => {
      window.fixture.state.players[0].guardianMode = mode
      window.fixture.render()
    }, initialMode)
    await page.locator(`.seat__portrait > img[data-guardian-mode="${initialMode}"]`).waitFor()
    await page.waitForFunction(() => !document.querySelector('.seat__portrait > img[data-guardian-transition]'))
    await setSize(page, 1)
  }
  await setSize(page, 1.25)
  assertScaled(idleBase, await measure(page, idleSelector), 1.25, `${screen}/${character}/idle`)
  if (character === 'guardian') {
    await page.locator('.board').screenshot({ path: resolve(output, `${browserName}-${screen}-guardian-rest-1.25.png`) })
  }
  await setSize(page, 1)
  assertRestored(idleBase, await measure(page, idleSelector), `${screen}/${character}/idle`)
  if (character === 'guardian') {
    await page.locator('.board').screenshot({ path: resolve(output, `${browserName}-${screen}-guardian-rest-1.png`) })
  }

  // If the one-shot attack blob has not arrived yet, the fixture should show its idle fallback.
  if (!['ironclad', 'watcher'].includes(character)) {
    const eagerSeq = await page.evaluate((sourceId) => window.fixture.attack(sourceId), sourceId)
    const eagerAttack = `${attackSelector}${eagerSeq}"]`
    await page.locator(eagerAttack).waitFor()
    const fallback = page.locator(`${eagerAttack} .character-attack__pose--rig.is-fallback`)
    if (await fallback.count()) {
      assert.equal(await fallback.locator('img').getAttribute('src'), await page.locator(idleSelector).getAttribute('src'),
        `${screen}/${character}: attack fallback must use idle art`)
    }
    await page.evaluate(({ character, heat }) => window.fixture.install(character, heat), { character, heat })
    await waitForIdle(page)
    await setSize(page, 1)
  }

  await page.waitForFunction((readyCount) => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) >= readyCount, readyCount)
  const seq = await page.evaluate((sourceId) => window.fixture.attack(sourceId), sourceId)
  const attackRoot = `${attackSelector}${seq}"]`
  await page.locator(attackRoot).waitFor()
  const poseSelector = `${attackRoot} .character-attack__pose > img`
  await waitForImage(page, poseSelector)
  if (!['ironclad', 'watcher'].includes(character)) {
    assert.equal(await page.locator(`${attackRoot} .character-attack__pose--rig.is-fallback`).count(), 0,
      `${screen}/${character}: measured attack must use its decoded pose`)
  }
  await setSize(page, 1)
  const attackBase = await measure(page, poseSelector)
  await setSize(page, 1.25)
  assertScaled(attackBase, await measure(page, poseSelector), 1.25, `${screen}/${character}/attack`)
  if (character === 'guardian') {
    await page.locator('.board').screenshot({ path: resolve(output, `${browserName}-${screen}-guardian-attack-1.25.png`) })
  }
  await setSize(page, 1)
  assertRestored(attackBase, await measure(page, poseSelector), `${screen}/${character}/attack`)
  if (character === 'guardian') {
    await page.locator('.board').screenshot({ path: resolve(output, `${browserName}-${screen}-guardian-attack-1.png`) })
  }

  await page.evaluate(({ character, heat }) => {
    document.documentElement.dataset.reducedMotion = 'true'
    window.fixture.install(character, heat)
  }, { character, heat })
  await page.waitForTimeout(100)
  await page.waitForFunction(() => {
    const image = document.querySelector('.seat__portrait > img')
    return image?.complete && image.naturalWidth > 0 && !document.querySelector('.character-attack')
  })
  await setSize(page, 1)
  const reducedBase = await measure(page, idleSelector)
  await setSize(page, 1.25)
  assertScaled(reducedBase, await measure(page, idleSelector), 1.25, `${screen}/${character}/reduced-idle`)
  await setSize(page, 1)
  assertRestored(reducedBase, await measure(page, idleSelector), `${screen}/${character}/reduced-idle`)
}

try {
  for (const [browserName, engine] of engines) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of contexts) {
        const context = await browser.newContext({
          viewport,
          ...(screen === 'horizontal-phone' ? { isMobile: true, hasTouch: true } : {}),
        })
        try {
          const page = await context.newPage()
          page.on('pageerror', (error) => errors.push(`${browserName}/${screen}: ${error}`))
          page.on('response', (response) => {
            if (response.status() >= 400 && /\/assets\/combat\/(characters|rigged)\//.test(response.url())) {
              errors.push(`${response.status()} ${response.url()}`)
            }
          })
          await page.goto(`http://localhost:${server.httpServer.address().port}`)
          await page.evaluate(async () => {
            document.querySelector('#root').style.display = 'none'
            document.documentElement.dataset.mobilePerformance = String(matchMedia('(pointer: coarse)').matches || innerWidth < 900)
            document.documentElement.dataset.reducedMotion = 'false'
            const node = document.createElement('div')
            node.className = 'app-shell app-shell--combat sts-scope'
            node.style.gridTemplateRows = 'minmax(0, 1fr)'
            document.body.append(node)
            const [R, D, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }] = await Promise.all([
              import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
              import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
              import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
            ])
            const reactRoot = (D.createRoot ?? D.default.createRoot)(node)
            const fixture = window.fixture = { seq: 1000, restoration: 0, installId: 0 }
            fixture.render = () => reactRoot.render((R.createElement ?? R.default.createElement)(CombatScreen, {
              state: structuredClone(fixture.state), act: 1, viewerId: 'p1', autoAdvance: false,
              authoritativeRestoration: fixture.restoration, onAction: () => {},
            }))
            fixture.install = (character, heat = 0) => {
              const rng = createRng(47)
              const player = createPlayer(rng, 'p1', character, character === 'guardian-defense' ? 'guardian' : character, 0)
              player.hp = player.maxHp = 999
              player.hand = []; player.draw = []; player.relics = []
              player.heat = heat

              const enemy = { uid: 'enemy-0', defId: 'guardian_attack', row: 0, isBoss: true, hp: 999, maxHp: 999,
                block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false }
              fixture.state = createCombat(rng, [player], [enemy], `character-size-${++fixture.installId}`)
              if (character === 'guardian-defense') fixture.state.players[0].guardianMode = 'defense'
              fixture.state.players[0].facingEnemyUid = enemy.uid
              fixture.state.phase = 'player'
              fixture.state.presentationEvents = []
              fixture.restoration++
              fixture.render()
            }
            fixture.attack = (sourceId) => {
              const seq = ++fixture.seq
              fixture.state.presentationEvents = [{ seq, kind: 'card', actorId: 'p1', sourceId,
                enemyIds: ['enemy-0'], playerIds: [], upgraded: false, copied: false, energy: 1 }]
              fixture.render()
              return seq
            }
            fixture.install('ironclad')
          })
          for (const [character, sourceId] of Object.entries(heroes)) {
            const heats = character === 'hexaghost' ? [0, 1, 2, 3, 4, 5, 6] : [0]
            for (const heat of heats) await checkHero(page, character, sourceId, heat, screen, browserName)
          }
          console.log(`PASS ${browserName}/${screen}: character size scaling`)
        } finally {
          await context.close()
        }
      }
    } finally {
      await browser.close()
    }
  }
  assert.deepEqual(errors, [])
  console.log('Character size browser check passed')
} finally {
  await server.close()
}
