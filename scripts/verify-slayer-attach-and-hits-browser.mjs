// Slayer Pack attach and hits choices in the real client, desktop (mouse/keyboard) and a
// horizontal phone (touch): attached cards on enemies, Pressure Points' Boss
// price, Bowling Bash's adjacent picks, Wave of the Hand's Stance choice, and
// the Nightmare+ / Ritual Dagger+ follow-up decisions, including the dagger's
// winning blow. Asserts game state; screenshots go to artifacts/ for review.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/slayer-attach-and-hits'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []

const enemy = (uid, over = {}) => ({ uid, defId: 'cultist', row: 0, isBoss: false,
  hp: 30, maxHp: 30, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
  goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: true, dead: false, ...over })
const boss = () => enemy('boss', { defId: 'hexaghost', isBoss: true, hp: 60, maxHp: 60 })

try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const touch = name !== 'desktop'
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: touch })
    page.setDefaultTimeout(30_000)
    page.on('pageerror', e => errors.push(`${name}: ${e}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`, { timeout: 120_000 })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)

    const stage = async (label, character, hand, enemies, over = {}, combatOver = {}) => {
      const run = createRun(917, [{ id: viewerId, name: 'Hero', character }, { id: 'ally', name: 'Ally', character: 'ironclad' }])
      run.combat = createCombat({ seed: 917, calls: 0 }, run.players, enemies, `slayer-attach-and-hits-${label}`)
      Object.assign(run.combat.players[0], { hand, draw: [], energy: 3, ...over })
      Object.assign(run.combat, combatOver)
      run.phase = 'combat'; run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(label => window.__STS_DEBUG__.getRun().combat?.combatId === `slayer-attach-and-hits-${label}`, label)
      await page.waitForTimeout(600)
      if (hand.length > 0) await assertHandClear()
    }
    // Every hand card is fully tappable: once the deal settles, nothing of the HUD sits over it.
    const assertHandClear = async () => {
      await page.waitForFunction(() => {
        const now = JSON.stringify([...document.querySelectorAll('.hand .card')].map((card) => {
          const box = card.getBoundingClientRect(); return [Math.round(box.x), Math.round(box.y)]
        }))
        const same = now === window.__g3HandLayout
        window.__g3HandLayout = now
        return same && !document.querySelector('.hand .card--drawn')
      }, undefined, { polling: 300 })
      const blocked = await page.evaluate(() => {
        const hud = [...document.querySelectorAll('.pile, .pip--energy, .combat__end-turn')].map((element) => element.getBoundingClientRect())
        return [...document.querySelectorAll('.hand .card')].flatMap((card, index) => {
          const box = card.getBoundingClientRect()
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          const covered = hud.some((other) => other.right > box.left && other.left < box.right &&
            other.bottom > box.top && other.top < box.bottom)
          return hit?.closest('.hand .card') && !covered ? [] : [`card ${index}: ${hit?.className}${covered ? ' (HUD box overlaps)' : ''}`]
        })
      })
      assert.deepEqual(blocked, [], 'no pile, Energy or End turn sits over a hand card')
    }
    const select = async (pattern) => {
      const card = page.getByRole('button', { name: pattern })
      if (touch) { await card.tap(); await card.tap() } else await card.press('Enter')
    }
    const targeted = (uid) => page.locator(`.enemy--targeted[data-enemy-id="${uid}"]`)
    // The painted rig overscans its button; the hit area is what takes the pointer.
    const pick = async (uid) => {
      const area = targeted(uid).locator('.enemy__hit-area')
      await (touch ? area.tap() : area.click())
    }
    const combat = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    const prompt = page.locator('.prompt')
    // Let the prompt and target glow finish fading in before the review screenshot.
    // A prompt is drawn above the stage: no enemy chip or sprite paints over its text, and
    // its backdrop is opaque enough that nothing behind shows through.
    const assertOnTop = async (locator) => {
      const report = await locator.evaluate((panel) => {
        const box = panel.getBoundingClientRect()
        const misses = []
        for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fy of [0.3, 0.5, 0.7]) {
          const hit = document.elementFromPoint(box.x + box.width * fx, box.y + box.height * fy)
          if (!hit || !panel.contains(hit)) misses.push(`${fx},${fy}:${hit?.className}`)
        }
        const style = getComputedStyle(panel)
        const channels = style.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? []
        const alpha = style.backgroundImage !== 'none' ? 1 : channels.length === 4 ? channels[3] : channels.length === 3 ? 1 : 0
        return { misses, alpha }
      })
      assert.deepEqual(report.misses, [], 'the prompt is on top of the stage')
      assert(report.alpha >= 0.85, `the prompt backdrop is opaque enough (${report.alpha})`)
    }
    const shot = async (label) => {
      // The played card flies to its pile over the prompt; shoot once it has landed.
      await page.waitForFunction(() => document.querySelectorAll('.card-flight-effect, .card-flight').length === 0,
        undefined, { timeout: 15_000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${out}/${name}-${label}.png` })
    }

    // Nightmare: the card leaves the hand and is shown on its enemy.
    await stage('nightmare', 'silent', [{ uid: 'nm', defId: 'slayer_nightmare', upgraded: false }],
      [enemy('e0'), enemy('e1', { row: 1 })])
    await select(/^Nightmare/)
    await pick('e0')
    await page.locator('.enemy[data-enemy-id="e0"] [data-slayer-attachment="slayer_nightmare"]').waitFor()
    assert.equal((await combat()).enemies[0].slayerAttachments[0].card.uid, 'nm')
    await shot('nightmare-attached')

    // Pressure Points: 1 Energy cannot reach the Boss; with 3 it costs 2 there.
    await stage('pressure-poor', 'watcher', [{ uid: 'pp', defId: 'slayer_pressure_points', upgraded: false }],
      [enemy('e0'), boss()], { energy: 1 })
    await select(/^Pressure Points/)
    await targeted('e0').waitFor()
    assert.match(await prompt.first().innerText(), /costs 2 Energy on a Boss/)
    assert.equal(await targeted('boss').count(), 0, 'an unaffordable Boss is not offered as a target')
    await page.locator('.enemy[data-enemy-id="boss"] .enemy__hit-area').click()
    assert.equal((await combat()).players[0].hand.length, 1, 'clicking the Boss does nothing')
    await shot('pressure-points-boss-unaffordable')
    await stage('pressure-rich', 'watcher', [{ uid: 'pp2', defId: 'slayer_pressure_points', upgraded: true }],
      [enemy('e0'), boss()])
    await select(/^Pressure Points/)
    await pick('boss')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    const rich = await combat()
    assert.equal(rich.players[0].energy, 1, 'the Boss price is 2')
    assert.equal(rich.enemies[1].slayerAttachments[0].card.uid, 'pp2')
    await page.locator('.enemy[data-enemy-id="boss"] [data-slayer-attachment="slayer_pressure_points"]').waitFor()
    await shot('pressure-points-on-boss')

    // Bowling Bash: target b, then two of its three neighbours.
    await stage('bowling', 'watcher', [{ uid: 'bb', defId: 'slayer_bowling_bash', upgraded: false }], [
      enemy('a'), enemy('b'), enemy('c'), enemy('d', { row: 1 }), enemy('e', { row: 1 }),
    ])
    await select(/^Bowling Bash/)
    await pick('b')
    await page.getByText(/choose adjacent enemy 1\/2/).waitFor()
    for (const uid of ['a', 'c', 'e']) assert.equal(await targeted(uid).count(), 1, `${uid} is adjacent to b`)
    assert.equal(await targeted('d').count(), 0, 'd is not adjacent to b')
    await shot('bowling-bash-adjacent')
    await pick('a')
    await page.getByText(/choose adjacent enemy 2\/2/).waitFor()
    assert.equal(await targeted('a').count(), 0, 'a chosen enemy cannot be picked twice')
    await pick('e')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    assert.deepEqual((await combat()).enemies.map(e => 30 - e.hp), [2, 2, 0, 0, 2])

    // Wave of the Hand+: the Stance is a printed choice, then the Weak's enemy.
    await stage('wave', 'watcher', [{ uid: 'wv', defId: 'slayer_wave_of_the_hand', upgraded: true }],
      [enemy('e0'), enemy('e1', { row: 1 })], { miracles: 0 })
    await select(/^Wave of the Hand/)
    await page.getByRole('button', { name: 'Miracle, Weak, enter Wrath' }).waitFor()
    await assertOnTop(prompt.filter({ has: page.getByRole('button', { name: 'Miracle, Weak, enter Wrath' }) }))
    await shot('wave-of-the-hand-modes')
    await page.getByRole('button', { name: 'Miracle, Weak, enter Wrath' }).click()
    await pick('e1')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    const waved = await combat()
    assert.equal(waved.players[0].stance, 'wrath')
    assert.equal(waved.players[0].miracles, 1, 'one Miracle')
    assert.deepEqual(waved.enemies.map(e => e.weak), [0, 1])

    // Nightmare+: its enemy dies with two others left; its owner picks the next.
    await stage('nightmare-plus', 'ironclad', [{ uid: 'st', defId: 'strike_ironclad', upgraded: true },
      { uid: 'spare', defId: 'defend_ironclad', upgraded: false }],
      [enemy('e0', { hp: 2, slayerAttachments: [{ card: { uid: 'nmp', defId: 'slayer_nightmare', upgraded: true }, playerId: viewerId }] }),
        enemy('e1'), enemy('e2', { row: 1 })])
    await select(/^Strike/)
    await pick('e0')
    const reattach = page.locator('[data-slayer-choice="reattach"]')
    await reattach.waitFor()
    await assertOnTop(reattach)
    await shot('nightmare-plus-reattach')
    await reattach.getByRole('button').last().click()
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingSlayerChoices)
    assert.equal((await combat()).enemies[2].slayerAttachments[0].card.uid, 'nmp')

    // An owed Nightmare+ choice arriving while a native modal (Distilled Chaos, Golden Eye Scry) is
    // open: the modal steps aside so the choice is clickable, and returns once it is answered.
    for (const [label, pendingKey, pending, dialogName] of [
      ['Distilled Chaos', 'pendingDistilled', { playerId: viewerId,
        cards: [{ uid: 'dc0', defId: 'strike_ironclad', upgraded: false }, { uid: 'dc1', defId: 'defend_ironclad', upgraded: false }] }, 'Distilled Chaos'],
      ['Golden Eye Scry', 'pendingRelicScry', { id: 1, playerId: viewerId, relicIndex: 0,
        cards: [{ uid: 'ge0', defId: 'strike_ironclad', upgraded: false }] }, /Golden Eye/],
    ]) {
      await stage(`owed-${pendingKey}`, 'ironclad', [], [enemy('e0', { dead: true, hp: 0 }), enemy('e1')], {}, { [pendingKey]: pending })
      const modal = page.getByRole('dialog', { name: dialogName })
      await modal.waitFor()
      assert(await modal.evaluate((el) => el.open && el.matches(':modal')), `${name} ${label} modal is open first`)
      await page.evaluate((choice) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        run.combat.pendingSlayerChoices = [choice]
        debug.setRun(run)
      }, { kind: 'reattach', playerId: viewerId, fromUid: 'e0', card: { uid: 'nmp', defId: 'slayer_nightmare', upgraded: true } })
      const owed = page.locator('[data-slayer-choice="reattach"]')
      await owed.waitFor()
      assert.equal(await page.locator('dialog:modal').count(), 0, `${name} ${label}: no modal blocks the owed choice`)
      await assertOnTop(owed)
      await owed.getByRole('button').last().click()
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingSlayerChoices)
      await page.waitForFunction(() => document.querySelector('dialog.distilled-choice:modal'))
      assert.deepEqual((await combat())[pendingKey].cards.map((card) => card.uid), pending.cards.map((card) => card.uid),
        `${name} ${label}: its cards were kept`)
    }

    // The same for the card reveal that native dialog hosts (Seek's draw-pile pick): an owed choice
    // (a teammate's Heel Hook, or Nightmare+ with an id) closes it so the answer is clickable, and the
    // reveal returns untouched once the choice is answered.
    for (const [label, owed, answer] of [
      ['Nightmare+', { pendingSlayerChoices: [{ id: 0, kind: 'reattach', playerId: viewerId, fromUid: 'e0',
        card: { uid: 'nmp', defId: 'slayer_nightmare', upgraded: true } }], nextPlayerChoiceId: 1 },
        async () => page.locator('[data-slayer-choice="reattach"]').getByRole('button').last().click()],
      ['Heel Hook', { pendingPlayerChoices: [{ id: 0, playerId: viewerId, sourceLabel: "Ally's Heel Hook", kind: 'drawOrDiscard' }],
        nextPlayerChoiceId: 1 },
        async () => page.getByRole('button', { name: 'Neither', exact: true }).click()],
    ]) {
      await stage(`owed-seek-${label}`, 'defect', [{ uid: 'sk', defId: 'seek', upgraded: false }],
        [enemy('e0', { dead: true, hp: 0 }), enemy('e1')], {
          draw: ['strike_defect', 'defend_defect', 'zap'].map((defId, index) => ({ uid: `sd${index}`, defId, upgraded: false })) })
      await select(/^Seek,/)
      const reveal = page.getByRole('dialog', { name: /Choose 1 from your draw pile/ })
      await reveal.waitFor()
      assert(await reveal.evaluate((el) => el.open && el.matches(':modal')), `${name} ${label}: the reveal is a modal first`)
      await page.evaluate((fields) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        Object.assign(run.combat, fields)
        debug.setRun(run)
      }, owed)
      await page.waitForFunction(() => !document.querySelector('dialog.choice-modal:modal'))
      assert.equal(await page.locator('dialog:modal').count(), 0, `${name} ${label}: no modal blocks the owed choice`)
      await answer()
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingSlayerChoices &&
        !window.__STS_DEBUG__.getRun().combat.pendingPlayerChoices)
      await page.waitForFunction(() => document.querySelector('dialog.choice-modal:modal'))
      assert.equal(await reveal.locator('.choice-modal__cards .card').count(), 3, `${name} ${label}: its three cards were kept`)
      await reveal.locator('.choice-modal__cards .card').first().click()
      await reveal.locator('.choice-modal__panel > button').click()
      await page.waitForFunction(() => !document.querySelector('dialog.choice-modal:modal'))
      assert.equal((await combat()).players[0].hand.length, 1, `${name} ${label}: Seek then took its pick into the hand`)
    }

    // Ritual Dagger+: a kill reveals the top rare to its owner, who Replaces the dagger.
    await stage('dagger', 'ironclad', [{ uid: 'rd', defId: 'slayer_ritual_dagger', upgraded: true }],
      [enemy('e0', { hp: 3 }), enemy('e1', { row: 1 })], { rareRewards: ['offering', 'barricade'] })
    await select(/^Ritual Dagger/)
    await pick('e0')
    const reveal = page.locator('[data-slayer-choice="ritualDagger"]')
    await reveal.waitFor()
    await assertOnTop(reveal)
    assert.match(await reveal.innerText(), /You reveal Offering/)
    // The panel holds the card at reading size, with both answers together and thumb-sized.
    const revealedCard = await reveal.locator('.card').boundingBox()
    assert(revealedCard.width >= 140, `the revealed card is readable (${revealedCard.width}px wide)`)
    const [bottom, replace] = await Promise.all(['Put it on the bottom of your rare deck', 'Replace Ritual Dagger with it']
      .map((label) => reveal.getByRole('button', { name: label }).boundingBox()))
    for (const box of [bottom, replace]) assert(box.height >= 44 && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height)
    assert(Math.abs(bottom.x - replace.x) < 2 && replace.y - (bottom.y + bottom.height) < 16, 'the two answers sit together')
    await shot('ritual-dagger-reveal')
    await reveal.getByRole('button', { name: 'Replace Ritual Dagger with it' }).click()
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingSlayerChoices)
    const swapped = await combat()
    assert.deepEqual(swapped.players[0].exhaust.map(c => c.defId), ['offering'])
    assert.deepEqual(swapped.players[0].rareRewards, ['barricade'])

    // ...and on the winning blow the victory waits for the answer.
    await stage('dagger-win', 'ironclad', [{ uid: 'rd2', defId: 'slayer_ritual_dagger', upgraded: true }],
      [enemy('e0', { hp: 3 })], { rareRewards: ['offering', 'barricade'] })
    await select(/^Ritual Dagger/)
    await pick('e0')
    await reveal.waitFor()
    await page.waitForTimeout(1500)
    const waiting = await page.evaluate(() => window.__STS_DEBUG__.getRun())
    assert.equal(waiting.phase, 'combat', 'the fight does not fold into the run before the owner answers')
    assert.equal(waiting.combat.phase, 'won')
    await shot('ritual-dagger-winning-blow')
    await reveal.getByRole('button', { name: 'Put it on the bottom of your rare deck' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat === null)
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].rareRewards.slice(0, 2)),
      ['barricade', 'offering'])

    // Someone else's open choice: a visible waiting banner, and Victory stays explained.
    const banner = page.locator('[data-slayer-waiting]')
    const allyReveal = { kind: 'ritualDagger', playerId: 'ally', cardUid: 'ally-rd', revealed: 'offering' }
    await stage('ally-choice', 'ironclad', [{ uid: 'wait-strike', defId: 'strike_ironclad', upgraded: false }],
      [enemy('e0'), enemy('e1', { row: 1 })], {}, { pendingSlayerChoices: [allyReveal] })
    await banner.waitFor()
    assert.equal(await banner.innerText(), 'Waiting for Ally to resolve Ritual Dagger+')
    const box = await banner.boundingBox()
    assert(box.width > 150 && box.height > 20 && box.y >= 0 && box.y + box.height <= height, `the banner is really visible ${JSON.stringify(box)}`)
    assert.equal(await page.locator('[data-slayer-choice]').count(), 0, 'the reveal itself stays private')
    await shot('waiting-for-ally')
    await stage('ally-choice-won', 'ironclad', [], [enemy('e0', { dead: true, hp: 0 })], {},
      { phase: 'won', pendingSlayerChoices: [allyReveal] })
    await page.getByText('Waiting for Ally to resolve Ritual Dagger+ before the party moves on').waitFor()
    const after = await banner.boundingBox()
    const title = await page.locator('.combat__result--won').boundingBox()
    assert(title, 'Victory is still announced')
    assert(after.height > 20 && after.y >= title.y + title.height - 1, 'the banner sits below the Victory title, not across it')
    await shot('waiting-for-ally-after-victory')
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Slayer attach and hits UI passed: attachments, Pressure Points Boss price, Bowling Bash picks, Wave Stance, Nightmare+ and Ritual Dagger+ choices on desktop and landscape touch.')
} finally { await browser.close(); await server.close() }
