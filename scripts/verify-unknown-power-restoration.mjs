import assert from 'node:assert/strict'
import { unknownPowerRefreshDecision } from '../src/ui/combat-screen/unknown-power.ts'

// Regression: the authoritative refresh may win the race with the action
// callback. That must restore the still-unused Power immediately instead of
// parking an unknown action that will never see another causally-later refresh.
assert.equal(unknownPowerRefreshDecision(false, 12, 13), 'restore')

assert.equal(unknownPowerRefreshDecision(false, 12, 12), 'wait')
assert.equal(unknownPowerRefreshDecision(false, 12, 11), 'wait')
assert.equal(unknownPowerRefreshDecision(false, 12, undefined), 'wait')
assert.equal(unknownPowerRefreshDecision(true, 12, 13), 'committed')
assert.equal(unknownPowerRefreshDecision(false, undefined, 13), 'unlock')

console.log('✓ unknown Power delivery restores for every callback/refresh ordering')
