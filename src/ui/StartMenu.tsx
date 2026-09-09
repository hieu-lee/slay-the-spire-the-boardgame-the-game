import { useEffect, useRef, useState } from 'react'
import { assetPath, isPreloadedImageDecoded, preloadImages, releasePreloadedImages } from '../game/assets.ts'
import type { DailyModifier, DailyModifierId, RunMode } from '../game/meta.ts'
import { relicDef, STARTING_RELIC } from '../game/relics.ts'
import { ASCENSION_RULES } from '../game/run.ts'
import type { CharacterId } from '../game/types.ts'
import { CampaignSelect } from './CampaignSelect.tsx'
import { MetaRunOptions } from './MetaRunOptions.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import type { GameSettings } from './game-settings.ts'

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
  onCharacter: (seat: number, character: CharacterId) => void
  onAscension: (ascension: number) => void
  onMode: (mode: RunMode) => void
  onCustomModifier: (id: DailyModifierId, enabled: boolean) => void
  onQuickStartAct: (act: 1 | 2 | 3 | 4) => void
  onStart: (campaign: 'base' | 'downfall') => void
  onResume?: () => void
  onOnline?: () => void
  onLeaderboard: () => void
  onCompendium: () => void
  onAchievements: () => void
  onCharacterBack: () => void
  settings: GameSettings
  onSettings: (settings: GameSettings) => void
  initiallyChoosingCharacter?: boolean
}

const HEROES: { id: CharacterId; name: string }[] = [
  { id: 'ironclad', name: 'Ironclad' },
  { id: 'silent', name: 'Silent' },
  { id: 'defect', name: 'Defect' },
  { id: 'watcher', name: 'Watcher' },
  { id: 'slime_boss', name: 'Slime Boss' },
  { id: 'guardian', name: 'Guardian' },
  { id: 'hexaghost', name: 'Hexaghost' },
  { id: 'hermit', name: 'Hermit' },
]

const CHARACTER_WALLPAPERS = HEROES.map(({ id }) => `menu/character-select/character-${id}-wallpaper.webp`)
const CAMPAIGN_ART = ['menu/campaign-standard-menu.webp', 'menu/campaign-downfall-menu.webp']

function warmRunSetup(character: CharacterId): Promise<void> {
  const selectedWallpaper = `menu/character-select/character-${character}-wallpaper.webp`
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
    src={assetPath(`menu/character-select/character-${character}-wallpaper.webp`)} alt="" aria-hidden="true" />
}

const RUN_MODES: { id: RunMode; name: string; copy: string }[] = [
  { id: 'standard', name: 'Standard', copy: 'Embark on a quest to Slay the Spire!' },
  { id: 'daily', name: 'Daily', copy: 'A new challenge is available once a day. Compete for the highest score!' },
  { id: 'custom', name: 'Custom', copy: 'Customize your own run with unique modifiers.' },
]

const HERO_COPY: Record<CharacterId, string> = {
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
  onCharacter,
  onAscension,
  onMode,
  onCustomModifier,
  onQuickStartAct,
  onStart,
  onResume,
  onOnline,
  onLeaderboard,
  onCompendium,
  onAchievements,
  onCharacterBack,
  settings,
  onSettings,
  initiallyChoosingCharacter = false,
}: StartMenuProps) {
  const hero = HEROES.find((candidate) => candidate.id === characters[0]) ?? HEROES[0]!
  const [selection, setSelection] = useState(onResume ? 'Resume' : 'Single Player')
  const [screen, setScreen] = useState<'main' | 'mode' | 'daily' | 'custom' | 'character' | 'campaign'>(initiallyChoosingCharacter ? 'character' : 'main')
  const [characterTransition, setCharacterTransition] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [embarking, setEmbarking] = useState(false)
  const [preparingCharacter, setPreparingCharacter] = useState(() =>
    initiallyChoosingCharacter && !isPreloadedImageDecoded(`menu/character-select/character-${hero.id}-wallpaper.webp`))
  const campaignLoad = useRef(0)
  const characterLoad = useRef(0)
  const characterButtons = useRef(new Map<CharacterId, HTMLButtonElement>())
  const loadingBack = useRef<HTMLButtonElement>(null)
  const hoveredWallpaper = useRef<string | null>(null)
  const mainMenuButton = useRef<HTMLButtonElement>(null)
  const startingRelic = STARTING_RELIC[hero.id]
  const special = startingRelic ? relicDef(startingRelic) : null
  useEffect(() => {
    if (screen === 'main' || screen === 'campaign') return
    // Run setup gives these assets time to load before character selection.
    // Decode only the displayed wallpaper and campaign pair: decoding all
    // eight full-screen wallpapers would pressure small-device GPU memory.
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
    campaignLoad.current += 1
    releasePreloadedImages([...CHARACTER_WALLPAPERS, ...CAMPAIGN_ART])
  }, [])
  const returnToMain = () => {
    campaignLoad.current += 1
    characterLoad.current += 1
    setEmbarking(false)
    setPreparingCharacter(false)
    releasePreloadedImages([...CHARACTER_WALLPAPERS, ...CAMPAIGN_ART])
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
      releasePreloadedImages(CHARACTER_WALLPAPERS.filter((path) =>
        path !== `menu/character-select/character-${hero.id}-wallpaper.webp`))
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
    const path = `menu/character-select/character-${character}-wallpaper.webp`
    const selectedPath = `menu/character-select/character-${hero.id}-wallpaper.webp`
    const previous = hoveredWallpaper.current
    if (previous && previous !== selectedPath && previous !== path) releasePreloadedImages([previous])
    hoveredWallpaper.current = path
    return preloadImages([path], { decode, fetchPriority: 'high' })
  }
  const selectCharacter = (character: CharacterId) => {
    if (character === hero.id) return
    const load = ++characterLoad.current
    const previousWallpaper = `menu/character-select/character-${hero.id}-wallpaper.webp`
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

      {screen === 'main' ? <section className="start-menu__title" aria-labelledby="game-title">
        <h1 id="game-title"><span>Slay</span><small>the</small><span aria-label="Spire">Sp<span className="start-menu__flame-i" aria-hidden="true">ı</span>re</span></h1>
        <p className="start-menu__edition">THE BOARD GAME</p>
      </section> : null}

      {screen === 'main' ? <nav className="start-menu__nav" aria-label="Main menu">
        {onResume ? <button type="button" aria-label="Resume" data-selected={selection === 'Resume'}
          onFocus={() => setSelection('Resume')} onMouseEnter={() => setSelection('Resume')}
          onClick={onResume}>Resume</button> : null}
        <button type="button" aria-label="Single Player" data-selected={selection === 'Single Player'}
          onFocus={() => setSelection('Single Player')} onMouseEnter={() => setSelection('Single Player')}
          ref={mainMenuButton} onClick={() => { warmRunSetup(hero.id); setScreen('mode') }}>Single Player</button>
        {!SINGLE_PLAYER_ONLY && onOnline ? <button type="button" aria-label="Play online" data-selected={selection === 'Multiplayer'}
          onFocus={() => setSelection('Multiplayer')} onMouseEnter={() => setSelection('Multiplayer')} onClick={onOnline}>Multiplayer</button>
          : null}
        <button type="button" aria-label="Leaderboard" data-selected={selection === 'Leaderboard'}
          onFocus={() => setSelection('Leaderboard')} onMouseEnter={() => setSelection('Leaderboard')} onClick={onLeaderboard}>Leaderboard</button>
        <button type="button" aria-label="Compendium" data-selected={selection === 'Compendium'}
          onFocus={() => setSelection('Compendium')} onMouseEnter={() => setSelection('Compendium')} onClick={onCompendium}>Compendium</button>
        <button type="button" aria-label="Achievements" data-selected={selection === 'Achievements'}
          onFocus={() => setSelection('Achievements')} onMouseEnter={() => setSelection('Achievements')} onClick={onAchievements}>Achievements</button>
        <button type="button" aria-label="Settings" data-selected={selection === 'Settings'}
          onFocus={() => setSelection('Settings')} onMouseEnter={() => setSelection('Settings')}
          onClick={() => setSettingsOpen(true)}>Settings</button>
      </nav> : null}

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

      {screen === 'custom' || screen === 'daily' ? <section className="start-menu__run-options" aria-labelledby="run-options-title">
        <h1 id="run-options-title">{screen === 'daily' ? 'Daily Climb' : 'Customize your run'}</h1>
        <p>{screen === 'daily' ? "Today's modifiers are fixed for this challenge." : 'Choose modifiers and where your run begins.'}</p>
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
          <p>Choose your character</p>
          <h1 id="character-select-title">{hero.name}</h1>
          <p>{HERO_COPY[hero.id]}</p>
          {special ? <p className="start-menu__character-special"><strong>{special.name}</strong> · {special.text}</p> : null}
        </div>
        <section className="start-menu__ascension" aria-label="Ascension">
          <button type="button" aria-label="Decrease Ascension" disabled={ascension === 0}
            onClick={() => onAscension(ascension - 1)}>‹</button>
          <div>
            <span className="start-menu__ascension-level" aria-hidden="true"><span>{ascension}</span></span>
            <p><strong>Ascension {ascension}</strong><span>{ASCENSION_RULES[ascension]}</span></p>
          </div>
          <button type="button" aria-label="Increase Ascension" disabled={ascension === maxAscension}
            onClick={() => onAscension(ascension + 1)}>›</button>
        </section>
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
            <img src={assetPath(`menu/character-select/portrait-${candidate.id}.png`)} alt="" />
          </button>)}
        </div>
        <button type="button" className="start-menu__character-back ribbon-back" aria-label="Back" title="Back"
          onClick={() => { returnToMain(); onCharacterBack() }}><span aria-hidden="true"></span></button>
        <button type="button" className="start-menu__character-embark" aria-label="Embark" title="Embark" disabled={embarking}
          aria-busy={embarking || undefined} onClick={startCampaign}><span aria-hidden="true">✓</span></button>
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
