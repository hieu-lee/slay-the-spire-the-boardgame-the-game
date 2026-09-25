import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/hermit-combo-audit'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
const c = (uid, defId) => ({ uid, defId, upgraded: false })
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const combat = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    let triggerId = 77
    async function load(power = 'hermit_combo', { upgraded = false, extraHand = 0, chamberSlots = 2 } = {}) {
      const run = createRun(908, [{ id: viewerId, name: 'Hermit', character: 'hermit' }])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      run.combat = createCombat({ seed: 908, calls: 0 }, run.players, [enemy, { ...enemy, uid: 'e1', row: 1 }], 'audit')
      run.combat.pendingHermitSetupLoads = []
      Object.assign(run.combat.players[0], {
        hand: [c('h1', 'hermit_strike'), c('h2', 'hermit_defend'), c('h3', 'hermit_strike'), c('h4', 'hermit_grudge'),
          ...Array.from({ length: extraHand }, (_, i) => c(`x${i}`, 'hermit_defend'))],
        draw: [c('d1', 'hermit_defend'), c('d2', 'hermit_snapshot'), c('d3', 'hermit_strike')],
        chamber: [c('k1', 'hermit_strike'), c('k2', 'hermit_defend'),
          ...Array.from({ length: chamberSlots - 2 }, (_, i) => c(`k${i + 3}`, 'hermit_snapshot'))], chamberSlots,
        powers: [{ ...c('source', power), upgraded }], energy: 3,
      })
      run.combat.pendingTriggers = [{ id: triggerId++, playerId: viewerId, sourceId: 'power:source' }]
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    }
    const dialog = page.getByRole('dialog', { name: "Hermit's Combo" })
    const loadCard = (title) => dialog.locator(`section[aria-labelledby="hermit-trigger-choice-load"] .card[title="${title}"]`)
    const chamberCard = (title) => dialog.locator(`section[aria-labelledby="hermit-trigger-choice-chamber"] .card[title="${title}"]`)
    const confirm = dialog.locator('.hermit-trigger-choice__confirm')
    const allVisible = (drawnCount) => dialog.evaluate((element, drawnCount) => {
      const options = [...element.querySelectorAll('section[aria-labelledby="hermit-trigger-choice-load"] .hermit-trigger-choice__option')]
      return options.slice(0, drawnCount).every((option) => option.querySelector('.hermit-trigger-choice__badge')) &&
        [...element.querySelectorAll('.hermit-trigger-choice__option')].every((option) => {
          const box = option.getBoundingClientRect()
          const row = option.parentElement.getBoundingClientRect()
          return box.left >= row.left && box.right <= row.right && box.top >= 0 && box.bottom <= innerHeight
        })
    }, drawnCount)

    await load()
    await dialog.waitFor()
    await page.waitForTimeout(400)
    await dialog.getByText('Drew Defend and Snapshot.').waitFor()
    assert.equal(await dialog.locator('.hermit-trigger-choice__badge').count(), 2, `${name}: drawn cards are not badged`)
    await dialog.getByText('Chamber full — discard 1 card to make room').waitFor()
    assert.equal(await confirm.textContent(), 'Choose 1 card to Load')
    assert(await confirm.isDisabled())
    const fits = () => dialog.locator('.choice-modal__panel').evaluate((panel) => {
      const shell = panel.closest('dialog')
      if (shell.scrollHeight > shell.clientHeight + 1 || shell.getBoundingClientRect().bottom > innerHeight) return false
      const box = panel.getBoundingClientRect()
      const actions = panel.querySelector('.hermit-trigger-choice__actions').getBoundingClientRect()
      const cards = [...panel.querySelectorAll('.card')].map((card) => card.getBoundingClientRect())
      return box.top >= 0 && box.bottom <= innerHeight && actions.bottom <= innerHeight &&
        panel.scrollHeight <= panel.clientHeight + 1 && cards.every((card) => card.bottom <= innerHeight && card.top >= 0)
    })
    assert(await fits(), `${name}: Combo dialog does not fit the viewport without scrolling`)
    assert.match(await loadCard('Snapshot').getAttribute('aria-label'), /, drawn$/)
    await loadCard('Grudge').hover()
    await dialog.locator('.hermit-trigger-choice__detail').getByText('Grudge').waitFor()
    await page.screenshot({ path: `${out}/${name}-open.png` })

    await loadCard('Snapshot').click()
    assert.equal(await confirm.textContent(), 'Choose 1 Chamber card to discard')
    await loadCard('Grudge').click()
    assert.equal(await loadCard('Snapshot').getAttribute('aria-pressed'), 'false', 'a second Load pick must replace the first')
    await loadCard('Snapshot').click()
    await chamberCard('Strike').click()
    assert.equal(await confirm.textContent(), 'Load Snapshot, discard Strike')
    assert.equal(await chamberCard('Strike').evaluate((card) => getComputedStyle(card).outlineStyle), 'solid',
      `${name}: the selected Chamber card has no selection mark under the pointer`)
    await page.screenshot({ path: `${out}/${name}-selected.png` })

    await dialog.getByRole('button', { name: 'View board' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.locator('.prompt').getByText("Hermit's Combo — choose cards").waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Choose cards',
      `${name}: focus was not returned to the reopen control`)
    await page.locator('[data-enemy-id="e1"] .enemy__head').click()
    assert.equal((await combat()).pendingTriggers.length, 1, `${name}: an enemy click resolved Combo while viewing the board`)
    await page.getByRole('button', { name: 'Choose cards' }).click()
    await dialog.waitFor()
    assert.equal(await confirm.textContent(), 'Load Snapshot, discard Strike', `${name}: viewing the board lost the picks`)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal((await combat()).pendingTriggers.length, 1, `${name}: Escape resolved Combo`)
    await page.getByRole('button', { name: 'Choose cards' }).click()
    await dialog.waitFor()
    await dialog.evaluate((element) => element.close())
    await page.getByRole('button', { name: 'Choose cards' }).click()
    await dialog.waitFor()
    await confirm.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.pendingTriggers.length === 0)
    const resolved = (await combat()).players[0]
    assert.deepEqual(resolved.chamber.map(({ uid }) => uid).sort(), ['d2', 'k2'])
    assert(resolved.discard.some(({ uid }) => uid === 'k1'))
    assert(resolved.hand.some(({ uid }) => uid === 'd1'))
    await dialog.waitFor({ state: 'hidden' })

    await load()
    await dialog.waitFor()
    await loadCard('Grudge').click()
    await chamberCard('Strike').click()
    assert.equal(await confirm.textContent(), 'Load Grudge, discard Strike, then choose its target')
    await confirm.click()
    await dialog.waitFor({ state: 'hidden' })
    const prompt = page.locator('.prompt')
    await prompt.getByText("Hermit's Combo — choose an enemy for Grudge").waitFor()
    await page.screenshot({ path: `${out}/${name}-target.png` })
    await prompt.getByRole('button', { name: 'Change cards' }).click()
    await dialog.waitFor()
    await loadCard('Strike').first().click()
    assert.equal(await confirm.textContent(), 'Load Strike, discard Strike')
    await confirm.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.pendingTriggers.length === 0)
    const plain = await combat()
    assert.deepEqual(plain.players[0].chamber.map(({ uid }) => uid).sort(), ['h1', 'k2'])
    assert.deepEqual(plain.enemies.map(({ hp }) => hp), [40, 40], `${name}: a non-Curse Load hit an enemy`)

    await load()
    await dialog.waitFor()
    await loadCard('Grudge').click()
    await chamberCard('Strike').click()
    await confirm.click()
    await prompt.getByText("Hermit's Combo — choose an enemy for Grudge").waitFor()
    await page.locator('[data-enemy-id="e1"] .enemy__head').click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.pendingTriggers.length === 0)
    const cursed = await combat()
    assert.equal(cursed.enemies[0].hp, 40)
    assert(cursed.enemies[1].hp < 40, `${name}: Grudge did not hit the chosen enemy`)
    assert(cursed.players[0].chamber.some(({ uid }) => uid === 'h4'))

    await load('hermit_smoking_barrel')
    const barrel = page.getByRole('dialog', { name: "Hermit's Smoking Barrel" })
    await barrel.waitFor()
    assert.equal(await barrel.locator('section[aria-labelledby="hermit-trigger-choice-load"]').count(), 0)
    await barrel.getByText('You may discard 1 Chamber card to draw 3').waitFor()
    const barrelConfirm = barrel.locator('.hermit-trigger-choice__confirm')
    assert.equal(await barrelConfirm.textContent(), 'Continue without choosing')
    await barrel.locator('.card[title="Defend"]').click()
    assert.equal(await barrelConfirm.textContent(), 'Discard Defend, draw 3')
    await page.screenshot({ path: `${out}/${name}-smoking-barrel.png` })
    await barrelConfirm.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.pendingTriggers.length === 0)
    const barrelled = (await combat()).players[0]
    assert.deepEqual(barrelled.chamber.map(({ uid }) => uid), ['k1'])
    assert.equal(barrelled.hand.length, 7, `${name}: Smoking Barrel did not draw 3`)

    await load('hermit_eternal_form')
    const eternal = page.getByRole('dialog', { name: "Hermit's Eternal Form" })
    await eternal.waitFor()
    await eternal.getByText('Load 1 card into the Chamber — it costs 0 this turn').waitFor()

    await load('hermit_combo', { upgraded: true, extraHand: 4 })
    await dialog.waitFor()
    await page.waitForTimeout(300)
    assert.equal(await dialog.locator('section[aria-labelledby="hermit-trigger-choice-load"] .card').count(), 11)
    assert.equal(await confirm.textContent(), 'Choose 1 card to Load', `${name}: a new trigger inherited earlier picks`)
    assert(await fits(), `${name}: an 11-card Combo+ choice does not fit the viewport height`)
    assert(await allVisible(3), `${name}: some Load options are hidden, or the drawn cards are not first`)
    await page.screenshot({ path: `${out}/${name}-large-hand.png` })
    await loadCard('Strike').last().click()
    assert.equal(await loadCard('Strike').last().getAttribute('aria-pressed'), 'true')

    await load('hermit_combo', { extraHand: 1, chamberSlots: 3 })
    await dialog.waitFor()
    await page.waitForTimeout(300)
    assert.equal(await dialog.locator('section[aria-labelledby="hermit-trigger-choice-load"] .card').count(), 7)
    assert.equal(await dialog.locator('section[aria-labelledby="hermit-trigger-choice-chamber"] .card').count(), 3)
    assert.equal(await confirm.textContent(), 'Choose 1 card to Load', `${name}: a new trigger inherited earlier picks`)
    assert(await fits(), `${name}: a 3-slot Chamber Combo choice does not fit the viewport height`)
    assert(await allVisible(2), `${name}: a 3-slot Chamber Combo choice hides cards off the edge`)
    await page.screenshot({ path: `${out}/${name}-three-slots.png` })
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Hermit Combo browser audit passed: card-face Load choice, drawn badges, board peek and Curse targeting on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
