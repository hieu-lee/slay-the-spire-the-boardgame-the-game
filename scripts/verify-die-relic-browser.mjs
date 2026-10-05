import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/die-relic'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = createRun(931, [{ id: viewerId, name: 'Ironclad', character: 'ironclad' }])
    const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
      actionIndex: 0, abilityUsed: true, dead: false }
    const second = { ...enemy, uid: 'e1' }
    run.combat = createCombat({ seed: 931, calls: 0 }, run.players, [enemy, second], `die-relic-${name}`)
    Object.assign(run.combat.players[0], { hand: [], powers: [], potions: [], relics: [
      { defId: 'dollys_mirror', spent: false }, { defId: 'red_mask', spent: false },
      { defId: 'necronomicon', spent: false }, { defId: 'gremlin_horn', spent: false },
      { defId: 'pen_nib', spent: false }, { defId: 'incense_burner', spent: false },
      { defId: 'charons_ashes', spent: false },
    ] })
    Object.assign(run.combat, { phase: 'start', die: 1, startTurnStage: 'effects',
      startTurnProgress: undefined, pendingTriggers: [], presentationEvents: [] })
    run.phase = 'combat'
    run.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    const mirror = page.locator('.relic-actions details').filter({ hasText: "Dolly's Mirror" })
    await mirror.locator('summary').click()
    const redMaskGroup = mirror.getByRole('group', { name: /Red Mask · die 5\/6/ })
    await redMaskGroup.waitFor({ state: 'visible' })
    const redMask = redMaskGroup.getByRole('button').first()
    assert.equal(await redMaskGroup.getByRole('button').count(), 2, `${name}: Red Mask should offer one chip per enemy`)
    assert.equal(await mirror.locator('.die-relic').count(), 7, `${name}: expected one tile per die Relic ability`)
    await redMask.scrollIntoViewIfNeeded()
    const bounds = await redMask.boundingBox()
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width &&
      bounds.y >= 0 && bounds.y + bounds.height <= height, `${name}: the Red Mask choice is clipped`)
    const panelBox = await page.locator('.relic-actions > section').boundingBox()
    assert(panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= width &&
      panelBox.y + panelBox.height <= height, `${name}: the die Relic panel runs off screen`)
    await page.screenshot({ path: `${out}/${name}-mirror-red-mask.png` })
    await redMask.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].relics[0].spent)
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].weak), 1,
      `${name}: selecting Red Mask did not apply Weak`)
    assert.equal(await mirror.count(), 0, `${name}: the spent Mirror still offers choices`)
    run.combat.players[0].relics[0].spent = false
    Object.assign(run.combat, { phase: 'player', die: 3 })
    run.combat.players[0].potions = ['destiny_draught']
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    await page.getByRole('button', { name: 'Use Destiny Draught' }).click()
    const destiny = page.getByRole('group', { name: /Red Mask · die 5\/6/ })
    await destiny.waitFor({ state: 'visible' })
    assert.equal(await destiny.getByRole('button').count(), 2, `${name}: Destiny Draught should offer one chip per enemy`)
    await page.screenshot({ path: `${out}/${name}-destiny-draught.png` })
    const duo = createRun(933, [{ id: viewerId, name: 'Ironclad', character: 'ironclad' },
      { id: 'p2', name: 'Hieu Le the Great', character: 'silent' }])
    duo.combat = createCombat({ seed: 933, calls: 0 }, duo.players, [enemy], `duo-${name}`)
    Object.assign(duo.combat.players[0], { hand: [], powers: [], potions: [], relics: [
      { defId: 'dollys_mirror', spent: false }, { defId: 'necronomicon', spent: false },
      { defId: 'incense_burner', spent: false },
    ] })
    Object.assign(duo.combat.players[1], { hand: [], powers: [], potions: [], relics: [
      { defId: 'necronomicon', spent: false },
    ] })
    Object.assign(duo.combat, { phase: 'start', die: 1, startTurnStage: 'effects',
      startTurnProgress: undefined, pendingTriggers: [], presentationEvents: [] })
    duo.phase = 'combat'
    duo.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), duo)
    const duoMirror = page.locator('.relic-actions details').filter({ hasText: "Dolly's Mirror" })
    await duoMirror.locator('summary').click()
    await duoMirror.locator('.die-relic-list--shared').waitFor()
    const owners = await duoMirror.locator('.die-relic__owner').allTextContents()
    assert.deepEqual(owners.sort(), ['Hieu Le the Great', 'Ironclad', 'Ironclad'].sort(), `${name}: owner labels`)
    const nameBoxes = await duoMirror.locator('.die-relic__name').evaluateAll(nodes =>
      nodes.map(node => node.getBoundingClientRect().height))
    assert(nameBoxes.every(box => box < 40), `${name}: a Relic name collapsed beside the owner label`)
    await page.screenshot({ path: `${out}/${name}-mirror-multiplayer.png` })

    const hermit = createRun(932, [{ id: viewerId, name: 'Hermit', character: 'hermit' }])
    hermit.combat = createCombat({ seed: 932, calls: 0 }, hermit.players, [enemy, second], `cheat-${name}`)
    hermit.combat.pendingHermitSetupLoads = []
    hermit.combat.die = 3
    Object.assign(hermit.combat.players[0], { hand: [], powers: [], potions: [], energy: 3,
      chamber: [{ uid: 'cheat', defId: 'hermit_cheat', upgraded: false }],
      relics: run.combat.players[0].relics.slice(1) })
    hermit.phase = 'combat'
    hermit.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), hermit)
    const chamber = page.getByRole('button', { name: /^Chamber,/ })
    if (await chamber.getAttribute('aria-expanded') !== 'true') await chamber.click()
    const cheat = page.locator('.hand .card--chamber-drawn')
    await cheat.click()
    const cheatPick = page.getByRole('group', { name: /Red Mask · die 5\/6/ })
    await cheatPick.waitFor({ state: 'visible' })
    await page.screenshot({ path: `${out}/${name}-cheat.png` })
    assert.equal(await cheatPick.getByRole('button').count(), 2, `${name}: Cheat should offer one chip per enemy`)
    await cheatPick.getByRole('button').first().click()
    await page.locator('.enemy:not(.enemy--dead) .enemy__head').first().click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[0].weak === 1)
    await page.screenshot({ path: `${out}/${name}-cheat-picked.png` })
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('✓ Dolly\'s Mirror offers and resolves Red Mask on desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
