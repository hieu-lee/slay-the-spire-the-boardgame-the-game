import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { enterRoom, roomChoices } from '../src/game/run.ts'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(repoRoot, 'artifacts/stable-hero-browser')
mkdirSync(output, { recursive: true })
let fixture = postNeowRun(1, [{ id: 'p1', name: 'Defect', character: 'defect' }])
fixture = enterRoom(fixture, roomChoices(fixture)[0].id)
if (!fixture.combat) throw new Error('stable-hero fixture did not enter combat')

const server = await createServer({ root: repoRoot, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(String(error)))
suite('stable combat hero')

await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')

const installCombat = async (enemyCount, suffix) => {
  await page.evaluate(({ source, enemyCount, suffix }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(source)
    const enemy = run.combat.enemies[0]
    run.combat.combatId = `${run.combat.combatId}-${suffix}`
    run.combat.phase = 'player'
    run.combat.players[0].character = 'defect'
    run.combat.players[0].dead = false
    run.combat.presentationEvents = []
    run.combat.enemies = Array.from({ length: enemyCount }, (_, index) => ({
      ...enemy, uid: `stable-enemy-${suffix}-${index}`, row: 0, isBoss: false,
      hp: enemy.maxHp, dead: false,
    }))
    debug.setRun(run)
  }, { source: fixture, enemyCount, suffix })
  await page.locator('.combat').waitFor()
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}

const heroGeometry = () => page.locator('.seat[data-player-id="p1"]').evaluate((seat) => {
  const portrait = seat.querySelector('.seat__portrait > img')
  const rect = portrait.getBoundingClientRect()
  const style = getComputedStyle(portrait)
  return {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    transform: style.transform, animation: style.animationName,
    stageWidth: getComputedStyle(seat.closest('.combat')).getPropertyValue('--stage-width'),
  }
})
const sameGeometry = (before, after) => ['x', 'y', 'width', 'height']
  .every((key) => Math.abs(before[key] - after[key]) <= 0.5)

await installCombat(8, 'desktop')
const desktopBaseline = await heroGeometry()
const nonAttackEvents = [
  { kind: 'orb', sourceId: 'orb-end-turn', orb: 'lightning', enemy: true },
  { kind: 'potion', sourceId: 'block_potion', enemy: false },
  { kind: 'card', sourceId: 'defend_defect', upgraded: false, copied: false, energy: 1, enemy: false },
  { kind: 'card', sourceId: 'deadly_poison', upgraded: false, copied: false, energy: 1, enemy: true },
]
const motionResults = []
for (const [index, definition] of nonAttackEvents.entries()) {
  const seq = 2_100_000 + index
  await page.evaluate(({ definition, seq }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies.find((enemy) => !enemy.dead)
    const { enemy, ...event } = definition
    run.combat.presentationEvents = [...run.combat.presentationEvents, {
      ...event, seq, actorId: actor.id, enemyIds: enemy ? [target.uid] : [], playerIds: [],
    }]
    debug.setRun(run)
  }, { definition, seq })
  await page.locator(`.combat-vfx[data-vfx-seq="${seq}"]`).first().waitFor()
  await page.waitForTimeout(80)
  motionResults.push({ sourceId: definition.sourceId, geometry: await heroGeometry(),
    attackLayers: await page.locator('.character-attack').count() })
}
check('non-attack combat effects never move or remount the hero', () => {
  for (const result of motionResults) {
    assert(sameGeometry(desktopBaseline, result.geometry),
      `${result.sourceId} moved the hero: ${JSON.stringify({ desktopBaseline, result })}`)
    assertEqual(result.geometry.transform, 'none', `${result.sourceId} transformed the hero portrait`)
    assertEqual(result.geometry.animation, 'none', `${result.sourceId} animated the hero portrait`)
    assertEqual(result.attackLayers, 0, `${result.sourceId} created an attack layer`)
  }
})

await installCombat(8, 'non-attack-cancels-attack')
const replacementBaseline = await heroGeometry()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const target = run.combat.enemies[0]
  run.combat.presentationEvents = [{
    seq: 2_200_000, kind: 'card', actorId: actor.id, sourceId: 'strike_defect',
    enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1,
  }]
  debug.setRun(run)
})
await page.locator('.character-attack').waitFor()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  run.combat.presentationEvents.push({
    seq: 2_200_001, kind: 'card', actorId: actor.id, sourceId: 'defend_defect',
    enemyIds: [], playerIds: [actor.id], upgraded: false, copied: false, energy: 1,
  })
  debug.setRun(run)
})
await page.locator('.combat-vfx[data-vfx-seq="2200001"]').waitFor()
await page.waitForTimeout(80)
const replacement = {
  geometry: await heroGeometry(),
  attackLayers: await page.locator('.character-attack').count(),
}
check('a newer non-attack effect clears an old attack without moving the hero', () => {
  assertEqual(replacement.attackLayers, 0)
  assert(sameGeometry(replacementBaseline, replacement.geometry),
    `Defend moved the hero: ${JSON.stringify({ replacementBaseline, replacement })}`)
  assertEqual(replacement.geometry.animation, 'none')
  assertEqual(replacement.geometry.transform, 'none')
})

const killFirstEnemy = async () => {
  const enemyId = await page.locator('.enemy').first().getAttribute('data-enemy-id')
  await page.evaluate((enemyId) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
    enemy.hp = 0
    enemy.dead = true
    debug.setRun(run)
  }, enemyId)
  await page.locator(`.enemy[data-enemy-id="${enemyId}"]`).waitFor({ state: 'detached', timeout: 3_000 })
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}
await killFirstEnemy()
const desktopAfterDeath = await heroGeometry()
check('an enemy disappearing does not move the desktop hero', () => {
  assert(sameGeometry(replacementBaseline, desktopAfterDeath),
    `enemy death moved the hero: ${JSON.stringify({ replacementBaseline, desktopAfterDeath })}`)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => !candidate.dead)
  run.combat.enemies.push({ ...enemy, uid: 'stable-enemy-summoned', hp: enemy.maxHp, dead: false })
  debug.setRun(run)
})
await page.locator('.enemy[data-enemy-id="stable-enemy-summoned"]').waitFor()
await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
const desktopAfterSummon = await heroGeometry()
check('an enemy appearing does not move the desktop hero', () => {
  assert(sameGeometry(desktopAfterDeath, desktopAfterSummon),
    `enemy summon moved the hero: ${JSON.stringify({ desktopAfterDeath, desktopAfterSummon })}`)
  assertEqual(desktopAfterSummon.stageWidth, desktopAfterDeath.stageWidth,
    'a replacement summon added a phantom stage slot')
})
await page.locator('.combat').screenshot({ path: join(output, 'stable-hero-desktop-after-enemy-lifecycle.png') })

await page.setViewportSize({ width: 844, height: 390 })
await installCombat(4, 'horizontal-phone')
const phoneBaseline = await heroGeometry()
await killFirstEnemy()
const phoneAfterDeath = await heroGeometry()
check('an enemy disappearing does not move the horizontal-phone hero', () => {
  assert(sameGeometry(phoneBaseline, phoneAfterDeath),
    `phone enemy death moved the hero: ${JSON.stringify({ phoneBaseline, phoneAfterDeath })}`)
})
await page.locator('.combat').screenshot({ path: join(output, 'stable-hero-horizontal-phone-after-enemy-death.png') })
check('stable-hero fixtures reported no browser errors', () => assertEqual(errors.length, 0, errors.join('\n')))

await browser.close()
await server.close()
report('stable combat hero')
