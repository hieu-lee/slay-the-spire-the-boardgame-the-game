#!/usr/bin/env node
import { mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { createRoomServer } from './room-server.mjs'
import { startRun } from './lib/rooms.mjs'
import { enterRoom, roomChoices } from '../src/game/run.ts'
import { ORDINARY_RELIC_IDS, relicAbilities, relicDef } from '../src/game/relics.ts'
import { assert, assertDeepEqual, assertEqual, check, report, suite } from './lib/harness.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/courier-browser`
mkdirSync(output, { recursive: true })
const rooms = createRoomServer()
const roomOrigin = `http://127.0.0.1:${(await rooms.listen(0)).port}`
const server = await createServer({ root, logLevel: 'silent', server: { port: 0, watch: { ignored: ['**/artifacts/**'] },
  proxy: { '/api': { target: roomOrigin }, '/ws': { target: roomOrigin, ws: true } } } })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`
const browser = await chromium.launch()
const errors = []
const checkAsync = async (label, assertion) => {
  try { await assertion(); check(label, () => {}) }
  catch (error) { check(label, () => { throw error }) }
}
const watch = (page) => {
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  return page
}

function courierCombat(seed, party, gold, extraRelics = []) {
  let run = postNeowRun(seed, party)
  run = enterRoom(run, roomChoices(run)[0].id)
  const equip = (player, index) => ({ ...player, gold: gold[index] ?? 0,
    relics: index === 0 ? [...player.relics, { defId: 'the_courier', spent: false }, ...extraRelics] : player.relics })
  run.players = run.players.map(equip)
  run.combat.players = run.combat.players.map(equip)
  run.itemDecks.relics = ['anchor', ...run.itemDecks.relics.filter((id) => id !== 'anchor')]
  return run
}

const setRun = (page, mutate) => page.evaluate((source) => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  new Function('run', source)(run)
  window.__STS_DEBUG__.setRun(run)
}, mutate)

const boxes = (page) => page.evaluate(() => {
  const rect = (selector) => {
    const boxes = [...document.querySelectorAll(selector)].map((element) => element.getBoundingClientRect()).filter((box) => box.width && box.height)
    return boxes.length ? { left: Math.min(...boxes.map((box) => box.left)), top: Math.min(...boxes.map((box) => box.top)),
      right: Math.max(...boxes.map((box) => box.right)), bottom: Math.max(...boxes.map((box) => box.bottom)) } : undefined
  }
  return { viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth,
    occupied: [...document.querySelectorAll('.seat__potions .potion-chip, .token--orb, .enemy__intent .icon-value, .combat__turn, .combat__phase')].map((element) => {
      const box = element.getBoundingClientRect()
      return { name: element.className, left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    }),
    courier: rect('.courier--offer, .courier--available, .courier--available > .courier__mascot'), banner: rect('.courier__banner'), endTurn: rect('.combat__end-turn'),
    cards: [...document.querySelectorAll('.combat .hand .card')].map((card) => {
      const box = card.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    }) }
})
const coveredByPlaque = (page) => page.evaluate(() => {
  const plaque = [...document.querySelectorAll('.courier--available')].find((element) => element.getClientRects().length)
  const boxes = [plaque, plaque.querySelector('.courier__mascot')].filter(Boolean).map((element) => element.getBoundingClientRect()).filter((box) => box.width && box.height)
  const box = { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) }
  plaque.style.visibility = 'hidden'
  const covered = new Set()
  for (let x = box.left + 2; x < box.right; x += 10) for (let y = box.top + 2; y < box.bottom; y += 6) {
    const hit = document.elementFromPoint(x, y)
    const owner = hit?.closest('button, img, .card, [role="img"], [aria-label]')
    if (owner && !owner.matches('main, section, .combat, .board')) covered.add(owner.getAttribute('aria-label') || owner.className || owner.tagName)
  }
  plaque.style.visibility = ''
  return [...covered]
})
const viewportsFor = (name, page) => name === 'desktop' ? [{ width: 1440, height: 900 }, { width: 1366, height: 650 }, { width: 1280, height: 720 }]
  : [page.viewportSize(), { width: 932, height: 430 }, { width: 812, height: 375 }, { width: 740, height: 360 }, { width: 667, height: 375 }]
async function clearancesAt(page, viewports) {
  const clearances = []
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(300)
    const hiddenTips = await hiddenRelicTips(page)
    const blockedHeader = await headerBlocked(page)
    const withoutCourier = await page.addStyleTag({ content: `.courier--available { display: none !important }
      .relic-chip[data-relic='the_courier'] { display: inline-grid !important }` })
    await page.waitForTimeout(100)
    const blockedHeaderBefore = await headerBlocked(page)
    await withoutCourier.evaluate((style) => style.remove())
    await page.waitForTimeout(450)
    clearances.push({ viewport, frame: await boxes(page), covered: await coveredByPlaque(page), hiddenTips, blockedAbilities: await blockedAbilities(page),
      blockedHeader: blockedHeader.filter((label) => !blockedHeaderBefore.includes(label)) })
  }
  await page.setViewportSize(viewports[0])
  return clearances
}
function assertClear(clearances, handSize) {
  for (const { viewport, frame, covered, hiddenTips, blockedAbilities, blockedHeader } of clearances) {
    const size = `${viewport.width}x${viewport.height}`
    assert(inside(frame.courier, frame.viewport), `${size}: Courier plaque leaves the viewport`)
    assert(!overlaps(frame.courier, frame.endTurn), `${size}: Courier plaque covers End turn`)
    assert(frame.cards.length === handSize && frame.cards.every((card) => !overlaps(frame.courier, card)), `${size}: Courier plaque covers the hand`)
    assertDeepEqual(covered, [], `${size}: Courier plaque covers ${covered.join(', ')}`)
    const crowded = frame.occupied.filter((box) => /combat__(turn|phase)/.test(box.name) ? overlaps(frame.courier, box)
      : overlaps(frame.courier, { left: (box.left + box.right) / 2, right: (box.left + box.right) / 2 + 1, top: (box.top + box.bottom) / 2, bottom: (box.top + box.bottom) / 2 + 1 }))
      .map((box) => box.name)
    assertDeepEqual(crowded, [], `${size}: Courier plaque overlaps ${crowded.join(', ')}`)
    assertDeepEqual(hiddenTips, [], `${size}: Courier plaque hides relic tooltips`)
    assertDeepEqual(blockedAbilities, [], `${size}: Courier plaque blocks relic abilities or turn keys`)
    assertDeepEqual(blockedHeader, [], `${size}: the Courier pushes the header over its own buttons`)
    assert(!frame.overflow)
  }
}
const inside = (box, viewport) => Boolean(box) && box.left >= 0 && box.top >= 0 && box.right <= viewport.width && box.bottom <= viewport.height
const overlaps = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const idleTurn = `run.combat.phase = 'player'
  run.combat.players[0] = { ...run.combat.players[0], hand: [], energy: 0, miracles: 0, shivs: 0, potions: [], powers: [] }`
const activeCourier = (page) => page.evaluate(() => {
  const active = document.activeElement
  return active?.closest('.courier__replace') ? 'replace' : active?.classList.contains('courier--offer') ? 'panel' : active?.textContent ?? ''
})
async function offerFitsSmallPhones(page, name) {
  if (name === 'desktop') return []
  const fits = []
  const home = page.viewportSize()
  for (const viewport of [{ width: 740, height: 360 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(300)
    fits.push(await page.evaluate(() => {
      const header = document.querySelector('.app-shell__header').getBoundingClientRect()
      const panel = document.querySelector('.courier--offer').getBoundingClientRect()
      const banner = document.querySelector('.courier__banner').getBoundingClientRect()
      return banner.top >= header.bottom && panel.bottom <= innerHeight && panel.left >= 0 && panel.right <= innerWidth
    }))
  }
  await page.setViewportSize(home)
  return fits
}
const liveCourierControls = (page) => page.evaluate(() => [...document.querySelectorAll('.courier--available button')]
  .filter((button) => button.getClientRects().length && !button.disabled && button.getAttribute('aria-disabled') !== 'true').length)
const settledFocus = (page, expected) => page.waitForFunction((expected) => {
  const active = document.activeElement
  return (active?.classList.contains('courier--offer') ? 'panel' : active?.textContent) === expected
}, expected, { timeout: 3000 }).then(() => expected, () => activeCourier(page))
const hiddenRelicTips = async (page) => {
  const hidden = []
  await page.mouse.move(1, page.viewportSize().height - 1)
  for (const relic of await page.locator('.app-shell__header .relic-chip').all()) {
    if (!(await relic.isVisible())) continue
    await relic.focus()
    await page.waitForTimeout(350)
    hidden.push(await relic.evaluate((chip) => {
      const tip = [...chip.querySelectorAll('.relic-tip')].find((element) => getComputedStyle(element).visibility !== 'hidden')
      if (!tip) return `no tooltip for ${chip.getAttribute('aria-label')}`
      const box = tip.getBoundingClientRect()
      for (let x = box.left + 12; x <= box.right - 12; x += (box.width - 24) / 4) for (let y = box.top + 12; y <= box.bottom - 12; y += (box.height - 24) / 3) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
        const hit = document.elementFromPoint(x, y)
        if (!tip.contains(hit)) return `${tip.querySelector('strong')?.textContent} under ${hit?.className}`
      }
      return ''
    }))
    await relic.evaluate((chip) => chip.blur())
  }
  await page.evaluate(() => document.activeElement?.blur())
  await page.waitForTimeout(300)
  return hidden.filter(Boolean)
}
const blockedAbilities = (page) => page.evaluate(() => [...document.querySelectorAll('.relic-actions section > button, .relic-actions section > details > summary, .combat__actions button')].filter((button) => {
  const box = button.getBoundingClientRect()
  const strip = button.closest('.combat__actions')?.getBoundingClientRect()
  if (strip && (box.left + box.width / 2 < strip.left || box.left + box.width / 2 > strip.right)) return false
  return Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.courier'))
}).map((button) => button.getAttribute('aria-label') || button.textContent))
const headerBlocked = (page) => page.evaluate(() => [...document.querySelectorAll('.app-shell__header button')].filter((button) => {
  const box = button.getBoundingClientRect()
  return box.width > 0 && !button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
}).map((button) => button.getAttribute('aria-label') || button.textContent))

async function startLocal(page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark', exact: true }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
}

async function localFlow(page, name, pause = 0) {
  const press = async (locator) => {
    if (pause) { await locator.hover(); await page.waitForTimeout(pause / 2) }
    await locator.click()
  }
  const offer = page.getByRole('dialog', { name: 'The Courier' })
  const buy = offer.getByRole('button', { name: /^(Buy|Pledge|Ask party)/ })
  const partyGold = `[2, 4, 0, 0].forEach((gold, index) => { run.players[index].gold = gold; run.combat.players[index].gold = gold })`
  const fullHand = `run.combat.players[0] = { ...run.combat.players[0], energy: 3,
    hand: run.players[0].deck.slice(0, 10).map((card, index) => ({ ...card, uid: 'courier-hand-' + index })) }
    run.combat.turn = 12
    run.combat.players.forEach((player, index) => { player.potions = index ? ['fire_potion', 'swift_potion']
      : ['fire_potion', 'swift_potion', 'block_potion', 'energy_potion', 'weak_potion'] })`
  await startLocal(page)
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), courierCombat(8801, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' }, { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' }, { id: 'p4', name: 'Watcher', character: 'watcher' },
  ], [2, 4, 0, 0], [{ defId: 'holy_water', spent: false, cubes: 2 }, { defId: 'runic_pyramid', spent: false }]))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat?.phase === 'player')
  const available = page.getByRole('group', { name: 'The Courier', exact: true })
  await available.waitFor()
  await setRun(page, fullHand)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${output}/${name}-available.png` })
  const clearances = await clearancesAt(page, viewportsFor(name, page))
  const disclosure = page.locator('.relic-actions details').first()
  const plaqueBeforeDisclosure = await available.boundingBox()
  await disclosure.locator('summary').click()
  await page.waitForTimeout(200)
  const plaqueWithDisclosure = await available.boundingBox()
  await disclosure.locator('summary').click()
  await available.waitFor()
  await checkAsync(`${name}: the Courier plaque covers nothing on a full four-hero board`, async () => {
    assertDeepEqual(plaqueWithDisclosure, plaqueBeforeDisclosure, 'opening a relic disclosure moved the Courier plaque')
    assertClear(clearances, 10)
  })

  const toggle = available.getByRole('button', { name: 'Courier choices' })
  let choices = null
  const folded = await page.evaluate(() => [...document.querySelectorAll('.courier--bar, .courier--header')]
    .filter((element) => element.getClientRects().length).map((element) => element.classList.contains('courier--header')))
  check(`${name}: the Courier uses the ${name === 'desktop' ? 'turn-row plaque' : 'folded header key'}`, () => assertDeepEqual(folded, [name !== 'desktop']))
  if (await toggle.isVisible()) {
    await press(toggle)
    await page.getByRole('button', { name: 'Look at Relic' }).waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${output}/${name}-choices.png` })
    choices = await page.evaluate(() => [...document.querySelectorAll('.courier__peek button')].filter((button) => button.getClientRects().length).map((button) => {
      const box = button.getBoundingClientRect()
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    }))
    await page.getByRole('button', { name: 'Look at Relic' }).focus()
    await page.keyboard.press('Escape')
    choices.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Courier choices'))
    choices.push(await page.getByRole('button', { name: 'Look at Relic' }).isHidden() && !(await page.locator('dialog.pause-menu[open]').count()))
    await press(toggle)
    await page.locator('.combat__turn').click()
    choices.push(await page.getByRole('button', { name: 'Look at Relic' }).isHidden())
    await press(toggle)
    await page.getByRole('button', { name: 'Look at Potion' }).focus()
    await page.keyboard.press('Tab')
    choices.push(await page.getByRole('button', { name: 'Look at Relic' }).isHidden())
    await press(toggle)
  }
  await press(page.getByRole('button', { name: 'Look at Relic' }))
  await offer.getByRole('heading', { name: 'Anchor' }).waitFor()
  await page.waitForTimeout(500 + pause)
  await page.screenshot({ path: `${output}/${name}-relic-offer.png` })
  const offerFrame = await boxes(page)
  const offerFits = await offerFitsSmallPhones(page, name)
  const offerHeader = await headerBlocked(page)
  const offerFocus = await activeCourier(page)
  const offerTips = await hiddenRelicTips(page)
  await checkAsync(`${name}: the relic offer is a centred, focused decision over a locked board`, async () => {
    assert(offerFits.every(Boolean), `the offer is clipped by the header or the viewport on a small phone: ${offerFits}`)
    if (choices) assertDeepEqual(choices, [true, true, true, true, true, true], 'the folded Courier choices are clipped, covered, lose focus on Escape, or stay open after Escape, an outside tap or tabbing away')
    assert(inside(offerFrame.courier, offerFrame.viewport) && inside(offerFrame.banner, offerFrame.viewport), `offer leaves the viewport: ${JSON.stringify(offerFrame)}`)
    assert(await page.locator('.courier-combat-lock').evaluate((element) => element.hasAttribute('inert')), 'board stayed interactive')
    assertEqual(offerFocus, 'Buy6')
    assertDeepEqual(offerHeader, [], 'the offer backdrop blocks the run header')
    assertDeepEqual(offerTips, [], 'the offer hides header relic tooltips')
    assert((await offer.locator('.courier__buy').evaluate((button) => getComputedStyle(button).backgroundImage)).includes('rgb(243, 209, 106)'), 'Buy is not the gold primary key')
    assertEqual(await offer.locator('.item-card-image').evaluate((image) => image.complete && image.naturalWidth > 0), true)
    assert((await offer.getAttribute('aria-describedby')) !== null)
  })
  await setRun(page, `run.players.forEach((player) => { player.gold = 0 }); run.combat.players.forEach((player) => { player.gold = 0 })`)
  await page.waitForFunction(() => document.querySelector('.courier__buy')?.disabled === true)
  await setRun(page, partyGold)
  await buy.and(page.getByRole('button', { name: 'Buy 6 Gold' })).waitFor()
  assert(await buy.isEnabled(), 'shared party Gold could not buy the relic')
  await press(buy)
  await offer.waitFor({ state: 'detached' })
  const bought = await page.evaluate(() => window.__STS_DEBUG__.getRun())
  const boughtFocus = await page.evaluate(() => document.activeElement?.classList.contains('app-shell'))
  const spentPlaque = await available.count()
  check(`${name}: buying spends the whole party's Gold for the relic`, () => {
    assert(bought.combat.players[0].relics.some((relic) => relic.defId === 'anchor'))
    assertDeepEqual(bought.combat.players.map((player) => player.gold), [0, 0, 0, 0])
    assertEqual(bought.courier.offer, null)
    assert(boughtFocus, 'closing the offer dropped focus to the page body')
    assertEqual(spentPlaque, 0, 'the Courier plaque stayed after its one use')
  })

  await setRun(page, `run.players[0].potions = ['swift_potion', 'blood_potion', 'energy_potion']
    run.combat.players[0].potions = [...run.players[0].potions]
    run.players.forEach((player) => { player.gold = 5 }); run.combat.players.forEach((player) => { player.gold = 5 })
    run.courier = { usedBy: ['p1'], offer: { playerId: 'p1', kind: 'potion', id: 'fire_potion' } }`)
  const replacement = offer.getByRole('group', { name: 'Replace Potion' })
  await replacement.waitFor()
  const potionFits = []
  const potionHome = page.viewportSize()
  for (const viewport of name === 'desktop' ? [] : [{ width: 740, height: 360 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(300)
    potionFits.push(await page.evaluate(() => {
      const header = document.querySelector('.app-shell__header').getBoundingClientRect()
      const panel = document.querySelector('.courier--offer').getBoundingClientRect()
      return document.querySelector('.courier__banner').getBoundingClientRect().top >= header.bottom && panel.bottom <= innerHeight
    }))
  }
  await page.setViewportSize(potionHome)
  await page.waitForTimeout(400 + pause)
  const disabledBeforeChoice = await buy.isDisabled()
  const fullBeltFocus = await activeCourier(page)
  const potionOfferFits = await offerFitsSmallPhones(page, name)
  const icons = await replacement.locator('.item-icon-image').evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
  await press(replacement.getByRole('button', { name: 'Blood Potion' }))
  await page.waitForTimeout(300 + pause)
  await page.screenshot({ path: `${output}/${name}-potion-offer.png` })
  const potionFrame = await boxes(page)
  await checkAsync(`${name}: a full belt picks a potion to replace before buying`, async () => {
    assert(disabledBeforeChoice, 'full belt could buy without choosing a replacement')
    assert(potionFits.every(Boolean), `the potion offer with its Replace row is clipped on a small phone: ${potionFits}`)
    assertEqual(fullBeltFocus, 'replace', 'a full belt did not focus the replacement choice')
    assert(potionOfferFits.every(Boolean), `the potion offer is clipped on a small phone: ${potionOfferFits}`)
    assertDeepEqual(icons, [true, true, true])
    assertEqual(await replacement.getByRole('button', { name: 'Blood Potion' }).getAttribute('aria-pressed'), 'true')
    assert(await buy.isEnabled(), 'choosing a replacement left Buy disabled')
    assert(inside(potionFrame.courier, potionFrame.viewport) && inside(potionFrame.banner, potionFrame.viewport))
  })
  await press(buy)
  await offer.waitFor({ state: 'detached' })
  const belt = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].potions)
  await setRun(page, `run.courier = { usedBy: ['p1'], offer: { playerId: 'p1', kind: 'potion', id: 'fire_potion' } }`)
  await replacement.getByRole('button', { name: 'Swift Potion' }).click()
  await offer.getByRole('button', { name: 'Discard', exact: true }).click()
  await offer.waitFor({ state: 'detached' })
  await setRun(page, `run.courier = { usedBy: ['p1'], offer: { playerId: 'p1', kind: 'potion', id: 'blood_potion' } }`)
  await replacement.waitFor()
  const staleChoice = { buy: await buy.isDisabled(), pressed: await replacement.locator('[aria-pressed="true"]').count() }
  check(`${name}: the chosen potion is the one replaced, and the choice does not outlive its offer`, () => {
    assertDeepEqual([...belt].sort(), ['energy_potion', 'fire_potion', 'swift_potion'])
    assertDeepEqual(staleChoice, { buy: true, pressed: 0 }, 'a replaced potion stayed chosen for the next offer')
  })

  await setRun(page, `run.courier = { usedBy: ['p1'], offer: { playerId: 'p1', kind: 'relic', id: 'kunai' } }`)
  await offer.locator('.courier__item .item-card-fallback').waitFor()
  const fallback = await offer.locator('.courier__item .item-card-fallback').evaluate((card) => ({
    clipped: card.scrollHeight > card.clientHeight + 1,
    icon: card.querySelector('.item-card-image').getBoundingClientRect().width / card.getBoundingClientRect().width,
  }))
  check(`${name}: an item without card art keeps its rules readable`, () => {
    assert(!fallback.clipped, 'the fallback card clips its rules text')
    assert(fallback.icon < 0.8, `the fallback icon is blown up to ${Math.round(fallback.icon * 100)}% of the card`)
  })

  await setRun(page, `run.players[0].relics.push({ defId: 'sozu', spent: false }); run.combat.players[0].relics.push({ defId: 'sozu', spent: false })
    run.players[0].potions = []; run.combat.players[0].potions = []
    run.courier = { usedBy: ['p1'], offer: { playerId: 'p1', kind: 'potion', id: 'swift_potion' } }`)
  await offer.getByText('Sozu prevents gaining Potions').waitFor()
  await checkAsync(`${name}: Sozu blocks a Potion offer and Discard closes it`, async () => {
    assert(await buy.isDisabled())
    assertEqual(await activeCourier(page), 'panel', 'a disabled Buy moved initial focus onto Discard')
    assertEqual(await offer.getByRole('group', { name: 'Replace Potion' }).count(), 0)
    await press(offer.getByRole('button', { name: 'Discard' }))
    await offer.waitFor({ state: 'detached' })
    assertEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().courier.offer), null)
    assert(await page.evaluate(() => document.activeElement?.classList.contains('app-shell')), 'discarding dropped focus to the page body')
  })

  await setRun(page, `run.combat.players[1].relics.push({ defId: 'the_courier', spent: false })
    run.courier = { usedBy: ['p2'], offer: { playerId: 'p2', kind: 'relic', id: 'anchor' } }`)
  await offer.waitFor()
  const peekDuringOtherOffer = await liveCourierControls(page)
  check(`${name}: a second Courier owner cannot peek while a teammate's offer is open`, () => assertEqual(peekDuringOtherOffer, 0))

  const duo = courierCombat(8801, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }, { id: 'p2', name: 'Silent', character: 'silent' }], [0, 0])
  duo.combat.turn = 12
  duo.combat.players.forEach((player) => { player.potions = ['fire_potion', 'swift_potion', 'block_potion'] })
  const lateRunRelics = ORDINARY_RELIC_IDS.filter((id) => id !== 'the_courier' && id !== 'sozu' && relicAbilities(relicDef(id)).length === 0).slice(0, 12)
  duo.combat.players[0].relics.push(...lateRunRelics.map((defId) => ({ defId, spent: false })))
  duo.players[0].relics = duo.combat.players[0].relics
  Object.assign(duo.combat.players[0], { shivs: 1, miracles: 1, hand: duo.players[0].deck.slice(0, 5).map((card, index) => ({ ...card, uid: 'duo-hand-' + index })) })
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), duo)
  await available.waitFor()
  await page.waitForTimeout(600)
  const duoClearances = await clearancesAt(page, viewportsFor(name, page))
  await setRun(page, `run.combat.pendingDistilled = { playerId: 'p1', cards: run.combat.players[0].hand.slice(0, 1) }`)
  await page.waitForTimeout(400)

  const peekDuringChoice = await liveCourierControls(page)
  await checkAsync(`${name}: the Courier plaque covers nothing on a two-hero board with a crowded turn row`, async () => {
    assertClear(duoClearances, 5)
    assertEqual(peekDuringChoice, 0, 'the Courier stayed available during a pending Distilled Chaos choice')
  })
}

async function autoAdvanceLock(page) {
  const phase = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat?.phase)
  await startLocal(page)
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), courierCombat(8804, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], [0]))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat?.phase === 'player')
  await setRun(page, idleTurn)
  await page.getByRole('group', { name: 'The Courier', exact: true }).waitFor()
  await page.waitForTimeout(900)
  const availablePhase = await phase()
  await page.getByRole('button', { name: 'Look at Relic' }).click()
  await page.getByRole('dialog', { name: 'The Courier' }).waitFor()
  await setRun(page, idleTurn)
  await page.waitForTimeout(900)
  const offerPhase = await phase()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  const advanced = await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat?.phase !== 'player', null, { timeout: 5000 }).then(() => true, () => false)
  check('solo: an unused Courier holds an idle turn until it is resolved', () => {
    assertEqual(availablePhase, 'player', 'an available Courier let an idle turn auto-advance')
    assertEqual(offerPhase, 'player', 'an open Courier offer let an idle turn auto-advance')
    assert(advanced, 'the idle turn never auto-advanced after the Courier was resolved')
  })
}

try {
  suite('courier browser')
  const solo = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }))
  await autoAdvanceLock(solo)
  await solo.close()
  const video = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output, size: { width: 1440, height: 900 } } })
  const videoPage = watch(await video.newPage())
  await localFlow(videoPage, 'desktop', 900)
  await video.close()
  renameSync(await videoPage.video().path(), `${output}/courier-demo.webm`)

  const phone = watch(await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true }))
  await localFlow(phone, 'horizontal-phone')
  await phone.close()

  const create = await fetch(`${roomOrigin}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ann', character: 'ironclad' }) }).then((response) => response.json())
  const seats = [{ token: create.token, name: 'Ann', character: 'ironclad' }]
  for (const [name, character] of [['Bo', 'silent'], ['Cy', 'defect']]) {
    const joined = await fetch(`${roomOrigin}/api/rooms/${create.snapshot.code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, character }) }).then((response) => response.json())
    seats.push({ token: joined.token, name, character })
  }
  const room = rooms.store.rooms.get(create.snapshot.code)
  startRun(room, create.token, { seed: 8802 })
  const party = room.seats.map((seat) => ({ id: seat.playerId, name: seat.name, character: seat.character }))
  const publish = (run) => { room.run = run; room.courierPledge = undefined; room.version += 1; rooms.publishRoom(room.code) }
  publish(courierCombat(8802, party, [0, 3, 3]))
  const pages = []
  for (const [index, seat] of seats.entries()) {
    const context = await browser.newContext({ viewport: index === 1 ? { width: 844, height: 390 } : { width: 1440, height: 900 } })
    await context.addInitScript(({ code, token }) => sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token })), { code: room.code, token: seat.token })
    await context.addInitScript(() => {
      const sockets = window.__ROOM_SOCKETS__ = []
      window.WebSocket = class extends window.WebSocket {
        constructor(...args) {
          super(...args)
          sockets.push(this)
        }
      }
    })
    const page = watch(await context.newPage())
    await page.goto(base, { waitUntil: 'networkidle' })
    pages.push(page)
  }
  const [ann, bo, cy] = pages
  await ann.getByRole('group', { name: 'The Courier', exact: true }).waitFor()
  const onlineFrame = await boxes(ann)
  const teammatePlaques = await Promise.all([bo, cy].map(async (page) => {
    await page.locator('.relic-actions').waitFor({ state: 'attached' })
    return page.getByRole('group', { name: 'The Courier', exact: true }).count()
  }))
  await ann.screenshot({ path: `${output}/online-desktop-available.png` })
  check('online: the Courier plaque sits clear of End turn', () => {
    assert(inside(onlineFrame.courier, onlineFrame.viewport) && !overlaps(onlineFrame.courier, onlineFrame.endTurn))
    assertDeepEqual(teammatePlaques, [0, 0], 'teammates without the Courier saw its plaque')
  })
  await bo.locator('.combat__end-turn').focus()
  await ann.setViewportSize({ width: 844, height: 390 })
  await ann.context().setOffline(true)
  await ann.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'Courier reconnect test'))
  await ann.locator('.connection--connected').waitFor({ state: 'detached' })
  const liveWhileReconnecting = await liveCourierControls(ann)
  await ann.context().setOffline(false)
  await ann.locator('.connection--connected').waitFor({ timeout: 20000 })
  const onlinePhoneKey = ann.getByRole('button', { name: 'Courier choices' })
  await onlinePhoneKey.click()
  await ann.getByRole('button', { name: 'Look at Relic' }).click()
  await ann.getByRole('dialog', { name: 'The Courier' }).waitFor()
  await ann.setViewportSize({ width: 1440, height: 900 })
  const onlineLocked = await ann.waitForFunction(() => document.querySelector('.courier-combat-lock')?.hasAttribute('inert') === true).then((handle) => handle.jsonValue())
  await bo.getByRole('dialog', { name: 'The Courier' }).waitFor()
  const lockedFocus = await settledFocus(bo, 'panel')
  const waitingLabel = await bo.locator('.courier__buy').getAttribute('aria-label')
  await ann.getByRole('button', { name: 'Ask party' }).click()
  const boOffer = bo.getByRole('dialog', { name: 'The Courier' })
  await bo.waitForFunction(() => document.querySelector('.courier__buy')?.disabled === false)
  const askedFocus = await settledFocus(ann, 'panel')
  const pledgeFocus = await settledFocus(bo, 'Pledge3')
  room.run.combat.players[1].dead = true
  room.version += 1
  rooms.publishRoom(room.code)
  await bo.waitForFunction(() => document.querySelector('.courier__buy')?.disabled === true)
  room.run.combat.players[1].dead = false
  room.version += 1
  rooms.publishRoom(room.code)
  await boOffer.getByRole('button', { name: 'Pledge 3 Gold' }).click()
  const meter = boOffer.getByRole('meter', { name: 'Gold pledged' })
  await meter.and(bo.locator('[aria-valuenow="3"]')).waitFor()
  room.run.combat.players[1].gold += 2
  room.version += 1
  rooms.publishRoom(room.code)
  await boOffer.getByRole('button', { name: 'Pledge 2 Gold' }).click()
  await meter.and(bo.locator('[aria-valuenow="5"]')).waitFor()
  const boPledged = room.courierPledge?.payments[party[1].id]
  await bo.reload({ waitUntil: 'networkidle' })
  await meter.and(bo.locator('[aria-valuenow="5"]')).waitFor()
  await bo.screenshot({ path: `${output}/online-horizontal-phone-pledged.png` })
  await checkAsync('online: a zero-Gold owner asks the party, and pledges fill the meter', async () => {
    assert(onlineLocked, 'online Courier offer left the board interactive')
    assertEqual(liveWhileReconnecting, 0, 'the header Courier key stayed live while reconnecting')
    assertEqual(waitingLabel, 'Waiting for Ann', 'a teammate saw the owner\'s action before the owner asked')
    assertEqual(lockedFocus, 'panel', 'locking the board left a teammate focused outside the offer')
    assertEqual(askedFocus, 'panel', 'asking the party dropped focus out of the offer')
    assertEqual(pledgeFocus, 'Pledge3', 'an arriving pledge did not focus Pledge')
    assertEqual(boPledged, 5, 'a repeat pledge replaced the earlier payment instead of adding to it')
    assert(await boOffer.getByRole('button', { name: /^Pledge/ }).isDisabled(), 'a teammate with no Gold left could pledge again')
    assertEqual(await meter.getAttribute('aria-valuemax'), '6')
    assertEqual(await boOffer.getByRole('button', { name: 'Discard' }).count(), 0)
    const frame = await boxes(bo)
    assert(inside(frame.courier, frame.viewport) && inside(frame.banner, frame.viewport))
  })
  await cy.getByRole('dialog', { name: 'The Courier' }).getByRole('button', { name: 'Pledge 1 Gold' }).click()
  await cy.getByRole('dialog', { name: 'The Courier' }).waitFor({ state: 'detached' })
  check('online: the last pledge buys the relic for the owner', () => {
    assert(room.run.combat.players[0].relics.some((relic) => relic.defId === 'anchor'))
    assertDeepEqual(room.run.combat.players.map((player) => player.gold), [0, 0, 2])
  })

  const sozu = courierCombat(8803, party, [12, 12, 12], [{ defId: 'sozu', spent: false }])
  sozu.courier = { usedBy: [party[0].id], offer: { playerId: party[0].id, kind: 'potion', id: 'fire_potion' } }
  publish(sozu)
  const sozuOffer = bo.getByRole('dialog', { name: 'The Courier' })
  await sozuOffer.getByText('Sozu prevents gaining Potions').waitFor()
  const ownerSozuOffer = ann.getByRole('dialog', { name: 'The Courier' })
  await ownerSozuOffer.getByText('Sozu prevents gaining Potions').waitFor()
  await checkAsync('online: nobody can fund a Potion for a Sozu owner', async () => {
    assert(await ownerSozuOffer.locator('.courier__buy').isDisabled(), 'a Sozu owner could buy a Potion')
    assert(await sozuOffer.locator('.courier__buy').isDisabled())
    assertEqual(await sozuOffer.getByRole('group', { name: 'Replace Potion' }).count(), 0)
  })
  check('pages have no uncaught errors', () => assertEqual(errors.length, 0, errors.join('\n')))
  report('courier browser')
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
