import { useState } from 'react'
import type { CharacterId } from '../game/types.ts'

type StartMenuProps = {
  playerCount: number
  seed: string
  ascension: number
  onPlayerCount: (count: number) => void
  onSeed: (seed: string) => void
  onAscension: (ascension: number) => void
  onStart: () => void
  onOnline: () => void
  onCompendium: () => void
}

const HEROES: { id: CharacterId; name: string }[] = [
  { id: 'ironclad', name: 'Ironclad' },
  { id: 'silent', name: 'Silent' },
  { id: 'defect', name: 'Defect' },
  { id: 'watcher', name: 'Watcher' },
]

export function StartMenu({
  playerCount,
  seed,
  ascension,
  onPlayerCount,
  onSeed,
  onAscension,
  onStart,
  onOnline,
  onCompendium,
}: StartMenuProps) {
  const [selection, setSelection] = useState('Play')
  return (
    <main className="start-menu">
      <div className="start-menu__profile" aria-label="Current profile">
        <span className="start-menu__profile-mark" aria-hidden="true">◆</span>
        <span><strong>THE PARTY</strong><small>Board Game Chronicle</small></span>
      </div>

      <section className="start-menu__title" aria-labelledby="game-title">
        <p className="start-menu__eyebrow">Contention Games · fan implementation</p>
        <h1 id="game-title"><span>Slay</span><small>the</small><span>Spire</span></h1>
        <p className="start-menu__edition">THE BOARD GAME</p>
      </section>

      <nav className="start-menu__nav" aria-label="Main menu">
        <button type="button" aria-label="Play" data-selected={selection === 'Play'}
          onFocus={() => setSelection('Play')} onMouseEnter={() => setSelection('Play')} onClick={onStart}>Play</button>
        <button type="button" aria-label="Play online" data-selected={selection === 'Multiplayer'}
          onFocus={() => setSelection('Multiplayer')} onMouseEnter={() => setSelection('Multiplayer')} onClick={onOnline}>Multiplayer</button>
        <button type="button" aria-label="Compendium" data-selected={selection === 'Compendium'}
          onFocus={() => setSelection('Compendium')} onMouseEnter={() => setSelection('Compendium')} onClick={onCompendium}>Compendium</button>
      </nav>

      <section className="start-menu__setup" aria-label="Run setup">
        <label>
          Party
          <select aria-label="Players" value={playerCount}
            onChange={(event) => onPlayerCount(Number(event.target.value))}>
            {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label>
          Seed
          <input value={seed} onChange={(event) => onSeed(event.target.value)} />
        </label>
        <label>
          Ascension
          <select value={ascension} onChange={(event) => onAscension(Number(event.target.value))}>
            {Array.from({ length: 14 }, (_, level) => <option key={level}>{level}</option>)}
          </select>
        </label>
      </section>

      <div className="start-menu__party" aria-label={`${playerCount} player party`}>
        {HEROES.slice(0, playerCount).map((hero) => (
          <span key={hero.id} title={hero.name}>
            <img src={`/assets/combat/characters/${hero.id}.webp`} alt="" />
          </span>
        ))}
      </div>
      <p className="start-menu__version">v0.1 · unofficial fan project</p>
    </main>
  )
}
