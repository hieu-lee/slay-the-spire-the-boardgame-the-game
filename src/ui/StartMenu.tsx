import { useEffect, useRef, useState } from 'react'
import { assetPath, isPreloadedImageDecoded, preloadImages, releasePreloadedImages } from '../game/assets.ts'
import type { DailyModifier, DailyModifierId, RunMode } from '../game/meta.ts'
import { relicDef, STARTING_RELIC } from '../game/relics.ts'
import { ASCENSION_RULES } from '../game/run.ts'
import { DAILY_ASCENSION } from '../game/daily.ts'
import { visualId } from '../game/skins.ts'
import { preferredSkin } from '../skin-preference.ts'
import type { CharacterId, ReleasedCharacterId } from '../game/types.ts'
import { CampaignSelect } from './CampaignSelect.tsx'
import { MailBox } from './MailBox.tsx'
import { MetaRunOptions } from './MetaRunOptions.tsx'
import { MAX_RUN_LOG_BYTES, parseRunLog, type RunLog } from './run-log.ts'
import { SettingsDialog } from './SettingsDialog.tsx'
import type { GameSettings } from './game-settings.ts'
import { CoinAmount } from './Coins.tsx'
import { useWallet } from './useWallet.ts'

const SINGLE_PLAYER_ONLY = import.meta.env.VITE_SINGLE_PLAYER === 'true'

type StartMenuProps = {
  characters: readonly CharacterId[]
  ascension: number
  maxAscension: number
  mode: RunMode
  dailyModifiers: readonly DailyModifier[]
  customModifierIds: readonly DailyModifierId[]
  quickStartAct: 1 | 2 | 3 | 4
  actIVUnlocked: boolean
  /** Embark found a new UTC day; today's seed is ready once the player confirms again. */
  dailyTurned?: boolean
  onCharacter: (seat: number, character: CharacterId) => void
  onAscension: (ascension: number) => void
  onMode: (mode: RunMode) => void
  onCustomModifier: (id: DailyModifierId, enabled: boolean) => void
  onQuickStartAct: (act: 1 | 2 | 3 | 4) => void
  onStart: (campaign: 'base' | 'downfall') => void
  /** Starts the guided tutorial run for the selected hero. */
  onTutorial: () => void
  onResume?: () => void
  onOnline?: () => void
  onLeaderboard: () => void
  onStats: () => void
  onProfile: () => void
  onCompendium: () => void
  onShop: () => void
  onReplay: (log: RunLog) => void
  onCharacterBack: () => void
  settings: GameSettings
  onSettings: (settings: GameSettings) => void
  initiallyChoosingCharacter?: boolean
}

const HEROES: { id: ReleasedCharacterId; name: string }[] = [
  { id: 'ironclad', name: 'Ironclad' },
  { id: 'silent', name: 'Silent' },
  { id: 'defect', name: 'Defect' },
  { id: 'watcher', name: 'Watcher' },
  { id: 'slime_boss', name: 'Slime Boss' },
  { id: 'guardian', name: 'Guardian' },
  { id: 'hexaghost', name: 'Hexaghost' },
  { id: 'hermit', name: 'Hermit' },
]

/** Character-select art follows the skin this account chose for the hero (Profile). */
const heroArt = (character: CharacterId) => visualId(character, preferredSkin(character))
const wallpaperOf = (character: CharacterId) => `menu/character-select/character-${heroArt(character)}-wallpaper.webp`
const characterWallpapers = () => HEROES.map(({ id }) => wallpaperOf(id))
const CAMPAIGN_ART = ['menu/campaign-standard-menu.webp', 'menu/campaign-downfall-menu.webp']

function warmRunSetup(character: CharacterId): Promise<void> {
  const selectedWallpaper = wallpaperOf(character)
  // Campaign art is the next screen's largest payload. Alternate character
  // art begins on its roster button's hover/focus, so it cannot be starved
  // behind a speculative low-priority request if the player picks it.
  void preloadImages(CAMPAIGN_ART, { decode: true, fetchPriority: 'high' })
  return preloadImages([selectedWallpaper], { decode: true, fetchPriority: 'high' })
}

function CharacterWallpaper({ character, transition }: { character: CharacterId; transition: boolean }) {
  const image = useRef<HTMLImageElement>(null)
  const [decoded, setDecoded] = useState(false)
  useEffect(() => {
    let active = true
    const element = image.current
    if (!element) return undefined
    void element.decode().then(
      () => { if (active) setDecoded(true) },
      () => { if (active) setDecoded(true) },
    )
    return () => { active = false }
  }, [])
  const animation = decoded ? `start-menu__character-wallpaper--${transition ? 'a' : 'b'}` : ''
  return <img ref={image} data-decoded={decoded || undefined} className={`start-menu__character-wallpaper ${animation}`}
    src={assetPath(wallpaperOf(character))} alt="" aria-hidden="true" />
}

const RUN_MODES: { id: RunMode; name: string; copy: string }[] = [
  { id: 'standard', name: 'Standard', copy: 'Embark on a quest to Slay the Spire!' },
  { id: 'daily', name: 'Daily', copy: 'A new challenge is available once a day. Compete for the highest score!' },
  { id: 'custom', name: 'Custom', copy: 'Customize your own run with unique modifiers.' },
]

const HERO_COPY: Record<ReleasedCharacterId, string> = {
  ironclad: 'The sole survivor of the Ironclads sold his soul for demonic power. He starts with the most HP, builds Strength to empower every hit, and turns Exhaust into fuel for devastating attacks.',
  silent: 'A deadly huntress from the foglands who eradicates foes with daggers and poison. She can stack lasting Poison or gather Shivs for explosive turns, rewarding patience and careful preparation.',
  defect: 'An ancient combat automaton that became self-aware and learned to manipulate Orbs. Channel Lightning, Frost, and Dark, then Evoke them at the right moment to turn stored power into victory.',
  watcher: 'A blind ascetic who came to evaluate the Spire and mastered its divine Stances. Shift between Calm and Wrath to control risk, use Miracles for extra Energy, and Scry toward the perfect turn.',
  slime_boss: 'A many-bodied monarch who commands a growing gang of Slimes. Split, combine, and direct the right Slime for each turn while keeping the whole horde alive.',
  guardian: 'An ancient construct that alternates between offense and defense. Socket Gems into cards, build Vigor, and shift modes to turn careful setup into a crushing counterattack.',
  hexaghost: 'A restless spirit bound to six flames. Advance and Retract the Heat track, gather Soulburn, and time its strongest effects for the hottest moments of the fight.',
  hermit: 'A lone gunslinger haunted by the Spire. Load cards into the Chamber, line up Dead On attacks, and unleash carefully prepared shots when the moment is right.',
}

export function StartMenu({
  characters,
  ascension,
  maxAscension,
  mode,
  dailyModifiers,
  customModifierIds,
  quickStartAct,
  actIVUnlocked,
  dailyTurned = false,
  onCharacter,
  onAscension,
  onMode,
  onCustomModifier,
  onQuickStartAct,
  onStart,
  onTutorial,
  onResume,
  onOnline,
  onLeaderboard,
  onStats,
  onProfile,
  onCompendium,
  onShop,
  onReplay,
  onCharacterBack,
  settings,
  onSettings,
  initiallyChoosingCharacter = false,
}: StartMenuProps) {
  const hero = HEROES.find((candidate) => candidate.id === characters[0]) ?? HEROES[0]!
  const wallet = useWallet()
  const [screen, setScreen] = useState<'main' | 'mode' | 'daily' | 'custom' | 'character' | 'campaign' | 'replay'>(initiallyChoosingCharacter ? 'character' : 'main')
  const [characterTransition, setCharacterTransition] = useState(false)
  // The tutorial reuses the Single Player character picker without Ascension.
  const [tutorialSetup, setTutorialSetup] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [embarking, setEmbarking] = useState(false)
  const [preparingCharacter, setPreparingCharacter] = useState(() =>
    initiallyChoosingCharacter && !isPreloadedImageDecoded(wallpaperOf(hero.id)))
  const campaignLoad = useRef(0)
  const characterLoad = useRef(0)
  const characterButtons = useRef(new Map<CharacterId, HTMLButtonElement>())
  const loadingBack = useRef<HTMLButtonElement>(null)
  const hoveredWallpaper = useRef<string | null>(null)
  const mainMenuButton = useRef<HTMLButtonElement>(null)
  const replayFile = useRef<HTMLInputElement>(null)
  const invalidReplayTimer = useRef<number | undefined>(undefined)
  const replayStartTimer = useRef<number | undefined>(undefined)
  const replayRequest = useRef(0)
  const [replayPrompt, setReplayPrompt] = useState('Give your run to me')
  const [replayDragging, setReplayDragging] = useState(false)
  const [replayTransition, setReplayTransition] = useState(false)
  // A Daily Climb always uses the base campaign at a fixed Ascension.
  const daily = mode === 'daily' && !tutorialSetup
  const shownAscension = daily ? DAILY_ASCENSION : ascension
  const startingRelic = STARTING_RELIC[hero.id]
  const special = startingRelic ? relicDef(startingRelic) : null
  useEffect(() => {
    if (screen === 'main' || screen === 'campaign' || screen === 'replay') return
    // Run setup gives these assets time to load before character selection.
    // Decode only the displayed wallpaper and campaign pair: decoding every
    // full-screen wallpaper would pressure small-device GPU memory.
    void warmRunSetup(hero.id)
  }, [hero.id, screen])
  useEffect(() => {
    if (screen !== 'character' || !preparingCharacter) return
    let active = true
    void warmRunSetup(hero.id).then(() => {
      if (!active) return
      setPreparingCharacter(false)
      requestAnimationFrame(() => characterButtons.current.get(hero.id)?.focus())
    })
    return () => { active = false }
  }, [hero.id, preparingCharacter, screen])
  useEffect(() => {
    if (screen === 'character' && preparingCharacter) loadingBack.current?.focus()
  }, [preparingCharacter, screen])
  useEffect(() => () => {
    replayRequest.current += 1
    campaignLoad.current += 1
    clearTimeout(invalidReplayTimer.current)
    clearTimeout(replayStartTimer.current)
    releasePreloadedImages([...characterWallpapers(), ...CAMPAIGN_ART])
  }, [])
  const returnToMain = () => {
    replayRequest.current += 1
    campaignLoad.current += 1
    characterLoad.current += 1
    setEmbarking(false)
    setPreparingCharacter(false)
    setTutorialSetup(false)
    clearTimeout(invalidReplayTimer.current)
    clearTimeout(replayStartTimer.current)
    setReplayPrompt('Give your run to me')
    setReplayDragging(false)
    setReplayTransition(false)
    releasePreloadedImages([...characterWallpapers(), ...CAMPAIGN_ART])
    setScreen('main')
    requestAnimationFrame(() => mainMenuButton.current?.focus())
  }
  const startCampaign = () => {
    const load = ++campaignLoad.current
    setEmbarking(true)
    void preloadImages(CAMPAIGN_ART, { decode: true, fetchPriority: 'high' }).then(() => {
      if (campaignLoad.current !== load) return
      // Keep the active hero ready for the campaign selector's Back action;
      // alternate wallpapers are no longer a likely next asset.
      releasePreloadedImages(characterWallpapers().filter((path) =>
        path !== wallpaperOf(hero.id)))
      setScreen('campaign')
    })
  }
  const startCharacterSelection = () => {
    const load = ++characterLoad.current
    setPreparingCharacter(true)
    void warmRunSetup(hero.id).then(() => {
      if (characterLoad.current !== load) return
      setPreparingCharacter(false)
      setScreen('character')
      requestAnimationFrame(() => characterButtons.current.get(hero.id)?.focus())
    })
  }
  const warmRosterWallpaper = (character: CharacterId, decode = false) => {
    const path = wallpaperOf(character)
    const selectedPath = wallpaperOf(hero.id)
    const previous = hoveredWallpaper.current
    if (previous && previous !== selectedPath && previous !== path) releasePreloadedImages([previous])
    hoveredWallpaper.current = path
    return preloadImages([path], { decode, fetchPriority: 'high' })
  }
  const selectCharacter = (character: CharacterId) => {
    if (character === hero.id) return
    const load = ++characterLoad.current
    const previousWallpaper = wallpaperOf(hero.id)
    setPreparingCharacter(true)
    void warmRosterWallpaper(character, true).then(() => {
      if (characterLoad.current !== load) return
      setCharacterTransition((current) => !current)
      onCharacter(0, character)
      releasePreloadedImages([previousWallpaper])
      setPreparingCharacter(false)
      requestAnimationFrame(() => characterButtons.current.get(character)?.focus())
    })
  }
  const invalidReplay = () => {
    clearTimeout(invalidReplayTimer.current)
    setReplayPrompt('Your run is invalid')
    invalidReplayTimer.current = window.setTimeout(() => setReplayPrompt('Give your run to me'), 3_000)
  }
  const acceptReplay = async (files: File[]) => {
    const request = ++replayRequest.current
    const file = files[0]
    if (files.length !== 1 || !file?.name.toLowerCase().endsWith('.json') || file.size > MAX_RUN_LOG_BYTES) return invalidReplay()
    let log: RunLog | null = null
    try { log = parseRunLog(await file.text()) } catch { /* Invalid file. */ }
    if (request !== replayRequest.current) return
    if (!log) return invalidReplay()
    clearTimeout(invalidReplayTimer.current)
    setReplayPrompt('Your run is accepted')
    setReplayTransition(true)
    replayStartTimer.current = window.setTimeout(() => onReplay(log), 900)
  }
  const dropReplay = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    setReplayDragging(false)
    return acceptReplay([...event.dataTransfer.files])
  }
  if (screen === 'campaign') return <CampaignSelect onChoose={onStart} onBack={() => {
    campaignLoad.current += 1
    setEmbarking(false)
    setScreen('character')
    requestAnimationFrame(() => characterButtons.current.get(hero.id)?.focus())
  }} />
  return (
    <main className="start-menu" data-reduced-motion={settings.reducedMotion || undefined}>
      {screen === 'main' ? <div className="start-menu__profile" aria-label="Current profile">
        <span className="start-menu__profile-mark" aria-hidden="true">◆</span>
        <span><strong>THE PARTY</strong><small>Board Game Chronicle</small></span>
      </div> : null}
      {screen === 'main' ? <div className="start-menu__corner">
        <button type="button" className="start-menu__purse"
          aria-label={`Shop · ${wallet.coins} ${wallet.coins === 1 ? 'coin' : 'coins'}`} title="Your coins · open the Shop" onClick={onShop}>
          <CoinAmount coins={wallet.coins} size={30} />
        </button>
        <button type="button" className="start-menu__icon" aria-label="Leaderboard" title="Leaderboard" onClick={onLeaderboard}>
          <img src={assetPath('menu/leaderboard-trophy.png')} alt="" />
        </button>
        <button type="button" className="start-menu__icon" aria-label="Stats" title="Stats" onClick={onStats}>
          <img src={assetPath('menu/stats-ledger.png')} alt="" />
        </button>
        {!SINGLE_PLAYER_ONLY ? <MailBox /> : null}
        <button type="button" className="start-menu__icon" aria-label="Profile" title="Profile" onClick={onProfile}>
          <img src={assetPath('menu/profile-medallion.png')} alt="" />
        </button>
        <button type="button" className="start-menu__icon" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
          <img src={assetPath('menu/settings-cog.png')} alt="" />
        </button>
      </div> : null}

      {screen === 'main' ? <div className="start-menu__landing">
        <section className="start-menu__title" aria-labelledby="game-title">
          <h1 id="game-title"><img src={assetPath('menu/title-logo.webp')} width="530" height="368" alt="Slay the Spire" /><span className="start-menu__title-flame" aria-hidden="true" /></h1>
        </section>
        <nav className="start-menu__nav" aria-label="Main menu">
        {onResume ? <button type="button" aria-label="Resume"
          onClick={onResume}>Resume</button> : null}
        <button type="button" aria-label="Single Player"
          ref={mainMenuButton} onClick={() => { warmRunSetup(hero.id); setTutorialSetup(false); setScreen('mode') }}>Single Player</button>
        <button type="button" aria-label="Tutorial"
          onClick={() => { setTutorialSetup(true); startCharacterSelection() }}>Tutorial</button>
        {!SINGLE_PLAYER_ONLY && onOnline ? <button type="button" aria-label="Play online" onClick={onOnline}>Multiplayer</button>
          : null}
        <button type="button" aria-label="Replay"
          onClick={() => setScreen('replay')}>Replay</button>
        <button type="button" aria-label="Compendium" onClick={onCompendium}>Compendium</button>
        <button type="button" aria-label="Shop" onClick={onShop}>Shop</button>
        </nav>
      </div> : null}

      {screen === 'mode' ? <section className="start-menu__mode-select" aria-label="Run modes">
        <div className="start-menu__mode-choices">
          {RUN_MODES.map((choice) => <button type="button" key={choice.id} aria-label={choice.name} className="start-menu__mode-choice" data-mode={choice.id}
            disabled={preparingCharacter} onClick={() => {
              onMode(choice.id)
              if (choice.id === 'standard') startCharacterSelection()
              else setScreen(choice.id)
            }}>
            <h2>{choice.name}</h2>
            <img src={assetPath(`menu/run-modes/mode-${choice.id}.webp`)} alt="" />
            <span>{choice.copy}</span>
          </button>)}
        </div>
        {preparingCharacter ? <p className="start-menu__mode-loading" role="status">Preparing character artwork…</p> : null}
        <button type="button" className="start-menu__screen-back ribbon-back" aria-label="Back" onClick={returnToMain}><span aria-hidden="true"></span></button>
      </section> : null}

      {screen === 'replay' ? <section className="run-replay-import" data-dragging={replayDragging || undefined}
        data-transitioning={replayTransition || undefined}
        onDragEnter={(event) => { event.preventDefault(); if (!replayTransition) setReplayDragging(true) }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setReplayDragging(false) }}
        onDrop={(event) => { event.preventDefault(); if (!replayTransition) void dropReplay(event) }}>
        <p key={replayPrompt} className="run-replay-import__prompt" aria-live="polite">{replayPrompt}</p>
        <span className="run-replay-import__hint">Drag one run log JSON anywhere onto this screen</span>
        <input ref={replayFile} className="run-replay-import__file" type="file" accept=".json,application/json"
          disabled={replayTransition} onChange={(event) => {
            const input = event.currentTarget
            void acceptReplay([...(input.files ?? [])]).finally(() => { input.value = '' })
          }} />
        <button type="button" className="run-replay-import__upload" disabled={replayTransition}
          onClick={() => replayFile.current?.click()}>Choose run log</button>
        <button type="button" className="run-replay-import__back ribbon-back" aria-label="Back to main menu"
          disabled={replayTransition} onClick={returnToMain}><span aria-hidden="true"></span></button>
        <span className="run-replay-import__flash" aria-hidden="true"></span>
      </section> : null}

      {screen === 'custom' || screen === 'daily' ? <section className="start-menu__run-options" aria-labelledby="run-options-title">
        <h1 id="run-options-title">{screen === 'daily' ? 'Daily Climb' : 'Customize your run'}</h1>
        <p>{screen === 'daily' ? `Everyone climbs today's shared seed at Ascension ${DAILY_ASCENSION}. Climb as often as you like; your best climb of the day is ranked by floors reached.` : 'Choose modifiers and where your run begins.'}</p>
        <MetaRunOptions
          mode={mode}
          dailyModifiers={dailyModifiers}
          customModifierIds={customModifierIds}
          quickStartAct={quickStartAct}
          actIVUnlocked={actIVUnlocked}
          onModeChange={onMode}
          onCustomModifierChange={onCustomModifier}
          onQuickStartActChange={onQuickStartAct}
          expanded
          showMode={false}
          showStartingAct={screen !== 'daily'}
        />
        <footer>
          <button type="button" className="ribbon-back" aria-label="Back" onClick={() => {
            characterLoad.current += 1
            setPreparingCharacter(false)
            setScreen('mode')
          }}><span aria-hidden="true"></span></button>
          <button type="button" disabled={preparingCharacter} onClick={startCharacterSelection}>Continue</button>
        </footer>
      </section> : null}

      {screen === 'character' && !preparingCharacter ? <section className="start-menu__character-select" aria-labelledby="character-select-title">
        <CharacterWallpaper key={hero.id} character={hero.id} transition={characterTransition} />
        <div className={`start-menu__character-copy start-menu__character-copy--${characterTransition ? 'a' : 'b'}`}>
          <p>{tutorialSetup ? 'Tutorial · Choose your character' : 'Choose your character'}</p>
          <h1 id="character-select-title">{hero.name}</h1>
          <p>{HERO_COPY[hero.id]}</p>
          {special ? <p className="start-menu__character-special"><strong>{special.name}</strong> · {special.text}</p> : null}
          {daily && dailyTurned ? <p className="start-menu__character-special" role="status">A new day has begun. Embark again to climb today's seed.</p> : null}
        </div>
        {!tutorialSetup ? <section className="start-menu__ascension" aria-label="Ascension">
          <button type="button" aria-label="Decrease Ascension" disabled={daily || shownAscension === 0}
            onClick={() => onAscension(ascension - 1)}>‹</button>
          <div>
            <span className="start-menu__ascension-level" aria-hidden="true"><span>{shownAscension}</span></span>
            <p><strong>Ascension {shownAscension}{daily ? ' · Daily Climb' : ''}</strong><span>{ASCENSION_RULES[shownAscension]}</span></p>
          </div>
          <button type="button" aria-label="Increase Ascension" disabled={daily || shownAscension === maxAscension}
            onClick={() => onAscension(ascension + 1)}>›</button>
        </section> : null}
        <div className="start-menu__character-roster" aria-label="Characters">
          {HEROES.map((candidate) => <button type="button" key={candidate.id}
            aria-label={candidate.name} aria-pressed={candidate.id === hero.id}
            disabled={preparingCharacter || embarking} onClick={() => selectCharacter(candidate.id)}
            ref={(element) => {
              if (element) characterButtons.current.set(candidate.id, element)
              else characterButtons.current.delete(candidate.id)
            }}
            onFocus={() => void warmRosterWallpaper(candidate.id)}
            onMouseEnter={() => void warmRosterWallpaper(candidate.id)}>
            <img src={assetPath(`menu/character-select/portrait-${heroArt(candidate.id)}.png`)} alt="" />
          </button>)}
        </div>
        <button type="button" className="start-menu__character-back ribbon-back" aria-label="Back" title="Back"
          onClick={() => { returnToMain(); onCharacterBack() }}><span aria-hidden="true"></span></button>
        {tutorialSetup ? <button type="button" className="start-menu__character-embark" aria-label="Start tutorial" title="Start tutorial"
          disabled={embarking} onClick={() => { setEmbarking(true); onTutorial() }}><span aria-hidden="true">✓</span></button>
          : <button type="button" className="start-menu__character-embark" aria-label="Embark" title="Embark" disabled={embarking}
          aria-busy={embarking || undefined} onClick={daily ? () => onStart('base') : startCampaign}><span aria-hidden="true">✓</span></button>}
      </section> : null}
      {screen === 'character' && preparingCharacter ? <section className="start-menu__character-select start-menu__character-loading"
        aria-label="Preparing character selection" aria-busy="true">
        <p role="status">Preparing character artwork…</p>
        <button type="button" className="start-menu__character-back ribbon-back" aria-label="Back" title="Back"
          ref={loadingBack} onClick={() => { returnToMain(); onCharacterBack() }}><span aria-hidden="true"></span></button>
      </section> : null}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onChange={onSettings} />
      {screen === 'main' ? <p className="start-menu__version">v0.1 · unofficial fan project</p> : null}
    </main>
  )
}
