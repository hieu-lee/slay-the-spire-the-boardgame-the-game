import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'
import { rulesetForCharacters } from '../src/game/meta.ts'

// Choice flows driven through the real combat UI, from click to engine state:
// the sequential end-turn panel (Stasis Engine, Invincible), private draw-pile
// search (Omniscience), the topdeck dialog (Thinking Ahead, Warcry), Carve
// Reality's mode and target-mode resets (including copied plays), cancelling
// a pile choice (Headbutt), an in-hand pick followed by an ally pick (True
// Grit), a Start-of-Turn discard reaction (Tools of the Trade), and Dash's
// optional row switch, Scry's Put in hand (Secret Weapon), Storm of Steel's
// overflow skip, Body Crash's Block spend, Deep Breath's ordered Exhaust move,
// skipping an unplayable mandatory Chamber play, Power Beam's Power pick, Slime
// Commands and Replication/Overexert searches, Soulburn targets, Gem-socketed
// Powers, optional Mode Shifts, Revenge Protocol, card-picking Potions, and
// card/Potion-picking Relics.
const root = resolve(import.meta.dirname, '..')
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
const errors = []

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
    await page.getByRole('button', { name, exact: true }).click()
  }
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')

  const readRun = () => page.evaluate(() => window.__STS_DEBUG__.getRun())
  const readState = () => page.evaluate(() => window.__STS_DEBUG__.getState())
  let fixtureId = 0
  async function load(characters, setup, arg) {
    const party = [characters].flat()
    const run = postNeowRun(61, party.map((character, index) => ({ id: `p${index + 1}`, name: character, character })))
    const roomId = run.map.rows[0][0]
    run.map.rooms[roomId].kind = 'encounter'
    const entered = enterRoom(run, roomId)
    Object.assign(entered.combat, { combatId: `downfall-choices-${fixtureId++}`, ruleset: rulesetForCharacters(party) })
    await page.evaluate((state) => window.__STS_DEBUG__.setRun(state), entered)
    await page.locator('.hand .card').first().waitFor()
    await page.evaluate(setup, arg)
  }
  const card = (uid, defId, upgraded = false) => ({ uid, defId, upgraded })
  const cards = (prefix, defId, count) => Array.from({ length: count }, (_, index) => card(`${prefix}-${index}`, defId))
  const stage = (characters, fixture) => load(characters, (f) => {
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    const [actor, ...allies] = next.combat.players
    Object.assign(actor, {
      stance: 'neutral', hand: [], draw: [], discard: [], exhaust: [], powers: [],
      energy: 3, block: 0, strength: 0, weak: 0, drawLocked: false, dead: false, ...f.player,
    })
    if (f.ally) Object.assign(allies[0], f.ally)
    Object.assign(next.combat, {
      phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined, ...f.combat,
    })
    const template = next.combat.enemies[0]
    next.combat.enemies = Array.from({ length: f.enemies ?? 1 }, (_, row) => ({
      ...template, uid: `${f.id}-enemy-${row}`, defId: f.enemyDef ?? template.defId, row,
      hp: f.hp ?? 10, maxHp: f.hp ?? 10, block: 0, weak: 0, vulnerable: 0, dead: false, abilityUsed: true,
    }))
    window.__STS_DEBUG__.setRun(next)
  }, fixture)
  const enemyHits = page.locator('.enemy .enemy__hit-area')
  const killEnemy = (index) => page.evaluate((i) => {
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    Object.assign(next.combat.enemies[i], { hp: 0, dead: true })
    window.__STS_DEBUG__.setRun(next)
  }, index)

  // Stasis Engine picks its private hand target from the end-turn panel on a phone.
  await page.setViewportSize({ width: 844, height: 390 })
  await load('guardian', async () => {
    const { beginEndTurnResolution } = await import('/src/game/combat.ts')
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    const player = next.combat.players[0]
    Object.assign(next.combat, { phase: 'player', pendingTriggers: [] })
    Object.assign(player, {
      stance: 'neutral', orbs: [null, null, null],
      hand: Array.from({ length: 6 }, (_, index) => ({
        uid: `ui-stasis-choice-${index}`, defId: 'guardian_defend', upgraded: false,
      })),
      powers: [{ uid: 'ui-stasis-engine', defId: 'guardian_stasis_engine', upgraded: false }],
    })
    next.combat.players = [player]
    next.combat = beginEndTurnResolution(next.combat)
    window.__STS_DEBUG__.setRun(next)
  })
  const stasisChoices = page.getByRole('group', { name: /Resolve .*Stasis Engine/ })
  const stasisChoiceLayout = await stasisChoices.evaluate((group) => {
    const boxes = [...group.querySelectorAll('button')].map((button) => button.getBoundingClientRect())
    return {
      insideViewport: boxes.every((box) => box.left >= 0 && box.right <= innerWidth),
      rows: new Set(boxes.map((box) => Math.round(box.top))).size,
    }
  })
  await stasisChoices.getByRole('button', { name: 'Defend' }).first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand[0]?.stasisRetained === true)
  assert((await readRun()).combat.players[0].hand[0]?.stasisRetained,
    'Stasis Engine did not retain the chosen hand card')
  assert(stasisChoiceLayout.insideViewport && stasisChoiceLayout.rows > 1,
    `phone Stasis choices did not wrap inside the viewport: ${JSON.stringify(stasisChoiceLayout)}`)

  // Invincible keeps its Power from the same panel.
  await load('hexaghost', async () => {
    const { beginEndTurnResolution } = await import('/src/game/combat.ts')
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    const player = next.combat.players[0]
    Object.assign(next.combat, { phase: 'player', pendingTriggers: [] })
    Object.assign(player, {
      stance: 'neutral', orbs: [null, null, null], hand: [],
      powers: [{ uid: 'ui-invincible', defId: 'invincible', upgraded: false }],
    })
    next.combat.players = [player]
    next.combat = beginEndTurnResolution(next.combat)
    window.__STS_DEBUG__.setRun(next)
  })
  await page.getByRole('group', { name: /Resolve .*Invincible/ })
    .getByRole('button', { name: 'Keep Invincible' }).click()
  await page.waitForFunction(() => !document.querySelector('.end-turn-effects'))
  assert((await readRun()).combat.players[0].powers.some((power) => power.uid === 'ui-invincible'),
    'Invincible was not kept')

  // Omniscience: an empty search offers an accurate shuffle, then a real search
  // aims the copy and the original.
  await page.setViewportSize({ width: 1440, height: 900 })
  const arrange = (f) => stage('watcher', {
    id: f.enemyUid, enemyDef: 'jaw_worm', hp: 20, player: {
      hand: [card(f.uid, 'omniscience', true)], draw: f.draw, energy: 2,
    },
  })

  await arrange({ uid: 'ui-final-empty-omni', enemyUid: 'ui-final-empty-enemy',
    draw: [{ uid: 'ui-final-empty-omni-power', defId: 'deva_form', upgraded: false }] })
  await page.getByRole('button', { name: /^Omniscience\+,/ }).click()
  const emptySearch = page.getByRole('dialog', { name: 'Choose 0 from your draw pile' })
  await emptySearch.waitFor()
  assert.equal(await emptySearch.getByRole('button', { name: 'Shuffle and continue' }).textContent(),
    'Shuffle and continue')
  await emptySearch.getByRole('button', { name: 'Shuffle and continue' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')

  await arrange({ uid: 'ui-final-omni', enemyUid: 'ui-final-omni-enemy', draw: [
    { uid: 'ui-final-omni-strike', defId: 'strike_watcher', upgraded: false },
    { uid: 'ui-final-omni-power', defId: 'deva_form', upgraded: false },
  ] })
  await page.getByRole('button', { name: /^Omniscience\+,/ }).click()
  const search = page.getByRole('dialog', { name: 'Choose 1 from your draw pile' })
  await search.waitFor()
  const powerChoices = await search.getByRole('button', { name: /^Deva Form,/ }).count()
  await search.getByRole('button', { name: /^Strike,/ }).click()
  await search.getByRole('button', { name: 'Play selected card twice and shuffle' }).click()
  await page.waitForFunction(() => {
    const combat = window.__STS_DEBUG__.getState()
    return combat.phase === 'copy' && combat.pendingCardCopy?.sourceNames.length === 2
  })
  const copyPrompt = await page.getByText('Choose an enemy for Strike copy (Omniscience)', { exact: true }).textContent()
  const copyPhase = await page.locator('.combat__phase').textContent()
  await page.locator('.enemy--targeted .enemy__hit-area').first().click()
  await page.waitForFunction(() => {
    const combat = window.__STS_DEBUG__.getState()
    return combat.phase === 'copy' && combat.pendingCardCopy?.sourceNames.length === 1
  })
  const originalPrompt = await page.getByText(
    'Choose an enemy for original Strike after Omniscience copy', { exact: true }).textContent()
  const originalPhase = await page.locator('.combat__phase').textContent()
  await page.locator('.enemy--targeted .enemy__hit-area').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
  const state = await readState()
  assert.equal(powerChoices, 0)
  assert.equal(copyPrompt, 'Choose an enemy for Strike copy (Omniscience)')
  assert.equal(copyPhase, 'Resolve Strike copy (Omniscience)')
  assert.equal(originalPrompt, 'Choose an enemy for original Strike after Omniscience copy')
  assert.equal(originalPhase, 'Resolve original Strike after Omniscience copy')
  assert.equal(state.enemies[0].hp, 18)
  assert(state.players[0].exhaust.some((card) => card.uid === 'ui-final-omni'))
  assert(state.players[0].exhaust.some((card) => card.uid === 'ui-final-omni-strike'))

  // Topdeck dialog: draw three, then put the chosen hand card back on top.
  for (const { defId, name, prompt } of [
    { defId: 'thinking_ahead', name: /^Thinking Ahead\+,/ },
    { defId: 'warcry', name: /^Warcry\+,/, prompt: 'Warcry+ — choose 1 card to put on top' },
  ]) {
    await stage('ironclad', { id: defId, player: {
      hand: [card('ui-topdeck', defId, true), card('ui-topdeck-held', 'strike_ironclad')],
      draw: cards('ui-topdeck-draw', 'defend_ironclad', 3), energy: 0,
    } })
    await page.getByRole('button', { name }).click()
    const topdeck = page.getByRole('dialog', { name: 'Choose 1 for the top of your draw pile' })
    await topdeck.waitFor()
    if (prompt) await page.getByText(prompt, { exact: true }).waitFor()
    await topdeck.locator('.card').last().click()
    await topdeck.getByRole('button', { name: 'Put selected card on top' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust
      .some((exhausted) => exhausted.uid === 'ui-topdeck'))
    const { players: [topdecked] } = await readState()
    assert.equal(topdecked.draw[0].uid, 'ui-topdeck-draw-2', `${defId} did not topdeck the chosen card`)
    assert.equal(topdecked.hand.length, 3, `${defId} left the wrong hand size`)
  }

  // Carve Reality: its two-enemy mode resets when a target dies mid-choice,
  // and stays disabled while a copied play only has one enemy.
  const carveFixture = { id: 'carve', enemies: 2, player: {
    stance: 'calm', hand: [card('ui-carve', 'carve_reality', true)],
  } }
  const oneMode = page.getByRole('button', { name: 'Deal 4 damage to one enemy', exact: true })
  const twoModes = page.getByRole('button', { name: 'Deal 4 damage to two enemies', exact: true })
  await stage('watcher', carveFixture)
  await page.getByRole('button', { name: /^Carve Reality\+,/ }).click()
  await twoModes.click()
  await page.getByText('Choose damage target 1/2').waitFor()
  await enemyHits.nth(0).click()
  await page.getByText('Choose damage target 2/2').waitFor()
  await killEnemy(1)
  await page.getByText('Choose how to play Carve Reality').waitFor()
  assert.deepEqual([await oneMode.isDisabled(), await twoModes.isDisabled()], [false, true],
    'a dead second target did not reset the impossible two-enemy mode')
  await oneMode.click()
  await enemyHits.nth(0).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
  assert.equal((await readState()).enemies[0].hp, 6, 'the reset single-target mode did not resolve')

  await stage('watcher', { ...carveFixture, enemies: 1, player: { stance: 'neutral' }, combat: {
    phase: 'copy',
    pendingCardCopy: {
      playerId: 'p1', card: card('ui-carve-copy', 'carve_reality', true), energySpent: 2,
      resumePhase: 'player', forcedExhaust: false, forcedChoices: null, deferredHavocs: [],
      sourceNames: ['Double Tap'],
    },
  } })
  await twoModes.waitFor()
  assert.deepEqual([await oneMode.isDisabled(), await twoModes.isDisabled()], [false, true],
    'a copied Carve Reality offered an impossible two-enemy mode')
  await oneMode.click()
  await enemyHits.click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
  assert.equal((await readState()).enemies[0].hp, 6, 'the copied Carve Reality did not hit its sole enemy')

  // Headbutt stays cancelable before and after its discard choice.
  const headbutt = page.getByRole('button', { name: /^Headbutt\+, cost 1,/ })
  const discardChoice = page.getByRole('dialog', { name: 'Choose 1 card from your discard pile' })
  const untouchedHeadbutt = async (reason) => {
    const { players: [player], enemies: [enemy] } = await readState()
    assert.deepEqual([player.energy, player.hand[0]?.uid, player.discard.length, enemy.hp],
      [1, 'ui-headbutt', 2, 10], reason)
  }
  await stage('ironclad', { id: 'headbutt', player: {
    hand: [card('ui-headbutt', 'headbutt', true)], energy: 1,
    discard: [card('ui-headbutt-lower', 'defend_ironclad'), card('ui-headbutt-chosen', 'bash')],
    draw: [card('ui-headbutt-draw', 'strike_ironclad')],
  } })
  await headbutt.click()
  await discardChoice.waitFor()
  assert.equal(await discardChoice.getByRole('button', { name: 'Cancel' }).count(), 1)
  await page.keyboard.press('Escape')
  await discardChoice.waitFor({ state: 'hidden' })
  await untouchedHeadbutt('cancelling the discard chooser spent the card')
  await headbutt.click()
  await discardChoice.getByRole('button', { name: /^Bash,/ }).click()
  await discardChoice.getByRole('button', { name: 'Put selected card on top' }).click()
  await page.waitForSelector('.enemy--targeted')
  await headbutt.click()
  await page.waitForSelector('.enemy--targeted', { state: 'detached' })
  await untouchedHeadbutt('cancelling after the discard choice spent the card')
  await headbutt.click()
  await discardChoice.getByRole('button', { name: /^Bash,/ }).click()
  await discardChoice.getByRole('button', { name: 'Put selected card on top' }).click()
  await page.locator('.enemy--targeted .enemy__hit-area').click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].draw[0]?.uid === 'ui-headbutt-chosen')

  // True Grit: pick the Exhaust card straight from the hand, then pick an ally seat.
  await stage(['ironclad', 'silent'], { id: 'grit', player: {
    hand: [card('ui-grit', 'true_grit'), card('ui-grit-a', 'strike_ironclad'), card('ui-grit-b', 'strike_ironclad')],
  } })
  await page.getByRole('button', { name: /^True Grit,/ }).click()
  await page.locator('.hand .card').nth(2).click()
  await page.getByText(/Choose who gets it/i).waitFor()
  assert.equal(await page.locator('.hand .card--picked').getAttribute('aria-pressed'), 'true',
    'the picked Exhaust card is not announced as selected')
  await page.locator('.seat--targetable').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust
    .some((exhausted) => exhausted.uid === 'ui-grit-b'))
  assert((await readState()).players.some((player) => player.block > 0), 'True Grit gave no Block')

  // Tools of the Trade: its Start-of-Turn discard reaction is a private dialog.
  await stage('silent', { id: 'tools', player: {
    hand: [card('ui-tools-tactician', 'tactician'), card('ui-tools-strike', 'strike_silent')],
    powers: [card('ui-tools', 'tools_of_the_trade')],
  }, combat: { phase: 'start', startTurnProgress: {
    choices: [], discard: { playerId: 'p1', sourceId: 'power:ui-tools', pendingTriggers: [] },
  } } })
  const toolsDialog = page.getByRole('dialog', { name: /Tools of the Trade — discard 1 card/ })
  await toolsDialog.waitFor()
  assert.equal(await toolsDialog.getByRole('button').count(), 2)
  await toolsDialog.getByRole('button', { name: /^Tactician/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
  const { players: [tooled] } = await readState()
  assert.equal(tooled.energy, 5, 'discarding Tactician did not refund its Energy')
  assert(tooled.exhaust.some((exhausted) => exhausted.uid === 'ui-tools-tactician'))

  // Dash+ resolves, then offers an optional row switch with a Keep rows skip.
  await stage(['ironclad', 'silent'], { id: 'dash', player: { row: 0, hand: [card('ui-dash', 'dash', true)] },
    ally: { row: 1, hp: 20 } })
  await page.getByRole('button', { name: /^Dash\+,/ }).click()
  await page.locator('.enemy--targeted .enemy__hit-area').first().click()
  await page.getByText('Choose another player to switch rows with, or keep rows').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Keep rows' }).count(), 1)
  await page.locator('.seat--targetable').click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].row === 1)
  const dashed = await readState()
  assert.deepEqual(dashed.players.map((player) => player.row), [1, 0])
  assert.equal(dashed.players[0].block, 3)
  assert.equal(dashed.enemies[0].hp, 7)

  // Scry's optional "Put in hand" action submits scryToHand through the dialog.
  await stage('ironclad', { id: 'secret-weapon', player: {
    hand: [card('ui-secret-weapon', 'secret_weapon')], energy: 0,
    draw: [card('ui-sw-strike', 'strike_ironclad'), card('ui-sw-burn', 'burn'), card('ui-sw-defend', 'defend_ironclad')],
  } })
  await page.getByRole('button', { name: /^Secret Weapon,/ }).click()
  const scry = page.getByRole('dialog', { name: 'Scry 3' })
  await scry.waitFor()
  await scry.getByRole('button', { name: 'Put in hand' }).click()
  assert.equal(await scry.getByRole('button', { name: 'Will put in hand' }).getAttribute('aria-pressed'), 'true')
  await scry.getByRole('button', { name: 'Put selected card in hand and keep the rest' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand
    .some((handCard) => handCard.uid === 'ui-sw-strike'))
  assert.deepEqual((await readState()).players[0].draw.map((drawn) => drawn.uid), ['ui-sw-burn', 'ui-sw-defend'])

  // Storm of Steel: discard-any-number from the hand, then skip the overflow Shiv attacks.
  await stage(['silent', 'ironclad'], { id: 'storm', enemies: 2, hp: 20, ally: { shivs: 1 }, player: {
    hand: [card('ui-storm', 'storm_of_steel', true), card('ui-storm-a', 'strike_silent'), card('ui-storm-b', 'defend_silent')],
    energy: 6, shivs: 4, attacksPlayedThisTurn: 0,
  } })
  await page.getByRole('button', { name: /^Storm of Steel\+,/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Skip remaining overflow attacks' }).count(), 0,
    'overflow could skip before its discard choice resolved')
  await page.getByRole('button', { name: /^Strike,/ }).click()
  await page.getByRole('button', { name: /^Defend,/ }).click()
  await page.getByRole('button', { name: 'Discard 2' }).click()
  await page.getByText('Choose overflow Shiv target 1/3, or skip the rest').waitFor()
  await enemyHits.nth(0).click()
  await page.getByRole('button', { name: 'Skip remaining overflow attacks' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player' &&
    !document.querySelector('.prompt')?.textContent?.includes('overflow'))
  const stormed = await readState()
  assert.equal(stormed.players[0].attacksPlayedThisTurn, 1, 'skipping did not stop the remaining overflow attacks')
  assert.deepEqual(stormed.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b), [19, 20])

  // Body Crash chooses how much Block to spend.
  await stage('guardian', { id: 'body-crash', hp: 20, player: {
    block: 2, vigor: 1, vigorSpentThisTurn: 0, guardianMode: 'defense', hand: [card('ui-body-crash', 'guardian_body_crash')],
  } })
  await page.getByRole('button', { name: /^Body Crash,/ }).click()
  await page.getByRole('button', { name: 'Spend 2 Block' }).click()
  await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
  const crashed = await readState()
  assert.deepEqual([crashed.players[0].block, crashed.enemies[0].hp], [0, 16], 'Body Crash did not spend the chosen Block')

  // Deep Breath keeps the clicked order when moving Exhaust-pile cards.
  await stage('guardian', { id: 'deep-breath', player: {
    hand: [card('ui-deep-breath', 'deep_breath', true)],
    exhaust: [card('ui-deep-strike', 'guardian_strike'), card('ui-deep-defend', 'guardian_defend')],
  } })
  await page.getByRole('button', { name: /^Deep Breath\+,/ }).click()
  await page.getByRole('button', { name: /^Strike,/ }).click()
  await page.getByRole('button', { name: /^Defend,/ }).click()
  await page.getByRole('button', { name: 'Put selected cards on top of your discard pile' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard.length === 2)
  const breathed = (await readState()).players[0]
  assert.deepEqual([breathed.discard.map((moved) => moved.uid), breathed.exhaust.map((kept) => kept.uid)],
    [['ui-deep-strike', 'ui-deep-defend'], ['ui-deep-breath']])

  // A mandatory Chamber play that cannot be played can be skipped without moving its card.
  await stage('hermit', { id: 'chamber-skip', player: {
    chamber: [card('ui-chamber-strike', 'hermit_strike')], chamberSlots: 2, cardPlayLocked: true,
  }, combat: { pendingHermitChamberPlays: [{
    playerId: 'p1', sourceCardId: 'ui-mandatory-chamber', cardUids: ['ui-chamber-strike'], free: true,
  }] } })
  await page.getByRole('button', { name: 'Skip unplayable Strike' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.pendingHermitChamberPlays.length === 0)
  assert.equal((await readState()).players[0].chamber[0]?.defId, 'hermit_strike')

  // Defense-mode Power Beam picks its Power from the discard pile (guardianPowerCardUid).
  await stage('guardian', { id: 'power-beam', hp: 20, player: {
    energy: 5, guardianMode: 'defense', hand: [card('ui-power-beam', 'guardian_power_beam')],
    discard: [card('ui-power-beam-choice', 'guardian_future_plans')],
  } })
  await page.getByRole('button', { name: /^Power Beam,/ }).click()
  await page.getByRole('button', { name: 'Play Future Plans for 0' }).click()
  await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers
    .some((power) => power.uid === 'ui-power-beam-choice'))
  const beamed = await readState()
  assert.deepEqual([beamed.players[0].energy, beamed.enemies[0].hp], [3, 17])

  // Slime Boss: a sole Slime and a sole enemy resolve Lick's Command without a prompt.
  await stage('slime_boss', { id: 'lick', hp: 20, player: {
    hand: [card('ui-lick', 'slime_boss_lick')], slimes: [{
      card: card('ui-bruiser', 'slime_boss_bruiser_slime'), level: 1, vigor: 0, temporaryVigor: 0,
      vigorTriggerUsedThisTurn: false,
    }],
  } })
  await page.getByRole('button', { name: /^Lick,/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
  assert.equal((await readState()).enemies[0].hp, 19, 'the sole Slime did not Command its sole enemy target')

  // Slime Boss search-and-play flows: Replication searches the draw pile for a Slime,
  // Overexert picks a hand card to play (Attacks twice); both fall back without a candidate.
  const slimeBoss = { id: 'slime-search', hp: 20 }
  await stage('slime_boss', { ...slimeBoss, player: {
    hand: [card('ui-replication', 'slime_boss_replication')], slimes: [],
    draw: [card('ui-replication-slime', 'slime_boss_bruiser_slime')],
  } })
  await page.getByRole('button', { name: /^Replication,/ }).click()
  const replication = page.getByRole('dialog', { name: 'Choose a Slime from your draw pile' })
  await replication.getByRole('button', { name: /^Bruiser Slime,/ }).click()
  await replication.getByRole('button', { name: 'Play selected Slime and shuffle' }).click()
  await replication.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].slimes.length === 1)
  await stage('slime_boss', { ...slimeBoss, player: {
    hand: [card('ui-empty-replication', 'slime_boss_replication')], slimes: [],
  } })
  await page.getByRole('button', { name: /^Replication,/ }).click()
  await page.getByRole('dialog', { name: 'No Slime is in your draw pile' })
    .getByRole('button', { name: 'Shuffle and continue' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)

  await stage('slime_boss', { ...slimeBoss, player: {
    guardianMode: null, slimes: [], hand: [card('ui-overexert', 'slime_boss_overexert')],
    draw: [card('ui-overexert-whirl', 'guardian_guardian_whirl'), card('ui-overexert-strike', 'strike_ironclad')],
  } })
  await page.getByRole('button', { name: /^Overexert,/ }).click()
  const overexert = page.getByRole('dialog', { name: 'Choose a playable card from your hand' })
  await overexert.getByRole('button', { name: /^Strike,/ }).click()
  await overexert.getByRole('button', { name: 'Play selected Attack twice' }).click()
  await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'copy')
  await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
  assert.equal((await readState()).enemies[0].hp, 18, 'Overexert did not play the chosen Attack twice')
  await stage('slime_boss', { ...slimeBoss, player: { slimes: [], hand: [card('ui-empty-overexert', 'slime_boss_overexert')] } })
  await page.getByRole('button', { name: /^Overexert,/ }).click()
  await page.getByRole('dialog', { name: 'No playable card remains' }).getByRole('button', { name: 'Continue' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)

  // Living Bomb assigns each spent Soulburn to its own enemy click (soulburnEnemyUids).
  await stage('hexaghost', { id: 'living-bomb', hp: 20, player: {
    heat: 1, soulburn: 2, hand: [card('ui-living-bomb', 'living_bomb')],
  } })
  await page.getByRole('button', { name: /^Living Bomb,/ }).click()
  for (let index = 0; index < 3; index++) await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
  const bombed = await readState()
  assert.deepEqual([bombed.players[0].soulburn, bombed.enemies[0].hp], [0, 17])

  // Gem-socketed Powers: Ruby aims an enemy, Jasper confirms an up-to-three Exhaust (PowerContext.exhaustUids).
  await stage('guardian', { id: 'gem-powers', hp: 20, player: {
    guardianMode: 'attack', strength: 2, weak: 1, hand: [card('ui-jasper-a', 'guardian_defend'), card('ui-jasper-b', 'guardian_strike')],
    powers: [
      { ...card('ui-floating-ruby', 'guardian_floating_orbs'), attachedGemId: 'guardian_ruby' },
      { ...card('ui-floating-jasper', 'guardian_floating_orbs'), attachedGemId: 'guardian_jasper' },
    ], powerTriggersUsedThisTurn: [],
  }, combat: { powerTriggersUsedThisTurn: [] } })
  await page.getByRole('button', { name: 'Use Floating Orbs with Ruby' }).click()
  await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().powerTriggersUsedThisTurn.length === 1)
  await page.getByRole('button', { name: 'Use Floating Orbs with Jasper' }).click()
  await page.getByLabel('Exhaust Defend').check()
  await page.getByLabel('Exhaust Strike').check()
  await page.getByRole('button', { name: 'Confirm 2' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust.length === 2)

  // Guardian optional Mode Shift prompts: a card's own choice, Bauble Burst's second Gem, and an Amethyst Power.
  const modeOf = async () => (await readState()).players[0].guardianMode
  await stage('guardian', { id: 'hack', player: { guardianMode: 'attack', hand: [card('ui-hack', 'guardian_hack')] } })
  await page.getByRole('button', { name: /^Hack,/ }).click()
  await page.getByRole('button', { name: 'Shift Mode', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
  assert.equal(await modeOf(), 'defense', 'Hack did not Mode Shift when asked')
  await stage('guardian', { id: 'bauble', player: { guardianMode: 'attack', hand: [
    { ...card('ui-bauble', 'guardian_bauble_burst'), attachedGemId: 'guardian_amethyst' },
  ] } })
  await page.getByRole('button', { name: /^Bauble Burst,/ }).click()
  await page.getByRole('button', { name: 'Keep Mode', exact: true }).click()
  await page.getByRole('button', { name: 'Second Gem: Mode Shift', exact: true }).click()
  await enemyHits.first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
  assert.equal(await modeOf(), 'defense', 'the second Amethyst did not Mode Shift')
  await stage('guardian', { id: 'amethyst-power', player: { guardianMode: 'attack', powers: [
    { ...card('ui-amethyst-orbs', 'guardian_floating_orbs'), attachedGemId: 'guardian_amethyst' },
  ], powerTriggersUsedThisTurn: [] }, combat: { powerTriggersUsedThisTurn: [] } })
  await page.getByRole('button', { name: 'Use Floating Orbs with Amethyst' }).click()
  await page.getByRole('button', { name: 'Mode Shift', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].guardianMode === 'defense')

  // Revenge Protocol picks an Attack from the hand to force for 0 Energy (PowerContext.cardUid).
  await stage('guardian', { id: 'revenge', player: { guardianMode: 'attack', hand: [card('ui-revenge-strike', 'guardian_strike')],
    powers: [card('ui-revenge', 'guardian_revenge_protocol')], powerTriggersUsedThisTurn: [] },
    combat: { powerTriggersUsedThisTurn: [] } })
  await page.getByRole('button', { name: /^Use Revenge Protocol/ }).click()
  await page.getByRole('button', { name: 'Strike', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0 &&
    window.__STS_DEBUG__.getState().powerTriggersUsedThisTurn.length === 1)

  // Potions that ask for a card (recoverDiscardUid, recoverExhaustUid, transformHandUid, exhaustUids).
  const potionDialog = (name) => page.getByRole('dialog', { name, exact: true })
  const strikes = cards('ui-potion-strike', 'strike_ironclad', 3)
  await stage('ironclad', { id: 'liquid-memories', player: { potions: ['liquid_memories'], discard: [strikes[0]] } })
  await page.getByRole('button', { name: 'Use Liquid Memories' }).click()
  await potionDialog('Liquid Memories').locator('.card').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.uid === 'ui-potion-strike-0')
  await stage('ironclad', { id: 'liquid-void', player: { potions: ['liquid_void'], exhaust: [strikes[1]] } })
  await page.getByRole('button', { name: 'Use Liquid Void' }).click()
  await potionDialog('Liquid Void').locator('.card').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.uid === 'ui-potion-strike-1')
  await stage('ironclad', { id: 'transform', player: { potions: ['transforming_brew'], hand: [strikes[2]] } })
  await page.getByRole('button', { name: 'Use Transforming Brew' }).click()
  await potionDialog('Transforming Brew').locator('.card').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.defId !== 'strike_ironclad')
  assert.equal((await readState()).players[0].potions.length, 0, 'Transforming Brew was not consumed')
  await stage('ironclad', { id: 'purity', player: { potions: ['purity_potion'], hand: strikes } })
  await page.getByRole('button', { name: 'Use Purity Potion' }).click()
  const purity = potionDialog('Purity Potion')
  await purity.locator('.card').nth(0).click()
  await purity.locator('.card').nth(1).click()
  await purity.getByRole('button', { name: 'Exhaust 2' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust.length === 2)

  // Combat Relic actions that submit a hand card or a held Potion (cardUids, discardPotionId).
  const relicAction = (name) => page.locator('.relic-actions details').filter({ hasText: name })
  await stage('ironclad', { id: 'fuel', player: { relics: [{ defId: 'fuel_canister', spent: false }],
    hand: [card('ui-fuel-strike', 'strike_ironclad')], energy: 0 } })
  await relicAction('Fuel Canister').locator('summary').click()
  await relicAction('Fuel Canister').locator('.card').first().click()
  await relicAction('Fuel Canister').getByRole('button', { name: 'Exhaust and gain Energy' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust
    .some((exhausted) => exhausted.uid === 'ui-fuel-strike'))
  await stage('ironclad', { id: 'shot-glass', player: { relics: [{ defId: 'shot_glass', spent: false }], potions: ['fire_potion'] } })
  await relicAction('Shot Glass').locator('summary').click()
  await relicAction('Shot Glass').getByRole('button', { name: /^Discard Fire Potion/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].potions.length === 0)

  assert.deepEqual(errors, [], 'page errors')
  console.log('Combat choices browser audit passed: every card, Power, Potion and Relic choice listed in the header resolves from combat UI.')
} finally {
  await browser.close()
  await server.close()
}
