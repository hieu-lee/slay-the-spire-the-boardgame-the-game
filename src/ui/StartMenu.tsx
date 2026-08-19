import { useRef, useState } from 'react'
import type { DailyModifier, DailyModifierId, RunMode } from '../game/meta.ts'
import type { CharacterId } from '../game/types.ts'
import { MetaRunOptions } from './MetaRunOptions.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import type { GameSettings } from './game-settings.ts'

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
  onStart: () => void
  onOnline: () => void
  onCompendium: () => void
  onAchievements: () => void
  settings: GameSettings
  onSettings: (settings: GameSettings) => void
}

const HEROES: { id: CharacterId; name: string }[] = [
  { id: 'ironclad', name: 'Ironclad' },
  { id: 'silent', name: 'Silent' },
  { id: 'defect', name: 'Defect' },
  { id: 'watcher', name: 'Watcher' },
]

const HERO_COPY: Record<CharacterId, string> = {
  ironclad: 'A relentless warrior who trades health for overwhelming strength.',
  silent: 'A precise huntress who turns poison and preparation into lethal turns.',
  defect: 'A combat automaton that channels orbs for power that builds over time.',
  watcher: 'A disciplined ascetic who changes stances to control risk and reward.',
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
  onOnline,
  onCompendium,
  onAchievements,
  settings,
  onSettings,
}: StartMenuProps) {
  const [selection, setSelection] = useState('Single Player')
  const [choosingCharacter, setChoosingCharacter] = useState(false)
  const runSettingsDialog = useRef<HTMLDialogElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const hero = HEROES.find((candidate) => candidate.id === characters[0]) ?? HEROES[0]!
  return (
    <main className="start-menu">
      <div className="start-menu__profile" aria-label="Current profile">
        <span className="start-menu__profile-mark" aria-hidden="true">◆</span>
        <span><strong>THE PARTY</strong><small>Board Game Chronicle</small></span>
      </div>

      {!choosingCharacter ? <section className="start-menu__title" aria-labelledby="game-title">
        <p className="start-menu__eyebrow">Contention Games · fan implementation</p>
        <h1 id="game-title"><span>Slay</span><small>the</small><span>Spire</span></h1>
        <p className="start-menu__edition">THE BOARD GAME</p>
      </section> : null}

      {!choosingCharacter ? <nav className="start-menu__nav" aria-label="Main menu">
        <button type="button" aria-label="Single Player" data-selected={selection === 'Single Player'}
          onFocus={() => setSelection('Single Player')} onMouseEnter={() => setSelection('Single Player')}
          onClick={() => setChoosingCharacter(true)}>Single Player</button>
        <button type="button" aria-label="Play online" data-selected={selection === 'Multiplayer'}
          onFocus={() => setSelection('Multiplayer')} onMouseEnter={() => setSelection('Multiplayer')} onClick={onOnline}>Multiplayer</button>
        <button type="button" aria-label="Compendium" data-selected={selection === 'Compendium'}
          onFocus={() => setSelection('Compendium')} onMouseEnter={() => setSelection('Compendium')} onClick={onCompendium}>Compendium</button>
        <button type="button" aria-label="Achievements" data-selected={selection === 'Achievements'}
          onFocus={() => setSelection('Achievements')} onMouseEnter={() => setSelection('Achievements')} onClick={onAchievements}>Achievements</button>
        <button type="button" aria-label="Settings" data-selected={selection === 'Settings'}
          onFocus={() => setSelection('Settings')} onMouseEnter={() => setSelection('Settings')}
          onClick={() => setSettingsOpen(true)}>Settings</button>
      </nav> : <section className="start-menu__character-select" aria-labelledby="character-select-title">
        <div className="start-menu__character-copy">
          <p>Choose your character</p>
          <h1 id="character-select-title">{hero.name}</h1>
          <p>{HERO_COPY[hero.id]}</p>
          <small>Ascension {ascension}</small>
        </div>
        <img className="start-menu__character-hero" src={`/assets/combat/characters/${hero.id}.webp`} alt={hero.name} />
        <div className="start-menu__character-roster" aria-label="Characters">
          {HEROES.map((candidate) => <button type="button" key={candidate.id}
            aria-label={candidate.name} aria-pressed={candidate.id === hero.id}
            onClick={() => onCharacter(0, candidate.id)}>
            <img src={`/assets/combat/characters/${candidate.id}.webp`} alt="" />
            <span>{candidate.name}</span>
          </button>)}
        </div>
        <div className="start-menu__character-actions">
          <button type="button" onClick={() => setChoosingCharacter(false)}>Back</button>
          <button type="button" onClick={() => runSettingsDialog.current?.showModal()}>Run settings</button>
          <button type="button" className="is-chosen" onClick={onStart}>Embark</button>
        </div>
      </section>}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onChange={onSettings} />
      <dialog ref={runSettingsDialog} className="start-menu__setup" aria-labelledby="start-menu-settings-title">
        <header><h2 id="start-menu-settings-title">Run setup</h2><button type="button" onClick={() => runSettingsDialog.current?.close()}>Close</button></header>
        <label>
          Ascension
          <select aria-label="Ascension" value={ascension} onChange={(event) => onAscension(Number(event.target.value))}>
            {Array.from({ length: maxAscension + 1 }, (_, level) => <option key={level}>{level}</option>)}
          </select>
        </label>
        <MetaRunOptions
          mode={mode}
          dailyModifiers={dailyModifiers}
          customModifierIds={customModifierIds}
          quickStartAct={quickStartAct}
          actIVUnlocked={actIVUnlocked}
          onModeChange={onMode}
          onCustomModifierChange={onCustomModifier}
          onQuickStartActChange={onQuickStartAct}
        />
        <fieldset className="start-menu__party">
          <legend>Characters</legend>
          {characters.slice(0, 1).map((character, seat) => {
            const hero = HEROES.find((candidate) => candidate.id === character) ?? HEROES[0]!
            return <label key={seat} title={`Player ${seat + 1}: ${hero.name}`}>
              <img src={`/assets/combat/characters/${hero.id}.webp`} alt="" />
              <span>P{seat + 1}</span>
              <select aria-label={`Player ${seat + 1} character`} value={character}
                onChange={(event) => onCharacter(seat, event.target.value as CharacterId)}>
                {HEROES.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
          })}
        </fieldset>
      </dialog>
      <p className="start-menu__version">v0.1 · unofficial fan project</p>
    </main>
  )
}
