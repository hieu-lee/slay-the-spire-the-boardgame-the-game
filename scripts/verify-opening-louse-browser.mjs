import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom, roomChoices } from '../src/game/run.ts'

// Failure cases: the opening card loses its Card Reward; its summon duplicates
// Gold/cards; taking Gold consumes the card; a reload loses the unclaimed card;
// the offered card cannot actually be added on desktop or horizontal phone.
const out = 'artifacts/opening-louse-browser'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  for (const [name, width, height] of [['desktop', 1440, 900], ['horizontal-phone', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(origin)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const id = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    let fixture
    for (let seed = 0; seed < 50; seed++) {
      const run = postNeowRun(seed, [{ id, name: 'Ironclad', character: 'ironclad' }])
      const entered = enterRoom(run, roomChoices(run)[0].id)
      if (entered.combat.enemies[0].defId === 'red_louse_first') { fixture = entered; break }
    }
    assert(fixture, 'a deterministic opening Louse seed must exist')
    assert.deepEqual(fixture.combat.enemies.map((enemy) => [enemy.defId, enemy.goldReward, enemy.cardReward]),
      [['red_louse_first', 1, 'normal'], ['green_louse', 0, null]], 'printed opening rewards, not summon rewards')
    // Shorten the fight, but retain the actual dealt encounter and reward data.
    fixture.combat.enemies.forEach((enemy) => { enemy.hp = 1; enemy.block = 0 })
    fixture.combat.players[0].hand = [
      { uid: 'opening-strike-1', defId: 'strike_ironclad', upgraded: false },
      { uid: 'opening-strike-2', defId: 'strike_ironclad', upgraded: false },
    ]
    fixture.combat.players[0].energy = 3
    const before = { gold: fixture.players[0].gold, deck: fixture.players[0].deck.length }
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fixture)
    for (const enemy of fixture.combat.enemies) {
      await page.locator('.hand .card').first().click()
      await page.locator(`[data-enemy-id="${enemy.uid}"]`).click()
      await page.waitForFunction((uid) => {
        const combat = window.__STS_DEBUG__.getRun().combat
        return !combat || combat.enemies.find((enemy) => enemy.uid === uid)?.dead
      }, enemy.uid)
    }
    await page.getByRole('heading', { name: 'Loot!', exact: true }).waitFor()
    const read = () => page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
    const loot = await read()
    assert.equal(loot.rewards[0].gold, 1)
    assert.equal(loot.rewards[0].cardReward, true)
    assert.equal(loot.rewards[0].potion, false)
    await page.getByRole('button', { name: '1 Gold', exact: true }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${out}/${name}-loot.png`, animations: 'disabled' })
    await page.getByRole('button', { name: '1 Gold', exact: true }).click()
    assert.equal((await read()).players[0].gold, before.gold + 1)
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('sts-solo-run') ?? 'null')
      return saved?.run?.phase === 'reward' && saved.run.rewards[0].gold === false && saved.run.rewards[0].cardReward
    })
    await page.reload()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    const cardLoot = page.getByRole('button', { name: 'Add a card to your deck.' })
    await cardLoot.waitFor()
    assert.equal(await page.getByRole('button', { name: '1 Gold', exact: true }).count(), 0, 'reload must not restore claimed Gold')
    await cardLoot.click()
    await page.getByRole('heading', { name: 'Choose a Card', exact: true }).waitFor()
    await page.locator('.reward-screen__cards .card').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${out}/${name}-card-choice.png`, animations: 'disabled' })
    const choice = (await read()).rewards[0].choices[0]
    await page.locator('.reward-screen__cards .card').first().click()
    await page.waitForFunction((length) => window.__STS_DEBUG__.getRun().players[0].deck.length === length, before.deck + 1)
    const after = await read()
    assert.equal(after.players[0].gold, before.gold + 1)
    assert(after.players[0].deck.some((card) => card.defId === choice), 'chosen reward must reach the deck')
    writeFileSync(`${out}/${name}-evidence.json`, JSON.stringify({ seed: fixture.rng.seed, before, loot: loot.rewards, choice, after }, null, 2))
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Opening Louse reward E2E passed on desktop and horizontal phone: 1 Gold, one Card Reward, reload, and card acquisition.')
} finally {
  await browser.close()
  await server.close()
}
