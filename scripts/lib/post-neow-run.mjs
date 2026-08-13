import { createRun } from '../../src/game/run.ts'

/** Legacy test setup from before Neow became an interactive run phase. */
export function postNeowRun(...args) {
  const run = createRun(...args)
  const solo = run.players.length === 1
  return {
    ...run,
    phase: 'map',
    neow: null,
    players: run.players.map((player) => ({
      ...player,
      gold: solo ? 2 : 0,
      relics: solo && !player.relics.some((relic) => relic.defId === 'loaded_die')
        ? [...player.relics, { defId: 'loaded_die', spent: false }]
        : player.relics,
    })),
  }
}
