import type { CharacterId } from './types.ts'

export type CampaignComponent =
  | { readonly kind: 'card'; readonly cardId: string; readonly name: string; readonly copies: number }
  | { readonly kind: 'goldenTicket'; readonly character: CharacterId; readonly name: string; readonly copies: 1 }

export type CharacterUnlock = {
  boxes: 1 | 4 | 8
  components: readonly CampaignComponent[]
}

const card = (cardId: string, name: string, copies = 1): CampaignComponent =>
  ({ kind: 'card', cardId, name, copies })

const ticket = (character: CharacterId): CampaignComponent =>
  ({ kind: 'goldenTicket', character, name: `Golden Ticket 2 (${character.charAt(0).toUpperCase()}${character.slice(1)})`, copies: 1 })

/** Physical unlock envelopes. `boxes` is the total checked-box threshold. */
export const CHARACTER_UNLOCKS: Readonly<Record<CharacterId, readonly CharacterUnlock[]>> = {
  ironclad: [
    { boxes: 1, components: [card('immolate', 'Immolate'), card('evolve', 'Evolve'), card('fire_breathing', 'Fire Breathing'), card('power_through', 'Power Through')] },
    { boxes: 4, components: [ticket('ironclad'), card('havoc', 'Havoc', 2), card('corruption', 'Corruption'), card('rampage', 'Rampage')] },
    { boxes: 8, components: [card('barricade', 'Barricade'), card('dark_embrace', 'Dark Embrace'), card('entrench', 'Entrench'), card('second_wind', 'Second Wind')] },
  ],
  silent: [
    { boxes: 1, components: [card('prepared', 'Prepared', 2), card('grand_finale', 'Grand Finale'), card('reflex', 'Reflex'), card('tactician', 'Tactician')] },
    { boxes: 4, components: [ticket('silent'), card('corpse_explosion', 'Corpse Explosion'), card('choke', 'Choke'), card('distraction', 'Distraction')] },
    // The source catalog says 4; the official companion correction places Concentrate in unlock 3.
    { boxes: 8, components: [card('doppelganger', 'Doppelganger'), card('concentrate', 'Concentrate'), card('expertise', 'Expertise'), card('outmaneuver', 'Outmaneuver')] },
  ],
  defect: [
    { boxes: 1, components: [card('turbo', 'TURBO', 2), card('echo_form', 'Echo Form'), card('overclock', 'Overclock'), card('sunder', 'Sunder')] },
    { boxes: 4, components: [ticket('defect'), card('defragment', 'Defragment'), card('consume', 'Consume'), card('heatsinks', 'Heatsinks')] },
    { boxes: 8, components: [card('fission', 'Fission'), card('double_energy', 'Double Energy'), card('equilibrium', 'Equilibrium'), card('recycle', 'Recycle')] },
  ],
  watcher: [
    { boxes: 1, components: [card('flurry_of_blows', 'Flurry of Blows', 2), card('blasphemy', 'Blasphemy'), card('worship', 'Worship')] },
    { boxes: 4, components: [ticket('watcher'), card('conjure_blade', 'Conjure Blade'), card('foresight', 'Foresight'), card('nirvana', 'Nirvana'), card('weave', 'Weave')] },
    { boxes: 8, components: [card('omniscience', 'Omniscience'), card('meditate', 'Meditate'), card('perseverance', 'Perseverance'), card('wreath_of_flame', 'Wreath of Flame')] },
  ],
}

export const COLORLESS_UNLOCK = {
  boxes: 3,
  cards: [
    card('apotheosis', 'Apotheosis'), card('hand_of_greed', 'Hand of Greed'), card('master_of_strategy', 'Master of Strategy'),
    card('mayhem', 'Mayhem'), card('the_bomb', 'The Bomb'), card('apparition', 'Apparition'), card('blind', 'Blind'),
    card('dark_shackles', 'Dark Shackles'), card('dramatic_entrance', 'Dramatic Entrance'), card('finesse', 'Finesse'),
    card('flash_of_steel', 'Flash of Steel'), card('good_instincts', 'Good Instincts'), card('impatience', 'Impatience'),
    card('madness', 'Madness'), card('mind_blast', 'Mind Blast'), card('panacea', 'Panacea'), card('panache', 'Panache'),
    card('purity', 'Purity'), card('sadistic_nature', 'Sadistic Nature'), card('swift_strike', 'Swift Strike'),
    card('thinking_ahead', 'Thinking Ahead'), card('trip', 'Trip'),
  ],
  neowCards: 6,
  event: { id: 'event-27', name: 'Sensory Stone', copies: 1 },
} as const

export const ACT_IV_UNLOCK_BOXES = 5
export const CHARACTER_UNLOCK_BOXES = 8
export const MAX_ASCENSION = 13

export type CampaignProgress = {
  version: 1
  characters: Record<CharacterId, number>
  colorless: number
  actIV: number
  unspentMarks: number
  highestAscension: number
  nextRunNumber: number
  finishedRunIds: string[]
}

export type MarkAllocation = {
  character: number
  pending: number
  unused: number
}

export type CampaignFinish = {
  runId: string
  characters: readonly CharacterId[]
  bossesDefeated: number
  joinedAfterBosses?: Partial<Record<CharacterId, number>>
  startedAtAct?: 1 | 2 | 3 | 4
  highestBossActDefeated: 0 | 1 | 2 | 3 | 4
  ascensionPlayed: number
}

export function createCampaignProgress(): CampaignProgress {
  return {
    version: 1,
    characters: { ironclad: 0, silent: 0, defect: 0, watcher: 0 },
    colorless: 0,
    actIV: 0,
    unspentMarks: 0,
    highestAscension: 0,
    nextRunNumber: 0,
    finishedRunIds: [],
  }
}

export function parseCampaignProgress(value: unknown, fallback = createCampaignProgress()): CampaignProgress {
  const safeFallback = (): CampaignProgress => ({
    ...fallback,
    characters: { ...fallback.characters },
    finishedRunIds: [...fallback.finishedRunIds],
  })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safeFallback()
  const saved = value as Partial<CampaignProgress>
  const integer = (entry: unknown, max: number) => Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= max
  const characters = saved.characters
  if (saved.version !== 1 || !characters || typeof characters !== 'object' || Array.isArray(characters) ||
    !(['ironclad', 'silent', 'defect', 'watcher'] as const).every((id) => integer(characters[id], CHARACTER_UNLOCK_BOXES)) ||
    !integer(saved.colorless, COLORLESS_UNLOCK.boxes) || !integer(saved.actIV, ACT_IV_UNLOCK_BOXES) ||
    !integer(saved.unspentMarks, COLORLESS_UNLOCK.boxes + ACT_IV_UNLOCK_BOXES) || !integer(saved.highestAscension, MAX_ASCENSION) ||
    Number(saved.colorless) + Number(saved.actIV) + Number(saved.unspentMarks) > COLORLESS_UNLOCK.boxes + ACT_IV_UNLOCK_BOXES ||
    !integer(saved.nextRunNumber, Number.MAX_SAFE_INTEGER) || !Array.isArray(saved.finishedRunIds) || saved.finishedRunIds.some((id) => typeof id !== 'string')) return safeFallback()
  return {
    version: 1,
    characters: { ironclad: characters.ironclad!, silent: characters.silent!, defect: characters.defect!, watcher: characters.watcher! },
    colorless: saved.colorless!, actIV: saved.actIV!, unspentMarks: saved.unspentMarks!, highestAscension: saved.highestAscension!, nextRunNumber: saved.nextRunNumber!, finishedRunIds: [...saved.finishedRunIds],
  }
}

export function characterUnlockLevel(progress: CampaignProgress, character: CharacterId): 0 | 1 | 2 | 3 {
  const boxes = progress.characters[character]
  return boxes >= 8 ? 3 : boxes >= 4 ? 2 : boxes >= 1 ? 1 : 0
}

export function unlockedCharacterComponents(progress: CampaignProgress, character: CharacterId): CampaignComponent[] {
  const boxes = progress.characters[character]
  return CHARACTER_UNLOCKS[character].filter((unlock) => boxes >= unlock.boxes).flatMap((unlock) => [...unlock.components])
}

export const isColorlessUnlocked = (progress: CampaignProgress): boolean => progress.colorless >= COLORLESS_UNLOCK.boxes
export const isActIVUnlocked = (progress: Pick<CampaignProgress, 'actIV'>): boolean => progress.actIV >= ACT_IV_UNLOCK_BOXES

function validateMarks(marks: number): void {
  if (!Number.isInteger(marks) || marks < 0) throw new Error('campaign marks must be a non-negative integer')
}

/** Fill the played character first; any legal overflow waits for the player's shared-track choice. */
export function awardCampaignMarks(progress: CampaignProgress, character: CharacterId, marks: number): { progress: CampaignProgress; allocation: MarkAllocation } {
  validateMarks(marks)
  const next: CampaignProgress = { ...progress, characters: { ...progress.characters }, finishedRunIds: [...progress.finishedRunIds] }
  const characterMarks = Math.min(CHARACTER_UNLOCK_BOXES - next.characters[character], marks)
  next.characters[character] += characterMarks
  const sharedCapacity = COLORLESS_UNLOCK.boxes - next.colorless + ACT_IV_UNLOCK_BOXES - next.actIV - next.unspentMarks
  const pending = Math.min(sharedCapacity, marks - characterMarks)
  next.unspentMarks += pending
  const allocation: MarkAllocation = { character: characterMarks, pending, unused: marks - characterMarks - pending }
  return { progress: next, allocation }
}

/** Spend pending marks on either shared track, in the exact amounts chosen by the players. */
export function allocateSharedMarks(progress: CampaignProgress, colorless: number, actIV: number): CampaignProgress {
  validateMarks(colorless)
  validateMarks(actIV)
  if (colorless + actIV > progress.unspentMarks) throw new Error('not enough unspent campaign marks')
  if (progress.colorless + colorless > COLORLESS_UNLOCK.boxes) throw new Error('Colorless unlock track is full')
  if (progress.actIV + actIV > ACT_IV_UNLOCK_BOXES) throw new Error('Act IV unlock track is full')
  return { ...progress, colorless: progress.colorless + colorless, actIV: progress.actIV + actIV, unspentMarks: progress.unspentMarks - colorless - actIV }
}

export function ascensionBossQualifies(playerCount: number, highestBossActDefeated: CampaignFinish['highestBossActDefeated']): boolean {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 4) throw new Error('campaign player count must be from 1 to 4')
  return highestBossActDefeated >= (playerCount === 1 ? 3 : 2)
}

/** Record a completed or lost game once. Every player earns one mark plus one per defeated boss. */
export function finishCampaign(progress: CampaignProgress, finish: CampaignFinish): CampaignProgress {
  const runId = finish.runId.trim()
  if (!runId) throw new Error('campaign finish requires a run id')
  if (progress.finishedRunIds.includes(runId)) return progress
  if (finish.characters.length < 1 || finish.characters.length > 4) throw new Error('campaign finish requires 1 to 4 players')
  const validCharacters: readonly CharacterId[] = ['ironclad', 'silent', 'defect', 'watcher']
  if (new Set(finish.characters).size !== finish.characters.length || finish.characters.some((character) => !validCharacters.includes(character))) throw new Error('campaign characters must be unique physical characters')
  if (!Number.isInteger(finish.bossesDefeated) || finish.bossesDefeated < 0 || finish.bossesDefeated > 6) throw new Error('bosses defeated must be from 0 to 6')
  if (!Number.isInteger(finish.highestBossActDefeated) || finish.highestBossActDefeated < 0 || finish.highestBossActDefeated > 4) throw new Error('highest defeated Boss Act must be from 0 to 4')
  const startedAtAct = finish.startedAtAct ?? 1
  if (!Number.isInteger(startedAtAct) || startedAtAct < 1 || startedAtAct > 4) throw new Error('starting Act must be from 1 to 4')
  const expectedMainBosses = finish.highestBossActDefeated < startedAtAct ? 0 : finish.highestBossActDefeated - startedAtAct + 1
  const bonusBosses = (finish.highestBossActDefeated >= 2 ? 1 : 0) +
    (finish.highestBossActDefeated >= 3 && finish.ascensionPlayed >= 13 ? 1 : 0)
  if (finish.bossesDefeated < expectedMainBosses || finish.bossesDefeated > expectedMainBosses + bonusBosses) throw new Error('highest defeated Boss Act does not match the Boss count')
  if (!Number.isInteger(finish.ascensionPlayed) || finish.ascensionPlayed < 0 || finish.ascensionPlayed > progress.highestAscension) throw new Error('played Ascension is not unlocked')

  let next = progress
  for (const character of finish.characters) {
    const joinedAfter = finish.joinedAfterBosses?.[character] ?? 0
    next = awardCampaignMarks(next, character, Math.max(0, finish.bossesDefeated - joinedAfter) + 1).progress
  }
  if (finish.ascensionPlayed === progress.highestAscension && ascensionBossQualifies(finish.characters.length, finish.highestBossActDefeated)) {
    next = { ...next, highestAscension: Math.min(MAX_ASCENSION, next.highestAscension + 1) }
  }
  return { ...next, finishedRunIds: [...next.finishedRunIds, runId] }
}

export type SpireKey = 'ruby' | 'sapphire' | 'emerald'
export type SpireKeys = Record<SpireKey, boolean>
export type KeyEvidence =
  | { key: 'ruby'; playerIds: readonly string[]; skippedPlayerIds: readonly string[] }
  | { key: 'sapphire'; playerIds: readonly string[]; skippedPlayerIds: readonly string[] }
  | { key: 'emerald'; playerIds: readonly string[]; burnsShuffledByPlayer: Readonly<Record<string, number>>; burningEliteDefeated: boolean }

export const createSpireKeys = (): SpireKeys => ({ ruby: false, sapphire: false, emerald: false })

function validParty(playerIds: readonly string[]): boolean {
  return playerIds.length >= 1 && playerIds.length <= 4 && playerIds.every((id) => id.length > 0) && new Set(playerIds).size === playerIds.length
}

export function canClaimKey(evidence: KeyEvidence): boolean {
  if (!validParty(evidence.playerIds)) return false
  if (evidence.key === 'emerald') {
    const entries = Object.entries(evidence.burnsShuffledByPlayer)
    return evidence.burningEliteDefeated && entries.length === evidence.playerIds.length && evidence.playerIds.every((id) => evidence.burnsShuffledByPlayer[id] === 2)
  }
  const skipped = new Set(evidence.skippedPlayerIds)
  return skipped.size === evidence.playerIds.length && evidence.playerIds.every((id) => skipped.has(id))
}

export function claimKey(keys: SpireKeys, evidence: KeyEvidence): SpireKeys {
  if (keys[evidence.key]) return keys
  if (!canClaimKey(evidence)) throw new Error(`${evidence.key} key requirements are not met`)
  return { ...keys, [evidence.key]: true }
}

export const hasAllKeys = (keys: SpireKeys): boolean => keys.ruby && keys.sapphire && keys.emerald

export function canEnterActIV(progress: Pick<CampaignProgress, 'actIV'>, keys: SpireKeys, completedAct: number): boolean {
  return completedAct === 3 && isActIVUnlocked(progress) && hasAllKeys(keys)
}
