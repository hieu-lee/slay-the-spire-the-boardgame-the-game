export const emptyMetrics = () => ({ floors: 0, combats: 0, turns: 0, damage: 0, taken: 0, blocked: 0, blockNetGained: 0 })
export function counters(run) {
  const player = run.phase === 'combat' ? run.combat.players[0] : run.players[0]
  const stats = player.damageStats ?? {}
  return { damage: (stats.attack ?? 0) + (stats.poison ?? 0) + (stats.special ?? 0),
    taken: stats.taken ?? 0, blocked: stats.blocked ?? 0, block: player.block }
}
export function observe(record, before, after, choice) {
  const act = record.acts[before.act] ??= { reached: true, bossDefeated: false, ...emptyMetrics() }
  const prior = counters(before), next = counters(after)
  const delta = { damage: next.damage - prior.damage, taken: next.taken - prior.taken, blocked: next.blocked - prior.blocked,
    blockNetGained: choice.scope === 'combat' ? Math.max(0, next.block - prior.block) : 0 }
  for (const key of ['damage', 'taken', 'blocked']) if (delta[key] < 0) throw new Error(`Combat counter ${key} decreased`)
  for (const [key, value] of Object.entries(delta)) act[key] += value
  act.floors += (after.floorsCleared ?? 0) - (before.floorsCleared ?? 0)
  act.combats += Number(before.phase === 'combat' && ['won', 'lost'].includes(before.combat.phase) && choice.name === 'resolveCombat')
  act.turns += Number(choice.scope === 'combat' && (after.combat?.turn ?? 0) > (before.combat?.turn ?? 0))
  // createCombat prepares round one before the first combat decision.
  if (before.phase !== 'combat' && after.phase === 'combat') act.turns += after.combat.turn
  act.bossDefeated ||= after.campaign.highestBossActDefeated >= before.act
  const oldDeck = new Map(before.players[0].deck.map((card) => [card.uid, card]))
  const newDeck = new Map(after.players[0].deck.map((card) => [card.uid, card]))
  const cardRow = (key) => record.cards[key] ??= { plays: 0, damage: 0, taken: 0, blocked: 0, blockNetGained: 0, added: 0, removed: 0, upgraded: 0 }
  for (const card of newDeck.values()) {
    const key = `${card.defId}${card.upgraded ? '+' : ''}`
    if (!oldDeck.has(card.uid) || oldDeck.get(card.uid).defId !== card.defId) cardRow(key).added++
    else if (card.upgraded && !oldDeck.get(card.uid).upgraded) cardRow(card.defId).upgraded++
  }
  for (const card of oldDeck.values()) if (!newDeck.has(card.uid) || newDeck.get(card.uid).defId !== card.defId) cardRow(`${card.defId}${card.upgraded ? '+' : ''}`).removed++
  if (['playCard', 'playCardCopy', 'playHermitChamberCard', 'activatePower', 'resolveDeterministicForcedCard'].includes(choice.name) && choice.source) {
    const row = cardRow(choice.source)
    row.plays++
    for (const [key, value] of Object.entries(delta)) row[key] += value
  }
}
const average = (rows, key) => rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null
export function summarize(manifest, records) {
  const complete = records.filter((record) => ['victory', 'defeat'].includes(record.outcome))
  const totals = complete.map((record) => Object.values(record.acts).reduce((total, act) => {
    for (const key of Object.keys(total)) total[key] += act[key]
    return total
  }, emptyMetrics()))
  const acts = [1, 2, 3].map((act) => {
    const rows = complete.map((record) => record.acts[act]).filter(Boolean)
    const defeated = rows.filter((row) => row.bossDefeated).length
    return { act, reached: rows.length, bossDefeated: defeated, bossWinRate: rows.length ? defeated / rows.length : null,
      averages: Object.fromEntries(Object.keys(emptyMetrics()).map((key) => [key, average(rows, key)])) }
  })
  const cards = {}
  for (const record of complete) for (const [key, row] of Object.entries(record.cards)) {
    const merged = cards[key] ??= Object.fromEntries(Object.keys(row).map((field) => [field, 0]))
    for (const [field, value] of Object.entries(row)) merged[field] += value
  }
  for (const record of complete) {
    const floors = Object.values(record.acts).reduce((sum, act) => sum + act.floors, 0)
    for (const key of new Set((record.finalDeck ?? []).map((card) => card.defId + (card.upgraded ? '+' : '')))) {
      const row = cards[key] ??= { plays: 0, damage: 0, taken: 0, blocked: 0, blockNetGained: 0, added: 0, removed: 0, upgraded: 0 }
      row.finalDeckRuns = (row.finalDeckRuns ?? 0) + 1
      row.winsWithCard = (row.winsWithCard ?? 0) + Number(record.outcome === 'victory')
      row.floorsWithCard = (row.floorsWithCard ?? 0) + floors
    }
  }
  for (const row of Object.values(cards)) {
    row.averageDamageDuringAction = row.plays ? row.damage / row.plays : null
    row.averageBlockNetGained = row.plays ? row.blockNetGained / row.plays : null
    row.averageFloorWithCard = row.finalDeckRuns ? row.floorsWithCard / row.finalDeckRuns : null
  }
  return { schemaVersion: 1, manifest, completed: complete.length, requested: manifest.runs,
    wins: complete.filter((record) => record.outcome === 'victory').length,
    failures: records.filter((record) => record.outcome === 'error').map(({ index, seed, error }) => ({ index, seed, error })),
    averages: Object.fromEntries(Object.keys(emptyMetrics()).map((key) => [key, average(totals, key)])),
    perCombat: Object.fromEntries(['damage', 'taken', 'blocked'].map((key) => [key,
      totals.reduce((sum, row) => sum + row.combats, 0) ? totals.reduce((sum, row) => sum + row[key], 0) / totals.reduce((sum, row) => sum + row.combats, 0) : null])),
    acts, cards, runs: records.map(({ index, seed, outcome, acts, steps, error }) => ({ index, seed, outcome, acts, steps, error })) }
}
const fmt = (value) => value === null ? 'n/a' : typeof value === 'number' ? Number(value.toFixed(2)) : value
export function markdown(report) {
  const { manifest, averages } = report
  const lines = [`# ${manifest.character} playtest — ${report.completed}/${report.requested} runs`, '',
    `Ascension ${manifest.ascension}; seeds ${manifest.seed}–${manifest.seed + manifest.runs - 1}; policy ${manifest.policyVersion}.`,
    `Engine ${manifest.revision}; source fingerprint ${manifest.fingerprint}.`, '',
    `Report generated at ${new Date().toISOString()}.`, '',
    `${report.wins} wins, ${report.completed - report.wins} defeats, ${report.failures.length} execution errors.`, '',
    '| Metric | Mean per completed run |', '| --- | ---: |',
    ...Object.entries(averages).map(([key, value]) => `| ${key} | ${fmt(value)} |`), '',
    '| Act | Reached | Boss defeated | Boss win rate | Mean floors | Damage | Taken | Blocked |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.acts.map((row) => `| ${row.act} | ${row.reached} | ${row.bossDefeated} | ${row.bossWinRate === null ? 'n/a' : fmt(row.bossWinRate * 100) + '%'} | ${fmt(row.averages.floors)} | ${fmt(row.averages.damage)} | ${fmt(row.averages.taken)} | ${fmt(row.averages.blocked)} |`), '',
    'Act means include only completed runs that reached that act. Floors count rooms entered, including the fatal room, matching the game counter. Combat counts include the fatal fight. Per-combat damage/taken/blocked: '
      + Object.entries(report.perCombat).map(([key, value]) => `${key} ${fmt(value)}`).join(', ') + '.', '',
    '## Card deltas', '', '| Card | Plays/activations | Damage during action | Mean/action | Net Block gained | Added | Removed | Upgraded |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.cards).sort((a, b) => b[1].damage - a[1].damage || a[0].localeCompare(b[0])).map(([key, row]) =>
      `| ${key} | ${row.plays} | ${row.damage} | ${fmt(row.averageDamageDuringAction)} | ${row.blockNetGained} | ${row.added} | ${row.removed} | ${row.upgraded} |`), '',
    'Damage includes attack, poison, and special engine counters; blocked means damage actually prevented. Net Block gained sums positive action-level changes, so it is not gross Block generated. Card deltas include simultaneous relic/trigger effects; poison ticks, passive orbs, and delayed powers remain in run totals. JSON also includes final-deck frequency, wins with each card, and average floor among runs carrying it. These observations are not causal card rankings.', '',
    'This is an AI-directed seeded solo engine playtest with replayable decisions, not a human-skill, browser/UI, multiplayer, or reconnect evaluation. Execution errors are excluded from performance means and never counted as defeats or completed budget.', '',
    '## Runs', '', '| Run | Seed | Outcome | Floors | Steps |', '| --- | --- | --- | ---: | ---: |',
    ...report.runs.map((row) => `| ${row.index + 1} | ${row.seed} | ${row.outcome} | ${Object.values(row.acts).reduce((sum, act) => sum + act.floors, 0)} | ${row.steps} |`), '',
    ...report.failures.map((row) => `Run ${row.index + 1} error: ${row.error}`), '' ]
  return lines.join('\n')
}
