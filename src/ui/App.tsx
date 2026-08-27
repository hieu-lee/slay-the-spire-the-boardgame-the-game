import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CombatState } from '../game/combat.ts'
import { assetPath } from '../game/assets.ts'
import {
  advanceAct,
  advanceQuickSetup,
  canGiveUpRun,
  canSkipEvent,
  chooseNeow,
  decideCourier,
  chooseEvent,
  chooseRelicReward,
  createRun,
  enterRoom,
  hasPendingRelicAcquisition,
  leaveRoom,
  finishMerchant,
  finishRun,
  giveUpRun,
  purchaseAtMerchant,
  removeAtCurrentMerchant,
  resolveCampfire,
  resolveNeowEffect,
  resolveNeowGold,
  revealNeowReward,
  neowPreview,
  resolveNeowReward,
  revealCardReward,
  revealPotionReward,
  revealRelicReward,
  unavailableEventOptionIds,
  resolveRelicReward,
  resolveBossRelicReward,
  resolvePotionReward,
  resolveTransformReward,
  pendingRelicPreview,
  resolvePendingRelic,
  resolveCardRewards,
  resolveCombat,
  revealCourier,
  roomChoices,
  startPendingBoss,
  switchBetweenCombatRow,
  tradePotion,
  usePotionOutsideCombat,
  victoryIsTerminal,
  visibleMap,
  wingBootChoices,
  skipEvent,
} from '../game/run.ts'
import type { RunState } from '../game/run.ts'
import { createRng, seedFromString } from '../game/rng.ts'
import type { CharacterId } from '../game/types.ts'
import { ROOM_LABEL } from '../game/run.ts'
import { hasRoomSession } from '../multiplayer/useRoomSession.ts'
import { ACT_IV_UNLOCK_BOXES, COLORLESS_UNLOCK, isActIVUnlocked } from '../game/campaign.ts'
import { allocateSharedMarks, canEnterActIV, createCampaignProgress, parseCampaignProgress } from '../game/campaign.ts'
import type { CampaignProgress } from '../game/campaign.ts'
import { eventCanStartCombat } from '../game/events.ts'
import { MapScreen } from './MapScreen.tsx'
import { MapOverlay } from './MapOverlay.tsx'
import { CardCollectionOverlay } from './CardCollectionOverlay.tsx'
import { CampfireScreen } from './CampfireScreen.tsx'
import { RewardScreen } from './RewardScreen.tsx'
import { relicDef } from '../game/relics.ts'
import { IconValue } from './Icon.tsx'
import { RelicBar } from './RelicChip.tsx'
import { OutsidePotionBar } from './OutsidePotionBar.tsx'
import { RelicResolvePanel } from './RelicResolvePanel.tsx'
import { StartMenu } from './StartMenu.tsx'
import { GiveUpPanel } from './GiveUpPanel.tsx'
import { CourierPanel, RoomScreen } from './RoomScreen.tsx'
import { NeowScreen } from './NeowScreen.tsx'
import { QuickSetupScreen } from './QuickSetupScreen.tsx'
import { CardMorph, CardMorphAnnouncement } from './CardMorph.tsx'
import { RunSummary, summarySeat } from './RunSummary.tsx'
import { useCardMorphs } from './useCardMorphs.ts'
import { cardDef, faceOf } from '../game/cards.ts'
import { currentQuickSetupStep, DAILY_MODIFIERS, rollDailyModifiers } from '../game/meta.ts'
import type { DailyModifierId, RunMetaOptions, RunMode } from '../game/meta.ts'
import { installSoundEffects, useBossFightMusic, useRunOutcomeSound } from './sfx.ts'
import { SettingsDialog } from './SettingsDialog.tsx'
import { useGameSettings } from './game-settings.ts'
import { wingBootLabel } from './wing-boots.ts'
import type { GameSettings } from './game-settings.ts'

const SINGLE_PLAYER_ONLY = import.meta.env.VITE_SINGLE_PLAYER === 'true'
const CombatScreen = lazy(() => import('./CombatScreen.tsx').then((module) => ({ default: module.CombatScreen })))
const OnlineGame = SINGLE_PLAYER_ONLY ? null : lazy(() => import('./OnlineGame.tsx').then((module) => ({ default: module.OnlineGame })))
const CompendiumScreen = lazy(() => import('./CompendiumScreen.tsx').then((module) => ({ default: module.CompendiumScreen })))
const AchievementsScreen = lazy(() => import('./AchievementsScreen.tsx').then((module) => ({ default: module.AchievementsScreen })))

const ROSTER: { character: CharacterId; name: string }[] = [
  { character: 'ironclad', name: 'Ironclad' },
  { character: 'silent', name: 'Silent' },
  { character: 'defect', name: 'Defect' },
  { character: 'watcher', name: 'Watcher' },
]
const DEFAULT_CHARACTERS = ROSTER.map((entry) => entry.character)

const CAMPAIGN_KEY = 'sts-physical-campaign'

function savedCampaign(): CampaignProgress {
  let progress: CampaignProgress
  try { progress = parseCampaignProgress(JSON.parse(localStorage.getItem(CAMPAIGN_KEY) ?? '{}')) }
  catch { progress = createCampaignProgress() }
  return SINGLE_PLAYER_ONLY
    ? { ...progress, colorless: COLORLESS_UNLOCK.boxes, actIV: ACT_IV_UNLOCK_BOXES, unspentMarks: 0 }
    : progress
}

function legalCharacters(selected: readonly CharacterId[]): CharacterId[] {
  const result: CharacterId[] = []
  for (let seat = 0; seat < ROSTER.length; seat += 1) {
    const wanted = selected[seat]
    result.push(wanted && !result.includes(wanted)
      ? wanted
      : DEFAULT_CHARACTERS.find((character) => !result.includes(character))!)
  }
  return result
}

function newRun(playerCount: number, seedText: string, ascension = 0, progress = savedCampaign(), chooseYourRelic = false, lastStand = false, selected = DEFAULT_CHARACTERS, meta: RunMetaOptions = {}): RunState {
  const party = legalCharacters(selected).slice(0, playerCount).map((character, index) => ({
    id: `p${index + 1}`,
    name: ROSTER.find((entry) => entry.character === character)!.name,
    character,
  }))
  return createRun(seedFromString(seedText), party, Math.min(ascension, progress.highestAscension), progress, chooseYourRelic, lastStand, meta)
}

function campaignBeforeCurrentRun(run: RunState): CampaignProgress {
  return !run.campaign.finalized
    ? { ...run.campaignProgress, nextRunNumber: Math.max(0, run.campaignProgress.nextRunNumber - 1) }
    : run.campaignProgress
}

function campaignBeforePendingRun(run: RunState): CampaignProgress {
  return !run.campaign.finalized && run.campaignProgress.unspentMarks > 0
    ? campaignBeforeCurrentRun(run)
    : run.campaignProgress
}

export function App() {
  const [online, setOnline] = useState(() => !SINGLE_PLAYER_ONLY && hasRoomSession())
  const [localOpen, setLocalOpen] = useState(false)
  const [settings, setSettings] = useGameSettings()
  useEffect(() => settings.sfxVolume > 0 ? installSoundEffects() : undefined, [settings.sfxVolume])
  return (
    <Suspense fallback={<main className="app-loading" role="status">Loading…</main>}>
      <div className="game-mode" hidden={online}>
        <LocalGame open={localOpen} onOpen={() => setLocalOpen(true)} onClose={() => setLocalOpen(false)} onOnline={SINGLE_PLAYER_ONLY ? undefined : () => setOnline(true)}
          settings={settings} onSettings={setSettings} active={!online} />
      </div>
      {online && OnlineGame ? <OnlineGame onLocal={() => setOnline(false)} settings={settings} onSettings={setSettings} /> : null}
    </Suspense>
  )
}

function LocalGame({ open, onOpen, onClose, onOnline, settings, onSettings, active }: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  onOnline?: () => void
  settings: GameSettings
  onSettings: (settings: GameSettings) => void
  active: boolean
}) {
  const [seedText, setSeedText] = useState<string>(() => crypto.randomUUID())
  const [ascension, setAscension] = useState(0)
  const [characters, setCharacters] = useState<CharacterId[]>(() => [...DEFAULT_CHARACTERS])
  const [chooseYourRelic, setChooseYourRelic] = useState(false)
  const [lastStand, setLastStand] = useState(false)
  const [mode, setMode] = useState<RunMode>('standard')
  const [customModifierIds, setCustomModifierIds] = useState<DailyModifierId[]>([])
  const [quickStartAct, setQuickStartAct] = useState<1 | 2 | 3 | 4>(1)
  const [run, setRun] = useState<RunState>(() => newRun(1, crypto.randomUUID()))
  const [choosingNextCharacter, setChoosingNextCharacter] = useState(false)
  const updateCombat = useCallback((next: CombatState) => {
    setRun((current) => ({ ...current, combat: next }))
  }, [])
  useRunOutcomeSound(run)
  useBossFightMusic(run.combat, active && open && settings.bgmVolume > 0, settings.bgmVolume)
  const [viewerId, setViewerId] = useState('p1')
  const [compendium, setCompendium] = useState(false)
  const [giveUpOpen, setGiveUpOpen] = useState(false)
  const [pauseOpen, setPauseOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsReturnToPause, setSettingsReturnToPause] = useState(false)
  const pauseDialog = useRef<HTMLDialogElement>(null)
  const runShell = useRef<HTMLElement>(null)
  const [achievements, setAchievements] = useState(false)
  const dailyModifiers = useMemo(() => rollDailyModifiers(createRng(seedFromString(seedText))).modifiers, [seedText])
  const metaOptions: RunMetaOptions = { mode, modifiers: customModifierIds, quickStartAct }
  const canGiveUp = canGiveUpRun(run, run.campaignProgress)

  /** The settings the run in progress was actually built from. */
  const [built, setBuilt] = useState({ count: 1, seed: seedText, ascension: 0, chooseYourRelic: false, lastStand: false, characters: [...DEFAULT_CHARACTERS], meta: {} as RunMetaOptions })

  useEffect(() => {
    const dialog = pauseDialog.current
    if (!dialog) return
    if (!active && pauseOpen) {
      setPauseOpen(false)
      return
    }
    if (pauseOpen && !dialog.open) dialog.showModal()
    else if (!pauseOpen && dialog.open) dialog.close()
  }, [active, pauseOpen])

  useEffect(() => {
    if (!active || !open || compendium || giveUpOpen) return undefined
    let timer: number | undefined
    const pause = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || pauseDialog.current?.open || document.querySelector('dialog[open]')) return
      if (event.target instanceof Element && event.target.closest('.powers, .potion-chip, .relic-chip')) return
      if (document.querySelector('.power__zoom, .potion-tip, .relic-chip:hover > .relic-tip, .relic-chip:focus-within > .relic-tip')) return
      timer = window.setTimeout(() => {
        if (!event.defaultPrevented && !document.querySelector('dialog[open]')) setPauseOpen(true)
      })
    }
    document.addEventListener('keydown', pause)
    return () => {
      document.removeEventListener('keydown', pause)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active, compendium, giveUpOpen, open])

  useEffect(() => {
    if (giveUpOpen && !canGiveUp) setGiveUpOpen(false)
  }, [canGiveUp, giveUpOpen])

  function restart(count: number, seed: string, nextAscension = 0, nextChooseYourRelic = chooseYourRelic, nextLastStand = lastStand, selected = characters, nextMeta: RunMetaOptions = metaOptions) {
    const nextCharacters = legalCharacters(selected)
    const progress = open ? campaignBeforePendingRun(run) : campaignBeforeCurrentRun(run)
    const legalAscension = Math.min(nextAscension, progress.highestAscension)
    setSeedText(seed)
    setAscension(legalAscension)
    setCharacters(nextCharacters)
    setChooseYourRelic(nextChooseYourRelic)
    setLastStand(nextLastStand)
    setViewerId('p1')
    setBuilt({ count, seed, ascension: legalAscension, chooseYourRelic: nextChooseYourRelic, lastStand: nextLastStand, characters: nextCharacters, meta: nextMeta })
    setRun(newRun(count, seed, legalAscension, progress, nextChooseYourRelic, nextLastStand, nextCharacters, nextMeta))
  }

  // A debug bridge for the Playwright suite: drive real clicks, assert real
  // state. Screenshots are for review; assertions read from here.
  useEffect(() => {
    const bridge = {
      getRun: () => run,
      /** The combat state, or null outside a fight. */
      getState: () => run.combat,
      setRun: (next: RunState) => setRun(next),
      reset: (count: number, seed: string, nextAscension = 0) => restart(count, seed, nextAscension, chooseYourRelic, lastStand, DEFAULT_CHARACTERS),
      setViewer: (id: string) => setViewerId(id),
    }
    ;(window as unknown as { __STS_DEBUG__?: typeof bridge }).__STS_DEBUG__ = bridge
  }, [run])

  useEffect(() => {
    setAscension((current) => Math.min(current, run.campaignProgress.highestAscension))
  }, [run.campaignProgress.highestAscension])

  // Guarded, like the read at `savedCampaign`. `setItem` throws on a full quota
  // and on blocked storage (Chrome's "block all cookies", enterprise policy, a
  // shared-origin dev host at the 5MB cap) — and thrown from a mount effect with
  // no error boundary above it, React unmounts the root and the whole app goes
  // white. Losing the campaign journal is a bad outcome; losing the game is a
  // worse one.
  useEffect(() => {
    try {
      localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(open ? campaignBeforePendingRun(run) : campaignBeforeCurrentRun(run)))
    } catch {
      // Storage is unavailable; the run continues in memory.
    }
  }, [open, run.campaignProgress, run.campaign.finalized])

  // A finished combat folds back into the run on its own; the player should not
  // have to click through a screen that only says "you won".
  useEffect(() => {
    if (open && !compendium && !pauseOpen && !settingsOpen && run.combat && (run.combat.phase === 'won' || run.combat.phase === 'lost')) {
      const timer = setTimeout(() => setRun((current) => resolveCombat(current)), 900)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [compendium, open, pauseOpen, run.combat, settingsOpen])

  const viewer = run.players.find((player) => player.id === viewerId) ?? run.players[0]
  // Fires wherever a card changed — campfire, event, reward, Neow, a relic —
  // because it watches the deck rather than each of those call sites.
  const morph = useCardMorphs(viewer?.deck, open ? run.campaign.runId : undefined, run.phase, viewerId)
  // The map is regenerated per act, so this counts the CURRENT act's climb, not
  // the run's. The summary labels it "Rooms this act" to match.
  const roomsCleared = useMemo(
    () => Object.values(run.map.rooms).filter((room) => room.visited).length,
    [run.map.rooms],
  )
  const pendingAcquisition = hasPendingRelicAcquisition(run)
  // Derived once per render: `visibleMap` rebuilds the room table (and clones
  // every room under Uncertain Future), and the map phase asked for it four
  // times — twice in one `MapScreen` line, then again per Wing Boots option.
  const seenMap = useMemo(() => visibleMap(run), [run])
  const wingChoices = useMemo(() => wingBootChoices(run, viewerId), [run, viewerId])
  const pendingPreview = useMemo(() => pendingRelicPreview(run, viewerId), [run, viewerId])
  const canSwitchRowsHere = run.phase === 'map' || run.phase === 'room' &&
    run.roomState?.kind === 'event' && eventCanStartCombat(run.roomState.card)
  const pendingOwner = run.players.find((player) => player.relics.some((relic) => relic.pending))
  const pendingRelic = pendingOwner?.relics.find((relic) => relic.pending)
  const roomKind = run.map.position ? run.map.rooms[run.map.position]?.kind : undefined
  const allocatingCampaignMarks = run.campaign.finalized || run.campaignProgress.unspentMarks > 0
  function allocateCampaignMark(colorless: number, actIV: number) {
    setRun((current) => {
      const progress = allocateSharedMarks(current.campaignProgress, colorless, actIV)
      if (current.campaign.finalized) return { ...current, campaignProgress: progress }
      return newRun(built.count, built.seed, built.ascension, { ...progress, nextRunNumber: progress.nextRunNumber - 1 }, built.chooseYourRelic, built.lastStand, built.characters, built.meta)
    })
  }

  if (!open) {
    if (compendium) return <CompendiumScreen onBack={() => setCompendium(false)} />
    if (achievements) return <AchievementsScreen onBack={() => setAchievements(false)} />
    return <StartMenu
      characters={characters}
      ascension={ascension}
      maxAscension={run.campaignProgress.highestAscension}
      mode={mode}
      dailyModifiers={dailyModifiers}
      customModifierIds={customModifierIds}
      quickStartAct={quickStartAct}
      actIVUnlocked={isActIVUnlocked(run.campaignProgress)}
      onCharacter={(seat, character) => setCharacters((current) => {
        const next = [...current]
        const previous = next[seat]
        if (!previous) return current
        const otherSeat = next.indexOf(character)
        if (otherSeat >= 0) next[otherSeat] = previous
        next[seat] = character
        return next
      })}
      onAscension={setAscension}
      onMode={setMode}
      onCustomModifier={(id, enabled) => setCustomModifierIds((current) => enabled
        ? current.includes(id) ? current : [...current, id]
        : current.filter((candidate) => candidate !== id))}
      onQuickStartAct={setQuickStartAct}
      onStart={() => {
        setChoosingNextCharacter(false)
        restart(1, seedText, ascension, false, false, characters, metaOptions)
        onOpen()
      }}
      onOnline={onOnline}
      onCompendium={() => setCompendium(true)}
      onAchievements={() => setAchievements(true)}
      onCharacterBack={() => setChoosingNextCharacter(false)}
      settings={settings}
      onSettings={onSettings}
      initiallyChoosingCharacter={choosingNextCharacter}
    />
  }

  return (
    <>
    <main ref={runShell} tabIndex={-1} inert={compendium || undefined} aria-hidden={compendium || undefined} className={`app-shell sts-scope${run.phase === 'combat' ? ' app-shell--combat' : ''}${run.phase === 'neow' ? ' app-shell--neow' : ''}${run.roomState?.kind === 'event' ? ' app-shell--event' : ''}${compendium ? ' app-shell--compendium-open' : ''}`}>
      <header className="app-shell__header">
        <h1>Slay the Spire</h1>
        <div className="run-status">
          <span className="pip">Act {run.act}</span>
          {run.ascension > 0 ? <span className="pip">Ascension {run.ascension}</span> : null}
          {viewer ? (
            <>
              {/* HP rides the header on every screen, not only in combat. It is
                  the number the whole run is steered by — whether to take the
                  elite, whether to rest or upgrade — and the digital game pins
                  it top-left everywhere for exactly that reason. */}
              <span className="pip pip--hp" role="img" aria-label={`Health ${viewer.hp} of ${viewer.maxHp}`}>
                {viewer.hp}/{viewer.maxHp}
              </span>
              <span className="pip" title="Gold">
                <IconValue name="gold" value={viewer.gold} size={20} />
              </span>
              <RelicBar relics={viewer.relics} label={`${viewer.name}'s relics`} />
            </>
          ) : null}
        </div>
        {viewer ? (
          <CardCollectionOverlay cards={viewer.deck} label="Current deck" triggerClassName="deck-peek__open">
            <img src={assetPath('menu/current-deck.webp')} alt="" />
            <span aria-hidden="true">{viewer.deck.length}</span>
          </CardCollectionOverlay>
        ) : null}
        {run.phase !== 'map' && run.phase !== 'setup' ? (
          <MapOverlay map={seenMap} act={run.act} bossDefId={run.actBossDefId} />
        ) : null}
        <button type="button" className="game-settings game-settings__summary" aria-label="Settings"
          onClick={() => { setSettingsReturnToPause(false); setSettingsOpen(true) }}>
          <img src={assetPath('menu/settings-cog.png')} alt="" />
        </button>
      </header>

      <SettingsDialog open={settingsOpen} settings={settings} onChange={onSettings}
        onClose={() => { setSettingsOpen(false); if (settingsReturnToPause) setPauseOpen(true) }}
        generalChildren={<>
          {run.meta.modifierIds.length > 0 ? <details className="ascension-rules run-modifiers">
            <summary>{run.meta.mode === 'daily' ? 'Daily Climb' : 'Custom Run'} · {run.meta.modifierIds.length} modifiers</summary>
            <ul>{run.meta.modifierIds.map((id) => {
              const modifier = DAILY_MODIFIERS.find((candidate) => candidate.id === id)!
              return <li key={id}><strong>{modifier.name}</strong> — {modifier.rule}</li>
            })}</ul>
          </details> : null}
          {run.players.length > 1 ? <label className="settings-select">Seat
            <select value={viewerId} onChange={(event) => setViewerId(event.target.value)}>
              {run.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
            </select>
          </label> : null}
        </>} />

      {giveUpOpen && canGiveUp ? <GiveUpPanel
        players={run.players} playerId={viewerId}
        onVote={(yes) => {
          setGiveUpOpen(false)
          if (yes) setRun((current) => giveUpRun(current))
        }}
        onCancel={() => setGiveUpOpen(false)}
      /> : null}

      <dialog ref={pauseDialog} className="choice-modal pause-menu" aria-labelledby="pause-menu-title"
        onCancel={(event) => { event.preventDefault(); setPauseOpen(false) }}>
        <section className="choice-modal__panel">
          <p>Game paused</p>
          <h2 id="pause-menu-title">Slay the Spire</h2>
          <button type="button" className="is-chosen" onClick={() => setPauseOpen(false)}>Resume</button>
          <button type="button" onClick={() => { setPauseOpen(false); setSettingsReturnToPause(true); setSettingsOpen(true) }}>Settings</button>
          <button type="button" onClick={() => { setPauseOpen(false); setCompendium(true) }}>Compendium</button>
          {canGiveUp ? <button type="button" onClick={() => { setPauseOpen(false); setGiveUpOpen(true) }}>Give up</button> : null}
          <button type="button" onClick={() => {
            if (!window.confirm('Abandon this run and return to the main menu?')) return
            setPauseOpen(false)
            onClose()
          }}>Return to main menu</button>
        </section>
      </dialog>

      {!allocatingCampaignMarks && run.phase === 'combat' && run.combat ? (
        <><div className="courier-combat-lock" inert={Boolean(run.courier.offer) || undefined} aria-disabled={Boolean(run.courier.offer) || undefined}><CombatScreen
          state={run.combat}
          act={run.act}
          viewerId={viewerId}
          autoAdvance={!compendium && !pauseOpen && !settingsOpen && !giveUpOpen && !run.courier.offer}
          courierAvailable={!run.courier.usedBy.includes(viewerId) &&
            run.combat.players.some((player) => player.id === viewerId && player.relics.some((relic) => relic.defId === 'the_courier'))}
          mutationsEnabled={!run.courier.offer}
          onChange={updateCombat}
        /></div><CourierPanel players={run.combat.players} viewerId={viewerId} ascension={run.ascension} usedBy={run.courier.usedBy} offer={run.courier.offer} onReveal={(kind) => setRun((current) => revealCourier(current, viewerId, kind))} onResolve={(decision, payments = {}, discardPotionId) => setRun((current) => decideCourier(current, current.courier.offer?.playerId ?? viewerId, decision, payments, discardPotionId))} /></>
      ) : null}
      {!allocatingCampaignMarks && run.phase !== 'combat' && run.phase !== 'defeat' && run.phase !== 'neow' &&
      !victoryIsTerminal(run, run.campaignProgress) && !pendingAcquisition ? (
        <OutsidePotionBar players={run.players} viewerId={viewerId}
          potionLimit={run.ascension >= 4 ? 2 : 3}
          onTrade={(potionId, playerId) => setRun((current) => tradePotion(current, viewerId, playerId, potionId))}
          onUse={(potionId, replacePotionId) => setRun((current) =>
            usePotionOutsideCombat(current, viewerId, potionId, replacePotionId))} />
      ) : null}
      {pendingPreview ? <RelicResolvePanel key={pendingPreview.relicId}
        pending={pendingPreview}
        deck={viewer?.deck ?? []} onResolve={(cardUids, rewardIndices) => setRun((current) =>
          resolvePendingRelic(current, viewerId, cardUids, rewardIndices))} /> : null}
      {run.phase !== 'neow' && pendingOwner && pendingRelic && pendingOwner.id !== viewerId ? <section className="room-screen" role="status">
        Waiting for {pendingOwner.name} to resolve {relicDef(pendingRelic.defId).name}.
        <button type="button" onClick={() => setViewerId(pendingOwner.id)}>Switch to {pendingOwner.name}</button>
      </section> : null}

      {!allocatingCampaignMarks && run.phase === 'neow' && run.neow ? <NeowScreen
        players={run.players}
        progress={Object.fromEntries(Object.keys(run.neow.players).map((id) => [id, neowPreview(run, id)]))}
        viewerId={viewerId}
        potionLimit={run.ascension >= 4 ? 2 : 3}
        enabled={!pendingAcquisition}
        disabledMessage={pendingOwner && pendingRelic
          ? `Waiting for ${pendingOwner.name} to resolve ${relicDef(pendingRelic.defId).name}.`
          : undefined}
        onViewer={setViewerId}
        onGold={(playerId, gain) => setRun((current) => resolveNeowGold(current, playerId, gain))}
        onReveal={(playerId, _stage, sources) => setRun((current) => revealNeowReward(current, playerId, sources))}
        onReward={(playerId, choice) => setRun((current) => resolveNeowReward(current, playerId, choice))}
        onEffect={(playerId, gain, decision) => setRun((current) => resolveNeowEffect(current, playerId, gain, decision))}
        onChoose={(playerId, optionIndex, decision) => setRun((current) => chooseNeow(current, playerId, optionIndex, decision))}
        onArmCardGain={morph.armGain}
      /> : null}

      {!allocatingCampaignMarks && run.phase === 'setup' && run.setup && !pendingAcquisition ? <QuickSetupScreen
        setup={run.setup}
        players={run.players}
        currentStep={currentQuickSetupStep(run.setup)}
        onAdvance={(cardUids) => setRun((current) => advanceQuickSetup(current, cardUids))}
      /> : null}

      {!allocatingCampaignMarks && run.phase === 'map' ? (
        <>
          <MapScreen map={seenMap} choices={pendingAcquisition ? [] : roomChoices({ ...run, map: seenMap })} blocked={pendingAcquisition}
            bossDefId={run.actBossDefId}
            onEnter={(roomId) => setRun((current) => enterRoom(current, roomId))} />
          {!pendingAcquisition && wingChoices.length > 0 ? <section className="room-screen map-prompt">
            <strong>Wing Boots</strong>
            {wingChoices.map((room) => <button type="button" key={room.id}
              onClick={() => setRun((current) => enterRoom(current, room.id, viewerId))}>
              {wingBootLabel(room, wingChoices, seenMap)}
            </button>)}
          </section> : null}
        </>
      ) : null}

      {!pendingAcquisition && canSwitchRowsHere &&
      run.players.filter((player) => !player.dead).length > 1 ? <section className="map-row-switch">
        <strong>Switch rows before the next combat</strong>
        {run.players.filter((player) => !player.dead).map((player) => <label key={player.id}>{player.name}
          <select value={player.row} onChange={(event) => setRun((current) =>
            switchBetweenCombatRow(current, player.id, Number(event.target.value)))}>
            {run.players.map((_seat, row) => <option value={row} key={row}>Row {row + 1}</option>)}
          </select>
        </label>)}
      </section> : null}

      {!allocatingCampaignMarks && run.phase === 'reward' && !pendingAcquisition ? (
        <RewardScreen
          players={run.players}
          rewards={run.rewards}
          onReveal={(playerId, sources) => setRun((current) => revealCardReward(current, playerId, sources))}
          onRevealPotion={(playerId) => setRun((current) => revealPotionReward(current, playerId))}
          onPotion={(playerId, decision) => setRun((current) => resolvePotionReward(current, playerId, decision))}
          onRelic={(playerId, choice) => setRun((current) => choice === 'reveal'
            ? revealRelicReward(current, playerId) : resolveRelicReward(current, playerId, choice === 'gain'))}
          onBossRelic={(playerId, relicId) => setRun((current) => resolveBossRelicReward(current, playerId, relicId))}
          onTransform={(playerId, cardUid) => setRun((current) => resolveTransformReward(current, playerId, cardUid))}
          onResolve={(decisions) => setRun((current) => resolveCardRewards(current, decisions))}
          potionLimit={run.ascension >= 4 ? 2 : 3}
        />
      ) : null}

      {!allocatingCampaignMarks && run.phase === 'betweenCombat' ? (
        <section className="room-screen between-combat">
          <h2>Another boss approaches</h2>
          <p className="muted">Switch rows now. Relics and once-per-combat effects reset for the next fight.</p>
          {run.players.filter((player) => !player.dead).map((player) => (
            <label key={player.id}>{player.name}
              <select value={player.row} onChange={(event) => setRun((current) =>
                switchBetweenCombatRow(current, player.id, Number(event.target.value)))}>
                {run.players.map((_seat, row) => <option value={row} key={row}>Row {row + 1}</option>)}
              </select>
            </label>
          ))}
          <button type="button" disabled={pendingAcquisition}
            onClick={() => setRun((current) => startPendingBoss(current))}>Face the next boss</button>
        </section>
      ) : null}

      {!allocatingCampaignMarks && !pendingAcquisition && run.phase === 'room'
        && roomKind === 'campfire' && !run.roomState ? (
        <CampfireScreen
          players={run.players}
          rubyAvailable={isActIVUnlocked(run.campaignProgress) && !run.campaign.keys.ruby}
          restAllowed={!run.meta.modifierIds.includes('night_terrors')}
          onResolve={(choices) => setRun((current) => resolveCampfire(current, choices))}
        />
      ) : null}

      {!allocatingCampaignMarks && !pendingAcquisition && run.phase === 'room' && run.roomState ? (
        <RoomScreen
          room={run.roomState}
          players={run.players}
          viewerId={viewerId}
          ascension={run.ascension}
          onPurchase={(purchase) => setRun((current) => purchaseAtMerchant(current, purchase))}
          onRemove={(playerId, cardUid, payments) => setRun((current) => removeAtCurrentMerchant(current, playerId, cardUid, payments))}
          onFinishMerchant={() => setRun((current) => finishMerchant(current))}
          onRelic={(playerId, decision) => setRun((current) => chooseRelicReward(current, playerId, decision))}
          onEvent={(playerId, decision) => setRun((current) => chooseEvent(current, playerId, decision))}
          eventCanSkip={canSkipEvent(run, viewerId)}
          unavailableEventOptionIds={unavailableEventOptionIds(run, viewerId)}
          onSkipEvent={(playerId) => setRun((current) => skipEvent(current, playerId))}
          sapphireAvailable={isActIVUnlocked(run.campaignProgress) && !run.campaign.keys.sapphire}
          eventForwardRooms={Object.values(seenMap.rooms).filter((room) => room.row > (run.map.position ? run.map.rooms[run.map.position]?.row ?? -1 : -1)).map((room) => ({ id: room.id, label: `Floor ${room.row + 1} · ${room.hidden ? 'Unknown' : ROOM_LABEL[room.kind]}` }))}
          onArmCardGain={morph.armGain}
        />
      ) : null}

      {!allocatingCampaignMarks && !pendingAcquisition && run.phase === 'room' && roomKind !== 'campfire' && !run.roomState ? (
        <section className="room-screen">
          <h2>{roomKind ?? 'room'}</h2>
          <button type="button" onClick={() => setRun((current) => leaveRoom(current))}>
            Back to the map
          </button>
        </section>
      ) : null}

      {!allocatingCampaignMarks && run.phase === 'victory' && !run.campaign.finalized ? (
        <section className="room-screen">
          <h2>{run.act >= 4 ? 'The Spire is conquered' : `Act ${run.act} complete`}</h2>
          <RunSummary act={run.act} roomsCleared={roomsCleared}
            ascension={run.ascension} seats={run.players.map(summarySeat)} />
          {run.lastStand && run.players.some((player) => player.dead) && run.act < 4 ? (
            <p role="status">Last Stand won the Act, but a fallen hero means the party cannot continue to the next Act.</p>
          ) : null}
          {!(run.lastStand && run.players.some((player) => player.dead)) &&
          (run.act < 3 || canEnterActIV(run.campaignProgress, run.campaign.keys, run.act)) ? <button type="button" disabled={pendingAcquisition}
            onClick={() => setRun((current) => advanceAct(current))}>
            Climb to Act {run.act + 1}
          </button> : null}
          <button type="button" disabled={pendingAcquisition}
            onClick={() => setRun((current) => finishRun(current))}>Stop and record result</button>
        </section>
      ) : null}

      {!allocatingCampaignMarks && run.phase === 'defeat' && !run.campaign.finalized ? (
        <section className="room-screen">
          <h2 className="room-screen__defeat">The party has fallen</h2>
          <RunSummary act={run.act} roomsCleared={roomsCleared}
            ascension={run.ascension} seats={run.players.map(summarySeat)} />
          {!run.campaign.finalized ? <button type="button" onClick={() => setRun((current) => finishRun(current))}>Record campaign result</button> : null}
        </section>
      ) : null}

      {allocatingCampaignMarks ? <section className="campaign-end"><span>Campaign journal</span><h2>Marks earned</h2><p>{run.campaignProgress.unspentMarks} shared mark{run.campaignProgress.unspentMarks === 1 ? '' : 's'} remain. Assign each to Colorless or Act IV.</p><div>{run.campaignProgress.unspentMarks > 0 && run.campaignProgress.colorless < 3 ? <button type="button" onClick={() => allocateCampaignMark(1, 0)}>Mark Colorless · {run.campaignProgress.colorless}/3</button> : null}{run.campaignProgress.unspentMarks > 0 && run.campaignProgress.actIV < 5 ? <button type="button" onClick={() => allocateCampaignMark(0, 1)}>Mark Act IV · {run.campaignProgress.actIV}/5</button> : null}{run.campaign.finalized && run.campaignProgress.unspentMarks === 0 ? <button type="button" onClick={() => { setSeedText(crypto.randomUUID()); setChoosingNextCharacter(true); onClose() }}>Begin next run →</button> : null}</div></section> : null}

      {/* Not on Neow: it is a full-bleed painted scene with seat cards in the
          bottom-left and Skip keys in the bottom-right, so the fixed log tab
          covers content in either corner and there is no scroller to move it
          clear. The log is supplementary and is on every other screen. */}
      {run.phase !== 'combat' && run.phase !== 'neow' ? <details className="log">
        <summary>Run log</summary>
        {run.log.slice(-6).map((line, i) => <p key={`${i}-${line}`}>{line}</p>)}
      </details> : null}
      {morph.current ? <CardMorph request={morph.current} onDone={morph.dismiss} /> : null}
      {/* `aria-live` rather than `role="status"`: the run already has status
          regions ("Choice locked. Waiting for the party…"), and a second one
          would both compete with them and make `getByRole('status')` ambiguous
          for the suites. A bare live region announces without claiming a role.
          Rendered always, empty when idle, because a live region has to exist
          before its text changes for the change to be announced. */}
      <CardMorphAnnouncement request={morph.current} name={(card) => faceOf(cardDef(card.defId), card.upgraded).name} />
    </main>
    {compendium ? <CompendiumScreen onBack={() => {
      setCompendium(false)
      requestAnimationFrame(() => runShell.current?.focus())
    }} backLabel="Back to run" /> : null}
    </>
  )
}
