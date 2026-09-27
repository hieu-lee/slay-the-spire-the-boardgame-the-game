import { createCampaignProgress } from '../../game/campaign.ts'
import { rulesetForCharacters } from '../../game/meta.ts'
import { createRng, seedFromString } from '../../game/rng.ts'
import { createRun, enterRoom } from '../../game/run.ts'
import type { RunState } from '../../game/run.ts'
import type { CharacterId } from '../../game/types.ts'

/**
 * The guided tutorial plays one fixed run per hero, so its script can name the
 * exact Neow card, rewards, route, enemies and opening hands the player meets.
 *
 * Two things keep that run on its script. It is built from a fresh campaign
 * journal, so the player's unlocks never change a reward deck. And every room
 * is entered on its own seed, so how long an earlier fight lasted (each round
 * rolls the die) cannot reshuffle a later fight's opening hand.
 */
export function createTutorialRun(character: CharacterId, name: string, seed: string): RunState {
  const campaign = rulesetForCharacters([character])
  return createRun(seedFromString(seed), [{ id: 'p1', name, character }], 0, createCampaignProgress(), false, false,
    { mode: 'standard', modifiers: [], quickStartAct: 1, campaign })
}

/** Enters a map room on that room's own seed; see createTutorialRun. */
export function enterTutorialRoom(run: RunState, roomId: string, seed: string): RunState {
  const entered = enterRoom({ ...run, rng: createRng(seedFromString(`${seed}/${roomId}`)) }, roomId)
  return entered.map === run.map ? run : entered
}
