// Deterministic fuzz client for the co-op Start-of-Turn window. It plays every seat
// the way the UI does (first valid target, re-pick stale targets, fumes gate), with
// random disconnects, reorders and mid-window Fire Potions, and reports whether the
// window always completes.
import { createCombat } from '../../src/game/combat/create.ts'
import { CARDS, faceOf } from '../../src/game/cards.ts'
import { RELICS, relicAbilities } from '../../src/game/relics.ts'
import { ENEMIES, enemyDef, startingHp } from '../../src/game/enemies.ts'
import { startTurnAbilities } from '../../src/game/combat/start-turn.ts'
import * as lib from './rooms.mjs'

function mulberry(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}

// ---- source pools
const powerPool = Object.values(CARDS).filter((c) => c.type === 'power' && (() => {
  const f = faceOf(c, false)
  return f.trigger?.kind === 'startOfTurn' || f.additionalTriggers?.some((t) => t.trigger.kind === 'startOfTurn')
})())
const relicPool = Object.values(RELICS).filter((r) => {
  try { return relicAbilities(r).some((a) => ['startOfTurn', 'dieRelic', 'startOfCombat'].includes(a.trigger?.kind)) } catch { return false }
}).map((r) => r.id).filter((id) => !id.startsWith('downfall_') && !['teleportation_stone','dueling_glove','sack_of_gems','black_powder','clasped_locket','snecko_egg','greed_ooze','dented_plate','wheel_of_change','battle_buddies','chronometer','loaded_die','hexaghost_starting_relic','ashes_of_sparta','nilrys_codex','cracked_core','ring_of_the_snake','pure_water'].includes(id))
const enemyPool = ['cultist', 'red_louse', 'jaw_worm', 'fungi_beast', 'acid_slime_m', 'spike_slime_m', 'gremlin_nob', 'looter', 'darkling_bha', 'darkling_hab', 'darkling']
  .filter((id) => ENEMIES[id])
const CHARS = ['ironclad', 'silent', 'defect', 'watcher', 'guardian', 'hexaghost']

function mkEnemy(uid, defId, row, nPlayers, rnd, opts) {
  const def = enemyDef(defId)
  const hp = Math.max(1, startingHp(def, nPlayers))
  return { uid, defId, row, isBoss: false, hp: opts.lowHp ? 1 + Math.floor(rnd() * 3) : hp, maxHp: hp, block: 0, strength: 0, vulnerable: 0, weak: 0,
    poison: opts.poison ? Math.floor(rnd() * 4) + (rnd() < 0.5 ? 1 : 0) : 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false, phase: 0 }
}

function mkCard(uid, defId) { return { uid, defId, upgraded: false } }

function buildScenario(seed) {
  const rnd = mulberry(seed)
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const nSeats = 2 + Math.floor(rnd() * 3)
  const store = lib.createStore({ file: null })
  const room = lib.createRoom(store, { code: 'F' + seed })
  const chars = [...CHARS].sort(() => rnd() - 0.5).slice(0, nSeats)
  chars.forEach((c, i) => lib.joinRoom(room, { name: 'p' + i, character: c }))
  lib.startRun(room, room.seats[0].token, { seed })
  const run = room.run
  const nEnemies = rnd() < 0.15 ? 8 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 5)
  const opts = { lowHp: rnd() < 0.5, poison: rnd() < 0.5 }
  const enemies = Array.from({ length: nEnemies }, (_, i) => mkEnemy('e' + i, pick(enemyPool), i % nSeats, nSeats, rnd, opts))
  const players = run.players.map((p) => {
    const q = structuredClone(p)
    q.powers = []
    q.relics = q.relics.filter((r) => rnd() < 0.5 || ['hexaghost_starting_relic','guardian_starting_relic'].includes(r.defId))
    const nPow = Math.floor(rnd() * 4)
    const own = powerPool.filter((c) => c.owner === q.character || c.owner === 'colorless')
    for (let i = 0; i < nPow && own.length; i++) q.powers.push(mkCard(`pw${p.id}${i}`, pick(own).id))
    const nRel = Math.floor(rnd() * 3)
    for (let i = 0; i < nRel; i++) q.relics.push({ defId: pick(relicPool), spent: false })
    q.shivs = rnd() < 0.5 ? 5 + Math.floor(rnd() * 3) : 0
    q.orbs = q.character === 'defect' || rnd() < 0.4
      ? Array.from({ length: 3 }, () => pick(['lightning', 'frost', 'dark', null])) : q.orbs
    q.hand = []
    q.potions = rnd() < 0.5 ? ['fire_potion'] : []
    return q
  })
  const combat = createCombat(run.rng, players, enemies, 'fz' + seed)
  combat.turn = rnd() < 0.3 ? 0 : 1
  combat.phase = combat.turn === 0 ? 'player' : 'roundEnd'
  room.run = { ...run, phase: 'combat', combat }
  return { room, rnd }
}

// ---- client policy
const blank = (id) => ({ id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] })

function clientChoices(room, token, shuffleOrder, rnd) {
  const snap = lib.snapshotFor(room, token)
  const me = snap.you.playerId
  const combat = { ...snap.run.combat, players: snap.run.combat.players.map((p) => ({ ...p, deck: p.deck ?? [], draw: p.draw ?? [], hand: p.hand ?? [], chamber: p.chamber ?? [], cardRewards: [], rareRewards: [] })) }
  let order = snap.startTurnAbilities.map((a) => a.id)
  if (shuffleOrder && snap.startTurnOrderPending && snap.startTurnCoordinatorId === me && rnd() < 0.7) {
    order = [...order].sort(() => rnd() - 0.5)
  }
  const saved = new Map((snap.startTurnChoices ?? []).map((c) => [c.id, c]))
  const targets = snap.startTurnEnemyTargets ?? {}
  const owner = new Map(snap.startTurnAbilities.map((a) => [a.id, a.playerId]))
  const drafts = order.map((id) => {
    const base = structuredClone(saved.get(id) ?? blank(id))
    base.shivEnemyUids ??= []; base.evokeSlots ??= []; base.evokeEnemyUids ??= []
    if (targets[id]) base.enemyUid = targets[id]
    return base
  })
  const mine = (id) => owner.get(id) === me
  for (let step = 0; step < 80; step++) {
    const abs = startTurnAbilities(combat, order, drafts)
    let changed = false
    for (const [i, a] of abs.entries()) {
      if (!mine(a.id)) continue
      const d = drafts[i]
      if (a.targets?.length && (d.enemyUid === undefined || a.enemyTargetStale || !a.targets.some((t) => t.uid === d.enemyUid))) {
        d.enemyUid = a.targets[0].uid; changed = true; break
      }
      if (a.players?.length && !a.players.some((p) => p.id === d.targetPlayerId)) { d.targetPlayerId = a.players[0].id; changed = true; break }
      if (a.exhaustCards?.length && !(d.exhaustUids?.length === 1 && a.exhaustCards.some((c) => c.uid === d.exhaustUids[0]))) { d.exhaustUids = [a.exhaustCards[0].uid]; changed = true; break }
      if (a.guardianModeShift && d.guardianModeShift === undefined) { d.guardianModeShift = false; changed = true; break }
      if (d.shivEnemyUids.length < a.overflowShivs && a.staleShivIndex === undefined) {
        d.shivEnemyUids.push(a.shivTargets?.[0]?.uid ?? combat.enemies.find((enemy) => !enemy.dead)?.uid ?? null); changed = true; break
      }
      if (a.staleShivIndex !== undefined) { d.shivEnemyUids[a.staleShivIndex] = a.shivTargets?.[0]?.uid ?? null; changed = true; break }
      if (a.evokeTargetIndex !== undefined) { d.evokeEnemyUids[a.evokeTargetIndex] = a.evokeTargets?.[0]?.uid ?? null; changed = true; break }
      if (a.evokeOrbs?.some((o, k) => o === 'frost' && d.evokeEnemyUids.length <= k)) {
        a.evokeOrbs.forEach((o, k) => { if (o === 'frost' && d.evokeEnemyUids.length <= k) d.evokeEnemyUids[k] = null }); changed = true; break
      }
      if (a.evokeChoice?.options[0]) {
        const p = a.evokeChoice.options[0]
        d.evokeSlots.push(p.slot); d.evokeEnemyUids.push(p.orb === 'frost' ? null : a.evokeTargets?.[0]?.uid ?? null); changed = true; break
      }
    }
    if (!changed) break
  }
  return drafts
}

// ---- driver
export function runSeed(seed) {
  const { room, rnd } = buildScenario(seed)
  const tokens = room.seats.map((s) => s.token)
  const events = []
  const errors = []
  try {
    lib.apply(room, tokens[0], { kind: 'startTurn' })
  } catch (e) { return { seed, kind: 'setup-error', message: e.message } }
  if (room.run.combat.phase !== 'start') return { seed, kind: 'skipped-no-start-window', phase: room.run.combat.phase }
  const flaky = rnd() < 0.5
  const disc = new Set()
  // returns 'progress' | 'idle' | 'other-prompt'
  function stepSeat(i, round, shuffleOrder) {
    const token = tokens[i]
    const snap = lib.snapshotFor(room, token)
    const me = snap.you.playerId
    const before = JSON.stringify([room.version, room.startTurnReady, room.run.combat.startTurnProgress, room.startTurnOrder])
    const scry = snap.startTurnScry
    try {
      if (snap.startTurnScryAbilities?.length && snap.startTurnCoordinatorId === me) {
        lib.apply(room, token, { kind: 'orderStartTurnScries', order: snap.startTurnScryAbilities.map((a) => a.id) }); return 'progress'
      }
      if (scry && scry.playerId === me) { lib.apply(room, token, { kind: 'resolveStartTurnScry', sourceId: scry.id, discardUids: [] }); return 'progress' }
      const dis = snap.startTurnDiscard
      if (dis && dis.playerId === me) { lib.apply(room, token, { kind: 'resolveStartTurnDiscard', sourceId: dis.sourceId, discardUid: dis.cards[0].uid }); return 'progress' }
      const c = room.run.combat
      if (c.pendingTriggers?.some((t) => t.startTurn) || c.startTurnProgress?.forcedCard ||
        c.pendingDieRelicChoices?.length || c.startTurnProgress?.rollPending || c.startTurnProgress?.discard || c.startTurnProgress?.beforeDraw) {
        const owners = [c.startTurnProgress?.discard?.playerId, c.startTurnProgress?.forcedCard?.playerId, ...(c.pendingTriggers ?? []).filter((t) => t.startTurn).map((t) => t.playerId), ...(c.pendingDieRelicChoices ?? []).map((t) => t.playerId)].filter(Boolean)
        orphan = owners.length > 0 && owners.every((o) => room.seats.find((x) => x.playerId === o)?.connected === false)
        lastPrompt = JSON.stringify({ progress: c.startTurnProgress, pend: c.pendingTriggers, die: c.pendingDieRelicChoices, conn: room.seats.map((x) => x.connected) }).slice(0, 600)
        return 'other-prompt'
      }
      const required = snap.startTurnRequired ?? []
      if (!required.includes(me)) return 'idle'
      const pendingMe = (snap.startTurnAbilities ?? []).some((a) => a.playerId === me && (a.enemyTargetStale))
      if (snap.startTurnDecided?.includes(me) && !pendingMe) return 'idle'
      // UI gate: canResolveStartTurn = viewer is coordinator || viewer isn't the pending Noxious Fumes owner
      const fumesOwner = snap.startTurnChoiceId ? snap.startTurnAbilities.find((a) => a.id === snap.startTurnChoiceId)?.playerId : undefined
      if (fumesOwner === me && snap.startTurnCoordinatorId !== me) return 'idle'
      const choices = clientChoices(room, token, shuffleOrder, rnd)
      lib.apply(room, token, { kind: 'resolveStartTurn', choices })
      const after = JSON.stringify([room.version, room.startTurnReady, room.run.combat.startTurnProgress, room.startTurnOrder])
      return after !== before ? 'progress' : 'idle'
    } catch (e) {
      errors.push({ round, seat: i, message: e.message, stack: e.stack?.split('\n').slice(1, 3).join(' | '), events: [...events] })
      return 'idle'
    }
  }
  let idle = 0
  let lastPrompt
  let orphan = false
  let sawPrompt = false
  for (let round = 0; round < 25 && room.run.combat.phase === 'start'; round++) {
    if (flaky) {
      const i = Math.floor(rnd() * tokens.length)
      if (rnd() < 0.3 && disc.size < tokens.length - 1 && !disc.has(i)) { lib.markDisconnected(room, tokens[i]); disc.add(i); events.push(`dc p${i}@${round}`) }
      else if (rnd() < 0.4 && disc.has(i)) { lib.joinRoom(room, { token: tokens[i], connected: true }); disc.delete(i); events.push(`rc p${i}@${round}`) }
    }
    if (room.run.combat.phase !== 'start') break
    if (rnd() < 0.25) {
      // mid-window damage: a seat throws a Fire Potion at a random living enemy (may kill a staged target)
      const i = Math.floor(rnd() * tokens.length)
      const living = room.run.combat.enemies.filter((e) => !e.dead)
      const me = room.seats[i].playerId
      if (!disc.has(i) && living.length && room.run.combat.players.find((p) => p.id === me)?.potions.includes('fire_potion')) {
        const t = living[Math.floor(rnd() * living.length)].uid
        try { lib.apply(room, tokens[i], { kind: 'usePotion', potionId: 'fire_potion', enemyUid: t }); events.push(`fire p${i}->${t}@${round}`) } catch (e) { events.push(`fire-ERR p${i}: ${e.message.slice(0, 60)}`) }
        if (room.run.combat.phase !== 'start') break
      }
    }
    let progressed = false
    for (const i of [...tokens.keys()].sort(() => rnd() - 0.5)) {
      if (disc.has(i) || room.run.combat.phase !== 'start') continue
      const r = stepSeat(i, round, true)
      if (r === 'other-prompt') sawPrompt = true
      if (r === 'progress') progressed = true
    }
    if (!progressed) { idle++; if (idle >= 3) break } else idle = 0
  }
  if (room.run.combat.phase === 'start') {
    // stuck probe: everyone reconnects, then every seat tries again (twice around)
    for (const i of disc) { lib.joinRoom(room, { token: tokens[i], connected: true }); events.push(`rc p${i}@final`) }
    const final = []
    for (let pass = 0; pass < 2 && room.run.combat.phase === 'start'; pass++) {
      for (const i of tokens.keys()) {
        if (room.run.combat.phase !== 'start') break
        const e0 = errors.length
        const r = stepSeat(i, 99, false)
        final.push(`${i}:${r}${errors.length > e0 ? ' ERR ' + errors.at(-1).message + ' @ ' + errors.at(-1).stack : ''}`)
        if (r === 'other-prompt') sawPrompt = true
      }
    }
    if (room.run.combat.phase === 'start' && sawPrompt && !orphan) return { seed, kind: 'inconclusive-other-prompt', events, errors, lastPrompt }
    if (room.run.combat.phase === 'start') {
      const snap = lib.snapshotFor(room, tokens[0])
      const c = room.run.combat
      return { seed, kind: orphan ? 'STUCK-orphan-prompt-disconnected-owner' : 'STUCK', events, errors, final, lastPrompt,
        required: room.startTurnRequired, ready: room.startTurnReady, coord: snap.startTurnCoordinatorId,
        orderPending: snap.startTurnOrderPending, choiceId: snap.startTurnChoiceId,
        progress: JSON.stringify(c.startTurnProgress)?.slice(0, 300), pendingTriggers: c.pendingTriggers.length,
        decided: snap.startTurnDecided, abilities: snap.startTurnAbilities.map((a) => `${a.id}${a.enemyTargetStale ? ' STALE' : ''}`),
        connected: room.seats.map((x) => x.connected) }
    }
  }
  return { seed, kind: errors.length ? 'recovered-after-errors' : 'ok', errors, events }
}

