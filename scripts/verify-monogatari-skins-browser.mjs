#!/usr/bin/env node
// Real Shop/Profile/run screens and real engine attacks, with repeatable videos and screenshots.
// Failure contract: docs/monogatari-skins/failure-modes.md. No synthetic presentation events.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { installAttackFixture } from './lib/skin-attack-fixture.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { SKIN_LABELS } from '../src/game/skins.ts'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

const root = resolve(import.meta.dirname, '..')
const HERO_NAME = { ironclad: 'Ironclad', silent: 'Silent', defect: 'Defect', watcher: 'Watcher' }
const output = join(root, 'artifacts/monogatari-skins')
mkdirSync(output, { recursive: true })
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium'
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const cases = [['ironclad', 'monogatari_ironclad', 'strike_ironclad'], ['defect', 'monogatari_defect', 'ball_lightning']]
const report = { engine, origin, cases: [], errors: [] }
assert.deepEqual(cases.map(([, skin]) => SKIN_LABELS[skin]), ['Ironclad-chan', 'Defect-chan'], 'the requested shop/profile names are exact')

async function decoded(page, selector) {
  const image = page.locator(selector).first()
  await image.waitFor({ state: 'attached' })
  await image.evaluate(async image => { await image.decode(); if (!image.naturalWidth) throw new Error('Undecoded sprite') })
  return image.getAttribute('src')
}

async function shot(page, name) {
  await page.evaluate(async () => {
    await Promise.all([...document.images].filter(image => {
      const box = image.getBoundingClientRect()
      const style = getComputedStyle(image)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }).map(image => image.decode()))
  })
  await page.screenshot({ path: join(output, `${engine}-${name}.png`) })
}

async function wallet(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('sts-wallet:testplayer') ?? localStorage.getItem('sts-wallet') ?? 'null'))
}

try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    const context = await browser.newContext({ viewport, isMobile: screen !== 'desktop', hasTouch: screen !== 'desktop',
      deviceScaleFactor: 1, recordVideo: { dir: output, size: viewport } })
    await context.addInitScript(() => {
      if (!localStorage.getItem('monogatari-seeded')) {
        localStorage.setItem('sts-wallet', JSON.stringify({ version: 1, coins: 5000, packs: [], skins: [], credited: {} }))
        localStorage.setItem('monogatari-seeded', '1')
      }
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', error => report.errors.push(String(error)))
    page.on('response', response => {
      if (response.status() >= 400 && /\/assets\/.*monogatari/.test(response.url())) report.errors.push(`${response.status()} ${response.url()}`)
    })
    try {
      await page.goto(origin)
      await page.getByRole('button', { name: 'Shop', exact: true }).click()
      await page.getByRole('tab', { name: /^Skins/ }).click()
      await shot(page, `${screen}-shop-offers`)
      for (const [character, skin] of cases) {
        const rack = page.locator(`.shop-skin[data-skin="${skin}"]`)
        assert.match(await decoded(page, `.shop-skin[data-skin="${skin}"] img.shop-skin__portrait`), new RegExp(`portrait-${skin}\\.png$`))
        // The hero is part of every name: two heroes may each have a skin with the same label.
        const title = `${SKIN_LABELS[skin]} skin for ${HERO_NAME[character]}`
        await rack.getByRole('button', { name: `Buy the ${title}, 2,500 coins`, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: `Buy the ${title}?`, exact: true })
        await dialog.locator('.shop-button--buy').click()
        const unlocked = page.getByRole('dialog', { name: `${title} unlocked`, exact: true })
        await unlocked.waitFor()
        await unlocked.getByRole('button', { name: 'Done', exact: true }).click()
      }
      const bought = await wallet(page)
      assert.equal(bought.coins, 0, 'two purchases charge exactly 5,000 coins')
      assert.deepEqual(bought.skins, cases.map(([, skin]) => skin))
      assert.deepEqual(bought.packs, [], 'cosmetics never change the card packs')
      assert.equal(await page.locator('.shop-skin[data-owned="true"] .shop-skin__buy').count(), 0, 'owned skins cannot be repurchased')
      await shot(page, `${screen}-shop-owned`)
      await page.reload()
      await page.getByRole('button', { name: 'Profile', exact: true }).click()
      await page.getByRole('tab', { name: 'Skins', exact: true }).click()
      for (const [character, skin] of cases) {
        const name = HERO_NAME[character]
        const tile = page.getByRole('radio', { name: `${name}, ${SKIN_LABELS[skin]}`, exact: true })
        assert.equal(await tile.getAttribute('aria-checked'), 'true', 'purchase automatically equips its own hero')
        await page.getByRole('radio', { name: `${name}, Default`, exact: true }).click()
        await tile.click()
      }
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sts-skins:testplayer'))),
        { ironclad: 'monogatari_ironclad', defect: 'monogatari_defect' })
      assert.equal(await page.locator('#profile-panel-skins .profile__scroll').evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
      await shot(page, `${screen}-profile`)

      for (const [character, skin, card] of cases) {
        await page.goto(origin)
        await page.getByRole('button', { name: 'Single Player', exact: true }).click()
        await page.getByRole('button', { name: 'Standard', exact: true }).click()
        await page.locator('.start-menu__character-roster').getByRole('button', { name: character === 'ironclad' ? 'Ironclad' : 'Defect', exact: true }).click()
        await page.waitForFunction(skin => document.querySelector('.start-menu__character-wallpaper')?.src.endsWith(`character-${skin}-wallpaper.webp`), skin)
        assert.match(await decoded(page, '.start-menu__character-wallpaper'), new RegExp(`character-${skin}-wallpaper\\.webp$`))
        await page.waitForTimeout(750) // Character-select crossfade must settle before screenshot audit.
        await shot(page, `${screen}-${skin}-character`)
        await page.getByRole('button', { name: 'Embark', exact: true }).click()
        await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
        await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
        const chosen = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0])
        assert.equal(chosen.character, character)
        assert.equal(chosen.skin, skin)
        assert.match(await decoded(page, '.neow-screen__hero'), new RegExp(`${skin}-hero\\.webp$`))

        const base = postNeowRun(61, [{ id: 'p1', name: 'ArtTest', character, skin }])
        // Avoid the fixture's unrelated Loaded Die start-choice overlay; keep the actual hero/cards.
        base.players[0].relics = base.players[0].relics.filter(relic => relic !== 'loaded_die')
        const camp = structuredClone(base)
        const room = camp.map.rows[0][0]
        camp.phase = 'room'; camp.map.position = room; camp.map.rooms[room].kind = 'campfire'
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), camp)
        await page.locator(`.campfire__sitter[data-visual="${skin}"]`).evaluate(sitter => sitter.decode())
        await shot(page, `${screen}-${skin}-campfire`)

        const fight = structuredClone(base)
        fight.phase = 'combat'
        const enemy = { uid: 'enemy-0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0,
          strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }
        fight.combat = preparePlayerTurn(createCombat(createRng(62), fight.players, [enemy], `monogatari-${screen}-${skin}`))
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), fight)
        await page.locator(`.seat__interactive[data-character="${skin}"]`).waitFor()
        assert.match(await decoded(page, '.seat__portrait > img'), new RegExp(skin))
        const cardImages = await page.locator('.card__art').evaluateAll(images => images.map(image => image.src))
        assert(cardImages.some(source => source.includes(`/skin-cards-sm/${skin}/`)), 'the real hand uses skinned scanned faces')
        await page.waitForTimeout(1400) // Complete the real hand-deal entrance before evidence capture.
        await shot(page, `${screen}-${skin}-combat`)

        // Standing arrival and an actual treasure pickup use the same identity, not the base hero.
        const merchant = structuredClone(base)
        merchant.phase = 'room'
        merchant.roomState = { kind: 'merchant', relics: ['anchor'], potions: ['fire_potion'], colorless: ['trip'],
          cards: { p1: { choices: merchant.players[0].cardRewards.slice(0, 3), cardsDrawn: [], raresDrawn: [] } },
          removalUsed: [], purchasedCards: {} }
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), merchant)
        assert.match(await decoded(page, '.merchant-arrival__party img'), new RegExp(`${skin}-standing\\.webp$`))
        await shot(page, `${screen}-${skin}-merchant`)
        const treasure = structuredClone(base)
        treasure.phase = 'room'
        treasure.campaignProgress.actIV = 5
        treasure.roomState = { kind: 'treasure', playerIds: ['p1'], decisions: {}, offers: {}, sharedOffers: ['anchor'] }
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), treasure)
        await page.getByRole('button', { name: 'Open treasure chest', exact: true }).click()
        await page.locator('[data-treasure-slot="0"]').click()
        if (!await page.locator('.treasure-claim--0').count()) {
          // Touch's first press opens details; its second confirms the pickup.
          await page.locator('[data-treasure-slot="0"]').click()
        }
        await page.locator('.treasure-claim--0').waitFor({ state: 'attached' })
        assert.match(await decoded(page, '.treasure-claim__hand--reach'), new RegExp(`hand-${skin}\\.webp$`))
        assert.match(await decoded(page, '.treasure-claim__hand--grip'), new RegExp(`grip-${skin}\\.webp$`))
        await shot(page, `${screen}-${skin}-treasure`)
        await page.locator('.treasure-claim:not(.treasure-preview)').waitFor({ state: 'detached' })

        // Reuse the production-screen real-engine fixture, with the new base/skin pair.
        await page.evaluate(installAttackFixture, { character, skin })
        await page.evaluate(([character, skin]) => window.attackFixture.reset(character, skin), [character, skin])
        await decoded(page, '.seat__portrait > img')
        await page.waitForTimeout(150)
        // A skin without its own Energy orb keeps its hero's: the orb's colours are chosen by the character.
        assert.equal(await page.locator('.pip--energy').getAttribute('data-character'), character, `${skin} keeps ${character}'s Energy orb`)
        await page.evaluate(card => window.attackFixture.attack(card), card)
        await page.locator(`.character-attack--${skin}`).waitFor()
        await page.waitForTimeout(350)
        await shot(page, `${screen}-${skin}-ready`)
        await page.waitForTimeout(250)
        await shot(page, `${screen}-${skin}-contact`)
        await page.locator('.character-attack').waitFor({ state: 'detached' })
        assert.equal(await page.locator('.character-attack').count(), 0, 'complete recovery returns to one idle body')
        await shot(page, `${screen}-${skin}-recovered`)
        await page.evaluate(card => { window.attackFixture.attack(card); window.attackFixture.attack(card) }, card)
        await page.locator('.character-attack').first().waitFor()
        await page.waitForTimeout(50)
        await page.evaluate(() => { window.attackFixture.restoration++; window.attackFixture.render() })
        await page.locator('.character-attack').waitFor({ state: 'detached' })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        // Horizontal phones intentionally ignore OS reduced motion when the game toggle is off.
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
        await page.evaluate(card => window.attackFixture.attack(card), card)
        await page.waitForTimeout(150)
        assert.equal(await page.locator('.character-attack').count(), 0, 'reduced motion does not leave attack poses')
        assert.match(await decoded(page, '.seat__portrait > img'), new RegExp(`${skin}-hero\\.webp$`))
        await shot(page, `${screen}-${skin}-reduced-motion`)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })
        report.cases.push({ screen, character, skin, purchase: 2500, realEngineAttack: card, restoration: true, reducedMotion: true })
      }
    } finally {
      const video = page.video()
      await context.close()
      if (video) {
        const videoPath = join(output, `${engine}-${screen}.webm`)
        await video.saveAs(videoPath)
        report.videos ??= []
        report.videos.push(videoPath)
      }
    }
  }
  assert.deepEqual(report.errors, [], 'browser runtime and new skin asset responses are clean')
  console.log(`PASS ${engine}: both skin purchases, profiles, menus, campfires, card faces, real attacks, restoration and reduced motion; videos in ${output}`)
} finally {
  writeFileSync(join(output, `${engine}-report.json`), JSON.stringify(report, null, 2) + '\n')
  await browser.close()
  await vite.close()
}
