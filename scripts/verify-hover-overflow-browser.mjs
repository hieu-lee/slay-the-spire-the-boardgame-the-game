import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { createRun } from '../src/game/run.ts'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const engine = process.argv.includes('--webkit') ? webkit : chromium
const browser = await engine.launch()
const out = `artifacts/hover-overflow/${engine.name()}`
mkdirSync(out, { recursive: true })

// Inspect nested scroll containers too: document-only bounds miss the Neow bug.
async function audit(page, selector, label) {
  const controls = page.locator(`${selector} button:enabled`)
  let checked = 0
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.activeElement?.blur())
    await control.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    const measure = element => {
      const result = [{ name: 'document', x: document.documentElement.scrollWidth > innerWidth + 1,
        y: document.documentElement.scrollHeight > innerHeight + 1 }]
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        result.push({ name: ancestor.className || ancestor.tagName,
          x: /auto|scroll/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1,
          y: /auto|scroll/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1 })
      }
      return result
    }
    const before = await control.evaluate(measure)
    for (const interaction of ['hover', 'focus']) {
      if (interaction === 'focus') await page.mouse.move(0, 0)
      await control[interaction]()
      await page.waitForTimeout(250)
      const after = await control.evaluate(measure)
      for (let i = 0; i < before.length; i++) {
        for (const axis of ['x', 'y']) assert(!after[i][axis] || before[i][axis],
          `${label}: ${interaction} ${await control.textContent()} created ${axis} scrolling in ${after[i].name}`)
      }
    }
    checked++
  }
  assert(checked > 0, `${label}: no controls audited`)
  await page.evaluate(() => document.activeElement?.blur())
  await controls.first().hover()
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/${label}.png` })
  console.log(`${label}: ${checked} controls, hover and focus stable`)
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    const page = installScreenAudit(await browser.newPage({ viewport,
      ...(viewport.width === 844 ? { isMobile: true, hasTouch: true } : {}) }))
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    for (const character of ['ironclad', 'guardian']) {
      const run = createRun(1, [{ id: 'p1', name: character, character }])
      run.neow.players.p1.redGoldPending = false
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.getByRole('button', { name: 'Reveal Card Reward', exact: true }).click()
      await page.locator('.reward-screen--card-choice').waitFor()
      await audit(page, '.reward-screen--card-choice', `${character}-reward-${viewport.width}`)
      run.neow.players.p1.redRewardPending = false
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.locator('.neow-options').waitFor()
      await audit(page, '.neow-action', `${character}-${viewport.width}`)
    }
    for (const kind of ['merchant', 'event', 'treasure', 'campfire']) {
      const run = createRun(1, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
      run.phase = 'room'
      run.neow = null
      run.players[0].gold = 30
      run.players[0].hp = 5
      if (kind === 'merchant') run.roomState = { kind, relics: ['anchor', 'happy_flower', 'akabeko'],
        potions: ['fire_potion', 'swift_potion', 'blood_potion'], colorless: [],
        cards: { p1: { choices: run.players[0].cardRewards.slice(0, 3), cardsDrawn: [], raresDrawn: [] } },
        removalUsed: [], purchasedCards: {} }
      if (kind === 'event') run.roomState = { kind, card: { id: 'big_fish', instanceId: 'hover-event', act: 1,
        minAscension: 0, requiresColorlessUnlock: false, name: 'Big Fish', scope: 'player',
        rule: 'Each player chooses a different option.', options: [
          { id: 'banana', label: 'Banana', description: 'Heal 2 HP.', effects: [{ tag: 'heal', amount: 2 }] },
          { id: 'box', label: 'Box', description: 'Gain a Relic. Gain a Curse.', effects: [{ tag: 'gain-relic' }, { tag: 'gain-curse' }] },
        ] }, decisions: {}, dieRolls: {} }
      if (kind === 'treasure') run.roomState = { kind, offers: { p1: 'anchor' }, playerIds: ['p1'], decisions: {} }
      if (kind === 'campfire') {
        run.map.position = run.map.rows[0][0]
        run.map.rooms[run.map.position].kind = 'campfire'
      }
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      if (kind === 'merchant') await page.getByRole('button', { name: 'Enter merchant shop' }).click()
      const selector = kind === 'campfire' ? '.campfire' : `.${kind}-stage`
      await page.locator(selector).waitFor()
      await audit(page, selector, `${kind}-${viewport.width}`)
      if (kind === 'merchant') {
        await page.getByRole('button', { name: /Card Removal Service/ }).click()
        await page.getByRole('group', { name: 'Card to remove' }).getByRole('button').first().click()
        await audit(page, '.merchant-removal-dialog', `removal-${viewport.width}`)
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      }
    }
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.phase = 'reward'
      run.combat = null
      run.rewardDestination = 'map'
      run.rewards = [{ playerId: 'p1', cardReward: true, choices: null, upgraded: false,
        gold: 8, potion: 'weak_potion', relic: 'anchor', bossRelics: false }]
      debug.setRun(run)
    })
    await page.locator('.reward-screen--loot').waitFor()
    await audit(page, '.reward-screen--loot', `loot-${viewport.width}`)
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
