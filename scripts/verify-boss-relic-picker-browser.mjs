import assert from 'node:assert/strict'
import { checkRewardSweep } from './lib/reward-hover.mjs'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { createRun } from '../src/game/run.ts'

const output = 'artifacts/boss-relic-picker'
mkdirSync(output, { recursive: true })
const rooms = createRoomServer()
const address = await rooms.listen(0)
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target: `http://127.0.0.1:${address.port}` }, '/ws': { target: `ws://127.0.0.1:${address.port}`, ws: true } },
} })
await server.listen()
const browser = await chromium.launch()
const errors = []
const choices = ['coffee_dripper', 'fusion_hammer', 'sozu']
const fixture = (players) => {
  const run = createRun(47, players)
  run.phase = 'reward'
  run.neow = null
  run.rewardDestination = 'victory'
  run.rewards = run.players.map((player) => ({
    playerId: player.id, gold: 3, potion: 'weak_potion', relic: false,
    cardReward: true, cardSource: 'rare', choices: null, upgraded: false, bossRelics: [...choices],
  }))
  return run
}
const picker = (page) => page.getByRole('dialog', { name: 'Choose a Relic', exact: true })
const checkLoot = async (page) => {
  const entry = page.getByRole('button', { name: 'Choose 1 of 3 relics', exact: true })
  await entry.waitFor()
  assert.equal(await page.getByRole('button', { name: 'Coffee Dripper', exact: true }).count(), 0,
    'individual boss relics leaked into the normal loot list')
  await entry.click()
  await picker(page).waitFor()
  assert.equal(await picker(page).locator('.relic-reward__choice').count(), 3)
}

try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['horizontal-phone', { width: 844, height: 390 }, true],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(origin)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const playerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = fixture([{ id: playerId, name: 'Ironclad', character: 'ironclad' }])
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), run)
    await page.getByRole('heading', { name: 'Loot!', exact: true }).waitFor()
    const before = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
    await checkLoot(page)
    await picker(page).getByRole('button', { name: 'Back to loot', exact: true }).click()
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), before)
    await checkLoot(page)
    await page.keyboard.press('Escape')
    await picker(page).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), before)
    await checkLoot(page)
    await picker(page).locator('.item-card-image').evaluateAll((images) => Promise.all(images.map((image) => image.decode())))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await checkRewardSweep(page, picker(page).locator('.relic-reward__choice'))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const hoverChoice = picker(page).getByRole('button', { name: 'Fusion Hammer', exact: true })
    await page.mouse.move(5, 5)
    await picker(page).evaluate(async dialog => {
      document.activeElement?.blur()
      await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
    })
    const resting = await hoverChoice.boundingBox()
    const sampleTween = () => hoverChoice.evaluate(choice => {
      getComputedStyle(choice).transform
      const animation = choice.getAnimations().find(animation => animation.transitionProperty === 'transform')
      if (!animation) return null
      animation.pause()
      const duration = animation.effect.getTiming().duration
      const widths = [0, duration / 2, duration].map(time => {
        animation.currentTime = time
        return choice.getBoundingClientRect().width
      })
      animation.finish()
      return { duration, widths }
    })
    await hoverChoice.hover()
    const growing = await sampleTween()
    assert(growing && growing.duration === 500 && growing.widths[0] < growing.widths[1] &&
      growing.widths[1] < growing.widths[2], `${screen}: relic hover must tween up`)
    assert(Math.abs(growing.widths[2] / resting.width - 1.25) < .01, 'relic hover must enlarge by 25%')
    await page.screenshot({ path: `${output}/${screen}-hover.png` })
    await page.mouse.move(5, 5)
    const shrinking = await sampleTween()
    assert(shrinking && shrinking.duration === 500 && shrinking.widths[0] > shrinking.widths[1] &&
      shrinking.widths[1] > shrinking.widths[2], `${screen}: relic hover must ease back`)
    assert(Math.abs(shrinking.widths[2] - resting.width) < 1)
    await page.keyboard.press('Tab')
    await hoverChoice.focus()
    await hoverChoice.evaluate(choice => Promise.all(choice.getAnimations().map(animation => animation.finished)))
    assert(Math.abs((await hoverChoice.boundingBox()).width / resting.width - 1.25) < .01,
      'keyboard focus must use the same relic enlargement')
    assert(await picker(page).evaluate((dialog) => [...dialog.querySelectorAll('button')].every((button) => {
      const box = button.getBoundingClientRect()
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
    })), `${screen}: relic choices or navigation clipped`)
    await page.screenshot({ path: `${output}/${screen}.png`, animations: 'disabled' })
    for (const mode of ['system', 'game']) {
      await page.emulateMedia({ reducedMotion: mode === 'system' ? 'reduce' : 'no-preference' })
      await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
      await hoverChoice.evaluate(choice => choice.blur())
      await page.mouse.move(5, 5)
      await hoverChoice.hover()
      assert(Math.abs((await hoverChoice.boundingBox()).width / resting.width - 1.25) < .01,
        `${screen}/${mode}: reduced motion must preserve relic inspection`)
      assert(await hoverChoice.evaluate(choice => getComputedStyle(choice).transitionDuration
        .split(',').every(duration => parseFloat(duration) <= .001)),
      `${screen}/${mode}: reduced motion must disable the tween`)
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })
    await picker(page).getByRole('button', { name: 'Coffee Dripper', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: 'Loot!', exact: true }).waitFor()
    const claimed = await page.evaluate(() => window.__STS_DEBUG__.getRun())
    assert.equal(claimed.players[0].relics.filter((relic) => choices.includes(relic.defId)).length, 1)
    assert.equal(claimed.players[0].relics.at(-1).defId, 'coffee_dripper')
    assert.equal(claimed.rewards[0].bossRelics, false)
    assert.equal(claimed.rewards[0].gold, 3)
    assert.equal(claimed.rewards[0].potion, 'weak_potion')
    assert.equal(claimed.rewards[0].cardReward, true)
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), run)
    await checkLoot(page)
    await picker(page).getByRole('button', { name: 'Skip', exact: true }).click()
    await page.getByRole('button', { name: '3 Gold', exact: true }).waitFor()
    const skipped = await page.evaluate(() => window.__STS_DEBUG__.getRun())
    assert.equal(skipped.rewards[0].bossRelics, false)
    assert.deepEqual(skipped.players[0].relics, run.players[0].relics)
    assert.equal(skipped.rewards[0].cardReward, true)
    const nested = structuredClone(run)
    nested.rewards[0].bossRelics = ['tiny_house', 'coffee_dripper', 'sozu']
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), nested)
    await checkLoot(page)
    await picker(page).getByRole('button', { name: 'Tiny House', exact: true }).click()
    await page.getByRole('heading', { name: 'Tiny House', exact: true }).waitFor()
    assert.equal(await picker(page).count(), 0, 'the relic picker covered its follow-up rewards')
    await context.close()

    const online = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone })
    const tab = await online.newPage()
    tab.on('pageerror', (error) => errors.push(error.message))
    await tab.goto(origin)
    await tab.getByRole('button', { name: 'Play online', exact: true }).click()
    await tab.getByRole('button', { name: 'Create room', exact: true }).click()
    await tab.locator('.online-lobby').waitFor()
    const session = await tab.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
    const room = rooms.store.rooms.get(session.code)
    room.phase = 'run'
    room.run = fixture(room.seats.map((seat) => ({ id: seat.playerId, name: seat.name, character: seat.character })))
    room.version++
    rooms.publishRoom(session.code)
    await checkLoot(tab)
    // An authoritative refresh can remove a shared choice while the picker stays open.
    room.run.rewards[0].bossRelics = ['coffee_dripper', 'fusion_hammer']
    room.version++
    rooms.publishRoom(session.code)
    await picker(tab).getByRole('button', { name: 'Sozu', exact: true }).waitFor({ state: 'detached' })
    await picker(tab).getByRole('button', { name: 'Fusion Hammer', exact: true }).click()
    await picker(tab).waitFor({ state: 'detached' })
    assert.equal(room.run.players[0].relics.filter((relic) => choices.includes(relic.defId)).length, 1)
    assert.equal(room.run.rewards[0].gold, 3)
    assert.equal(room.run.rewards[0].potion, 'weak_potion')
    assert.equal(room.run.rewards[0].cardReward, true)
    await online.close()
    console.log(`PASS ${screen}: grouped boss reward, separate picker, Back/Skip, and authoritative relic selection`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
