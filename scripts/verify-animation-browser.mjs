#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, devices, webkit } from 'playwright'
import { actionsForEnemy } from '../src/game/enemies.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, (process.argv.find((arg) => arg.startsWith('--out=')) ?? '--out=artifacts/animation-browser').slice(6))
const browserName = (process.argv.find((arg) => arg.startsWith('--browser=')) ?? '--browser=chromium').slice(10)
const browserType = browserName === 'webkit' ? webkit : chromium
mkdirSync(output, { recursive: true })

const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await browserType.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: browserName === 'webkit' ? 2 : 1,
})
await page.addInitScript(() => {
  window.__ANIMATION_SFX__ = []
  HTMLMediaElement.prototype.play = function play() {
    window.__ANIMATION_SFX__.push({
      path: new URL(this.src).pathname,
      cue: this.dataset.combatSfx ?? null,
      delayMs: Number(this.dataset.combatSfxDelay ?? 0),
    })
    return Promise.resolve()
  }
})
let releaseTimeEater
let phoneContext
const timeEaterAssetGate = new Promise((resolve) => { releaseTimeEater = resolve })
await page.route('**/time_eater-attack.webp', async (route) => {
  await timeEaterAssetGate
  await route.continue()
})
page.setDefaultTimeout(30_000)
const failures = []
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

function check(condition, message) {
  if (!condition) failures.push(message)
}

async function screenshot(name) {
  await page.locator('.board').screenshot({ path: join(output, `${name}.png`) })
}

async function setPhase(phase) {
  await page.evaluate((next) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = next
    debug.setRun(run)
  }, phase)
}

try {
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  check(await settings.getByText('Screen shake', { exact: true }).count() === 0,
    'the removed screen-shake setting is still visible')
  check(await settings.getByRole('button', { name: 'general' }).count() === 0 &&
    await settings.locator('nav').evaluate((nav) => getComputedStyle(nav).gridTemplateColumns.split(' ').length === 2),
  'settings left an empty General tab or grid column after removing screen shake')
  check(await page.evaluate(() => document.documentElement.dataset.screenShake === undefined),
    'the removed screen-shake runtime flag is still installed')
  await settings.getByRole('button', { name: /Back/ }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'boss-gallery'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    debug.setRun({
      ...run,
      phase: 'map',
      neow: null,
      players: run.players.map((player) => ({
        ...player,
        gold: 2,
        relics: player.relics.some((relic) => relic.defId === 'loaded_die')
          ? player.relics
          : [...player.relics, { defId: 'loaded_die', spent: false }],
      })),
    })
  })
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map' && !document.querySelector('.neow-screen'))
  await page.locator('.room--reachable').first().click()
  await page.locator('.combat').waitFor()
  if (await page.getByRole('button', { name: 'Resolve start of turn' }).count()) {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }

  const template = await page.evaluate(() => {
    const combat = window.__STS_DEBUG__.getRun().combat
    return { combat: structuredClone(combat), enemy: structuredClone(combat.enemies[0]) }
  })
  const bossIds = [
    'awakened_one_phase_1', 'awakened_one_phase_2', 'bronze_automaton', 'corrupt_heart',
    'deca', 'donu', 'guardian_attack', 'guardian_defensive', 'hexaghost', 'slime_boss',
    'the_champ', 'the_collector', 'time_eater',
  ]
  const meleeBossIds = new Set([
    'awakened_one_phase_1', 'awakened_one_phase_2', 'bronze_automaton', 'donu',
    'guardian_attack', 'guardian_defensive', 'slime_boss', 'the_champ', 'time_eater',
  ])

  for (const defId of bossIds) {
    const fixture = { ...template.enemy, uid: 'animation-boss', defId, isBoss: true, hp: 999, maxHp: 999, dead: false }
    let actionIndex = 0
    while (actionIndex < 8 && !actionsForEnemy({ ...fixture, actionIndex }, template.combat.die)
      .some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) actionIndex++
    check(actionIndex < 8, `${defId}: no attack action found`)
    await page.evaluate(({ base, enemy, actionIndex }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat = structuredClone(base)
      run.combat.enemies = [{ ...enemy, actionIndex }]
      run.combat.phase = 'player'
      for (const player of run.combat.players) Object.assign(player, { hp: 999, maxHp: 999, dead: false })
      debug.setRun(run)
    }, { base: template.combat, enemy: fixture, actionIndex })
    const card = page.locator(`.enemy--boss[data-enemy-def="${defId}"]`)
    await card.waitFor()
    await page.waitForFunction((id) =>
      document.querySelector(`.enemy--boss[data-enemy-def="${id}"]`)?.getAttribute('data-animation') === 'idle', defId)
    await screenshot(`boss-${defId}-idle`)
    await setPhase('enemy')
    await page.waitForFunction((id) =>
      document.querySelector(`.enemy--boss[data-enemy-def="${id}"]`)?.getAttribute('data-animation') === 'attack', defId)
    if (defId === 'time_eater') {
      const cold = await card.locator('.enemy__art--cutout').evaluate((art) => ({
        naturalHeight: art.naturalHeight,
        dash: getComputedStyle(art.closest('.enemy')).getPropertyValue('--boss-dash-x'),
      }))
      check(cold.naturalHeight === 0 && cold.dash === '', `time_eater: cold-load fixture was not cold ${JSON.stringify(cold)}`)
      releaseTimeEater()
      await page.waitForFunction(() => {
        const art = document.querySelector('.enemy--boss[data-enemy-def="time_eater"] .enemy__art--cutout')
        if (!art) return false
        const dash = Number.parseFloat(getComputedStyle(art.closest('.enemy')).getPropertyValue('--boss-dash-x'))
        return art.naturalHeight > 0 && Number.isFinite(dash)
      })
    }
    const attackStartedAt = Date.now()
    const waitUntilAttackTime = (time) => page.waitForTimeout(Math.max(0, time - (Date.now() - attackStartedAt)))
    await waitUntilAttackTime(220)
    const windupRect = await card.locator('.enemy__art--cutout').evaluate((art) => {
      const rect = art.getBoundingClientRect()
      const canvas = document.createElement('canvas')
      canvas.width = art.naturalWidth
      canvas.height = art.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(art, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let lowerBodyRight = -1
      for (let y = Math.round(canvas.height * 0.72); y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 16) lowerBodyRight = Math.max(lowerBodyRight, x + 1)
        }
      }
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: innerWidth, height: innerHeight, lowerBodyRight }
    })
    check(windupRect.left >= -1 && windupRect.right <= windupRect.width + 1 &&
      windupRect.top >= -1 && windupRect.bottom <= windupRect.height + 1,
    `${defId}: wind-up art leaves viewport ${JSON.stringify(windupRect)}`)
    await screenshot(`boss-${defId}-windup`)
    await waitUntilAttackTime(1005)
    await screenshot(`boss-${defId}-impact`)
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const name = animation.animationName ?? ''
        if (name.startsWith('boss-') || name.startsWith('awakened-')) {
          animation.currentTime = 1005
          animation.pause()
        }
      }
    })
    const audit = await card.evaluate((enemy) => {
      const art = enemy.querySelector('.enemy__art--cutout')
      const artStyle = getComputedStyle(art)
      const rect = art.getBoundingClientRect()
      const contactLeft = Number.parseFloat(getComputedStyle(enemy).getPropertyValue('--boss-contact-left'))
      const heroes = [...enemy.closest('.board').querySelectorAll('.seat__portrait > img')]
      const saved = heroes.map((hero) => hero.style.animation)
      heroes.forEach((hero) => { hero.style.animation = 'none' })
      const heroRight = Math.max(...heroes.map((hero) => hero.getBoundingClientRect().right))
      heroes.forEach((hero, index) => { hero.style.animation = saved[index] ?? '' })
      const effect = getComputedStyle(enemy, '::after')
      const canvas = document.createElement('canvas')
      canvas.width = art.naturalWidth
      canvas.height = art.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(art, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let lowerBodyRight = -1
      for (let y = Math.round(canvas.height * 0.72); y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 16) lowerBodyRight = Math.max(lowerBodyRight, x + 1)
        }
      }
      return {
        motion: enemy.getAttribute('data-attack-motion'),
        image: art.getAttribute('src'),
        loaded: art.complete && art.naturalWidth > 0,
        animation: artStyle.animationName,
        duration: artStyle.animationDuration,
        lowerBodyRight,
        rect: {
          left: rect.left, visibleLeft: rect.left + contactLeft / art.naturalHeight * rect.height,
          right: rect.right, top: rect.top, bottom: rect.bottom,
        },
        heroRight,
        viewport: { width: innerWidth, height: innerHeight },
        effect: {
          animation: effect.animationName,
          duration: effect.animationDuration,
          image: effect.backgroundImage,
          opacity: effect.opacity,
          right: effect.right,
          bottom: effect.bottom,
          width: effect.width,
          height: effect.height,
          transform: effect.transform,
          translate: effect.translate,
        },
        targets: [...enemy.closest('.board').querySelectorAll('.seat:not(.seat--dead) .seat__portrait')]
          .map((target) => {
            const style = getComputedStyle(target, '::before')
            return { animation: style.animationName, duration: style.animationDuration, image: style.backgroundImage }
          }),
      }
    })
    check(audit.loaded && audit.image.endsWith('-attack.webp'), `${defId}: attack art did not load`)
    check(audit.duration === '1.83s', `${defId}: body duration is ${audit.duration}`)
    check(audit.motion === (meleeBossIds.has(defId) ? 'melee' : 'ranged'),
      `${defId}: expected ${meleeBossIds.has(defId) ? 'melee' : 'ranged'} motion, got ${audit.motion}`)
    check(audit.rect.left >= -1 && audit.rect.right <= audit.viewport.width + 1 &&
      audit.rect.top >= -1 && audit.rect.bottom <= audit.viewport.height + 1,
    `${defId}: attack art leaves viewport ${JSON.stringify(audit.rect)}`)
    if (audit.motion === 'melee') {
      check(audit.animation === 'boss-melee-dash', `${defId}: missing melee dash`)
      check(Math.abs(audit.rect.visibleLeft - audit.heroRight) <= 2,
        `${defId}: visible edge ${audit.rect.visibleLeft} missed hero edge ${audit.heroRight}`)
    } else {
      check(audit.animation === 'boss-ranged-cast', `${defId}: missing ranged cast`)
    }
    if (defId === 'awakened_one_phase_1') {
      check(audit.targets.length > 0 && audit.targets.every((effect) =>
        effect.animation === 'awakened-claw-scratch' && effect.duration === '0.55s' &&
        effect.image.includes('awakened-claw-scratch.webp')), 'Awakened One phase 1 target scratches are missing')
    }
    if (defId === 'awakened_one_phase_2') {
      check(audit.effect.animation === 'awakened-blue-fire' && audit.effect.duration === '0.55s' &&
        audit.effect.image.includes('awakened-blue-fire.webp') && Number(audit.effect.opacity) > 0.5,
      `Awakened One phase 2 breath is missing: ${JSON.stringify(audit.effect)}`)
    }
    await waitUntilAttackTime(1500)
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const name = animation.animationName ?? ''
        if (name.startsWith('boss-') || name.startsWith('awakened-')) animation.currentTime = 1500
      }
    })
    check(await card.getAttribute('data-animation') === 'attack', `${defId}: attack art unlatched during recovery`)
    const recoveryLowerBodyRight = await card.locator('.enemy__art--cutout').evaluate((art) => {
      const canvas = document.createElement('canvas')
      canvas.width = art.naturalWidth
      canvas.height = art.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(art, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let right = -1
      for (let y = Math.round(canvas.height * 0.72); y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 16) right = Math.max(right, x + 1)
        }
      }
      return right
    })
    if (defId === 'deca') {
      const landmarks = [windupRect.lowerBodyRight, audit.lowerBodyRight, recoveryLowerBodyRight]
      check(Math.max(...landmarks) - Math.min(...landmarks) <= 4,
        `deca: ranged actor landmark moves between phases ${landmarks.join(', ')}`)
    }
    await screenshot(`boss-${defId}-recovery`)
    if (defId === bossIds[0]) {
      const moteHints = async () => card.locator('.enemy__portrait').evaluate((portrait) => {
        const style = getComputedStyle(portrait, '::before')
        return { animation: style.animationName, willChange: style.willChange }
      })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const reduced = await moteHints()
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const mobile = await page.evaluate(() => {
        document.documentElement.dataset.mobilePerformance = 'true'
        const portrait = document.querySelector('.enemy__portrait')
        const style = getComputedStyle(portrait, '::before')
        const result = { display: style.display, animation: style.animationName, willChange: style.willChange }
        document.documentElement.dataset.mobilePerformance = 'false'
        return result
      })
      check(reduced.animation === 'none' && reduced.willChange === 'auto' &&
        mobile.display !== 'none' && mobile.animation !== 'none',
      `phone lost PC enemy motes or desktop reduced motion stayed active ${JSON.stringify({ reduced, mobile })}`)
    }
  }

  const timingBoss = { ...template.enemy, uid: 'timing-boss', defId: 'awakened_one_phase_1', isBoss: true,
    hp: 999, maxHp: 999, dead: false }
  let timingActionIndex = 0
  while (timingActionIndex < 8 && !actionsForEnemy({ ...timingBoss, actionIndex: timingActionIndex }, template.combat.die)
    .some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) timingActionIndex++
  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.enemies = [{ ...enemy, actionIndex }]
    run.combat.phase = 'player'
    for (const player of run.combat.players) Object.assign(player, { hp: 999, maxHp: 999, block: 0, dead: false })
    debug.setRun(run)
  }, { base: template.combat, enemy: timingBoss, actionIndex: timingActionIndex })
  await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"][data-animation="idle"]').waitFor()
  const initialPartyHp = await page.evaluate(() =>
    window.__STS_DEBUG__.getRun().combat.players.reduce((sum, player) => sum + player.hp, 0))
  await setPhase('enemy')
  await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"][data-animation="attack"]').waitFor()
  await page.waitForTimeout(600)
  check(await page.evaluate(() =>
    window.__STS_DEBUG__.getRun().combat.players.reduce((sum, player) => sum + player.hp, 0)) === initialPartyHp,
  'boss damage resolved before the 730ms contact')
  await page.waitForTimeout(250)
  check(await page.evaluate(() =>
    window.__STS_DEBUG__.getRun().combat.players.reduce((sum, player) => sum + player.hp, 0)) < initialPartyHp,
  'boss damage did not resolve at the 730ms contact')

  const guardian = { ...template.enemy, uid: 'guardian-transform', defId: 'guardian_defensive', isBoss: true,
    actionIndex: 1, hp: 999, maxHp: 999, dead: false }
  await page.evaluate(({ base, enemy }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.enemies = [enemy]
    run.combat.phase = 'player'
    for (const player of run.combat.players) Object.assign(player, { hp: 999, maxHp: 999, block: 0, dead: false })
    debug.setRun(run)
  }, { base: template.combat, enemy: guardian })
  await page.locator('.enemy--boss[data-enemy-def="guardian_defensive"][data-animation="idle"]').waitFor()
  await setPhase('enemy')
  await page.locator('.enemy--boss[data-enemy-def="guardian_defensive"][data-animation="attack"]').waitFor()
  await page.waitForTimeout(800)
  const guardianTransform = await page.locator('.enemy--boss').evaluate((enemy) => ({
    defId: enemy.getAttribute('data-enemy-def'),
    animation: enemy.getAttribute('data-animation'),
    art: enemy.querySelector('.enemy__art--cutout')?.getAttribute('src'),
  }))
  check(guardianTransform.defId === 'guardian_attack' && guardianTransform.animation === 'attack' &&
    guardianTransform.art?.endsWith('/guardian_defensive-attack.webp'),
  `guardian: transform cut off the defensive attack latch ${JSON.stringify(guardianTransform)}`)

  const heroCases = [
    { character: 'ironclad', sourceId: 'strike_ironclad', duration: '1.8s', contact: 630, samples: [270, 900, 1500] },
    { character: 'defect', sourceId: 'strike_defect', duration: '1.65s', contact: 1110, samples: [270, 825, 1375] },
    { character: 'watcher', sourceId: 'strike_watcher', duration: '1.65s', contact: 1050, samples: [270, 825, 1375] },
    { character: 'silent', sourceId: 'predator', duration: '2.04s', contact: 1025, samples: [170, 1025, 2039] },
  ]
  for (const [heroIndex, hero] of heroCases.entries()) {
    const ids = await page.evaluate(({ base, enemy, character, sourceId, heroIndex }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat = structuredClone(base)
      run.combat.phase = 'player'
      const enemyIds = character === 'watcher'
        ? ['animation-target-1', 'animation-target-2', 'animation-target-3', 'animation-target-4']
        : character === 'silent'
        ? ['animation-target-1', 'animation-target-2', 'animation-target-3']
        : ['animation-target']
      run.combat.enemies = enemyIds.map((uid, row) => ({
        ...enemy, uid, row, defId: 'cultist', isBoss: false, hp: 999, maxHp: 999, dead: false,
      }))
      const actor = run.combat.players[0]
      Object.assign(actor, {
        character, name: character, hp: 999, maxHp: 999, dead: false,
        stance: character === 'watcher' ? 'wrath' : actor.stance,
      })
      const seq = 1_000_001 + heroIndex
      const attack = {
        seq, kind: 'card', actorId: actor.id, sourceId, enemyIds, playerIds: [],
        upgraded: false, copied: false, energy: 1,
      }
      run.combat.presentationEvents = character === 'silent'
        ? [attack, { ...attack, seq: seq + 1, enemyIds: [enemyIds[0]], copied: true }]
        : [attack]
      debug.setRun(run)
      return { actorId: actor.id, seq: character === 'silent' ? seq + 1 : seq, targetId: enemyIds[0] }
    }, { base: template.combat, enemy: template.enemy, heroIndex, ...hero })
    const seat = page.locator(`.seat[data-player-id="${ids.actorId}"]`)
    const currentAttack = seat.locator(`.character-attack--${hero.character}[data-attack-seq="${ids.seq}"]`)
    await currentAttack.waitFor()
    const body = seat.locator('.seat__portrait > img')
    check(await body.evaluate((image, duration) => getComputedStyle(image).animationDuration === duration, hero.duration),
      `${hero.character}: wrong body duration`)
    if (hero.character === 'silent') {
      const daggers = await seat.locator('.character-attack__dagger').evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element)
          const frames = element.getAnimations()[0]?.effect?.getKeyframes() ?? []
          return {
            animation: style.animationName,
            duration: Number.parseFloat(style.animationDuration) * 1000,
            delay: Number.parseFloat(style.animationDelay) * 1000,
            roundTrip: frames.length > 1 && frames[0].transform === frames.at(-1).transform,
          }
        }))
      check(daggers.length === 4 && daggers.every((dagger) =>
        dagger.animation === 'attack-dagger-round-trip' && dagger.duration === 1750 && dagger.roundTrip),
      `silent: daggers are not 1.75s round trips ${JSON.stringify(daggers)}`)
      const returnMs = Math.max(...daggers.map(({ delay, duration }) => delay + duration))
      const sampleSilentBody = async (time) => {
        await seat.evaluate((element, currentTime) => {
          for (const layer of [
            element.querySelector('.seat__portrait > img'),
            element.querySelector('.character-attack__pose--silent-throw'),
          ]) {
            const animation = layer.getAnimations()[0]
            if (animation) {
              animation.pause()
              animation.currentTime = currentTime
            }
          }
        }, time)
        await page.evaluate(() => new Promise(requestAnimationFrame))
        return seat.evaluate((element) => {
          const idle = element.querySelector('.seat__portrait > img')
          return {
            idle: Number(getComputedStyle(idle).opacity),
            pose: Number(getComputedStyle(element.querySelector('.character-attack__pose--silent-throw')).opacity),
          }
        })
      }
      const handoff = {
        beforeReturn: await sampleSilentBody(returnMs - 1),
        afterReturn: await sampleSilentBody(returnMs),
      }
      check(handoff.beforeReturn.pose > 0.99 && handoff.beforeReturn.idle === 0 &&
        handoff.afterReturn.pose === 0 && handoff.afterReturn.idle > 0.99,
      `silent: body did not hand off from throw pose after dagger return ${JSON.stringify(handoff)}`)
      await screenshot(`hero-silent-3-${returnMs}ms`)
    }
    if (hero.character === 'watcher') {
      const impact = currentAttack.locator('.character-attack__meteor-impact').first()
      const genericImpact = page.locator(
        `.enemy[data-enemy-id="${ids.targetId}"] .combat-vfx--attack-impact[data-vfx-seq="${ids.seq}"]`,
      )
      await genericImpact.waitFor()
      const genericTiming = await genericImpact.evaluate((element) => {
        const style = getComputedStyle(element)
        const firstFrame = element.getAnimations()[0]?.effect?.getKeyframes()[0]
        return { delay: style.animationDelay, firstOpacity: firstFrame?.opacity }
      })
      check(genericTiming.delay === '1.05s' && genericTiming.firstOpacity === '0',
        `watcher: generic impact begins before contact ${JSON.stringify(genericTiming)}`)
      const impactOpacityAt = (time) => impact.evaluate((element, currentTime) => {
        const animation = element.getAnimations()[0]
        if (animation) {
          animation.currentTime = currentTime
          animation.pause()
        }
        return Number(getComputedStyle(element).opacity)
      }, time)
      check(await impactOpacityAt(1_049) === 0, 'watcher: meteor impact is visible before ground contact')
      check(await impactOpacityAt(1050) >= 0.9, 'watcher: meteor impact is missing at ground contact')
    }
    for (const [index, time] of hero.samples.entries()) {
      await seat.evaluate((element, currentTime) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          const name = animation.animationName ?? ''
          if (animation.effect?.getTiming().iterations === 1 || name.startsWith('attack-') ||
            name.startsWith('watcher-') || name.endsWith('-pose') ||
            name === 'defect-core-charge') {
            animation.pause()
            animation.currentTime = currentTime
          }
        }
      }, time)
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const visibleBodies = await seat.evaluate((element) => {
        const idle = Number(getComputedStyle(element.querySelector('.seat__portrait > img')).opacity) > 0.01 ? 1 : 0
        const poses = [...element.querySelectorAll('.character-attack__pose')]
          .filter((pose) => Number(getComputedStyle(pose).opacity) > 0.01).length
        return idle + poses
      })
      check(visibleBodies === 1, `${hero.character}: ${visibleBodies} bodies visible at ${time}ms`)
      await screenshot(`hero-${hero.character}-${index}-${time}ms`)
    }
    await currentAttack.waitFor({ state: 'detached' })
    if (hero.character === 'silent') await seat.locator('.character-attack--silent').waitFor({ state: 'detached' })
    const cue = `card:${hero.character}:${hero.sourceId}:base`
    const sounds = await page.evaluate((expected) =>
      window.__ANIMATION_SFX__.filter((sound) => sound.cue === expected), cue)
    const impactPaths = new Set(['/assets/sfx/attack.ogg', '/assets/sfx/enemy-hit.ogg',
      '/assets/sfx/block.ogg', '/assets/sfx/weak.ogg'])
    check(sounds.some((sound) => impactPaths.has(sound.path) && sound.delayMs === hero.contact),
      `${hero.character}: impact SFX missed ${hero.contact}ms contact ${JSON.stringify(sounds)}`)
    check(sounds.some((sound) => sound.delayMs < hero.contact),
      `${hero.character}: attack has no launch/accent SFX before contact ${JSON.stringify(sounds)}`)
    if (hero.character === 'watcher' && browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page)
      let compositorLayers = []
      cdp.on('LayerTree.layerTreeDidChange', ({ layers }) => { compositorLayers = layers })
      await cdp.send('LayerTree.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
      })
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const stressSeq = await page.evaluate((seq) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        const actor = run.combat.players[0]
        const enemyIds = run.combat.enemies.map((enemy) => enemy.uid)
        run.combat.presentationEvents = [{
          seq, kind: 'card', actorId: actor.id, sourceId: 'strike_watcher', enemyIds,
          playerIds: [], upgraded: false, copied: false, energy: 1,
        }]
        debug.setRun(run)
        return seq
      }, ids.seq + 0.5)
      await seat.locator(`.character-attack--watcher[data-attack-seq="${stressSeq}"]`).waitFor()
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const documentNode = await cdp.send('DOM.getDocument')
      const compositorProbe = {}
      for (const [name, selector] of Object.entries({
        body: `.seat[data-player-id="${ids.actorId}"] .seat__portrait > img`,
        aura: `.seat[data-player-id="${ids.actorId}"] .stance-aura`,
        pose: `.seat[data-player-id="${ids.actorId}"] .character-attack__pose--watcher-cast`,
        meteor: `.seat[data-player-id="${ids.actorId}"] .character-attack__meteor`,
        impact: `.seat[data-player-id="${ids.actorId}"] .character-attack__meteor-impact`,
      })) {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector })
        const { node } = await cdp.send('DOM.describeNode', { nodeId })
        const layer = compositorLayers.find((candidate) => candidate.backendNodeId === node.backendNodeId)
        compositorProbe[name] = layer
          ? (await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId })).compositingReasons
          : []
      }
      check(Object.values(compositorProbe).every((reasons) => reasons.some((reason) => reason.includes('will-change'))),
        `watcher: animated layers were not promoted by Chrome ${JSON.stringify(compositorProbe)}`)
      await page.evaluate(() => {
        window.__WATCHER_FRAME_PROFILE__ = new Promise((resolve) => {
          const frameGaps = []
          const longTasks = []
          let startedAt
          let previous
          const observer = new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) longTasks.push(entry.duration)
          })
          observer.observe({ type: 'longtask' })
          const sample = (now) => {
            startedAt ??= now
            if (previous !== undefined) frameGaps.push(now - previous)
            previous = now
            if (now - startedAt < 1_650) requestAnimationFrame(sample)
            else {
              observer.disconnect()
              frameGaps.sort((a, b) => a - b)
              resolve({
                frames: frameGaps.length,
                maxGap: frameGaps.at(-1) ?? 0,
                p95Gap: frameGaps[Math.floor(frameGaps.length * 0.95)] ?? 0,
                longTasks,
              })
            }
          }
          requestAnimationFrame(sample)
        })
      })
      const frameProfile = await page.evaluate(() => window.__WATCHER_FRAME_PROFILE__)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      await cdp.send('LayerTree.disable')
      console.log(`Watcher frame profile: ${JSON.stringify(frameProfile)}`)
      await seat.locator(`.character-attack--watcher[data-attack-seq="${stressSeq}"]`).waitFor({ state: 'detached' })
    }
  }

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_030_000) + 1
    Object.assign(actor, { character: 'silent', hp: 999, maxHp: 999, dead: false })
    Object.assign(target, { hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'predator', enemyIds: [target.uid],
      playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForTimeout(1_100)
  const impactsBeforeLateToggle = await page.evaluate(() => window.__ANIMATION_SFX__.filter((sound) =>
    sound.path === '/assets/sfx/attack.ogg').length)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.waitForTimeout(50)
  check(await page.evaluate(() => window.__ANIMATION_SFX__.filter((sound) =>
    sound.path === '/assets/sfx/attack.ogg').length) === impactsBeforeLateToggle,
  'enabling reduced motion after contact replayed the impact SFX')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.waitForTimeout(50)

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_040_000) + 1
    Object.assign(actor, { character: 'silent', hp: 999, maxHp: 999, dead: false })
    Object.assign(target, { hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'predator', enemyIds: [target.uid],
      playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.cue === 'card:silent:predator:base'))
  check(!await page.evaluate(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 1_025)),
  'Silent impact SFX played before its normal-motion contact')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.waitForTimeout(50)
  check(await page.evaluate(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 0)),
  'enabling reduced motion did not move the pending impact SFX to immediate contact')
  await page.waitForTimeout(1_050)
  check(!await page.evaluate(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 1_025)),
  'enabling reduced motion left the old delayed impact SFX queued')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_050_000) + 1
    Object.assign(actor, { character: 'silent', hp: 999, maxHp: 999, dead: false })
    Object.assign(target, { hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'predator', enemyIds: [target.uid],
      playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.cue === 'card:silent:predator:base'))
  await page.waitForTimeout(50)
  const reducedMotionSounds = await page.evaluate(() => window.__ANIMATION_SFX__.filter((sound) =>
    sound.cue === 'card:silent:predator:base'))
  check(reducedMotionSounds.some((sound) => sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 0),
    `reduced motion delayed Silent impact SFX ${JSON.stringify(reducedMotionSounds)}`)
  check(await page.locator('.character-attack').count() === 0, 'reduced motion still rendered a character attack')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'won'
    window.__REDUCED_WIN_START__ = performance.now()
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'combat')
  const reducedOutcome = await page.evaluate(() => ({
    elapsed: performance.now() - window.__REDUCED_WIN_START__,
    victorySounds: window.__ANIMATION_SFX__.filter((sound) => sound.path === '/assets/sfx/victory.ogg').length,
  }))
  check(reducedOutcome.elapsed < 500 && reducedOutcome.victorySounds === 1,
    `OS reduced motion delayed the victory outcome ${JSON.stringify(reducedOutcome)}`)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches)

  await page.evaluate(({ base, enemy }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.phase = 'combat'
    run.combat = structuredClone(base)
    run.combat.phase = 'player'
    run.combat.enemies = [{ ...enemy, uid: 'targetless-enemy', hp: 0, dead: true }]
    run.combat.pendingSummons = [{
      sourceUid: 'targetless-enemy', row: 0, defIds: ['acid_slime'], turn: run.combat.turn,
      direct: true, timing: 'endOfTurn',
    }]
    Object.assign(run.combat.players[0], {
      character: 'watcher', stance: 'wrath', hp: 999, maxHp: 999,
      powers: [{ uid: 'targetless-omega', defId: 'omega', upgraded: false }],
    })
    debug.setRun(run)
  }, { base: template.combat, enemy: template.enemy })
  await page.locator('.end-turn-order > summary').click()
  const omegaOrder = page.locator('.end-turn-order li').filter({ hasText: 'Omega' })
  await omegaOrder.waitFor()
  const performanceModeHints = await page.evaluate(() => {
    const read = () => [
      document.querySelector('.seat__portrait > img'),
      document.querySelector('.enemy__portrait > .enemy__art--cutout'),
      document.querySelector('.stance-aura'),
    ].filter(Boolean).map((element) => getComputedStyle(element).willChange)
    document.documentElement.dataset.mobilePerformance = 'true'
    const mobile = read()
    document.documentElement.dataset.mobilePerformance = 'false'
    return { mobile }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  performanceModeHints.reduced = await page.evaluate(() => [
    document.querySelector('.seat__portrait > img'),
    document.querySelector('.enemy__portrait > .enemy__art--cutout'),
    document.querySelector('.stance-aura'),
  ].filter(Boolean).map((element) => getComputedStyle(element).willChange))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  check(performanceModeHints.mobile[0] === 'auto' &&
    performanceModeHints.reduced.every((hint) => hint === 'auto'),
  `idle phone or desktop reduced-motion layers stayed promoted ${JSON.stringify(performanceModeHints)}`)
  check(await omegaOrder.locator('select').count() === 0, 'targetless Omega rendered a broken target picker')
  await page.getByRole('button', { name: /^End turn/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'enemy')
  check(await page.locator('.combat-error').count() === 0, 'targetless Omega was rejected by the local end-turn UI')

  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.enemies = [{ ...enemy, actionIndex }]
    run.combat.phase = 'player'
    debug.setRun(run)
  }, { base: template.combat, enemy: timingBoss, actionIndex: timingActionIndex })
  await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"][data-animation="idle"]').waitFor()
  await setPhase('enemy')
  await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"][data-animation="attack"]').waitFor()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.combatId = `${run.combat.combatId}-restored`
    run.combat.phase = 'player'
    debug.setRun(run)
  })
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'idle',
  undefined, { timeout: 250 })

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_100_000) + 1
    run.phase = 'combat'
    run.combat.phase = 'won'
    Object.assign(target, { hp: 0, dead: true })
    Object.assign(actor, { character: 'watcher', hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'strike_watcher',
      enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.locator('.character-attack--watcher').waitFor()
  await page.waitForTimeout(1_200)
  const preImpactOutcome = await page.evaluate(() => ({
    runPhase: window.__STS_DEBUG__.getRun().phase,
    impactOpacity: Number(getComputedStyle(document.querySelector('.character-attack__meteor-impact')).opacity),
    victorySounds: window.__ANIMATION_SFX__.filter((sound) => sound.path === '/assets/sfx/victory.ogg').length,
  }))
  check(preImpactOutcome.runPhase === 'combat' && preImpactOutcome.impactOpacity > 0,
    `victory replaced the final meteor before impact ${JSON.stringify(preImpactOutcome)}`)
  check(preImpactOutcome.victorySounds === 0, 'victory SFX played over the falling meteor')
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'combat', undefined, { timeout: 4_000 })
  check(await page.evaluate(() =>
    window.__ANIMATION_SFX__.some((sound) => sound.path === '/assets/sfx/victory.ogg')),
  'victory SFX did not land with the post-animation outcome')

  phoneContext = await browser.newContext({
    ...devices['iPhone 13 landscape'],
    reducedMotion: 'reduce',
  })
  await phoneContext.addInitScript(() => {
    window.__ANIMATION_SFX__ = []
    HTMLMediaElement.prototype.play = function play() {
      window.__ANIMATION_SFX__.push({
        path: new URL(this.src).pathname,
        cue: this.dataset.combatSfx ?? null,
        delayMs: Number(this.dataset.combatSfxDelay ?? 0),
      })
      return Promise.resolve()
    }
  })
  const phone = await phoneContext.newPage()
  phone.setDefaultTimeout(30_000)
  await phone.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  check(await phone.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches &&
    document.documentElement.dataset.mobilePerformance === 'true'),
  'iPhone regression fixture did not reproduce OS Reduce Motion in mobile performance mode')
  check(await phone.locator('link[rel="preload"][as="image"][href*="/combat/characters/"]').count() === 7,
    'iPhone 13 did not preload all attack pose assets')
  await phone.getByRole('button', { name: 'Single Player', exact: true }).click()
  await phone.getByRole('button', { name: 'Embark' }).click()
  await phone.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await phone.evaluate(() => window.__STS_DEBUG__.reset(1, 'boss-gallery'))
  await phone.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await phone.evaluate((combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    debug.setRun({
      ...run,
      phase: 'combat',
      neow: null,
      combat: structuredClone(combat),
    })
  }, template.combat)
  await phone.locator('.combat').waitFor()
  const phoneFixture = template.combat
  const phoneHeroes = [
    { character: 'ironclad', sourceId: 'strike_ironclad', contact: 630, poses: ['ironclad-ready', 'ironclad-impact'] },
    { character: 'defect', sourceId: 'strike_defect', contact: 1110, poses: ['defect-charge', 'defect-release'] },
    { character: 'silent', sourceId: 'predator', contact: 1025, poses: ['silent-throw'] },
    { character: 'watcher', sourceId: 'strike_watcher', contact: 1050, poses: ['watcher-charge', 'watcher-cast'] },
  ]
  for (const [index, hero] of phoneHeroes.entries()) {
    await phone.evaluate(({ base, hero, index }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat = structuredClone(base)
      run.combat.combatId = `${run.combat.combatId}-iphone-${hero.character}-${index}`
      run.combat.phase = 'player'
      run.combat.presentationEvents = []
      run.combat.players = [run.combat.players[0]]
      Object.assign(run.combat.players[0], { character: hero.character, hp: 999, maxHp: 999, dead: false,
        stance: hero.character === 'watcher' ? 'wrath' : run.combat.players[0].stance })
      run.combat.enemies = [{ ...run.combat.enemies[0], uid: 'iphone-target', defId: 'cultist', isBoss: false,
        hp: 999, maxHp: 999, dead: false }]
      debug.setRun(run)
    }, { base: phoneFixture, hero, index })
    await phone.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await phone.evaluate(({ hero, index }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      const actor = run.combat.players[0]
      const target = run.combat.enemies[0]
      target.hp -= 1
      run.combat.presentationEvents = [{
        seq: 2_000_001 + index, kind: 'card', actorId: actor.id, sourceId: hero.sourceId,
        enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1,
      }]
      window.__ANIMATION_SFX__ = []
      debug.setRun(run)
    }, { hero, index })
    const attack = phone.locator(`.character-attack--${hero.character}`)
    await attack.waitFor()
    await phone.locator('.enemy .hit-vfx').waitFor()
    const iphoneAttack = await phone.evaluate(({ hero }) => {
      const seat = document.querySelector(`.seat--attack-${hero.character}`)
      const body = seat?.querySelector('.seat__portrait > img')
      const attack = seat?.querySelector(`.character-attack--${hero.character}`)
      const target = document.querySelector('.enemy__portrait')
      const hit = target?.querySelector('.hit-vfx')
      const targetVfx = target?.querySelector('.combat-vfx--attack-impact')
      const poses = hero.poses.map((pose) => attack?.querySelector(`.character-attack__pose--${pose}`))
      const targetVfxStyle = targetVfx ? getComputedStyle(targetVfx) : null
      return {
        viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
        mobilePerformance: document.documentElement.dataset.mobilePerformance,
        osReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        gameReducedMotion: document.documentElement.dataset.reducedMotion,
        bodyAnimation: body ? getComputedStyle(body).animationName : '',
        attackVisible: Boolean(attack && getComputedStyle(attack).display !== 'none'),
        poseAssets: poses.map((pose) => ({
          display: pose ? getComputedStyle(pose).display : 'none',
          animation: pose ? getComputedStyle(pose).animationName : 'none',
          loaded: pose?.querySelector('img')?.complete && (pose.querySelector('img')?.naturalWidth ?? 0) > 0,
        })),
        speedTrail: attack && hero.character === 'ironclad'
          ? { animation: getComputedStyle(attack, '::before').animationName,
              filter: getComputedStyle(attack, '::before').filter }
          : null,
        meteorCount: attack?.querySelectorAll('.character-attack__meteor').length ?? 0,
        projectileCount: attack?.querySelectorAll('.character-attack__dagger, .character-attack__bolt').length ?? 0,
        hitDelay: Number.parseFloat(hit ? getComputedStyle(hit).getPropertyValue('--hit-delay') : '0'),
        hitAnimation: hit ? getComputedStyle(hit).animationName : 'none',
        portraitAnimations: target?.getAnimations().length ?? 0,
        targetVfx: {
          display: targetVfxStyle?.display ?? 'none',
          image: targetVfxStyle?.backgroundImage ?? 'none',
          blend: targetVfxStyle?.mixBlendMode ?? 'normal',
          animation: targetVfxStyle?.animationName ?? 'none',
          beforeDisplay: targetVfx ? getComputedStyle(targetVfx, '::before').display : 'none',
          beforeAnimation: targetVfx ? getComputedStyle(targetVfx, '::before').animationName : 'none',
          afterDisplay: targetVfx ? getComputedStyle(targetVfx, '::after').display : 'none',
          afterAnimation: targetVfx ? getComputedStyle(targetVfx, '::after').animationName : 'none',
        },
      }
    }, { hero })
    check(iphoneAttack.mobilePerformance === 'true',
      `iPhone 13 did not enable its performance profile ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.osReducedMotion && iphoneAttack.gameReducedMotion === 'false' &&
      iphoneAttack.bodyAnimation === `attack-${hero.character}` && iphoneAttack.attackVisible &&
      iphoneAttack.poseAssets.every((pose) => pose.display !== 'none' && pose.animation !== 'none' && pose.loaded) &&
      (hero.character !== 'watcher' || iphoneAttack.meteorCount === 1),
    `iPhone 13 OS Reduce Motion skipped ${hero.character} attack frames ${JSON.stringify(iphoneAttack)}`)
    check(!iphoneAttack.speedTrail || iphoneAttack.speedTrail.animation === 'attack-speed-trail' &&
      iphoneAttack.speedTrail.filter !== 'none',
    `iPhone 13 lost Ironclad's PC speed trail ${JSON.stringify(iphoneAttack)}`)
    check((hero.character === 'silent' || hero.character === 'defect') === (iphoneAttack.projectileCount > 0),
      `iPhone 13 changed ${hero.character}'s projectile content ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.hitDelay > 0, `iPhone 13 damage landed before ${hero.character} contact ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.hitAnimation === 'impact-bloom' && iphoneAttack.targetVfx.display !== 'none' &&
      iphoneAttack.targetVfx.image !== 'none' && iphoneAttack.targetVfx.blend === 'screen' &&
      iphoneAttack.targetVfx.animation === 'combat-vfx-reveal' &&
      iphoneAttack.targetVfx.beforeDisplay !== 'none' && iphoneAttack.targetVfx.beforeAnimation === 'combat-vfx-ring' &&
      iphoneAttack.targetVfx.afterDisplay !== 'none' && iphoneAttack.targetVfx.afterAnimation === 'combat-vfx-streak',
    `iPhone 13 lost PC impact VFX layers for ${hero.character} ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.portraitAnimations === 0, `damage shook the iPhone target ${JSON.stringify(iphoneAttack)}`)
    await phone.waitForTimeout(hero.contact + 120)
    const phoneSounds = await phone.evaluate((cue) => window.__ANIMATION_SFX__.filter((sound) => sound.cue === cue),
      `card:${hero.character}:${hero.sourceId}:base`)
    const phoneImpactPaths = new Set(['/assets/sfx/attack.ogg', '/assets/sfx/enemy-hit.ogg',
      '/assets/sfx/block.ogg', '/assets/sfx/weak.ogg'])
    check(phoneSounds.some((sound) => phoneImpactPaths.has(sound.path) && sound.delayMs === hero.contact) &&
      phoneSounds.some((sound) => sound.delayMs < hero.contact),
    `iPhone 13 changed ${hero.character} SFX content/timing ${JSON.stringify(phoneSounds)}`)
    if (hero.character === 'watcher') {
      await phone.locator('.board').screenshot({ path: join(output, `iphone-13-${browserName}-watcher-impact.png`) })
    }
  }

  await phone.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
  await phone.waitForTimeout(50)
  await phone.evaluate(({ base }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-iphone-game-reduced`
    run.combat.phase = 'player'
    run.combat.players = [run.combat.players[0]]
    Object.assign(run.combat.players[0], { character: 'watcher', hp: 999, maxHp: 999, dead: false })
    run.combat.enemies = [{ ...run.combat.enemies[0], uid: 'iphone-reduced-target', defId: 'cultist',
      isBoss: false, hp: 998, maxHp: 999, dead: false }]
    run.combat.presentationEvents = [{
      seq: 2_100_001, kind: 'card', actorId: run.combat.players[0].id, sourceId: 'strike_watcher',
      enemyIds: ['iphone-reduced-target'], playerIds: [], upgraded: false, copied: false, energy: 1,
    }]
    debug.setRun(run)
  }, { base: phoneFixture })
  await phone.waitForTimeout(100)
  check(await phone.locator('.character-attack').count() === 0,
    'the visible in-game Reduce motion toggle no longer suppresses phone attacks')
  await phone.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })
  await phone.waitForTimeout(50)
  await phone.evaluate(() => { document.documentElement.dataset.mobilePerformance = 'false' })
  await phone.waitForTimeout(50)
  check(await phone.locator('.seat__portrait > img').evaluate((body) =>
    getComputedStyle(body).animationName === 'none'),
  'coarse-pointer non-phone ignored OS Reduce Motion CSS')
  await phone.evaluate(() => { document.documentElement.dataset.mobilePerformance = 'true' })
  await phone.waitForTimeout(50)

  await phone.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-iphone-boss`
    run.combat.players = [run.combat.players[0]]
    Object.assign(run.combat.players[0], { hp: 999, maxHp: 999, dead: false })
    run.combat.enemies = [{ ...enemy, uid: 'iphone-boss', actionIndex, hp: 999, maxHp: 999, dead: false }]
    run.combat.phase = 'enemy'
    debug.setRun(run)
  }, { base: phoneFixture, enemy: timingBoss, actionIndex: timingActionIndex })
  const phoneBoss = phone.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')
  await phoneBoss.locator('.enemy__art--cutout').waitFor()
  await phone.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'attack')
  const iphoneBossAnimation = await phoneBoss.evaluate((boss) => ({
    name: getComputedStyle(boss.querySelector('.enemy__art--cutout')).animationName,
    filter: getComputedStyle(boss.querySelector('.enemy__art--cutout')).filter,
    claw: [...document.querySelectorAll('.seat:not(.seat--dead) .seat__portrait')].map((portrait) => ({
      display: getComputedStyle(portrait, '::before').display,
      animation: getComputedStyle(portrait, '::before').animationName,
    })),
  }))
  check(iphoneBossAnimation.name !== 'none' &&
    iphoneBossAnimation.claw.length > 0 && iphoneBossAnimation.claw.every((claw) =>
      claw.display !== 'none' && claw.animation === 'awakened-claw-scratch'),
    `iPhone 13 skipped the boss attack ${JSON.stringify(iphoneBossAnimation)}`)

  check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
} finally {
  await phoneContext?.close()
  await browser.close()
  await server.close()
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}
console.log(`Animation browser QA passed: 13 bosses × 4 states, 4 heroes × 3 phases; screenshots: ${output}`)
