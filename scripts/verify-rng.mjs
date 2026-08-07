import { createRng, nextFloat, nextInt, shuffle, pickMany, seedFromString } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('rng')

check('same seed produces the same float stream', () => {
  const a = createRng(1234)
  const b = createRng(1234)
  for (let i = 0; i < 100; i++) assertEqual(nextFloat(a), nextFloat(b), `float ${i}`)
})

// A run is stored as (seed, action log) and replayed to reconstruct state. If the
// RNG stream ever changes, every saved run and every recorded playtest silently
// replays into a different game. These vectors make that break loudly instead.
check('the RNG stream matches its golden vectors', () => {
  const rng = createRng(0)
  assertDeepEqual(
    Array.from({ length: 6 }, () => nextFloat(rng)),
    [
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
      0.46732782293111086, 0.5450490827206522,
    ],
    'nextFloat stream changed — every saved run replays differently now',
  )
  assertDeepEqual(
    shuffle(createRng(12345), [1, 2, 3, 4, 5, 6, 7, 8]),
    [4, 1, 2, 6, 5, 7, 3, 8],
    'shuffle order changed — every saved run replays differently now',
  )
  assertEqual(seedFromString('slay-the-spire'), 3590542712, 'seedFromString changed — named seeds now yield different runs')
})

check('seedFromString stays unsigned', () => {
  for (const text of ['', 'x', 'slay-the-spire', 'ϴ high bits ÿÿÿ', 'a'.repeat(200)]) {
    const seed = seedFromString(text)
    assertEqual(seed, seed >>> 0, `seed for ${JSON.stringify(text)} must survive an unsigned cast unchanged`)
  }
})

check('different seeds diverge', () => {
  const a = createRng(1)
  const b = createRng(2)
  let same = 0
  for (let i = 0; i < 50; i++) if (nextFloat(a) === nextFloat(b)) same++
  assert(same === 0, `expected no shared values, got ${same}`)
})

check('floats stay in [0, 1)', () => {
  const r = createRng(99)
  for (let i = 0; i < 10000; i++) {
    const v = nextFloat(r)
    assert(v >= 0 && v < 1, `float out of range: ${v}`)
  }
})

check('nextInt stays in range and covers it', () => {
  const r = createRng(7)
  const seen = new Set()
  for (let i = 0; i < 5000; i++) {
    const v = nextInt(r, 6)
    assert(Number.isInteger(v) && v >= 0 && v < 6, `int out of range: ${v}`)
    seen.add(v)
  }
  assertEqual(seen.size, 6, 'every face of a d6 should appear')
})

check('nextInt handles an empty range', () => {
  const r = createRng(7)
  assertEqual(nextInt(r, 0), 0)
  assertEqual(nextInt(r, -3), 0)
})

check('shuffle is a permutation and is deterministic', () => {
  const source = Array.from({ length: 40 }, (_, i) => i)
  const a = shuffle(createRng(5150), [...source])
  const b = shuffle(createRng(5150), [...source])
  assertDeepEqual(a, b, 'same seed should shuffle identically')
  assertDeepEqual([...a].sort((x, y) => x - y), source, 'shuffle must preserve elements')
  assert(a.join() !== source.join(), 'a 40-element shuffle should not be the identity')
})

check('shuffle handles empty and single-element arrays', () => {
  assertDeepEqual(shuffle(createRng(1), []), [])
  assertDeepEqual(shuffle(createRng(1), ['x']), ['x'])
})

// Without this, a shuffle that is subtly biased — a wrong loop bound, a swap
// against the wrong index — still passes every structural check above.
check('shuffle visits all permutations roughly evenly', () => {
  const trials = 48000
  const counts = new Map()
  const rng = createRng(20240607)
  for (let i = 0; i < trials; i++) {
    const key = shuffle(rng, ['a', 'b', 'c', 'd']).join('')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  assertEqual(counts.size, 24, 'all 24 permutations of 4 elements should appear')
  const expected = trials / 24
  let chiSquare = 0
  for (const observed of counts.values()) chiSquare += (observed - expected) ** 2 / expected
  // 23 degrees of freedom, p = 0.001 → 49.73. Deterministic seed, so this is stable.
  assert(chiSquare < 49.73, `shuffle looks biased: chi-square ${chiSquare.toFixed(2)} over 24 permutations`)
})

check('nextInt is unbiased across its range', () => {
  const rng = createRng(31337)
  const buckets = new Array(10).fill(0)
  const trials = 100000
  for (let i = 0; i < trials; i++) buckets[nextInt(rng, 10)]++
  const expected = trials / 10
  let chiSquare = 0
  for (const observed of buckets) chiSquare += (observed - expected) ** 2 / expected
  // 9 degrees of freedom, p = 0.001 → 27.88.
  assert(chiSquare < 27.88, `nextInt looks biased: chi-square ${chiSquare.toFixed(2)} over 10 buckets`)
})

check('pickMany returns distinct items without mutating the source', () => {
  const source = ['a', 'b', 'c', 'd', 'e']
  const frozen = [...source]
  const picked = pickMany(createRng(3), source, 3)
  assertEqual(picked.length, 3)
  assertEqual(new Set(picked).size, 3, 'picks must be distinct')
  assertDeepEqual(source, frozen, 'source array must not be mutated')
  for (const item of picked) assert(source.includes(item), `unexpected item ${item}`)
})

check('pickMany clamps to the available count', () => {
  assertEqual(pickMany(createRng(3), ['a', 'b'], 10).length, 2)
  assertEqual(pickMany(createRng(3), ['a', 'b'], -1).length, 0)
})

check('seedFromString is stable and varies by input', () => {
  assertEqual(seedFromString('spire'), seedFromString('spire'))
  assert(seedFromString('spire') !== seedFromString('spire2'), 'seeds should differ')
  assert(seedFromString('') >= 0, 'seed must be unsigned')
})

report('rng')
