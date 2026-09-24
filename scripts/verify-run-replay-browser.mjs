#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/run-replay')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })

const profile = { username: 'Replay Tester', token: '00000000-0000-4000-8000-000000000001' }
const open = async (viewport, hasTouch = viewport.width === 844, isMobile = false) => {
  const context = await browser.newContext({ viewport, hasTouch, isMobile })
  await context.addInitScript((saved) => localStorage.setItem('sts-profile', JSON.stringify(saved)), profile)
  await context.addInitScript(() => {
    window.__awaitReplay = async ({ controller, promise }, timeout = 30_000) => {
      let timer
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new Error(`Replay timed out after ${timeout}ms`)); controller.abort() }, timeout)
        })])
      } catch (error) {
        controller.abort()
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(origin, { waitUntil: 'networkidle' })
  return { context, page, errors }
}

const droppedFile = async (page, name, text) => page.locator('.run-replay-import').evaluate((screen, file) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([file.text], file.name, { type: 'application/json' }))
  screen.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
}, { name, text })

let desktop
try {
  desktop = await open({ width: 1600, height: 900 })
  const { page } = desktop
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await page.getByText('Give your run to me', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) =>
    /menu\/(?:campaign|character-select\/character-.*-wallpaper)/.test(name))), false, 'Replay preloaded unrelated run setup art')
  assert.equal(await page.locator('input[type="file"]').count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Choose run log' }).isVisible(), false, 'Desktop exposed the phone file chooser')
  await page.screenshot({ path: join(output, 'time-eater-desktop.png') })
  const desktopFit = await page.evaluate(() => {
    const prompt = document.querySelector('.run-replay-import__prompt')?.getBoundingClientRect()
    const back = document.querySelector('.run-replay-import__back')?.getBoundingClientRect()
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, prompt, back }
  })
  assert(desktopFit.prompt && desktopFit.back)
  assert(desktopFit.scrollWidth <= desktopFit.width && desktopFit.scrollHeight <= desktopFit.height)
  assert(desktopFit.prompt.x >= 0 && desktopFit.prompt.right <= desktopFit.width)
  assert(desktopFit.back.x >= 0 && desktopFit.back.bottom <= desktopFit.height)

  await droppedFile(page, 'not-a-run.txt', '{}')
  await page.getByText('Your run is invalid', { exact: true }).waitFor()
  await page.getByText('Give your run to me', { exact: true }).waitFor()
  await droppedFile(page, 'broken.json', '{')
  await page.getByText('Your run is invalid', { exact: true }).waitFor()

  const invalidStates = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { createCombat } = await import('/src/game/combat.ts')
    const { validateRunLog } = await import('/src/ui/run-log.ts')
    const makeLog = (initial) => {
      const final = structuredClone(initial); final.phase = 'defeat'; final.neow = null; final.combat = null
      return { version: 2, runId: initial.campaign.runId, initial, events: [{ patch: [{ path: [], value: final }] }] }
    }
    const brokenPhase = createRun(39, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenPhase.phase = 'combat'; brokenPhase.combat = null
    const brokenRelic = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenRelic.players[0].relics = [{ defId: 'definitely_not_a_relic', spent: false }]
    const brokenMap = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenMap.map.rows = ['not-a-row']
    const oversizedMap = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    oversizedMap.map.rows = Array.from({ length: 33 }, () => [oversizedMap.map.rows[0][0]])
    const brokenRoom = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenRoom.roomState = { kind: 'not-a-room' }
    const brokenCourier = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenCourier.courier = {}
    const inheritedCard = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    inheritedCard.players[0].deck[0].defId = 'constructor'
    const brokenModifier = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenModifier.meta = { ...brokenModifier.meta, modifierIds: ['not_real'] }
    const { DAILY_MODIFIERS } = await import('/src/game/meta.ts')
    const repeatedModifier = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    repeatedModifier.meta = { ...repeatedModifier.meta, modifierIds: [DAILY_MODIFIERS[0].id, DAILY_MODIFIERS[0].id] }
    const brokenCampaign = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    delete brokenCampaign.campaign.keys
    const brokenGold = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenGold.players[0].gold = {}
    const brokenRng = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenRng.rng = { seed: Infinity, calls: -0.5, replayValues: ['bad'] }
    const strayCombat = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    strayCombat.combat = {}
    const brokenPlayer = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    delete brokenPlayer.players[0].dead
    const brokenResources = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'guardian' }])
    brokenResources.players[0].block = 1_000_000_000
    brokenResources.players[0].vigor = 1_000_000_000
    const brokenCollections = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'slime_boss' }])
    brokenCollections.players[0].relics = Array(257).fill(brokenCollections.players[0].relics[0])
    brokenCollections.players[0].potions = Array(33).fill('fire_potion')
    brokenCollections.players[0].orbs = Array(33).fill(null)
    brokenCollections.players[0].slimes = Array(33).fill(brokenCollections.players[0].slimes[0])
    const brokenRapidFire = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'hermit' }])
    brokenRapidFire.players[0].nextAttackRapidFire = 1_000_000_000
    const brokenAttackCount = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenAttackCount.players[0].attacksPlayedThisTurn = 1_000_000_000
    const brokenEvent = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenEvent.eventDeck[0] = { ...brokenEvent.eventDeck[0], options: [null] }
    const oversizedEvent = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    oversizedEvent.eventDeck[0] = { ...oversizedEvent.eventDeck[0],
      options: Array(33).fill(oversizedEvent.eventDeck[0].options[0]) }
    const brokenEventEffect = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenEventEffect.eventDeck[0] = { ...brokenEventEffect.eventDeck[0],
      options: [{ ...brokenEventEffect.eventDeck[0].options[0], effects: [null] }] }
    const brokenEventCount = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenEventCount.eventDeck[0] = { ...brokenEventCount.eventDeck[0], options: [{ ...brokenEventCount.eventDeck[0].options[0],
      effects: [{ ...brokenEventCount.eventDeck[0].options[0].effects[0], count: 1_000_000_000 }] }] }
    const brokenNeow = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenNeow.neow.players.p1.reward = { kind: 'potion', choices: ['definitely_not_a_potion'],
      cardsDrawn: [], raresDrawn: [] }
    const brokenSocket = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenSocket.pendingGuardianSockets = [null]
    const brokenPendingRelic = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenPendingRelic.players[0].relics[0] = { defId: 'orrery', spent: false, pending: true, pendingRewardDraws: {} }
    const brokenReward = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenReward.phase = 'reward'; brokenReward.neow = null
    brokenReward.rewards = [{ playerId: 'p1', cardReward: true, choices: [], upgraded: false,
      cardsDrawn: [], raresDrawn: [], potion: false, relic: false, bossRelics: false, availableSources: {} }]
    const brokenSetup = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenSetup.phase = 'setup'; brokenSetup.neow = null
    brokenSetup.setup = { kind: 'quick-start', targetAct: 2, playerIds: ['missing-player'], rowIndex: 0,
      repeatIndex: 0, playerIndex: 0, die: null }
    const duplicateSetup = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    duplicateSetup.phase = 'setup'; duplicateSetup.neow = null
    duplicateSetup.setup = { kind: 'quick-start', targetAct: 2, playerIds: ['p1', 'p1'], rowIndex: 0,
      repeatIndex: 0, playerIndex: 0, die: null }
    const brokenMerchant = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenMerchant.phase = 'room'; brokenMerchant.neow = null
    brokenMerchant.map.position = brokenMerchant.map.rows[0][0]
    brokenMerchant.roomState = { kind: 'merchant', relics: [], potions: [], colorless: [],
      cards: { p1: { choices: ['definitely_not_a_card'], cardsDrawn: [], raresDrawn: [] } }, removalUsed: [],
      purchasedCards: {}, guardianGems: {}, socketCardsBought: {} }
    const oversizedMerchant = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    oversizedMerchant.phase = 'room'; oversizedMerchant.neow = null; oversizedMerchant.map.position = oversizedMerchant.map.rows[0][0]
    oversizedMerchant.roomState = { kind: 'merchant', relics: [null, null, null, null], potions: [], colorless: [],
      cards: { p1: { choices: [], cardsDrawn: [], raresDrawn: [] } }, removalUsed: [],
      purchasedCards: {}, guardianGems: {}, socketCardsBought: {} }
    const brokenCombat = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenCombat.combat = createCombat({ seed: 40, calls: 0 }, brokenCombat.players, [{
      uid: 'broken', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
    }], 'broken-combat')
    brokenCombat.phase = 'combat'; brokenCombat.neow = null
    delete brokenCombat.combat.pendingTriggers
    delete brokenCombat.combat.rng
    delete brokenCombat.combat.enemies[0].uid
    delete brokenCombat.combat.enemies[0].hp
    const brokenPresentation = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenPresentation.combat = createCombat({ seed: 40, calls: 0 }, brokenPresentation.players, [{
      uid: 'presentation-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
    }], 'broken-presentation')
    brokenPresentation.phase = 'combat'; brokenPresentation.neow = null
    brokenPresentation.combat.presentationEvents.push({ kind: 'card', seq: 1, actorId: 'p1',
      sourceId: 'definitely_not_a_card', enemyIds: [], playerIds: [], upgraded: false, copied: false, energy: 1 })
    const oversizedPresentationTargets = structuredClone(brokenPresentation)
    oversizedPresentationTargets.combat.presentationEvents = [{ kind: 'card', seq: 1, actorId: 'p1',
      sourceId: 'strike_ironclad', enemyIds: Array(65).fill('presentation-enemy'), playerIds: [],
      upgraded: false, copied: false, energy: 1 }]
    const brokenCopy = structuredClone(brokenPresentation)
    brokenCopy.combat.presentationEvents = []
    brokenCopy.combat.phase = 'copy'
    brokenCopy.combat.pendingCardCopy = {}
    const oversizedCopy = structuredClone(brokenPresentation)
    oversizedCopy.combat.presentationEvents = []
    oversizedCopy.combat.phase = 'copy'
    oversizedCopy.combat.pendingCardCopy = { id: 1, playerId: 'p1',
      card: { uid: 'oversized-copy', defId: 'strike_ironclad', upgraded: false }, energySpent: 0,
      resumePhase: 'player', forcedExhaust: false, forcedChoices: null, deferredHavocs: [],
      sourceNames: Array(65).fill('Rapid Fire') }
    const oversizedCopyEnergy = structuredClone(oversizedCopy)
    oversizedCopyEnergy.combat.pendingCardCopy.sourceNames = ['Rapid Fire']
    oversizedCopyEnergy.combat.pendingCardCopy.energySpent = 1_000_000_000
    const unsafeDeferredCopy = structuredClone(oversizedCopy)
    unsafeDeferredCopy.combat.pendingCardCopy.sourceNames = ['Rapid Fire']
    unsafeDeferredCopy.combat.pendingCardCopy.deferredHavocs = [{
      card: { uid: 'deferred', defId: 'strike_ironclad', upgraded: false }, exhaust: false,
      remainingEffects: [{ kind: 'gainOrbSlots', amount: 1_000_000_000 }],
    }]
    const brokenStartChoice = structuredClone(brokenPresentation)
    brokenStartChoice.combat.presentationEvents = []
    brokenStartChoice.combat.phase = 'start'
    brokenStartChoice.combat.startTurnProgress = { choices: [{ id: 'bad', shivEnemyUids: [],
      evokeSlots: [{}], trigger: { loadUids: {} } }] }
    const oversizedHand = structuredClone(brokenPresentation)
    oversizedHand.combat.presentationEvents = []
    oversizedHand.combat.players[0].hand = Array.from({ length: 513 }, (_, index) => ({
      uid: `oversized-${index}`, defId: 'strike_ironclad', upgraded: false,
    }))
    const brokenPreparedCombat = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenPreparedCombat.phase = 'room'; brokenPreparedCombat.neow = null
    brokenPreparedCombat.map.position = brokenPreparedCombat.map.rows[0][0]
    brokenPreparedCombat.roomState = { kind: 'event', card: brokenPreparedCombat.eventDeck[0],
      decisions: {}, dieRolls: {}, preparedCombat: {} }
    const oversizedEventRoom = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    oversizedEventRoom.phase = 'room'; oversizedEventRoom.neow = null
    oversizedEventRoom.map.position = oversizedEventRoom.map.rows[0][0]
    oversizedEventRoom.roomState = { kind: 'event', card: oversizedEventRoom.eventDeck[0], decisions: {}, dieRolls: {},
      preparedStartTurnScryAbilities: Array.from({ length: 33 }, (_, index) =>
        ({ id: `scry-${index}`, playerId: 'p1', label: 'Scry', amount: 1 })) }
    const brokenEncounter = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenEncounter.enemyDecks.first[0] = { ...brokenEncounter.enemyDecks.first[0],
      randomSummons: { group: 'gremlin', count: 1_000_000_000 } }
    const brokenTopLevel = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenTopLevel.rewardDestination = { bad: true }; brokenTopLevel.eventCombat = []
    const oversizedNestedCollection = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    oversizedNestedCollection.campaignProgress.finishedRunIds = Array(513).fill('finished-run')
    const brokenTreasure = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    brokenTreasure.phase = 'room'; brokenTreasure.neow = null; brokenTreasure.map.position = brokenTreasure.map.rows[0][0]
    brokenTreasure.roomState = { kind: 'treasure', offers: { p1: null }, playerIds: [{}], decisions: { p1: { bad: true } } }
    const oversizedTreasure = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    oversizedTreasure.phase = 'room'; oversizedTreasure.neow = null; oversizedTreasure.map.position = oversizedTreasure.map.rows[0][0]
    oversizedTreasure.roomState = { kind: 'treasure', offers: { p1: null }, playerIds: ['p1'], decisions: {},
      sharedOffers: Array(33).fill(null) }
    const sparse = createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    const sparseFinal = structuredClone(sparse); sparseFinal.phase = 'defeat'; sparseFinal.neow = null
    const selector = makeLog(createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }]))
    selector.events[0].choice = { source: { selector: '[' } }
    const expensiveSelector = makeLog(createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }]))
    expensiveSelector.events[0].choice = { source: { selector: 'body:has(div:has(button))' } }
    const ambiguousPatch = makeLog(createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }]))
    ambiguousPatch.events.unshift({ patch: [{ path: ['nextPendingRelicId'], remove: 'yes', value: 123 }] })
    const oversizedPatches = makeLog(createRun(40, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }]))
    oversizedPatches.events.unshift({ patch: Array.from({ length: 2_001 }, () => ({ path: ['log', 0], remove: true })) })
    return {
      phase: validateRunLog(makeLog(brokenPhase)),
      relic: validateRunLog(makeLog(brokenRelic)),
      map: validateRunLog(makeLog(brokenMap)),
      oversizedMap: validateRunLog(makeLog(oversizedMap)),
      room: validateRunLog(makeLog(brokenRoom)),
      courier: validateRunLog(makeLog(brokenCourier)),
      inheritedCard: validateRunLog(makeLog(inheritedCard)),
      modifier: validateRunLog(makeLog(brokenModifier)),
      repeatedModifier: validateRunLog(makeLog(repeatedModifier)),
      campaign: validateRunLog(makeLog(brokenCampaign)),
      gold: validateRunLog(makeLog(brokenGold)),
      rng: validateRunLog(makeLog(brokenRng)),
      strayCombat: validateRunLog(makeLog(strayCombat)),
      player: validateRunLog(makeLog(brokenPlayer)),
      resources: validateRunLog(makeLog(brokenResources)),
      collections: validateRunLog(makeLog(brokenCollections)),
      rapidFire: validateRunLog(makeLog(brokenRapidFire)),
      attackCount: validateRunLog(makeLog(brokenAttackCount)),
      event: validateRunLog(makeLog(brokenEvent)),
      oversizedEvent: validateRunLog(makeLog(oversizedEvent)),
      eventEffect: validateRunLog(makeLog(brokenEventEffect)),
      eventCount: validateRunLog(makeLog(brokenEventCount)),
      neow: validateRunLog(makeLog(brokenNeow)),
      socket: validateRunLog(makeLog(brokenSocket)),
      pendingRelic: validateRunLog(makeLog(brokenPendingRelic)),
      reward: validateRunLog(makeLog(brokenReward)),
      setup: validateRunLog(makeLog(brokenSetup)),
      duplicateSetup: validateRunLog(makeLog(duplicateSetup)),
      merchant: validateRunLog(makeLog(brokenMerchant)),
      oversizedMerchant: validateRunLog(makeLog(oversizedMerchant)),
      combat: validateRunLog(makeLog(brokenCombat)),
      presentation: validateRunLog(makeLog(brokenPresentation)),
      presentationTargets: validateRunLog(makeLog(oversizedPresentationTargets)),
      copy: validateRunLog(makeLog(brokenCopy)),
      oversizedCopy: validateRunLog(makeLog(oversizedCopy)),
      copyEnergy: validateRunLog(makeLog(oversizedCopyEnergy)),
      deferredCopy: validateRunLog(makeLog(unsafeDeferredCopy)),
      startChoice: validateRunLog(makeLog(brokenStartChoice)),
      hand: validateRunLog(makeLog(oversizedHand)),
      preparedCombat: validateRunLog(makeLog(brokenPreparedCombat)),
      eventRoom: validateRunLog(makeLog(oversizedEventRoom)),
      encounter: validateRunLog(makeLog(brokenEncounter)),
      topLevel: validateRunLog(makeLog(brokenTopLevel)),
      nestedCollection: validateRunLog(makeLog(oversizedNestedCollection)),
      treasure: validateRunLog(makeLog(brokenTreasure)),
      oversizedTreasure: validateRunLog(makeLog(oversizedTreasure)),
      selector: validateRunLog(selector),
      expensiveSelector: validateRunLog(expensiveSelector),
      ambiguousPatch: validateRunLog(ambiguousPatch),
      patches: validateRunLog(oversizedPatches),
      sparse: validateRunLog({ version: 2, runId: sparse.campaign.runId, initial: sparse,
        events: [{ patch: [{ path: ['rewards', 1_000_000], value: {} }] }, { patch: [{ path: [], value: sparseFinal }] }] }),
    }
  })
  assert.deepEqual(invalidStates, { phase: null, relic: null, map: null, oversizedMap: null, room: null, courier: null,
    inheritedCard: null, modifier: null, repeatedModifier: null, campaign: null, gold: null, rng: null, strayCombat: null, player: null, resources: null,
    collections: null, rapidFire: null, attackCount: null, event: null, oversizedEvent: null, eventEffect: null,
    eventCount: null, neow: null,
    socket: null, pendingRelic: null, reward: null, setup: null, duplicateSetup: null, merchant: null, oversizedMerchant: null, combat: null,
    presentation: null, presentationTargets: null, copy: null, oversizedCopy: null, copyEnergy: null, deferredCopy: null,
    startChoice: null, hand: null,
    preparedCombat: null, eventRoom: null, encounter: null, topLevel: null, nestedCollection: null, treasure: null,
    oversizedTreasure: null, selector: null, expensiveSelector: null,
    ambiguousPatch: null, patches: null, sparse: null })

  const legacyCompatibility = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { validateRunLog } = await import('/src/ui/run-log.ts')
    const makeLog = (initial) => {
      const final = structuredClone(initial); final.phase = 'defeat'; final.neow = null; final.combat = null
      return { version: 2, runId: initial.campaign.runId, initial, events: [{ patch: [{ path: [], value: final }] }] }
    }
    const selectors = ['.campfire__choices button', '.reward-screen__player > .loot-choice:nth-of-type(4)',
      `[data-orb-slot="${String.fromCharCode(92)}30 "]`]
    const selectorRuns = selectors.map((selector) => {
      const log = makeLog(createRun(49, [{ id: 'p1', name: 'Replay Tester', character: 'defect' }]))
      log.events[0].choice = { source: { selector } }
      return Boolean(validateRunLog(log))
    })
    const potion = createRun(50, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    potion.neow.players.p1.reward = { kind: 'potion', choices: ['attack_potion'],
      cardsDrawn: ['attack_potion'], raresDrawn: [] }
    const summonGroup = createRun(52, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    summonGroup.enemyDecks.encounter[0] = { ...summonGroup.enemyDecks.encounter[0], summons: ['byrd'] }
    const redundant = createRun(51, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    delete redundant.nextPendingRelicId
    const final = structuredClone(redundant); final.phase = 'defeat'; final.neow = null
    const removal = { version: 2, runId: redundant.campaign.runId, initial: redundant, events: [
      { patch: [{ path: ['nextPendingRelicId'], remove: true }] }, { patch: [{ path: [], value: final }] },
    ] }
    return { selectorRuns, potion: Boolean(validateRunLog(makeLog(potion))),
      summonGroup: Boolean(validateRunLog(makeLog(summonGroup))), removal: Boolean(validateRunLog(removal)) }
  })
  assert.deepEqual(legacyCompatibility, { selectorRuns: [true, true, true], potion: true, summonGroup: true, removal: true },
    'Previously recorded run-log shapes stopped validating')

  assert.equal(await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { buyFromMerchant, createMerchant, merchantPurchaseCost } = await import('/src/game/noncombat.ts')
    const { validateRunLog } = await import('/src/ui/run-log.ts')
    const initial = createRun(46, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    initial.players[0].gold = 99
    const shop = createMerchant(initial.itemDecks, initial.players)
    const cost = merchantPurchaseCost(shop, { buyerId: 'p1', section: 'card', slot: 0, payments: {} })
    const bought = buyFromMerchant(shop, initial.itemDecks, initial.players, initial.ascension,
      { buyerId: 'p1', section: 'card', slot: 0, payments: { p1: cost } })
    if (!bought) return false
    initial.players = bought.players; initial.roomState = bought.shop; initial.phase = 'room'; initial.neow = null
    initial.map.position = initial.map.rows[0][0]
    const final = structuredClone(initial); final.phase = 'defeat'
    return Boolean(validateRunLog({ version: 2, runId: initial.campaign.runId, initial,
      events: [{ patch: [{ path: [], value: final }] }] }))
  }), true, 'A legitimate sold merchant card slot was rejected')

  const validationBudget = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { validateRunLog } = await import('/src/ui/run-log.ts')
    const initial = createRun(45, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    const final = structuredClone(initial); final.phase = 'defeat'; final.neow = null
    const events = Array.from({ length: 2_000 }, (_, index) => ({ patch: index === 1_999
      ? [{ path: [], value: final }] : [{ path: ['log', index], value: `Step ${index} ${'x'.repeat(1_024)}` }] }))
    const started = performance.now()
    const result = validateRunLog({ version: 2, runId: initial.campaign.runId, initial, events })
    return { result, elapsed: performance.now() - started }
  })
  assert.equal(validationBudget.result, null)
  assert(validationBudget.elapsed < 1_000, `Run-log work budget was too slow: ${validationBudget.elapsed}ms`)

  const controlBudget = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { validateRunLog } = await import('/src/ui/run-log.ts')
    const initial = createRun(47, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    const selector = `button${':not(.missing)'.repeat(290)}`
    const events = Array.from({ length: 1_000 }, () => ({ patch: [{ path: ['log', 0], value: 'step' }],
      choice: { source: { selector } } }))
    const started = performance.now()
    const result = validateRunLog({ version: 2, runId: initial.campaign.runId, initial, events })
    return { result, elapsed: performance.now() - started }
  })
  assert.equal(controlBudget.result, null)
  assert(controlBudget.elapsed < 1_000, `Run-log control budget was too slow: ${controlBudget.elapsed}ms`)

  const abortedReplayStates = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { playRunLog } = await import('/src/ui/run-log.ts')
    const initial = createRun(48, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    const final = structuredClone(initial); final.phase = 'defeat'; final.neow = null; final.players[0].gold = 999
    const controller = new AbortController()
    const gold = []
    const replay = playRunLog({ version: 2, runId: initial.campaign.runId, initial, events: [{
      patch: [{ path: [], value: final }], choice: { source: { selector: '#never-appears' } },
    }] }, { setRun: (run) => gold.push(run.players[0].gold), setViewer() {}, reducedMotion: true, signal: controller.signal })
    const abortTimer = setTimeout(() => controller.abort(), 120)
    try {
      const remove = await window.__awaitReplay({ controller, promise: replay }, 5_000)
      remove()
      return gold
    } finally {
      clearTimeout(abortTimer)
      controller.abort()
    }
  })
  assert.deepEqual(abortedReplayStates, [0], 'Aborted replay applied the in-flight event patch')
  assert.equal(await page.locator('.run-replay__cursor').count(), 0, 'Aborted replay left its synthetic cursor behind')

  const localBeforeReplay = await page.evaluate(() => ({
    progress: structuredClone(window.__STS_DEBUG__.getRun().campaignProgress),
    stored: localStorage.getItem('sts-physical-campaign'),
  }))

  const fixture = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const initial = createRun(41, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    initial.campaignProgress.highestAscension = 13
    const final = structuredClone(initial)
    final.phase = 'defeat'
    final.neow = null
    return { version: 2, runId: initial.campaign.runId, initial,
      events: [{ patch: [{ path: [], value: final }], viewerId: 'p1' }] }
  })
  await page.locator('.run-replay-import').evaluate((screen, log) => {
    const transfer = new DataTransfer()
    const file = new File([JSON.stringify(log)], 'slow.json', { type: 'application/json' })
    file.text = () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(log)), 150))
    transfer.items.add(file)
    screen.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, fixture)
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await page.getByText('Give your run to me', { exact: true }).waitFor()
  await droppedFile(page, 'run.json', JSON.stringify(fixture))
  await page.getByText('Your run is accepted', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-replay-import[data-transitioning="true"]').count(), 1)
  assert.equal(await page.locator('.run-replay-import').evaluate((screen) => {
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
    return screen.dispatchEvent(event)
  }), false, 'A drop during the accepted transition was not canceled')
  await page.waitForTimeout(360)
  await page.screenshot({ path: join(output, 'clock-transition-desktop.png') })
  await page.locator('.app-shell').waitFor()
  await page.locator('.run-replay__cursor').waitFor()
  assert.equal(await page.evaluate(async () => (await import('/src/ui/run-log.ts')).queryRunLogControl(
    document, { selector: '.game-settings', name: 'Settings' })), null, 'Replay may activate settings controls')
  await page.screenshot({ path: join(output, 'replay-desktop.png') })

  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Slay the Spire' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Give up', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Return to main menu', exact: true }).click()
  await page.getByRole('button', { name: 'Replay', exact: true }).waitFor()
  assert.equal(await page.locator('.run-replay__cursor').count(), 0, 'synthetic cursor survived leaving replay')
  const localAfterReplay = await page.evaluate(() => ({
    progress: window.__STS_DEBUG__.getRun().campaignProgress,
    stored: localStorage.getItem('sts-physical-campaign'),
  }))
  assert.deepEqual(localAfterReplay, localBeforeReplay, 'Replay overwrote the local campaign journal')

  const guard = await page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { playRunLog } = await import('/src/ui/run-log.ts')
    const action = document.createElement('button')
    action.id = 'replay-action-fixture'
    action.textContent = 'Replay action fixture'
    const step = document.createElement('button')
    step.id = 'replay-step-fixture'
    step.textContent = 'Replay step fixture'
    step.addEventListener('click', () => { step.dataset.clicks = String(Number(step.dataset.clicks ?? 0) + 1) })
    const overlay = document.createElement('dialog')
    overlay.className = 'card-collection'
    const gameplayDialog = document.createElement('dialog')
    gameplayDialog.className = 'replay-gameplay-dialog-fixture'
    gameplayDialog.textContent = 'Replay gameplay choice'
    action.addEventListener('click', () => {
      const clicks = Number(action.dataset.clicks ?? 0) + 1
      action.dataset.clicks = String(clicks)
      if (clicks === 1) overlay.showModal()
    })
    const inspect = document.createElement('button')
    inspect.className = 'map-peek__open'
    inspect.textContent = 'Replay inspection fixture'
    inspect.addEventListener('click', () => { inspect.dataset.clicks = String(Number(inspect.dataset.clicks ?? 0) + 1) })
    document.body.append(action, step, inspect, overlay, gameplayDialog)
    const initial = createRun(42, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    const final = structuredClone(initial); final.phase = 'defeat'; final.neow = null
    const controller = new AbortController()
    window.__REPLAY_GUARD__ = { controller, promise: playRunLog({ version: 2, runId: initial.campaign.runId, initial,
      events: [{ patch: [{ path: [], value: final }], choice: { source: { selector: '#replay-action-fixture' },
        steps: [{ selector: '#replay-step-fixture' }] } }] },
    { setRun() {}, setViewer() {}, reducedMotion: false, signal: controller.signal,
      pause: () => { document.body.dataset.replayPauseRequests = String(Number(document.body.dataset.replayPauseRequests ?? 0) + 1) } }) }
    return true
  })
  assert.equal(guard, true)
  await page.evaluate(() => document.querySelector('.replay-gameplay-dialog-fixture').showModal())
  await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(() => ({
    open: document.querySelector('.replay-gameplay-dialog-fixture').open,
    pauses: document.body.dataset.replayPauseRequests,
  })), { open: true, pauses: '1' }, 'Escape mutated a replay gameplay dialog instead of requesting pause')
  await page.evaluate(() => document.querySelector('.replay-gameplay-dialog-fixture').close())
  await page.getByRole('button', { name: 'Replay action fixture' }).click()
  await page.getByRole('button', { name: 'Replay inspection fixture' }).click()
  const trusted = await page.evaluate(() => ({ action: document.querySelector('#replay-action-fixture').dataset.clicks ?? '0',
    inspect: document.querySelector('.map-peek__open').dataset.clicks ?? '0' }))
  assert.deepEqual(trusted, { action: '0', inspect: '1' })
  await page.waitForFunction(() => document.querySelector('#replay-action-fixture')?.dataset.clicks === '1')
  await page.waitForTimeout(1_200)
  assert.equal(await page.evaluate(() => document.querySelector('#replay-step-fixture')?.dataset.clicks ?? '0'), '0',
    'Replay continued through a multi-step choice while an inspection overlay was open')
  await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(() => ({
    open: document.querySelector('.card-collection').open,
    pauses: document.body.dataset.replayPauseRequests,
  })), { open: false, pauses: '1' }, 'Escape failed to close replay inspection without opening pause')
  await page.evaluate(() => window.__awaitReplay(window.__REPLAY_GUARD__))
  assert.equal(await page.locator('.run-replay__cursor').evaluate((cursor) => cursor.getAnimations().length), 0,
    'Replay retained completed cursor animations')
  await page.getByRole('button', { name: 'Replay action fixture' }).click()
  await page.getByRole('button', { name: 'Replay inspection fixture' }).click()
  const afterReplay = await page.evaluate(() => ({ action: document.querySelector('#replay-action-fixture').dataset.clicks ?? '0',
    step: document.querySelector('#replay-step-fixture').dataset.clicks ?? '0',
    inspect: document.querySelector('.map-peek__open').dataset.clicks ?? '0' }))
  assert.deepEqual(afterReplay, { action: '1', step: '1', inspect: '2' }, 'Replay stopped being read-only at the end of the log')
  await page.evaluate(async () => {
    window.__REPLAY_GUARD__.controller.abort()
    const remove = await window.__awaitReplay(window.__REPLAY_GUARD__)
    remove()
    document.querySelector('#replay-action-fixture').click()
    if (document.querySelector('#replay-action-fixture').dataset.clicks !== '2') throw new Error('Replay guard survived cleanup')
    delete window.__REPLAY_GUARD__
    const { createRun } = await import('/src/game/run.ts')
    const { playRunLog } = await import('/src/ui/run-log.ts')
    const initial = createRun(44, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    const controller = new AbortController()
    window.__REPLAY_FAILURE__ = { controller, promise: playRunLog({ version: 2, runId: initial.campaign.runId, initial,
      events: [{ patch: [{ path: ['missing', 'value'], value: true }],
        choice: { source: { selector: '#replay-action-fixture' } } }] },
    { setRun() {}, setViewer() {}, reducedMotion: true, signal: controller.signal }).then(() => '', (error) => String(error)) }
  })
  await page.waitForFunction(() => document.querySelector('#replay-action-fixture')?.dataset.clicks === '3')
  assert.match(await page.evaluate(() => window.__awaitReplay(window.__REPLAY_FAILURE__)), /Invalid run log path/)
  assert.equal(await page.locator('.run-replay__cursor').count(), 0, 'Failed replay left a frozen cursor')
  await page.getByRole('button', { name: 'Replay action fixture' }).click()
  assert.equal(await page.evaluate(() => document.querySelector('#replay-action-fixture').dataset.clicks), '3',
    'Failed replay stopped being read-only')
  await page.evaluate(() => {
    window.__REPLAY_FAILURE__.controller.abort()
    document.querySelector('#replay-action-fixture').click()
    if (document.querySelector('#replay-action-fixture').dataset.clicks !== '4') throw new Error('Failed replay guard survived cleanup')
    document.querySelector('#replay-action-fixture')?.remove()
    document.querySelector('#replay-step-fixture')?.remove()
    document.querySelector('.map-peek__open')?.remove()
    document.querySelector('.card-collection')?.remove()
    document.querySelector('.replay-gameplay-dialog-fixture')?.remove()
    delete document.body.dataset.replayPauseRequests
    delete window.__REPLAY_FAILURE__
  })

  for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
    await page.getByRole('button', { name: label, exact: true }).click()
  }
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
  await page.getByRole('button', { name: 'Gain 3 Gold', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players[0].gold === 3)
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.nextPendingRelicId = 1
    window.__STS_DEBUG__.setRun(run)
  })
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.nextPendingRelicId = undefined
    window.__STS_DEBUG__.setRun(run)
  })
  await page.evaluate(async () => {
    const { createCombat } = await import('/src/game/combat.ts')
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    const enemy = { uid: 'replay-jaw-worm', defId: 'jaw_worm', row: 0, isBoss: false, actsLast: false,
      hp: 40, maxHp: 40, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }
    run.combat = createCombat({ seed: 43, calls: 0 }, run.players, [enemy], 'run-replay-card-target')
    Object.assign(run.combat.players[0], {
      hand: [{ uid: 'replay-strike', defId: 'strike_ironclad', upgraded: false }], energy: 3,
    })
    run.phase = 'combat'
    run.neow = null
    window.__STS_DEBUG__.setRun(run)
  })
  const replayStrike = page.getByRole('button', { name: /^Strike,/ })
  await replayStrike.waitFor()
  await replayStrike.click()
  await page.locator('[data-enemy-id="replay-jaw-worm"]').click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
  assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp), 39)
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'defeat'
    run.neow = null
    window.__STS_DEBUG__.setRun(run)
  })
  await page.getByRole('button', { name: 'Extract run logs', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-run-log-control=""]')?.disabled)
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Extract run logs', exact: true }).click(),
  ]).then(([value]) => value)
  const path = await download.path()
  assert(path)
  const downloaded = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(downloaded.version, 2)
  assert.equal(downloaded.runId, downloaded.initial.campaign.runId)
  assert(downloaded.events.length > 0)
  assert(downloaded.events.some((event) => event.choice?.source?.name === 'Gain 3 Gold'), 'Downloaded log omitted the recorded game decision')
  assert(downloaded.events.some((event) => event.choice?.source?.name?.startsWith('Strike,') && event.choice.target),
    'Downloaded log omitted the recorded card target')
  assert(downloaded.events.some((event) => event.patch.some((change) => change.remove && change.path[0] === 'nextPendingRelicId')),
    'Downloaded log did not preserve an undefined property as a JSON removal')
  assert.equal(await page.evaluate(async (log) => Boolean((await import('/src/ui/run-log.ts')).validateRunLog(log)), downloaded), true,
    'Downloaded JSON did not survive a validation round-trip')
  const legacy = structuredClone(downloaded)
  const legacyRemoval = legacy.events.flatMap((event) => event.patch).find((change) => change.remove)
  delete legacyRemoval.remove
  legacyRemoval.value = undefined
  const normalizedDownload = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async (log) => (await import('/src/ui/run-log.ts')).downloadRunLog(log), legacy),
  ]).then(([value]) => value)
  const normalizedPath = await normalizedDownload.path()
  assert(normalizedPath)
  const normalized = JSON.parse(readFileSync(normalizedPath, 'utf8'))
  assert(normalized.events.some((event) => event.patch.some((change) => change.remove === true)),
    'Legacy IndexedDB undefined patch was not normalized for JSON download')
  assert.equal(await page.evaluate(async (log) => Boolean((await import('/src/ui/run-log.ts')).validateRunLog(log)), normalized), true,
    'Normalized legacy log did not survive validation')
  assert.equal(await page.getByText('Run log downloaded.', { exact: true }).count(), 1)

  assert.equal(await page.getByRole('button', { name: 'Prepare next run →', exact: true }).count(), 0,
    'Extracting logs unlocked the next run before the campaign result was recorded')
  await page.getByRole('button', { name: 'Record campaign result', exact: true }).click()
  await page.getByRole('button', { name: 'Prepare next run →', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await droppedFile(page, 'recorded-run.json', JSON.stringify(downloaded))
  await page.getByText('Your run is accepted', { exact: true }).waitFor()
  await page.getByRole('button', { name: /^Strike,/ }).waitFor()
  assert.equal(await page.getByText('Run log downloaded.', { exact: true }).count(), 0, 'Replay retained a stale download message')
  await page.locator('.deck-peek__open').click()
  await page.getByRole('dialog', { name: 'Current deck' }).waitFor()
  assert.equal(await page.locator('.hand').getByRole('button', { name: /^Strike,/ }).count(), 1,
    'Replay advanced while deck inspection was open')
  await page.getByRole('dialog', { name: 'Current deck' }).getByRole('button', { name: 'Back' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'defeat')
  assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].gold), 3, 'Recorded decision was not replayed')
  assert.equal(await page.getByText(/^Replay stopped/).count(), 0)
  await page.waitForTimeout(1_700)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Slay the Spire' }).waitFor()
  await page.getByRole('button', { name: 'Return to main menu', exact: true }).click()
  await page.getByRole('button', { name: 'Replay', exact: true }).waitFor()
  assert.deepEqual(desktop.errors, [])
  await desktop.context.close()

  const merchantReplay = await open({ width: 1600, height: 900 })
  for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
    await merchantReplay.page.getByRole('button', { name: label, exact: true }).click()
  }
  const merchantRemoval = await merchantReplay.page.evaluate(async () => {
    const { createRun } = await import('/src/game/run.ts')
    const { createMerchant } = await import('/src/game/noncombat.ts')
    const { playRunLog } = await import('/src/ui/run-log.ts')
    const initial = createRun(53, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
    initial.players[0].gold = 99
    initial.roomState = createMerchant(initial.itemDecks, initial.players)
    initial.phase = 'room'; initial.neow = null; initial.map.position = initial.map.rows[0][0]
    const after = structuredClone(initial)
    after.players[0].gold -= 3
    after.players[0].deck.splice(1, 1)
    after.roomState.removalUsed.push('p1')
    const event = { patch: [{ path: [], value: after }], choice: {
      source: { selector: 'main > section > div:nth-of-type(1) > button', name: 'Enter merchant shop' },
      steps: [
        { selector: 'main > section > div:nth-of-type(2) > div:nth-of-type(5) > button', name: '▱Card Removal Service3 Gold' },
        { selector: 'dialog:nth-of-type(2) > section > div > button:nth-of-type(2)', name: 'Strike, cost 1, attack, deal 1 damage' },
        { selector: 'dialog:nth-of-type(2) > section > button', name: 'Remove selected card · ◉ 3' },
      ],
    } }
    const controller = new AbortController()
    try {
      const cleanup = await window.__awaitReplay({ controller, promise: playRunLog({ version: 2, runId: initial.campaign.runId, initial, events: [event] }, {
        setRun: (run) => window.__STS_DEBUG__.setRun(run), setViewer() {}, reducedMotion: true, signal: controller.signal,
      }) })
      cleanup()
      return { error: null, deckSize: window.__STS_DEBUG__.getRun().players[0].deck.length }
    } catch (error) { return { error: String(error), deckSize: window.__STS_DEBUG__.getRun().players[0].deck.length } }
    finally { controller.abort() }
  })
  assert.deepEqual(merchantRemoval, { error: null, deckSize: 9 }, 'Replay stalled in the merchant card-removal dialog')
  await merchantReplay.page.screenshot({ path: join(output, 'merchant-card-removal-replay.png') })
  assert.deepEqual(merchantReplay.errors, [])
  await merchantReplay.context.close()

  const touchDesktop = await open({ width: 1600, height: 900 }, true)
  await touchDesktop.page.getByRole('button', { name: 'Replay', exact: true }).click()
  assert.equal(await touchDesktop.page.getByRole('button', { name: 'Choose run log' }).isVisible(), false,
    'Touch-capable desktop exposed the horizontal-phone file chooser')
  await touchDesktop.context.close()

  const phone = await open({ width: 844, height: 390 }, true, true)
  await phone.page.getByRole('button', { name: 'Replay', exact: true }).click()
  await phone.page.getByText('Give your run to me', { exact: true }).waitFor()
  await phone.page.getByRole('button', { name: 'Choose run log' }).waitFor()
  await phone.page.screenshot({ path: join(output, 'time-eater-horizontal-phone.png') })
  const phoneFit = await phone.page.evaluate(() => {
    const required = [...document.querySelectorAll('.run-replay-import__prompt, .run-replay-import__upload, .run-replay-import__back')]
      .map((element) => element.getBoundingClientRect().toJSON())
    const upload = document.querySelector('.run-replay-import__upload')?.getBoundingClientRect().toJSON()
    return { width: innerWidth, height: innerHeight, required, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, upload }
  })
  assert(phoneFit.scrollWidth <= phoneFit.width && phoneFit.scrollHeight <= phoneFit.height)
  assert(phoneFit.required.every((box) => box.x >= 0 && box.y >= 0 && box.right <= phoneFit.width && box.bottom <= phoneFit.height), JSON.stringify(phoneFit))
  assert(phoneFit.upload && phoneFit.upload.width >= 240 && phoneFit.upload.height >= 72, JSON.stringify(phoneFit.upload))
  await phone.page.locator('input[type="file"]').setInputFiles({ name: 'run.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await phone.page.getByText('Your run is accepted', { exact: true }).waitFor()
  await phone.page.locator('.app-shell').waitFor()
  await phone.page.keyboard.press('Escape')
  await phone.page.getByRole('button', { name: 'Return to main menu', exact: true }).click()
  await phone.page.getByRole('button', { name: 'Replay', exact: true }).waitFor()
  assert.deepEqual(phone.errors, [])
  await phone.context.close()

  const widePhone = await open({ width: 932, height: 430 }, true, true)
  await widePhone.page.getByRole('button', { name: 'Replay', exact: true }).click()
  await widePhone.page.getByRole('button', { name: 'Choose run log' }).waitFor()
  assert.deepEqual(widePhone.errors, [])
  await widePhone.context.close()

  console.log('✓ run replay: desktop drag and phone upload validation, Time Eater transition, live cursor, input guard, pause menu, log download')
} finally {
  if (desktop) await desktop.page.evaluate(() => {
    window.__REPLAY_GUARD__?.controller.abort()
    window.__REPLAY_FAILURE__?.controller.abort()
  }).catch(() => {})
  await browser.close()
  await server.close()
}
