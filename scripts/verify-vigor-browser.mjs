import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'

const out = 'artifacts/vigor-controls'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
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
    async function load(mode, character = 'guardian', forced = false) {
      const run = createRun(911, [{ id: viewerId, name: 'Guardian', character }])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      run.combat = createCombat({ seed: 911, calls: 0 }, run.players, [enemy], 'vigor-controls')
      Object.assign(run.combat.players[0], { guardianMode: mode, vigor: 2, vigorSpentThisTurn: 0, strength: 1,
        hand: [{ uid: 'card', defId: mode === 'attack' ? 'guardian_strike' : 'guardian_defend', upgraded: false }], energy: 3 })
      if (forced) run.combat.startTurnProgress = { choices: [], forcedCard: { playerId: viewerId, cardUid: 'card' } }
      run.phase = 'combat'; run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.getByRole('button', { name: 'Spend 1 Vigor, 2 available', exact: true }).waitFor()
      await page.waitForTimeout(1200)
      await page.locator('.card-morph').waitFor({ state: 'hidden' })
    }
    for (const mode of ['attack', 'defense']) {
      await load(mode)
      assert.equal(await page.locator('.seat__mechanic').filter({ hasText: /Vigor/ }).count(), 0)
      assert.equal(await page.locator('.token--vigorSpent').count(), 0)
      for (const available of [2, 1]) {
        const button = page.getByRole('button', { name: `Spend 1 Vigor, ${available} available`, exact: true })
        const bounds = await button.boundingBox()
        assert(bounds.x > width / 2 && bounds.y < height / 2)
        if (name === 'desktop') { await button.focus(); await page.keyboard.press('Enter') }
        else await button.tap()
        await page.getByRole('button', { name: `Spend 1 Vigor, ${available - 1} available`, exact: true }).waitFor()
      }
      assert(await page.getByRole('button', { name: 'Spend 1 Vigor, 0 available', exact: true }).isDisabled())
      assert.equal(await page.locator('.token--vigorSpent .token__count').textContent(), '2')
      assert.equal(await page.locator('.token--strength .token__count').textContent(), '1')
      const token = await page.locator('.token--vigorSpent').boundingBox()
      const hp = await page.locator('.seat--viewer .bar').boundingBox()
      await page.screenshot({ path: `${out}/${name}-${mode}.png` })
      assert(token.y >= hp.y + hp.height - 1.1, `active Vigor belongs below HP: ${JSON.stringify({token,hp})}`)
      assert(await page.locator('.token--vigorSpent img').evaluate(img => img.complete && img.naturalWidth > 0))
      await page.getByRole('button', { name: mode === 'attack' ? /^Strike,/ : /^Defend,/ }).click()
      assert.equal(await page.getByRole('button', { name: /^Spend [0-9]+ Vigor$/ }).count(), 0)
      if (mode === 'attack') await page.locator('.enemy:not(.enemy--dead)').first().click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
      const result = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
      assert.equal(mode === 'attack' ? 40 - result.enemies[0].hp : result.players[0].block, mode === 'attack' ? 4 : 3)
    }
    await load('attack', 'ironclad')
    await page.getByRole('button', { name: 'Spend 1 Vigor, 2 available', exact: true }).click()
    assert.equal(await page.locator('.token--vigorSpent .token__count').textContent(), '1')
    await load('attack', 'guardian', true)
    await page.getByRole('button', { name: 'Spend 2 Vigor', exact: true }).click()
    await page.locator('.enemy:not(.enemy--dead)').first().click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    const forcedResult = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    assert.equal(40 - forcedResult.enemies[0].hp, 4)
    assert.equal(forcedResult.players[0].vigor, 0)

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const modeRun = createRun(912, [{ id: viewerId, name: 'Guardian', character: 'guardian' }])
    modeRun.combat = createCombat({ seed: 912, calls: 0 }, modeRun.players, [{
      uid: 'mode-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
      actionIndex: 0, abilityUsed: false, dead: false,
    }], 'guardian-mode-choice')
    modeRun.combat = preparePlayerTurn({ ...modeRun.combat, phase: 'roundEnd' })
    modeRun.phase = 'combat'; modeRun.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), modeRun)
    const formChoice = page.getByRole('group', { name: 'Choose Guardian form for this turn' })
    await formChoice.waitFor()
    await page.waitForTimeout(1200)
    await page.locator('.card-morph').waitFor({ state: 'hidden' })
    await formChoice.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
    const formVisual = await formChoice.locator('button').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button)
      return {
        text: button.textContent.trim(), border: style.borderTopWidth, background: style.backgroundImage,
        animation: style.animationName, image: button.querySelector('img')?.getAttribute('src'),
        box: button.getBoundingClientRect().toJSON(),
      }
    }))
    assert.deepEqual(formVisual.map(({ text, border, background }) => ({ text, border, background })), [
      { text: '', border: '0px', background: 'none' },
      { text: '', border: '0px', background: 'none' },
    ])
    assert(formVisual[0].image.endsWith('/combat/characters/guardian.webp'))
    assert(formVisual[1].image.endsWith('/combat/characters/guardian-defense.webp'))
    assert(formVisual.every(({ animation }) => animation === 'end-turn-effect-arrive'))
    assert(formVisual.every(({ box }) => box.top >= 0 && box.bottom <= height && box.left >= 0 && box.right <= width))
    await page.screenshot({ path: `${out}/${name}-guardian-form-choice.png` })
    await page.getByRole('button', { name: 'Choose Defense Mode' }).click()
    await page.waitForFunction(() => {
      const combat = window.__STS_DEBUG__.getRun().combat
      return combat.phase === 'player' && combat.players[0].guardianMode === 'defense'
    })

    const localModeRun = createRun(914, [
      { id: viewerId, name: 'Ironclad', character: 'ironclad' },
      { id: 'guardian-seat', name: 'Guardian', character: 'guardian' },
    ])
    localModeRun.combat = createCombat({ seed: 914, calls: 0 }, localModeRun.players, modeRun.combat.enemies, 'local-guardian-mode-choice')
    localModeRun.combat = preparePlayerTurn({ ...localModeRun.combat, phase: 'roundEnd' })
    localModeRun.phase = 'combat'; localModeRun.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), localModeRun)
    await page.getByRole('button', { name: 'Choose Defense Mode' }).click()
    await page.waitForFunction(() => {
      const combat = window.__STS_DEBUG__.getRun().combat
      return combat.phase === 'player' && combat.players[1].guardianMode === 'defense'
    })

    const finderRun = createRun(913, [{ id: viewerId, name: 'Guardian', character: 'guardian' }])
    finderRun.combat = createCombat({ seed: 913, calls: 0 }, finderRun.players, [{
      uid: 'finder-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
      actionIndex: 0, abilityUsed: false, dead: false,
    }], 'gem-finder-scry')
    Object.assign(finderRun.combat.players[0], {
      hand: [], discard: [], powers: [{ uid: 'finder', defId: 'guardian_gem_finder', upgraded: false }],
      draw: [
        { uid: 'gem-attack', defId: 'guardian_multi_beam', upgraded: false },
        { uid: 'gem-power', defId: 'guardian_floating_orbs', upgraded: false },
        { uid: 'plain', defId: 'guardian_defend', upgraded: false },
      ],
    })
    finderRun.phase = 'combat'; finderRun.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), finderRun)
    await page.getByRole('button', { name: 'Use Gem Finder' }).click()
    const finder = page.getByRole('dialog', { name: 'Gem Finder — Scry 3' })
    await finder.waitFor()
    assert.equal(await finder.locator('.card').count(), 3)
    assert.equal(await finder.getAttribute('class'), 'distilled-choice')
    assert.deepEqual(await finder.locator('.card').evaluateAll(cards => cards.map(card => card.getAttribute('aria-disabled'))),
      ['true', 'true', 'false'])
    await finder.getByRole('button', { name: /^Multi Beam,/ }).dispatchEvent('click')
    await finder.getByRole('button', { name: 'Keep all and continue' }).waitFor()
    await finder.getByRole('button', { name: /^Defend,/ }).click()
    await page.screenshot({ path: `${out}/${name}-gem-finder-scry.png` })
    await finder.getByRole('button', { name: 'Discard 1 and continue' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 2)
    const finderPlayer = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0])
    assert.deepEqual(finderPlayer.hand.map(card => card.uid), ['gem-attack', 'gem-power'])
    assert.deepEqual(finderPlayer.discard.map(card => card.uid), ['plain'])
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Guardian controls passed: Vigor, form choice, and Gem Finder Scry on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
