// Deterministic RNG. Every random decision in the engine goes through a seeded
// stream so a game can be replayed exactly from (seed, action log) — which is
// what makes server-authoritative multiplayer and reproducible playtests work.

export type RngState = { seed: number; calls: number }

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0, calls: 0 }
}

/** mulberry32 — small, fast, good enough for a board game. */
function mulberry32(a: number): number {
  a = (a + 0x6d2b79f5) >>> 0
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Advances `state` and returns a float in [0, 1). */
export function nextFloat(state: RngState): number {
  state.seed = (state.seed + 0x6d2b79f5) >>> 0
  state.calls++
  return mulberry32(state.seed - 0x6d2b79f5)
}

/** Integer in [0, maxExclusive). Returns 0 when the range is empty. */
export function nextInt(state: RngState, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0
  return Math.floor(nextFloat(state) * maxExclusive)
}

/** Fisher-Yates, in place. */
export function shuffle<T>(state: RngState, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = nextInt(state, i + 1)
    const a = items[i] as T
    const b = items[j] as T
    items[i] = b
    items[j] = a
  }
  return items
}

export function pick<T>(state: RngState, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined
  return items[nextInt(state, items.length)]
}

/** Picks `count` distinct items without mutating `items`. */
export function pickMany<T>(state: RngState, items: readonly T[], count: number): T[] {
  return shuffle(state, [...items]).slice(0, Math.max(0, count))
}

/** Hashes an arbitrary string into a seed, so rooms can be seeded by name. */
export function seedFromString(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
