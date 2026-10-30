import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const output = 'artifacts/sever-soul'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['horizontal-phone', { width: 844, height: 390 }, true],
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const run = postNeowRun(47, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
    const room = run.map.rows[0][0]
    run.map.rooms[room].kind = 'encounter'
    const base = enterRoom(run, room)
    base.campaign.runId = `sever-soul-${screen}`
    Object.assign(base.combat, { phase: 'player', pendingTriggers: [], startTurnProgress: undefined })
    const card = (defId, uid, upgraded = false) => ({ defId, uid, upgraded })
    const sever = card('sever_soul', 'sever')
    const upgraded = card('sever_soul', 'sever-plus', true)
    const fuel = [card('defend_ironclad', 'defend'), card('daze', 'daze'), card('strike_ironclad', 'strike')]
    const deck = [sever, upgraded, ...fuel]
    Object.assign(base.combat.players[0], {
      hand: [], draw: [], discard: [], exhaust: [], relics: [], potions: [],
      powers: [card('feel_no_pain', 'feel-no-pain')], energy: 2, strength: 0, weak: 0, block: 0, deck,
    })
    base.players[0].deck = structuredClone(deck)
    base.combat.enemies = [{ ...base.combat.enemies[0], uid: 'target', defId: 'small_slime',
      hp: 30, maxHp: 30, block: 0, vulnerable: 0, dead: false }]
    let fixtureNumber = 0
    const setHand = async (hand, draw = [], energy = 2) => {
      const fixture = structuredClone(base)
      fixture.combat.combatId = `sever-${screen}-${fixtureNumber++}`
      fixture.combat.players[0].hand = hand
      fixture.combat.players[0].draw = draw
      fixture.combat.players[0].energy = energy
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), fixture)
      await page.waitForFunction(id => window.__STS_DEBUG__.getState()?.combatId === id, fixture.combat.combatId)
      await page.locator('.hand .card').first().waitFor()
    }
    const activate = locator => phone ? locator.tap() : locator.click()
    const play = async (name) => {
      await page.locator(`.hand .card[title="${name}"]`).click()
    }
    const dialog = page.getByRole('dialog', { name: /Choose .* in your hand to Exhaust/ })
    const read = () => page.evaluate(() => structuredClone(window.__STS_DEBUG__.getState()))
    const confirm = () => dialog.getByRole('button', { name: /^Exhaust / })
    const finish = async () => {
      await activate(confirm())
      await dialog.waitFor({ state: 'detached' })
      await activate(page.locator('[data-enemy-id="target"] .enemy__head'))
    }

    await setHand([card('havoc', 'havoc'), ...fuel], [sever], 1)
    await play('Havoc')
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
    await dialog.focus()
    await page.keyboard.press('Escape')
    assert(await dialog.isVisible(), 'Havoc’s mandatory choice cannot be dismissed')
    await activate(dialog.locator('.card[title="Defend"]'))
    await finish()
    await page.waitForFunction(() => !window.__STS_DEBUG__.getState().startTurnProgress?.forcedCard)
    const havocPlayed = await read()
    assert.equal(havocPlayed.enemies[0].hp, 27)
    assert.equal(havocPlayed.players[0].energy, 0)
    assert.deepEqual(havocPlayed.players[0].exhaust.map(card => card.uid).sort(), ['defend', 'sever'])

    await setHand([sever, ...fuel])
    const before = await read()
    await play('Sever Soul')
    await dialog.waitFor()
    assert.equal(await dialog.locator('.card').count(), 3, 'only other hand cards may be exhausted')
    assert.equal(await dialog.locator('.card[title="Sever Soul"]').count(), 0)
    assert(await confirm().isDisabled())
    await activate(dialog.locator('.card[title="Defend"]'))
    await activate(dialog.locator('.card[title="Daze"]'))
    assert.equal(await dialog.locator('.card--selected').count(), 1, 'base card allows one choice')
    await activate(dialog.locator('.card[title="Daze"]'))
    assert(await confirm().isDisabled(), 'deselecting the only choice must disable confirmation')
    assert.deepEqual(await read(), before, 'inspection must not spend Energy, deal damage or exhaust cards')
    if (phone) await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }))
    else await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await read(), before, 'cancelling must leave the play uncommitted')
    await play('Sever Soul')
    await dialog.waitFor()
    await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }))
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await read(), before, 'Cancel must leave the entire combat unchanged')
    await play('Sever Soul')
    await dialog.waitFor()
    await activate(dialog.locator('.card[title="Daze"]'))
    assert(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const controls = [...element.querySelectorAll('.hand-exhaust__actions button')]
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight &&
        controls.every(control => {
          const box = control.getBoundingClientRect()
          return box.top >= rect.top && box.bottom <= rect.bottom
        }) && element.matches(':modal') && element.contains(document.activeElement)
    }), `${screen}: modal, focus and confirmation controls must fit the screen`)
    await page.screenshot({ path: `${output}/${screen}-base.png` })
    await finish()
    await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
    const basePlayed = await read()
    assert.deepEqual(basePlayed.players[0].exhaust.map(card => card.uid), ['daze'])
    assert.equal(basePlayed.enemies[0].hp, 27)
    assert.equal(basePlayed.players[0].block, 1, 'Feel No Pain must still observe the Exhaust')

    for (const count of [1, 2]) {
      await setHand([upgraded, ...fuel])
      await play('Sever Soul+')
      await dialog.waitFor()
      assert.match(await dialog.locator('h2').innerText(), /1 or 2 cards/)
      assert(await confirm().isDisabled(), 'the upgrade cannot skip an available Exhaust')
      await activate(dialog.locator('.card[title="Defend"]'))
      if (count === 2) await activate(dialog.locator('.card[title="Daze"]'))
      await page.screenshot({ path: `${output}/${screen}-upgrade-${count}.png` })
      await finish()
      await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
      const played = await read()
      assert.deepEqual(played.players[0].exhaust.map(card => card.uid), ['defend', 'daze'].slice(0, count))
      assert.equal(played.enemies[0].hp, 26)
      assert.equal(played.players[0].hand.length, 3 - count)
    }

    await setHand([upgraded, ...fuel])
    await play('Sever Soul+')
    await dialog.waitFor()
    await activate(dialog.locator('.card[title="Defend"]'))
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.combat.players[0].hand = run.combat.players[0].hand.filter(card => card.uid !== 'defend')
      window.__STS_DEBUG__.setRun(run)
    })
    await dialog.locator('.card[title="Defend"]').waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('.hand-exhaust__actions button')?.disabled)
    await activate(dialog.locator('.card[title="Daze"]'))
    await finish()
    await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
    assert.deepEqual((await read()).players[0].exhaust.map(card => card.uid), ['daze'],
      'live hand updates must discard stale selections')

    await setHand([sever])
    await play('Sever Soul')
    await activate(page.locator('[data-enemy-id="target"] .enemy__head'))
    await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
    assert.equal(await dialog.count(), 0, 'an empty eligible hand must not strand the play')
    assert.equal((await read()).enemies[0].hp, 27)
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${screen}: Sever Soul picker, cancellation, upgrade range, live hand and empty hand`)
  }
} finally {
  await browser.close()
  await server.close()
}
