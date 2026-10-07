// Kratos's Rage of Sparta meter in the real combat screen: it appears only for
// Kratos, fills with Rage, docks beside the Energy orb without covering a full
// hand, four enemies or the piles, and its Hold toggle reaches the played
// card's action, switches back off, and resets for the next combat.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/rage-meter/browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const origin = `http://localhost:${server.httpServer.address().port}`

// Renders the production CombatScreen and applies plays through the engine, recording each action.
async function installRageFixture() {
  document.querySelector('#root').style.display = 'none'
  const node = document.createElement('div')
  node.className = 'app-shell app-shell--combat sts-scope'
  node.style.gridTemplateRows = 'minmax(0, 1fr)'
  document.body.append(node)
  const [R, D, DOM, { CombatScreen }, { createPlayer }, { createCombat, playCard }, { createRng }] = await Promise.all([
    import('/@id/react'), import('/@id/react-dom/client'), import('/@id/react-dom'),
    import('/src/ui/CombatScreen.tsx'), import('/src/game/run.ts'), import('/src/game/combat.ts'),
    import('/src/game/rng.ts'), import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
  ])
  const root = (D.createRoot ?? D.default.createRoot)(node)
  const flushSync = DOM.flushSync ?? DOM.default.flushSync
  const f = window.rageFixture = { actions: [] }
  f.render = () => flushSync(() => root.render((R.createElement ?? R.default.createElement)(CombatScreen, {
    state: structuredClone(f.state), act: 1, viewerId: 'p1', autoAdvance: false,
    onAction: async (action) => {
      f.actions.push(action)
      if (action.kind === 'playCard') {
        const { kind: _kind, cardUid, preflight: _p, expectedShivOverflow: _e, skipOverflow: _s, copyId: _c, ...context } = action
        f.state = playCard(f.state, 'p1', cardUid, context)
        f.render()
      }
      return { status: 'ok' }
    },
  })))
  f.reset = (character, rage, hand, extra = {}) => {
    const rng = createRng(47)
    const player = createPlayer(rng, 'p1', 'MeterTest', character, 0)
    Object.assign(player, { draw: [], relics: [], energy: 3, rage,
      hand: hand.map((defId, index) => ({ uid: `h${index}`, defId, upgraded: false })), ...extra })
    const enemies = Array.from({ length: 4 }, (_, i) => ({ uid: `enemy-${i}`, defId: 'jaw_worm', row: 0, isBoss: false,
      hp: 30, maxHp: 30, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      actionIndex: 0, abilityUsed: true, dead: false }))
    f.combats = (f.combats ?? 0) + 1
    f.state = createCombat(rng, [player], enemies, `rage-meter-${f.combats}`)
    f.state.phase = 'player'
    f.state.presentationEvents = []
    f.actions = []
    f.render()
  }
  f.setRage = (rage) => { f.state.players[0].rage = rage; f.render() }
}

const rect = (page, selector, pick = 'first') => page.locator(selector)[pick]().evaluate((node) => {
  const box = node.getBoundingClientRect()
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
})
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const fullHand = ['kratos_spartan_guard', 'kratos_plume_of_prometheus',
  ...Array.from({ length: 4 }, () => ['strike_kratos', 'defend_kratos']).flat()]

// The meter sits just right of `neighbor` and covers no card, pile, End turn, health bar or Chamber.
async function assertDocked(page, screen, neighbor) {
  await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 10)
  await page.waitForTimeout(600)
  const box = await rect(page, '.rage-meter')
  const left = await rect(page, neighbor)
  assert(box.left >= left.right && box.left - left.right < 40 && box.top < left.bottom && box.bottom > left.top,
    `${screen}: meter docks beside ${neighbor} ${JSON.stringify({ box, left })}`)
  const others = await page.locator('.hand .card, .pile, .combat__end-turn, .bar, .hermit-chamber-trigger, .pip--energy')
    .evaluateAll((nodes) => nodes.map((node) => {
      const b = node.getBoundingClientRect()
      return { name: node.className, left: b.left, top: b.top, right: b.right, bottom: b.bottom }
    }))
  for (const other of others) assert(!overlaps(box, other), `${screen}: meter overlaps ${other.name}`)
  return box
}

const browser = await chromium.launch({ headless: true })
const errors = []
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['short-desktop', { width: 1366, height: 650 }],
    ['horizontal-phone', { width: 844, height: 390 }]]) {
    const phone = screen === 'horizontal-phone'
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${screen}: ${error}`))
    await page.goto(origin)
    await page.evaluate(installRageFixture)

    await page.evaluate(() => window.rageFixture.reset('ironclad', 0, ['strike_ironclad']))
    assert.equal(await page.locator('.rage-meter').count(), 0, `${screen}: only Kratos gets a Rage meter`)

    // A full ten-card hand against four enemies is the most crowded board.
    await page.evaluate((hand) => window.rageFixture.reset('kratos', 0, hand), fullHand)
    await page.evaluate(() => document.fonts.ready)
    const meter = page.locator('.rage-meter')
    await meter.waitFor()
    const level = () => meter.locator('.rage-meter__level').evaluate((node) => Number(node.getAttribute('y')))
    const empty = await level()
    for (const rage of [1, 3, 5]) {
      await page.evaluate((value) => window.rageFixture.setRage(value), rage)
      assert.equal(await meter.getAttribute('data-rage'), String(rage), `${screen}: meter reports Rage ${rage}`)
      assert.equal(await meter.locator('.rage-meter__count').textContent(), String(rage))
    }
    assert(await level() < empty, `${screen}: molten fill rises with Rage`)
    assert.equal(await meter.getAttribute('data-full'), 'true', `${screen}: a full meter burns`)

    // Docked beside the Energy orb like the Hermit's Chamber, clear of everything else, and clickable.
    // Phones zoom the stage, so compare against the orb rather than viewport pixels.
    await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 10)
    await page.waitForTimeout(600)
    const box = await assertDocked(page, screen, '.pip--energy')
    assert(await page.evaluate(() => {
      const button = document.querySelector('.rage-meter')
      const b = button.getBoundingClientRect()
      return button.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height * 0.7))
    }), `${screen}: nothing covers the meter`)
    await page.screenshot({ path: resolve(output, `${screen}.png`) })

    // Holding Rage reaches the play: Spartan Guard keeps its Rage and gains only its base Block.
    // The damage badges follow too: Plume of Prometheus drops from its Unleash 5 to its base 1.
    await page.evaluate(() => window.rageFixture.setRage(2))
    const plumeDamage = page.locator('.hand .card').nth(1).locator('.card__live-damage')
    assert.equal(await plumeDamage.textContent(), '5', `${screen}: Plume previews its Unleash damage`)
    await meter.click()
    assert.equal(await meter.getAttribute('aria-pressed'), 'true', `${screen}: Hold toggles on`)
    assert.equal(await plumeDamage.textContent(), '1', `${screen}: held Rage previews Plume without Unleash`)
    await page.locator('.hand .card').first().click()
    await page.waitForFunction(() => window.rageFixture.actions.some((action) => action.kind === 'playCard'))
    const played = await page.evaluate(() => {
      const f = window.rageFixture
      return { action: f.actions.find((action) => action.kind === 'playCard'), rage: f.state.players[0].rage, block: f.state.players[0].block }
    })
    assert.equal(played.action.holdRage, true, `${screen}: the play carries holdRage`)
    assert.deepEqual([played.rage, played.block], [2, 2], `${screen}: held Rage is kept and Unleash skipped`)
    await meter.screenshot({ path: resolve(output, `${screen}-held.png`) })

    // Off again, the next play Unleashes: Spartan Guard spends 2 Rage for 6 Block.
    await meter.click()
    assert.equal(await meter.getAttribute('aria-pressed'), 'false', `${screen}: Hold toggles off`)
    await page.evaluate(() => window.rageFixture.reset('kratos', 2, ['kratos_spartan_guard']))
    await page.locator('.hand .card').first().click()
    await page.waitForFunction(() => window.rageFixture.actions.some((action) => action.kind === 'playCard'))
    const unleashed = await page.evaluate(() => {
      const f = window.rageFixture
      return { action: f.actions.find((action) => action.kind === 'playCard'), rage: f.state.players[0].rage, block: f.state.players[0].block }
    })
    assert.equal(unleashed.action.holdRage, undefined, `${screen}: an unheld play sends no holdRage`)
    assert.deepEqual([unleashed.rage, unleashed.block], [0, 6], `${screen}: Unleash spends Rage when not held`)

    // Hold belongs to one combat: the next fight starts unleashing again.
    await meter.click()
    assert.equal(await meter.getAttribute('aria-pressed'), 'true')
    await page.evaluate(() => window.rageFixture.reset('kratos', 2, ['kratos_spartan_guard']))
    assert.equal(await meter.getAttribute('aria-pressed'), 'false', `${screen}: Hold resets for a new combat`)

    // A Kratos with Chamber slots (Corrupted Shard) keeps both pieces side by side.
    await page.evaluate((hand) => window.rageFixture.reset('kratos', 3, hand, { chamberSlots: 1 }), fullHand)
    await assertDocked(page, `${screen} with a Chamber`, '.hermit-chamber-trigger')
    await page.screenshot({ path: resolve(output, `${screen}-chamber.png`) })
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log('rage meter: Kratos-only, fills with Rage, docks clear beside the Energy orb, and Hold reaches the play and resets per combat on desktop, short desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
