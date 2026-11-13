import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat/create.ts'
import { GAME_SETTINGS_KEY } from '../src/ui/game-settings.ts'

const out = 'artifacts/act-four-facing'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const errors = [], problems = []
const check = (condition, message) => { if (!condition) problems.push(message) }
const card = (uid, defId) => ({ uid, defId, upgraded: false })
try {
  for (const [screen, width, height, phone] of [['desktop', 1440, 900, false], ['phone', 844, 390, true],
    ['phone-small', 667, 375, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' })
    await context.addInitScript(key => localStorage.setItem(key, JSON.stringify({ reducedMotion: true, bgmVolume: 0, sfxVolume: 0 })), GAME_SETTINGS_KEY)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { timeout: 60_000 })
    await setTestUsername(page, 'Viet')
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
      await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    let fixture = 0
    const state = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    async function load({ count = 1, phase = 'player', side = 'shield', ordinary = false, survivor } = {}) {
      const names = ['Viet', 'Ann', 'Bo', 'Chi'], characters = ['silent', 'ironclad', 'defect', 'watcher']
      const run = createRun(47, names.slice(0, count).map((name, index) => ({ id: index ? `p${index + 1}` : viewerId, name, character: characters[index] })))
      run.act = ordinary ? 1 : 4; run.ascension = ordinary ? 0 : 11; run.phase = 'combat'; run.neow = null
      const base = { isBoss: false, ascension: 11, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
        goldReward: 0, cardReward: null, actionIndex: phase === 'start' ? 0 : 1, abilityUsed: false, dead: false }
      const enemies = ordinary ? [{ ...base, ascension: 0, uid: 'nob', defId: 'gremlin_nob', row: 0, hp: 20, maxHp: 20 }] : [
        { ...base, uid: 'spear', defId: 'spire_spear', row: 3, hp: 42, maxHp: 42 },
        { ...base, uid: 'shield', defId: 'spire_shield', row: 0, hp: 3, maxHp: 30 },
      ]
      run.combat = createCombat(run.rng, run.players, enemies, `facing-${fixture++}`)
      if (survivor) Object.assign(run.combat.enemies.find(enemy => enemy.uid !== survivor), { dead: true, hp: 0 })
      Object.assign(run.combat, { phase, turn: 2, die: 4, startTurnStage: phase === 'start' ? 'facing' : undefined })
      run.combat.players.forEach((player, index) => Object.assign(player, {
        row: ordinary ? 0 : count === 1 ? side === 'shield' ? 1 : 2 : count === 2 ? index + 1 : index,
        facingEnemyUid: ordinary || phase === 'start' ? null : count === 1 ? side : index < count / 2 ? 'shield' : 'spear',
        hp: 8, maxHp: 8, energy: 3, strength: phase === 'player' ? 2 : 0, vulnerable: phase === 'player' ? 1 : 0,
        strengthLossAtEndOfTurn: phase === 'player' ? 2 : 0,
        hand: [card(`idle-${index}`, `defend_${characters[index]}`), card(`strike-${index}`, `strike_${characters[index]}`)], draw: [], discard: [], exhaust: [], powers: [], relics: [], potions: [],
      }))
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(id => window.__STS_DEBUG__.getRun().combat?.combatId === id &&
        document.querySelectorAll('.seat[data-player-id]').length === window.__STS_DEBUG__.getRun().combat.players.length,
      run.combat.combatId)
      await page.locator('.seat__portrait > img, .enemy__art--cutout').evaluateAll(images => Promise.all(images.map(image => image.decode())))
      await page.waitForFunction(() => !document.querySelector('.combat').getAnimations().some(animation => animation.playState === 'running'))
    }
    const activate = locator => phone ? locator.tap() : locator.click()
    const enemy = uid => page.locator(`[data-enemy-id="${uid}"]`)
    const target = uid => activate(enemy(uid).locator('.enemy__hit-area'))
    const resolve = () => activate(page.getByRole('button', { name: 'Resolve start of turn', exact: true }))
    const playerPhase = () => page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    async function inspect(screen, label, { cues = 0, rowLabels = 0 } = {}) {
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `${out}/${screen}-${label}.png` })
      check(!/empty row|Player [1-4]/.test(await page.locator('.board').innerText()), `${screen}/${label}: placeholder seats or player labels are painted`)
      check(await page.locator('.enemy__row').count() === rowLabels, `${screen}/${label}: the enemy row label does not match its real occupant`)
      const boxes = await page.locator('.seat .bar, .enemy:not(.enemy--dead) .bar').evaluateAll(bars => bars.map(bar => {
        const r = bar.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
      }))
      const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      check(boxes.every(box => box.x >= 0 && box.y >= 0 && box.right <= width && box.bottom <= height), `${screen}/${label}: an HP band leaves the viewport`)
      check(boxes.every((box, index) => boxes.every((other, j) => index === j || box.right <= other.x || other.right <= box.x || box.bottom <= other.y || other.bottom <= box.y)), `${screen}/${label}: actor HP bands overlap`)
      check(await page.locator('.seat__facing').count() === cues, `${screen}/${label}: current Facing choices are not visible on the real heroes`)
      const cueBounds = await page.locator('.seat__facing').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(), clip = element.parentElement.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && box.left >= clip.left && box.right <= clip.right + 1
      }))
      check(cueBounds.every(Boolean), `${screen}/${label}: a Facing cue is clipped`)
      const targets = await page.locator('.enemy:not(.enemy--dead) .enemy__hit-area').evaluateAll(elements =>
        elements.map(element => { const box = element.getBoundingClientRect(); return box.width * visualViewport.scale >= 44 && box.height * visualViewport.scale >= 44 }))
      check(targets.every(Boolean), `${screen}/${label}: an enemy is too small to tap`)
      const intents = await page.locator('.enemy:not(.enemy--dead) .enemy__intent').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(), board = element.closest('.board').getBoundingClientRect()
        return { top: box.top, bottom: box.bottom, boardTop: board.top, boardBottom: board.bottom,
          scale: getComputedStyle(element).getPropertyValue('--stage-scale'),
          artHeight: getComputedStyle(element).getPropertyValue('--elite-art-height'),
          headHeight: getComputedStyle(element).getPropertyValue('--elite-head-height') }
      }))
      check(intents.every(box => box.top >= box.boardTop && box.bottom <= box.boardBottom), `${screen}/${label}: an intent is clipped ${JSON.stringify(intents)}`)
    }
    await load()
    await inspect(screen, 'solo-shield', { cues: 1 })
    assert.match(await page.locator('.seat').getAttribute('aria-label'), /Facing Spire Shield/)
    check(/16/.test(await enemy('shield').locator('.enemy__intent').innerText()), `${screen}: Shield intent ignores its actual Vulnerable target in row 2`)
    const strike = page.locator('.hand .card[data-card-name="Strike"]')
    await activate(strike)
    if (phone) {
      assert(await strike.evaluate(card => document.activeElement === card), 'the first tap must reveal the card')
      await activate(strike)
    }
    await page.locator('[data-enemy-id="shield"].enemy--targeted').waitFor()
    await target('shield')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies.find(enemy => enemy.uid === 'shield').dead)
    assert.equal((await state()).enemies.find(enemy => enemy.uid === 'spear').hp, 42, 'the Shield click hit Spear')
    await inspect(screen, 'spear-survivor')

    await load({ phase: 'start', side: 'spear' })
    await target('spear'); await resolve(); await playerPhase()
    assert.equal((await state()).players[0].facingEnemyUid, 'spear')
    assert.equal((await state()).players[0].hand.concat((await state()).players[0].draw, (await state()).players[0].discard).filter(card => card.defId === 'burn').length, 2)
    await inspect(screen, 'solo-spear', { cues: 1 })

    for (const survivor of ['shield', 'spear']) {
      await load({ phase: 'start', survivor })
      await activate(page.getByRole('button', { name: 'Face away', exact: true }))
      await resolve(); await playerPhase()
      const away = (await state()).players[0]
      assert.equal(away.facingEnemyUid, null)
      assert.equal(away.energy, 3)
      assert.equal(away.hand.concat(away.draw, away.discard).filter(card => card.defId === 'burn').length, 0)
      await inspect(screen, `away-from-${survivor}`, { cues: 1 })
      assert.match(await page.locator('.seat').getAttribute('aria-label'), /Facing away from Spire/)
    }

    await load({ count: 2 })
    await inspect(screen, 'two-player', { cues: 2 })

    await load({ count: 4, phase: 'start' })
    assert.equal(await page.getByRole('button', { name: 'Face away', exact: true }).count(), 0, 'both elites alive must require choosing a side')
    await page.getByRole('status').filter({ hasText: /^Viet — choose Facing$/ }).waitFor()
    await inspect(screen, 'facing-choice')
    await target('shield')
    await page.getByRole('status').filter({ hasText: /^Ann — choose Facing$/ }).waitFor()
    await target('shield')
    assert(await enemy('shield').isDisabled(), 'a third player can choose the full Shield side')
    assert(!(await enemy('spear').isDisabled()), 'Spear was disabled before its two slots were filled')
    await target('spear'); await target('spear'); await resolve(); await playerPhase()
    assert.deepEqual((await state()).players.map(player => player.facingEnemyUid), ['shield', 'shield', 'spear', 'spear'])
    assert.deepEqual((await state()).players.map(player => player.energy), [2, 2, 3, 3])
    await inspect(screen, 'four-player', { cues: 4 })
    assert.equal(await page.locator('.seat[data-player-id="p3"] .seat__facing').getAttribute('title'), 'Facing Spire Spear')
    await load({ count: 4, phase: 'start', survivor: 'spear' })
    const away = page.getByRole('button', { name: 'Face away', exact: true })
    await activate(away); await activate(away)
    assert(await away.isDisabled(), 'a third player can face away into a full side')
    await target('spear'); await target('spear'); await resolve(); await playerPhase()
    assert.deepEqual((await state()).players.map(player => player.facingEnemyUid), [null, null, 'spear', 'spear'])
    assert.deepEqual((await state()).players.map(player => player.hand.concat(player.draw, player.discard).filter(card => card.defId === 'burn').length), [0, 0, 2, 2])
    await inspect(screen, 'survivor-capacity', { cues: 4 })

    await load({ count: 4 })
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.combat.players[1].vulnerable = 0
      window.__STS_DEBUG__.setRun(run)
      window.__STS_DEBUG__.setViewer('p2')
    })
    await page.waitForFunction(() => document.querySelector('.row--viewer .seat')?.dataset.playerId === 'p2')
    assert.match(await enemy('shield').locator('.enemy__intent').innerText(), /^8\b/, 'Shield must preview the current viewer, ahead of a Vulnerable teammate')
    await inspect(screen, 'teammate-view', { cues: 4 })
    await page.evaluate(id => window.__STS_DEBUG__.setViewer(id), viewerId)

    await load({ ordinary: true })
    await inspect(screen, 'ordinary-elite', { rowLabels: 1 })
    assert.equal(await enemy('nob').locator('.enemy__row').innerText(), 'Viet')
    console.log(`${screen}: solo, last survivor, four-player capacity and viewer-specific Facing exercised`)
    await context.close()
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(problems, [])
  console.log('✓ Act IV Facing: no phantom seats, accurate intents, readable heroes and real capacity/penalty choices on desktop and horizontal phone')
} catch (error) {
  if (errors.length) console.error(errors)
  throw error
} finally {
  await browser.close()
  await server.close()
}
