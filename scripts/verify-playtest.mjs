// Owning boundary: AI CLI sessions, isolated budgets, durable results and authoritative metrics.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execute, parseOptions } from './playtest.mjs'
import { applyAction } from './playtest/engine.mjs'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { createRun, enterRoom, roomChoices } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { ALL_CHARACTER_IDS } from '../src/game/types.ts'

const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const save = (file, value) => writeFileSync(file, JSON.stringify(value))
const invoke = (command, out, extra = {}) => execute({ ...parseOptions([command, '--out', out]), ...extra })
let request = 0
const act = (out, worker, view, actions, extra = {}) => invoke('act', out, { worker, revision: view.revision,
  request: `test-${request++}`, actions: JSON.stringify(actions), ...extra })
// Scripted surrender-style choices exercise budget plumbing; they are not an AI balance sample.
function scriptedWorker(out, worker) {
  let view = invoke('inspect', out, { worker })
  for (let guard = 0; !view.done && guard < 5000; guard++) {
    let input
    if (view.phase === 'neow') {
      const neow = view.prompts.neow
      input = neow.redGoldPending ? ['resolveNeowGold', false]
        : neow.redRewardPending || neow.reward ? ['resolveNeowReward', neow.reward?.kind === 'potion' ? { kind: 'skip' } : null]
          : neow.pendingEffect ? ['resolveNeowEffect', false] : ['neow', 0]
    } else if (view.phase === 'map') input = ['room', view.prompts.routes.find((room) => room.kind === 'encounter')?.id ?? view.prompts.routes[0].id]
    else if (view.phase === 'combat') input = view.prompts.endAbility
      ? ['resolveEndTurnAbility', `${view.prompts.endAbility.id}@${view.prompts.endAbility.targets[0].uid}`]
      : view.prompts.endAbilities?.length > 1 && !view.prompts.endAbilities.some((ability) => ability.orbChoice)
        ? ['end', view.prompts.endAbilities.map((ability) => ability.id + (ability.targets?.length ? `@${ability.targets[0].uid}` : ''))] : ['end']
    else throw new Error(`Unexpected scripted-budget prompt ${view.phase}`)
    view = act(out, worker, view, [input])
    assert(!view.error, view.error)
  }
  assert(view.done, 'worker must finish its entire assigned budget')
}
if (process.argv[2] === '--worker-mode') {
  scriptedWorker(process.argv[3], Number(process.argv[4])); process.exit(0)
}
const temp = mkdtempSync(join(tmpdir(), 'sts-playtest-'))
function fixture(out, run) {
  const session = json(join(out, 'worker-0.json'))
  session.run = run; session.reveal = null; session.lastView = null
  save(join(out, 'worker-0.json'), session)
  return invoke('inspect', out)
}
function combatRun(character = 'ironclad', cards = ['strike_ironclad', 'strike_ironclad', 'defend_ironclad']) {
  const run = createRun(7, [{ id: 'p1', name: 'Playtest', character }])
  const player = run.players[0]
  const hand = cards.map((defId, index) => ({ uid: `test${index}`, defId, upgraded: false }))
  const combat = createCombat(createRng(2), [{ ...player, hand, deck: hand, draw: [], discard: [], powers: [] }], [{
    uid: 'e0', defId: 'jaw_worm', hp: 30, maxHp: 30, row: 0, isBoss: false, ascension: 0, block: 0,
    strength: 0, weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, dead: false, goldReward: 0, cardReward: 'none',
  }])
  combat.phase = 'player'; combat.players[0].hand = hand; combat.players[0].draw = []; combat.players[0].energy = 3
  return { ...run, phase: 'combat', neow: null, combat, players: [{ ...player, deck: hand }] }
}
try {
  // Invalid input must not accidentally turn an AI typo into an empty/huge budget.
  for (const args of [['init', '--runs', 'NaN'], ['init', '--workers', '0'], ['init', '--seed', '4294967295', '--runs', '2'], ['init', '--character', 'unknown']]) assert.throws(() => parseOptions(args))
  const out = join(temp, 'sequence')
  invoke('init', out, { runs: 1 })
  let view = invoke('inspect', out)
  assert.equal(view.phase, 'neow')
  assert.equal(view.prompts.neow.redGoldPending, true, 'optional Gold remains an AI choice')
  const initialFile = readFileSync(join(out, 'worker-0.json'), 'utf8')
  assert.throws(() => act(out, 0, view, [['neow', 0]], { revision: 999 }), /Stale/)
  assert.equal(readFileSync(join(out, 'worker-0.json'), 'utf8'), initialFile)
  const goldRequest = { command: 'act', out, worker: 0, revision: view.revision, request: 'gold', actions: JSON.stringify([['resolveNeowGold', true]]) }
  const first = invoke('act', out, goldRequest)
  const replay = invoke('act', out, goldRequest)
  assert.deepEqual(JSON.parse(JSON.stringify({ ...replay, replayed: undefined })), JSON.parse(JSON.stringify(first)))
  assert.equal(json(join(out, 'worker-0.json')).revision, first.revision)
  assert.throws(() => invoke('act', out, { ...goldRequest, actions: JSON.stringify([['resolveNeowGold', false]]) }), /different input/)

  const streamed = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./playtest.mjs', import.meta.url)), 'serve', '--out', out],
    { input: 'invalid-json\n' + JSON.stringify({ command: 'inspect' }) + '\n', encoding: 'utf8' })
  assert.equal(streamed.status, 0, streamed.stderr)
  const messages = streamed.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(messages.length, 3); assert(messages[1].error); assert.equal(messages[2].revision, first.revision)

  view = fixture(out, combatRun())
  const unseen = json(join(out, 'worker-0.json'))
  unseen.run.combat.players[0].draw = [{ uid: 'hidden-test', defId: 'bash', upgraded: false }]
  unseen.run.combat.potionDeck = ['secret-supply-test']
  save(join(out, 'worker-0.json'), unseen)
  const publicView = JSON.stringify(invoke('inspect', out, { detail: true }))
  assert(!publicView.includes('hidden-test')); assert(!publicView.includes('secret-supply-test'))
  view = fixture(out, combatRun())
  const sequence = act(out, 0, view, [['play', 'test0', 'e0'], ['play', 'test1', 'e0'], ['play', 'test2']])
  assert.equal(sequence.sequence.completed, 3)
  assert.equal(sequence.enemies[0].hp, 28)
  assert.equal(sequence.player.block, 1)
  const state = json(join(out, 'worker-0.json'))
  assert.equal(state.record.acts[1].damage, 2)
  assert.equal(state.record.cards.strike_ironclad.plays, 2)
  const delta = invoke('inspect', out, { since: sequence.revision })
  assert.deepEqual(delta.changes, {}, 'unchanged compact inspection sends no repeated definitions')

  view = fixture(out, combatRun())
  const changed = act(out, 0, view, [['play', 'test0', 'e0']], { since: view.revision })
  const expanded = JSON.parse(JSON.stringify(view))
  for (const [key, value] of Object.entries(changed.changes)) {
    if (value === null) delete expanded[key]
    else if (key.endsWith('Text')) expanded[key] = { ...expanded[key], ...value }
    else expanded[key] = value
  }
  assert.deepEqual(expanded, JSON.parse(JSON.stringify(invoke('inspect', out))), 'compact changes reconstruct the full current prompt')

  let choiceBatch = join(temp, 'choice-metadata')
  invoke('init', choiceBatch, { runs: 1 }); invoke('inspect', choiceBatch)
  const modified = combatRun('ironclad', ['bash'])
  modified.combat.players[0].hand[0].freeThisTurn = true
  modified.combat.players[0].hand[0].retainThisTurn = true
  modified.combat.players[0].powers = [{ uid: 'bomb', defId: 'the_bomb', upgraded: false, counter: 2 }]
  view = fixture(choiceBatch, modified)
  assert.deepEqual(view.player.hand[0].slice(2), [null, { freeThisTurn: true, retainThisTurn: true }])
  assert.equal(view.player.powers[0][3].counter, 2, 'public Power cubes survive compact and detailed inspection')
  assert.equal(invoke('inspect', choiceBatch, { detail: true }).player.hand[0][3].freeThisTurn, true)
  for (const key of ['nextCardCost', 'enemyNextCardCost', 'hpLossLimitThisRound']) {
    modified.combat.players[0][key] = 0
    view = fixture(choiceBatch, modified)
    assert.equal(view.player[key], 0, `${key}: zero is an active override, not the unset default`)
  }

  const ordered = combatRun('defect', ['shame'])
  ordered.combat.players[0].orbs = ['frost', null, null]
  ordered.combat.players[0].block = 0
  view = fixture(choiceBatch, ordered)
  assert(view.prompts.endAbilities.length > 1)
  const needsOrder = act(choiceBatch, 0, view, [['end']])
  assert.match(needsOrder.error, /explicit end order/)
  const shameFirst = [...view.prompts.endAbilities].sort((a, b) => Number(!a.label.includes('Shame')) - Number(!b.label.includes('Shame'))).map((ability) => ability.id)
  const ignoredOrder = act(choiceBatch, 0, needsOrder, [['beginEndTurnResolution', shameFirst]])
  assert.match(ignoredOrder.error, /Use end/, 'long-form automatic resolution cannot silently ignore a supplied order')
  const choseOrder = act(choiceBatch, 0, ignoredOrder, [['end', shameFirst]])
  assert(!choseOrder.error, choseOrder.error)
  assert.equal(json(join(choiceBatch, 'worker-0.json')).record.acts[1].blockNetGained, 1, 'Shame resolves before Frost because the AI selected that order')

  for (const potion of ['transforming_brew', 'entropic_brew']) {
    choiceBatch = join(temp, potion)
    invoke('init', choiceBatch, { runs: 1 }); invoke('inspect', choiceBatch)
    const brewed = combatRun('ironclad', ['strike_ironclad'])
    brewed.combat.players[0].potions = [potion]
    brewed.combat.players[0].cardRewards = ['bash', 'cleave', 'shrug_it_off']
    brewed.combat.potionDeck = ['block_potion', 'fire_potion']
    view = fixture(choiceBatch, brewed)
    const gained = act(choiceBatch, 0, view, [['potion', potion, { transformHandUid: 'test0' }], ['play', 'test0', 'e0']])
    assert.equal(gained.sequence.completed, 1)
    assert.equal(gained.sequence.stopped, 'draw_or_reveal', `${potion} reveals private physical supply before any queued action`)
    if (potion === 'transforming_brew') {
      assert.equal(gained.player.hand[0][1], 'bash')
      const transformed = json(join(choiceBatch, 'worker-0.json'))
      transformed.run.combat.phase = 'lost'; transformed.run.combat.players[0].hp = 0; transformed.run.combat.players[0].dead = true
      save(join(choiceBatch, 'worker-0.json'), transformed)
      const terminalView = act(choiceBatch, 0, gained, [['resolveCombat']])
      assert(terminalView.done)
      const rows = json(join(choiceBatch, 'run-0001.json')).cards
      assert.equal(rows.strike_ironclad.removed, 1); assert.equal(rows.bash.added, 1, 'same-UID transformations count both sides of the deck delta')
    }
  }

  const courierBatch = join(temp, 'courier-reveal')
  invoke('init', courierBatch, { runs: 1 }); invoke('inspect', courierBatch)
  const courier = combatRun('ironclad', ['strike_ironclad', 'acrobatics'])
  courier.combat.enemies[0].hp = 1
  courier.combat.players[0].draw = [{ uid: 'courier-hidden', defId: 'defend_ironclad', upgraded: false }]
  courier.combat.players[0].relics.push({ defId: 'the_courier', spent: false })
  view = fixture(courierBatch, courier)
  const delivery = act(courierBatch, 0, view, [['revealCourier', 'relic'], ['decideCourier', 'discard']])
  assert(!delivery.error, delivery.error)
  assert.equal(delivery.sequence.completed, 1, 'the AI sees a hidden Courier relic before deciding whether to buy or discard it')
  assert(delivery.prompts.courier.id)
  let waiting = delivery
  for (const input of [['play', 'test0', 'e0'], ['end'], ['reveal', 'test1']]) {
    waiting = act(courierBatch, 0, waiting, [input])
    assert.match(waiting.error, /Courier offer/)
    assert.equal(waiting.enemies[0].hp, 1); assert(waiting.prompts.courier)
    assert(!JSON.stringify(waiting).includes('courier-hidden'))
  }
  const declined = act(courierBatch, 0, waiting, [['decideCourier', 'discard']])
  assert(!declined.error, declined.error); assert(!declined.prompts.courier)

  courier.combat.enemies[0].hp = 30
  courier.combat.players[0].gold = 10; courier.players[0].gold = 10
  courier.relicDeck = ['war_paint', ...courier.relicDeck.filter((id) => id !== 'war_paint')]
  courier.itemDecks.relics = [...courier.relicDeck]
  view = fixture(courierBatch, courier)
  const paintOffer = act(courierBatch, 0, view, [['revealCourier', 'relic']])
  assert.equal(paintOffer.prompts.courier.id, 'war_paint')
  const bought = act(courierBatch, 0, paintOffer, [['decideCourier', 'buy', { p1: 8 }]])
  assert(!bought.error, bought.error); assert(!bought.prompts.relic, 'deferred acquisition is not an illegal mid-combat prompt')
  const advanced = act(courierBatch, 0, bought, [['end']])
  assert(!advanced.error, advanced.error)
  assert.equal(advanced.combatPhase, 'player'); assert.equal(advanced.turn, bought.turn + 1, 'deferred War Paint does not stall enemy or draw transitions')
  const deferred = json(join(courierBatch, 'worker-0.json'))
  deferred.run.combat.phase = 'lost'; deferred.run.combat.players[0].hp = 0; deferred.run.combat.players[0].dead = true
  save(join(courierBatch, 'worker-0.json'), deferred)
  const afterFight = act(courierBatch, 0, advanced, [['resolveCombat']])
  assert.equal(afterFight.phase, 'defeat'); assert.equal(afterFight.prompts.relic.relicId, 'war_paint')
  const upgraded = act(courierBatch, 0, afterFight, [['resolvePendingRelic', ['test1']]])
  assert(!upgraded.error, upgraded.error); assert(upgraded.done)

  const forcedBatch = join(temp, 'forced-card')
  invoke('init', forcedBatch, { runs: 1 }); invoke('inspect', forcedBatch)
  const forced = combatRun('ironclad', ['havoc'])
  forced.combat.players[0].draw = [{ uid: 'forced-defense', defId: 'defend_ironclad', upgraded: false }]
  view = fixture(forcedBatch, forced)
  const havoc = act(forcedBatch, 0, view, [['play', 'test0']])
  assert(!havoc.error, havoc.error); assert(!havoc.prompts.forced)
  assert.equal(havoc.player.block, 1, 'a mandatory forced Defend resolves without a redundant AI prompt')
  const forcedStats = json(join(forcedBatch, 'worker-0.json')).record.cards.defend_ironclad
  assert.equal(forcedStats.plays, 1); assert.equal(forcedStats.blockNetGained, 1)

  const ledgerBatch = join(temp, 'turn-ledger')
  invoke('init', ledgerBatch, { runs: 1 }); invoke('inspect', ledgerBatch)
  const sneaky = combatRun('silent', ['sneaky_strike'])
  view = fixture(ledgerBatch, sneaky)
  assert(!view.turnState.discardedThisTurn)
  const withoutDiscard = act(ledgerBatch, 0, view, [['play', 'test0', 'e0']])
  assert.equal(withoutDiscard.player.energy, 1)
  sneaky.combat.discardedThisTurn = ['p1']
  view = fixture(ledgerBatch, sneaky)
  const resumedLedger = invoke('inspect', ledgerBatch, { detail: true })
  assert.deepEqual(resumedLedger.turnState.discardedThisTurn, ['p1'])
  const afterDiscard = act(ledgerBatch, 0, resumedLedger, [['play', 'test0', 'e0']])
  assert.equal(afterDiscard.player.energy, 3, 'the resumed prompt exposes the actual discard-dependent Energy refund')

  const bootsBatch = join(temp, 'wing-boots')
  invoke('init', bootsBatch, { runs: 1 }); invoke('inspect', bootsBatch)
  let boots = createRun(7, [{ id: 'p1', name: 'Playtest', character: 'ironclad' }])
  boots.phase = 'map'; boots.neow = null
  boots = enterRoom(boots, roomChoices(boots)[0].id)
  boots = { ...boots, phase: 'map', combat: null }
  boots = enterRoom(boots, roomChoices(boots)[0].id)
  boots = { ...boots, phase: 'map', combat: null }
  boots.players[0].relics.push({ defId: 'wing_boots', spent: false, uses: 3 })
  view = fixture(bootsBatch, boots)
  assert(view.prompts.wingRoutes.length > 0)
  const alternate = view.prompts.wingRoutes[0]
  assert(!view.prompts.routes.some((room) => room.id === alternate.id))
  const flew = act(bootsBatch, 0, view, [['room', alternate.id, true]])
  assert(!flew.error, flew.error)
  assert.equal(flew.player.relics.find((relic) => relic.defId === 'wing_boots').uses, 2)

  view = fixture(out, combatRun('ironclad', ['pommel_strike', 'strike_ironclad']))
  let checkpoint = json(join(out, 'worker-0.json'))
  checkpoint.run.combat.players[0].draw = [{ uid: 'drawn', defId: 'defend_ironclad', upgraded: false }]
  save(join(out, 'worker-0.json'), checkpoint)
  const drew = act(out, 0, view, [['play', 'test0', 'e0'], ['play', 'test1', 'e0']])
  assert.equal(drew.sequence.completed, 1); assert.equal(drew.sequence.stopped, 'draw_or_reveal')
  assert(drew.player.hand.some(([uid]) => uid === 'test1'))

  // Acrobatics reveals the draw-then-discard hand. It commits that card, so it cannot scout and switch.
  view = fixture(out, combatRun('silent', ['acrobatics', 'strike_silent']))
  checkpoint = json(join(out, 'worker-0.json'))
  checkpoint.run.combat.players[0].draw = [{ uid: 'after-acro', defId: 'defend_silent', upgraded: false }]
  save(join(out, 'worker-0.json'), checkpoint)
  const revealed = act(out, 0, view, [['reveal', 'test0'], ['play', 'test1', 'e0']])
  assert.equal(revealed.sequence.completed, 1)
  assert(revealed.prompts.reveal.cards.some(([uid]) => uid === 'after-acro'))
  const blocked = act(out, 0, revealed, [['play', 'test1', 'e0']])
  assert.match(blocked.error, /committed/)
  const resolved = act(out, 0, blocked, [['play', 'test0', { discardUids: ['after-acro'] }]])
  assert(!resolved.error, resolved.error)
  assert.equal(resolved.sequence.stopped, 'reveal_resolved')

  const rewardBatch = join(temp, 'reward-prompt')
  invoke('init', rewardBatch, { runs: 1 }); invoke('inspect', rewardBatch)
  let awarded = createRun(1, [{ id: 'p1', name: 'Playtest', character: 'ironclad' }])
  awarded = { ...awarded, phase: 'map', neow: null }
  awarded = enterRoom(awarded, roomChoices(awarded)[0].id)
  awarded.combat.phase = 'won'
  awarded.combat.enemies = awarded.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true, goldReward: 1, cardReward: 'normal', potionReward: false, relicReward: false }))
  awarded.combat.players[0].cardRewards = ['shrug_it_off', 'cleave', 'headbutt', 'future-reward-test']
  view = fixture(rewardBatch, awarded)
  const offered = act(rewardBatch, 0, view, [['resolveCombat']])
  assert.equal(offered.phase, 'reward'); assert(offered.cardText.cleave)
  assert(!JSON.stringify(offered).includes('future-reward-test'))

  // Shard source decks are AI choices, not forced reveals, in combat and Neow.
  awarded.combat.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  view = fixture(rewardBatch, awarded)
  const shardReward = act(rewardBatch, 0, view, [['resolveCombat']])
  assert(!shardReward.error, shardReward.error)
  assert.equal(shardReward.prompts.rewards[0].choices, null)
  const sources = shardReward.prompts.rewards[0].availableSources.slice(0, 3)
  const shardRevealed = act(rewardBatch, 0, shardReward, [['revealCardReward', sources]])
  assert(!shardRevealed.error, shardRevealed.error)
  assert.equal(shardRevealed.prompts.rewards[0].choices.length, 3)
  const shardNeow = createRun(1, [{ id: 'p1', name: 'Playtest', character: 'ironclad' }])
  shardNeow.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  view = fixture(rewardBatch, shardNeow)
  const shardGold = act(rewardBatch, 0, view, [['resolveNeowGold', true]])
  assert(!shardGold.error, shardGold.error); assert.equal(shardGold.prompts.neow.redReward, null)
  const neowRevealed = act(rewardBatch, 0, shardGold, [['revealNeowReward', shardGold.prompts.neow.availableSources.slice(0, 3)]])
  assert(!neowRevealed.error, neowRevealed.error)
  assert.equal(neowRevealed.prompts.neow.redReward.choices.length, 3)

  const actBatch = join(temp, 'act-continuation')
  invoke('init', actBatch, { runs: 1 }); invoke('inspect', actBatch)
  const victory = createRun(1, [{ id: 'p1', name: 'Playtest', character: 'ironclad' }])
  victory.phase = 'victory'; victory.neow = null; victory.campaign.highestBossActDefeated = 1
  const bossRoom = Object.values(victory.map.rooms).find((room) => room.kind === 'boss')
  victory.map.position = bossRoom.id; bossRoom.visited = true
  view = fixture(actBatch, victory)
  const refused = act(actBatch, 0, view, [['finishRun']])
  assert.match(refused.error, /next Act/); assert.equal(invoke('report', actBatch).completed, 0)
  const continued = act(actBatch, 0, refused, [['advanceAct']])
  assert.equal(continued.act, 2); assert.equal(continued.phase, 'map')
  const thirdAct = json(join(actBatch, 'worker-0.json')).run
  thirdAct.act = 3; thirdAct.phase = 'victory'; thirdAct.campaign.highestBossActDefeated = 3; thirdAct.campaign.bossesDefeated = 3
  view = fixture(actBatch, thirdAct)
  const won = act(actBatch, 0, view, [['finishRun']])
  assert.equal(won.done, true, JSON.stringify(won))
  assert.equal(invoke('report', actBatch).wins, 1)

  // Finalization and per-act denominators are independent of a policy's playing strength.
  // A fatal encounter uses the real counters; no fight is declared won for this check.
  const terminal = combatRun()
  terminal.combat.phase = 'lost'; terminal.combat.players[0].hp = 0; terminal.combat.players[0].dead = true
  terminal.combat.players[0].damageStats = { attack: 7, poison: 2, special: 1, taken: 10, blocked: 3 }
  terminal.combatsFinished = 0; terminal.floorsCleared = 1
  view = fixture(out, terminal)
  const session = json(join(out, 'worker-0.json'))
  session.record.acts[1] = { reached: true, bossDefeated: false, floors: 1, combats: 0, turns: 2, damage: 10, taken: 10, blocked: 3, blockNetGained: 4 }
  save(join(out, 'worker-0.json'), session)
  const finished = act(out, 0, view, [['resolveCombat']])
  assert(finished.done)
  const receipt = json(join(out, 'run-0001.json'))
  assert.equal(receipt.outcome, 'defeat'); assert(receipt.campaign.finalized)
  assert.equal(receipt.acts[1].combats, 1)
  const report = invoke('report', out)
  assert.equal(report.completed, 1); assert.equal(report.averages.damage, 10)
  assert.equal(report.acts[0].reached, 1); assert.equal(report.acts[1].averages.damage, null)
  assert(readFileSync(report.report, 'utf8').includes('Card deltas'))

  // Worker indices/seed ownership and physical component baseline hold for every character.
  for (const character of ALL_CHARACTER_IDS) {
    const parallel = join(temp, character)
    invoke('init', parallel, { character, workers: 4, runs: 50, seed: 100 })
    const views = [0, 1, 2, 3].map((worker) => invoke('inspect', parallel, { worker }))
    assert.deepEqual(views.map((row) => row.seed), [100, 101, 102, 103])
    assert.equal(new Set(views.map((row) => row.run)).size, 4)
    assert(views.every((row) => row.player.character === character))
  }
  const budget = join(temp, 'parallel-50')
  invoke('init', budget, { runs: 50, workers: 4 })
  const workers = [0, 1, 2, 3].map((worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), '--worker-mode', budget, String(worker)])
    let output = ''
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(output)))
  }))
  await Promise.all(workers)
  const replayedRun = invoke('replay', budget, { run: 25 })
  assert.equal(replayedRun.verified, true)
  const lastRecord = json(join(budget, 'run-0049.json'))
  const campaign = createCampaignProgress()
  for (const character of ALL_CHARACTER_IDS) campaign.characters[character] = 8
  campaign.colorless = 8
  let recovered = createRun(lastRecord.seed, [{ id: 'p1', name: 'Playtest', character: 'ironclad' }], 0, campaign)
  for (const choice of lastRecord.actions) recovered = applyAction(recovered, choice)
  save(join(budget, 'worker-0.json'), { worker: 0, revision: 999, run: recovered, record: lastRecord })
  assert.equal(invoke('inspect', budget).done, true, 'resume reconciles a finalized checkpoint and its existing receipt')
  const fifty = invoke('report', budget)
  assert.equal(fifty.completed, 50); assert.equal(fifty.errors.length, 0)
  assert.equal(new Set(Array.from({ length: 50 }, (_, index) => json(join(budget, `run-${String(index + 1).padStart(4, '0')}.json`)).seed)).size, 50)
  for (let worker = 0; worker < 4; worker++) assert.equal(json(join(budget, `worker-${worker}.json`)).run, null)
  console.log('playtest: AI prompts, sequences, draw stops, reveal commitment, replay, resumption, receipts, metrics and 8-character worker isolation passed')
} finally { rmSync(temp, { recursive: true, force: true }) }
