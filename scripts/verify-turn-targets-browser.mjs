import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/turn-targets'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
const c = (uid, defId, upgraded = false) => ({ uid, defId, upgraded })
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const combat = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    const hp = async () => (await combat()).enemies.map((enemy) => enemy.hp)
    let fixtureId = 0
    async function load({ phase = 'player', die = 1, player = {}, teammate, boss = false } = {}) {
      await page.waitForFunction(() => !document.querySelector('.card-flight-effect'))
      const run = createRun(931, [{ id: viewerId, name: 'Defect', character: 'defect' },
        ...(teammate ? [{ id: 'mate', name: 'Mate', character: 'defect' }] : [])])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: true, dead: false }
      run.combat = createCombat({ seed: 931, calls: 0 }, run.players,
        [enemy, { ...enemy, uid: 'e1', row: 1 },
          ...(boss ? [{ ...enemy, uid: 'boss', defId: 'donu', isBoss: true, hp: 50, maxHp: 50 }] : [])],
        `turn-targets-${fixtureId++}`)
      Object.assign(run.combat.players[0], {
        hand: [], draw: [], discard: [], exhaust: [], powers: [], relics: [], potions: [], energy: 3,
        orbs: [null, null, null], ...player,
      })
      if (teammate) {
        Object.assign(run.combat.players[0], { character: 'ironclad', orbs: [null, null, null], powers: [] })
        Object.assign(run.combat.players[1], {
          hand: [], draw: [], discard: [], exhaust: [], relics: [], potions: [], ...teammate,
        })
      }
      Object.assign(run.combat, { combatId: `turn-targets-${name}-${fixtureId}`, phase, die, turn: 1, startTurnStage: phase === 'start' ? 'effects' : undefined,
        startTurnProgress: undefined, endTurnProgress: undefined, pendingTriggers: [], presentationEvents: [] })
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(id => window.__STS_DEBUG__.getRun().combat?.combatId === id, run.combat.combatId)
      await page.locator('[data-enemy-id="e1"]').waitFor()
      await page.waitForTimeout(400)
    }
    async function drag(source, enemyUid) {
      const from = await source.boundingBox()
      const to = await page.locator(`[data-enemy-id="${enemyUid}"]`).evaluate((element) => {
        const rect = (element.querySelector('.enemy__hit-area') ?? element).getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.mouse.up()
    }
    const caption = page.locator('.end-turn-effects__prompt')
    const visibleCaption = () => caption.evaluate((element) => [...element.childNodes]
      .filter((node) => !(node instanceof Element && node.classList.contains('visually-hidden')))
      .map((node) => node.textContent).join(''))
    const startSource = page.locator('.start-turn-effects')
    const orbButton = (orb, slot) => page.getByRole('button', { name: `Evoke ${orb} Orb ${slot}`, exact: true })
    const orbsVisibleAndClear = () => page.locator('.orbs__target').evaluateAll((orbs) => orbs.length > 0 && orbs.every((orb) => {
      const r = orb.getBoundingClientRect()
      const value = orb.querySelector('.orb__value')?.getBoundingClientRect()
      return r.width >= 24 && orb.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) &&
        (!value || orb.contains(document.elementFromPoint(value.x + value.width / 2, value.y + value.height / 2)))
    }))

    // A card Evoke chooses the Orb on the hero, then aims each Lightning Evoke.
    await load({ player: { hand: [c('dual', 'dual_cast')], orbs: ['lightning', 'frost', 'dark'] } })
    await page.locator('.hand .card[title="Dual Cast"]').click()
    await orbButton('lightning', 1).waitFor()
    assert.equal(await page.locator('.orbs__target').count(), 3)
    assert(await orbsVisibleAndClear(), `${name}: the hero's Orbs are covered while choosing an Evoke`)
    assert.equal(await page.locator('.prompt').filter({ hasText: /Evoke/ }).evaluateAll((prompts) =>
      prompts.filter((prompt) => prompt.getBoundingClientRect().width > 1).length), 0,
    `${name}: a text Orb picker is still painted over the board`)
    assert.notEqual(await page.locator('.orbs__target .token--orb').first().evaluate((token) =>
      getComputedStyle(token).boxShadow), 'none', `${name}: choosable Orbs have no selection ring`)
    await page.screenshot({ path: `${out}/${name}-card-evoke-choice.png` })
    await orbButton('lightning', 1).click()
    const evokeTarget = page.locator('.evoke-target-effect')
    await evokeTarget.waitFor()
    assert.equal(await visibleCaption(), 'Drag to an enemy')
    assert.equal(await evokeTarget.locator('.token--orb-lightning').count(), 1)
    await page.screenshot({ path: `${out}/${name}-card-evoke-target.png` })
    assert.match(await caption.textContent(), /lightning Orb 1: Drag to an enemy$/)
    await evokeTarget.locator('button').click()
    assert.equal(await evokeTarget.locator('button').getAttribute('aria-pressed'), 'true')
    await page.locator('[data-enemy-id="e1"] .enemy__head').click()
    await page.waitForTimeout(200)
    assert.equal(await evokeTarget.count(), 1, `${name}: Dual Cast lost its second Lightning aim`)
    assert.equal(await evokeTarget.locator('button').getAttribute('aria-pressed'), 'false',
      `${name}: the second Evoke aim started already armed`)
    assert.match(await caption.textContent(), /lightning Orb 2: Drag to an enemy$/, `${name}: the second aim was not announced`)
    assert.equal(await page.locator('.seat__interactive .token--orb-lightning').count(), 0,
      `${name}: the aimed Lightning still sits in its slot`)
    await drag(evokeTarget.locator('button'), 'e0')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    const dualHp = await hp()
    assert(dualHp[0] < 30 && dualHp[1] < 30, `${name}: Dual Cast Lightning did not hit both aimed enemies: ${dualHp}`)
    assert.equal(await evokeTarget.count(), 0)

    // Row-targeting Lightning aims at rows; a boss stands in every row and cannot be picked alone.
    await load({ boss: true, player: { hand: [c('dual-row', 'dual_cast')], orbs: ['lightning', 'frost', 'dark'],
      powers: [c('electro', 'electrodynamics')] } })
    await page.locator('.hand .card[title="Dual Cast"]').click()
    await orbButton('lightning', 1).click()
    await evokeTarget.waitFor()
    await drag(evokeTarget.locator('button'), 'boss')
    await page.waitForTimeout(200)
    assert.equal(await evokeTarget.count(), 1, `${name}: a row-targeting Evoke accepted the boss alone`)
    await drag(evokeTarget.locator('button'), 'e1')
    await page.waitForTimeout(200)
    await drag(evokeTarget.locator('button'), 'e0')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    const rowHp = await hp()
    assert(rowHp[0] < 30 && rowHp[1] < 30 && rowHp[2] <= 50 - 4,
      `${name}: row Lightning did not hit both rows and the boss twice: ${rowHp}`)

    // A start-of-turn Evoke uses the same Orb picker and aim.
    await load({ phase: 'start', player: { powers: [c('storm', 'storm', true)], orbs: ['lightning', 'frost', 'dark'] } })
    await orbButton('dark', 3).waitFor()
    assert(await orbsVisibleAndClear(), `${name}: the hero's Orbs are covered while choosing Storm's Evoke`)
    await startSource.locator('.end-turn-effect--card').waitFor()
    assert.equal(await visibleCaption(), 'Choose an Orb', `${name}: Storm's Evoke choice has no visible cause`)
    assert.equal(await startSource.locator('[inert] .end-turn-effect--card').count(), 1,
      `${name}: Storm's cause card is still an inert-less control`)
    await page.screenshot({ path: `${out}/${name}-start-evoke-choice.png` })
    await orbButton('dark', 3).click()
    await evokeTarget.locator('.token--orb-dark').waitFor()
    await drag(evokeTarget.locator('button'), 'e1')
    await evokeTarget.waitFor({ state: 'detached' })
    // Storm+ channels again into full slots: the second choice shows the planned Lightning in slot 3.
    await orbButton('lightning', 3).waitFor()
    await orbButton('frost', 2).click()
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    const stormHp = await hp()
    assert(stormHp[0] === 30 && stormHp[1] < 30, `${name}: Storm's Dark Evoke missed its aimed enemy: ${stormHp}`)

    // In a local party the Evoke choice sits on the owner's Orbs, not the viewer's.
    await load({ phase: 'start', teammate: { powers: [c('mate-storm', 'storm')], orbs: ['lightning', 'frost', 'dark'] } })
    const mateSeat = page.locator('.seat__interactive[data-player-id="mate"]')
    await mateSeat.getByRole('button', { name: 'Evoke frost Orb 2', exact: true }).waitFor()
    assert.equal(await page.locator('.orbs__target').count(), 3, `${name}: the viewer's seat shows a teammate's Evoke choice`)
    await mateSeat.getByRole('button', { name: 'Evoke frost Orb 2', exact: true }).click()
    await page.locator('.orbs__target').first().waitFor({ state: 'detached' })

    // A targeted start-of-turn relic floats as its own source.
    await load({ phase: 'start', die: 4, player: { relics: [{ defId: 'stone_calendar', spent: false }] } })
    await startSource.locator('.end-turn-effect--relic').waitFor()
    assert.equal(await visibleCaption(), 'Drag to an enemy')
    assert(!overlaps(await caption.boundingBox(), await page.locator('.start-turn-order > summary').boundingBox()),
      `${name}: the start-of-turn caption covers the order summary`)
    await page.screenshot({ path: `${out}/${name}-start-enemy-target.png` })
    await startSource.locator('.end-turn-effect--relic').click()
    await page.locator('[data-enemy-id="e0"] .enemy__head').click()
    await startSource.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Reset start choices' }).click()
    assert.equal(await startSource.locator('.end-turn-effect--relic').getAttribute('aria-pressed'), 'false',
      `${name}: a re-opened start-of-turn source stayed armed`)
    await drag(startSource.locator('.end-turn-effect--relic'), 'e1')
    await startSource.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    assert.deepEqual(await hp(), [30, 26], `${name}: Stone Calendar hit the wrong enemy`)

    // A targeted start-of-turn Power floats its card as the source.
    await load({ phase: 'start', player: { powers: [c('fumes', 'noxious_fumes')] } })
    await startSource.locator('.end-turn-effect--card').waitFor()
    assert.equal(await visibleCaption(), 'Drag to an enemy')
    await drag(startSource.locator('.end-turn-effect--card'), 'e1')
    await startSource.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    assert.deepEqual((await combat()).enemies.map((enemy) => enemy.poison), [0, 1], `${name}: Noxious Fumes poisoned the wrong enemy`)

    // End-of-turn Lightning keeps its drag source with only a short caption.
    await load({ player: { hand: [c('deflect', 'deflect')], orbs: ['lightning', 'lightning', null] } })
    await page.getByRole('button', { name: 'End turn', exact: true }).click()
    await page.locator('.end-turn-effects button.end-turn-effect--orb').waitFor()
    assert.equal(await visibleCaption(), 'Drag to an enemy')
    assert.match(await caption.textContent(), /Lightning Orb 1: Drag to an enemy$/)
    await page.screenshot({ path: `${out}/${name}-end-lightning.png` })
    await drag(page.locator('.end-turn-effects button.end-turn-effect--orb'), 'e0')
    await page.waitForFunction(() => document.querySelector('.end-turn-effects__prompt')?.textContent?.includes('Lightning Orb 2'))
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Turn target browser audit passed: Orb Evoke choice and aim, start-of-turn relic aim, and end-of-turn captions on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
