import { savedCampaign } from '../../campaign-storage.ts'
import type { CampaignProgress } from '../../game/campaign.ts'
import { DAILY_MODIFIERS, type RunMetaOptions } from '../../game/meta.ts'
import { isCardPackId } from '../../game/packs.ts'
import { seedFromString } from '../../game/rng.ts'
import { createRun, resumeNeow, type RunState } from '../../game/run.ts'
import { CHARACTER_IDS, type CharacterId } from '../../game/types.ts'
import { preferredSkin } from '../../skin-preference.ts'
import { MAX_RUN_KEY_LENGTH } from '../../wallet.ts'
import { currentWalletKey } from '../../wallet-storage.ts'
import { RUN_PHASES } from '../run-log.ts'

export const ROSTER: { character: CharacterId; name: string }[] = [
  { character: 'ironclad', name: 'Ironclad' },
  { character: 'silent', name: 'Silent' },
  { character: 'defect', name: 'Defect' },
  { character: 'watcher', name: 'Watcher' },
  { character: 'slime_boss', name: 'Slime Boss' },
  { character: 'guardian', name: 'Guardian' },
  { character: 'hexaghost', name: 'Hexaghost' },
  { character: 'hermit', name: 'Hermit' },
]

export const DEFAULT_CHARACTERS = ROSTER.map((entry) => entry.character)

export const SOLO_RUN_KEY = 'sts-solo-run'

export type BuiltRun = {
  count: number
  seed: string
  ascension: number
  chooseYourRelic: boolean
  lastStand: boolean
  characters: CharacterId[]
  meta: RunMetaOptions
  /** The wallet ledger's key for this run's boss coins; drawn fresh at every start, absent on older saves. */
  coinKey?: string
  /**
   * The wallet of the account that started the run (`currentWalletKey()`): only it is
   * paid when the result is recorded. Absent on older saves, which pay whoever records.
   */
  owner?: string
}

export type SoloRunSave = {
  version: 1
  run: RunState
  built: BuiltRun
  terminalRun?: RunState | null
  recordRunId?: string | null
  runLogExtractedRunId?: string | null
}

function resumablePhase(run: Partial<RunState>): boolean {
  if (run.phase === 'combat') return run.combat !== null && typeof run.combat === 'object' &&
    Array.isArray(run.combat.players) && Array.isArray(run.combat.enemies) && Array.isArray(run.combat.pendingSummons)
  if (run.phase === 'neow') return run.neow !== null && typeof run.neow === 'object' &&
    Array.isArray(run.neow.deck) && run.neow.players !== null && typeof run.neow.players === 'object'
  if (run.phase === 'setup') return run.setup !== null && typeof run.setup === 'object' && Array.isArray(run.setup.playerIds)
  if (run.phase === 'reward') return Boolean(run.rewards?.length || run.pendingGuardianSockets?.length ||
    run.players?.some((player) => player.relics.some((relic) => relic.pending)))
  if (run.phase === 'betweenCombat') return typeof run.pendingBossDefId === 'string'
  if (run.phase === 'room') return (typeof run.map?.position === 'string' && Boolean(run.map.rooms?.[run.map.position])) ||
    (run.setup !== null && typeof run.setup === 'object' && run.roomState?.kind === 'merchant')
  return true
}

/** A save from before the shared-seed Daily Climb cannot rebuild a daily run without its day. */
function legacyDailyAsStandard(built: BuiltRun): BuiltRun {
  return built.meta.mode === 'daily' && !built.meta.dailyDate ? { ...built, meta: { ...built.meta, mode: 'standard' } } : built
}

/** Whether the account signed in now started this run (older saves name no owner). */
export const ownsRun = (built: Pick<BuiltRun, 'owner'>): boolean => built.owner === undefined || built.owner === currentWalletKey()

export function savedSoloRun(): SoloRunSave | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SOLO_RUN_KEY) ?? 'null') as Partial<SoloRunSave> | null
    const run = saved?.run as Partial<RunState> | undefined
    const built = saved?.built as Partial<BuiltRun> | undefined
    const completed = run?.campaign?.finalized === true && saved?.terminalRun?.campaign?.runId === run.campaign.runId
    return saved?.version === 1 && (run?.campaign?.finalized === false || completed) && run.players?.length === 1 &&
      typeof run.phase === 'string' && RUN_PHASES.has(run.phase) && typeof run.seed === 'number' &&
      typeof run.rng?.seed === 'number' && typeof run.rng.calls === 'number' && run.campaignProgress !== null &&
      typeof run.campaignProgress === 'object' && run.map?.rooms !== null && typeof run.map?.rooms === 'object' &&
      Array.isArray(run.map.rows) && run.enemyDecks !== null && typeof run.enemyDecks === 'object' &&
      Array.isArray(run.potionDeck) && Array.isArray(run.relicDeck) && Array.isArray(run.bossRelicDeck) &&
      Array.isArray(run.guardianGemDeck) && Array.isArray(run.pendingGuardianSockets) && Array.isArray(run.rewards) &&
      run.itemDecks !== null && typeof run.itemDecks === 'object' && Array.isArray(run.eventDeck) &&
      run.courier !== null && typeof run.courier === 'object' && run.meta !== null &&
      typeof run.meta === 'object' && Array.isArray(run.meta.modifierIds) && Array.isArray(run.log) &&
      // A run saved when Kratos was a character cannot continue: the engine no longer has him.
      run.players.every((player) => typeof player?.id === 'string' && CHARACTER_IDS.some((id) => id === player.character) && Array.isArray(player.deck) &&
        Array.isArray(player.relics) && Array.isArray(player.potions)) &&
      built?.count === 1 && typeof built.seed === 'string' && typeof built.ascension === 'number' &&
      typeof built.chooseYourRelic === 'boolean' && typeof built.lastStand === 'boolean' &&
      Array.isArray(built.characters) && built.characters.every((character) => DEFAULT_CHARACTERS.includes(character)) &&
      built.meta !== null && typeof built.meta === 'object' && !Array.isArray(built.meta) &&
      (built.meta.mode === undefined || ['standard', 'daily', 'custom'].includes(built.meta.mode)) &&
      (built.meta.modifiers === undefined || Array.isArray(built.meta.modifiers) && built.meta.modifiers.every((id) =>
        DAILY_MODIFIERS.some((modifier) => modifier.id === id))) &&
      (built.meta.quickStartAct === undefined || [1, 2, 3, 4].includes(built.meta.quickStartAct)) &&
      (built.meta.ruleset === undefined || built.meta.ruleset === 'base' || built.meta.ruleset === 'downfall') &&
      (built.meta.campaign === undefined || built.meta.campaign === 'base' || built.meta.campaign === 'downfall') &&
      (built.meta.dailyDate === undefined || typeof built.meta.dailyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(built.meta.dailyDate)) &&
      (built.meta.cardPacks === undefined || Array.isArray(built.meta.cardPacks) && built.meta.cardPacks.every(isCardPackId)) &&
      (built.coinKey === undefined || typeof built.coinKey === 'string' && built.coinKey.length > 0 && built.coinKey.length <= MAX_RUN_KEY_LENGTH) &&
      (built.owner === undefined || typeof built.owner === 'string' && built.owner.length > 0 && built.owner.length <= MAX_RUN_KEY_LENGTH) &&
      // Another account's run is never offered to the one signed in now.
      ownsRun(built as BuiltRun) &&
      resumablePhase(run)
      ? { ...saved as SoloRunSave, built: legacyDailyAsStandard(built as BuiltRun), run: completed ? run as RunState : resumeNeow(run as RunState) }
      : null
  } catch {
    return null
  }
}

export function legalCharacters(selected: readonly CharacterId[]): CharacterId[] {
  const result: CharacterId[] = []
  for (let seat = 0; seat < ROSTER.length; seat += 1) {
    const wanted = selected[seat]
    result.push(wanted && !result.includes(wanted)
      ? wanted
      : DEFAULT_CHARACTERS.find((character) => !result.includes(character))!)
  }
  return result
}

export function newRun(playerCount: number, seedText: string, ascension = 0, progress = savedCampaign(), chooseYourRelic = false, lastStand = false, selected = DEFAULT_CHARACTERS, meta: RunMetaOptions = {}): RunState {
  const party = legalCharacters(selected).slice(0, playerCount).map((character, index) => ({
    id: `p${index + 1}`,
    name: ROSTER.find((entry) => entry.character === character)!.name,
    character,
    // Presentation only: the skin this account has chosen for the hero, frozen into the run.
    skin: preferredSkin(character),
  }))
  return createRun(seedFromString(seedText), party, Math.min(ascension, progress.highestAscension), progress, chooseYourRelic, lastStand, meta)
}

/** The player's own journal; a Daily Climb runs on a shared baseline instead. */
export function campaignBeforeCurrentRun(run: RunState): CampaignProgress {
  if (run.meta.dailyDate !== undefined) {
    // The climb still used a run number, so the next run must not reuse its id.
    const journal = savedCampaign()
    return { ...journal, nextRunNumber: Math.max(journal.nextRunNumber, run.campaignProgress.nextRunNumber) }
  }
  return {
    ...run.campaignProgress,
    nextRunNumber: run.campaign.finalized ? run.campaignProgress.nextRunNumber : Math.max(0, run.campaignProgress.nextRunNumber - 1),
    highestAscension: Math.max(run.campaignProgress.highestAscension, savedCampaign().highestAscension),
  }
}

export function campaignBeforePendingRun(run: RunState): CampaignProgress {
  return run.meta.dailyDate !== undefined || !run.campaign.finalized && run.campaignProgress.unspentMarks > 0
    ? campaignBeforeCurrentRun(run)
    : run.campaignProgress
}
