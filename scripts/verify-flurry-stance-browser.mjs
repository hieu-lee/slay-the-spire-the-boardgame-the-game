import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const output = 'artifacts/flurry-stance'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['horizontal-phone', { width: 844, height: 390 }, true],
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: phone, isMobile: phone })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const run = postNeowRun(47, [{ id: 'p1', name: 'Watcher', character: 'watcher' }])
    const room = run.map.rows[0][0]
    run.map.rooms[room].kind = 'encounter'
    const fixture = enterRoom(run, room)
    fixture.campaign.runId = `flurry-${screen}`
    Object.assign(fixture.combat, { phase: 'player', pendingTriggers: [], startTurnProgress: undefined,
      stanceChangedThisTurn: [] })
    const card = (defId, uid, upgraded = false) => ({ defId, uid, upgraded })
    const hand = [
      card('flurry_of_blows', 'flurry'), card('flurry_of_blows', 'flurry-plus', true),
      card('tranquility', 'calm'), card('crescendo', 'wrath'), card('empty_body', 'neutral'),
    ]
    const draw = [card('flurry_of_blows', 'next-flurry'), card('flurry_of_blows', 'next-plus', true)]
    Object.assign(fixture.combat.players[0], {
      hand, draw, discard: [], exhaust: [], powers: [], relics: [], potions: [],
      energy: 9, block: 0, stance: 'calm', deck: [...hand, ...draw],
    })
    fixture.players[0].deck = structuredClone(fixture.combat.players[0].deck)
    fixture.combat.enemies = [{ ...fixture.combat.enemies[0], uid: 'target', defId: 'small_slime',
      hp: 30, maxHp: 30, block: 0, dead: false }]
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), fixture)
    const flurries = page.locator('.hand .card[title^="Flurry of Blows"]')
    const badge = flurries.locator('.card__stance-bonus')
    await flurries.first().waitFor()
    assert.deepEqual(await badge.allTextContents(), ['No stance change', 'No stance change'])
    assert.equal(await page.locator('.hand .card:not([title^="Flurry"]) .card__stance-bonus').count(), 0)
    const play = async name => {
      await page.locator(`.hand .card[title="${name}"]`).click()
    }
    await play('Tranquility')
    assert.deepEqual(await badge.allTextContents(), ['No stance change', 'No stance change'],
      'entering the current stance must not activate Flurry')
    await flurries.first().focus()
    await page.waitForFunction(() => !document.querySelector('.hand[data-hand-moving]'))
    await page.screenshot({ path: `${output}/${screen}-inactive.png` })
    await play('Crescendo')
    assert.deepEqual(await badge.allTextContents(), ['Stance changed', 'Stance changed'])
    await play('Empty Body')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].stance), 'neutral')
    assert.deepEqual(await badge.allTextContents(), ['Stance changed', 'Stance changed'],
      'leaving stance must not clear an already-earned bonus')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-solo-run')).run.combat.stanceChangedThisTurn.includes('p1'))
    await page.reload()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await flurries.first().waitFor()
    assert.deepEqual(await badge.allTextContents(), ['Stance changed', 'Stance changed'],
      'solo Resume preserves upstream’s exact mid-turn stance bonus')
    assert.deepEqual(await badge.allTextContents(), ['Stance changed', 'Stance changed'])
    await flurries.first().focus()
    assert.match(await flurries.first().evaluate(card => document.getElementById(card.getAttribute('aria-describedby')).textContent),
      /You changed stance this turn/)
    await page.waitForFunction(() => !document.querySelector('.hand[data-hand-moving]'))
    await page.waitForFunction(card => card.getAnimations().every(animation => animation.playState === 'finished'),
      await flurries.first().elementHandle())
    const badgeLayout = await badge.first().evaluate(mark => ({
      card: mark.parentElement.getBoundingClientRect().toJSON(),
      mark: mark.getBoundingClientRect().toJSON(),
      damage: mark.parentElement.querySelector('.card__live-damage')?.getBoundingClientRect().toJSON(),
      scroll: mark.scrollWidth, client: mark.clientWidth,
    }))
    assert(await badge.first().evaluate(mark => {
      const card = mark.parentElement.getBoundingClientRect(), box = mark.getBoundingClientRect()
      const damage = mark.parentElement.querySelector('.card__live-damage')?.getBoundingClientRect()
      return box.left >= card.left && box.right <= card.right && box.top >= card.top &&
        box.bottom < card.top + card.height * 0.58 && mark.scrollWidth <= mark.clientWidth &&
        (!damage || box.top >= damage.bottom || box.bottom <= damage.top || box.left >= damage.right || box.right <= damage.left)
    }), `the badge must fit above the printed rules and not cover the damage preview: ${JSON.stringify(badgeLayout)}`)
    await page.screenshot({ path: `${output}/${screen}-active.png` })
    await page.getByRole('button', { name: /^Current deck,/ }).click()
    const deck = page.getByRole('dialog', { name: 'Current deck', exact: true })
    await deck.waitFor()
    assert((await deck.locator('.card__stance-bonus').allTextContents()).every(text => text === 'Stance changed'))
    await deck.getByRole('button', { name: 'Back', exact: true }).click()
    await play('Flurry of Blows+')
    await page.locator('[data-enemy-id="target"] .enemy__head').click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 27)
    await page.getByRole('button', { name: 'End turn', exact: true }).click()
    await page.waitForFunction(() => {
      const state = window.__STS_DEBUG__.getState()
      return state.turn === 2 && state.phase === 'player'
    })
    assert((await badge.count()) >= 2)
    assert((await badge.allTextContents()).every(text => text === 'No stance change'),
      'the indicator must reset with the engine at the next turn')
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${screen}: stance changes, same-stance entry, resume, aiming and next-turn reset`)
  }
} finally {
  await browser.close()
  await server.close()
}
