// Seeded co-op Start-of-Turn fuzz: whatever the mix of sources, reorders,
// disconnects and mid-window damage, every seat must be able to finish the window
// without a stale-plan refusal. Pinned seeds are past failures (silent stalls,
// stale targets, stranded owners); the sweep guards the ordinary cases.
import { runSeed } from './lib/start-turn-fuzz.mjs'
import { suite, check, assert, report } from './lib/harness.mjs'

suite('start-of-turn fuzz')

// 30813: a paused window whose parked pick went stale; 41226: a Fumes pick reveals another
// seat's Evoke prompt; 30145: a reordered plan outdates a non-required seat's staged pick;
// 20242: an Evoke draft staged before the order commit; 70195: an answered seat's outdated pick hides
// another seat's Shiv prompt. 1000 is an ordinary window.
const SEEDS = [30813, 41226, 30145, 20242, 70195, 1000]

for (const seed of SEEDS) {
  check(`seed ${seed} finishes the window`, () => {
    const result = runSeed(seed)
    assert(result.kind === 'ok' || result.kind === 'recovered-after-errors',
      `${result.kind}: ${JSON.stringify({ ready: result.ready, required: result.required, final: result.final,
        progress: result.progress, abilities: result.abilities, events: result.events })}`)
    const refusals = result.errors.filter((error) => /plan changed|stale/i.test(error.message))
    assert(refusals.length === 0,
      `${refusals.length} stale refusals: ${refusals.map((error) => error.message).join('; ')}`)
  })
}

report('start-of-turn fuzz')
