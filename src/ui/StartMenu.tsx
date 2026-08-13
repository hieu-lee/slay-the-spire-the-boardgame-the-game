import { useState } from 'react'
import type { CharacterId } from '../game/types.ts'

type StartMenuProps = {
  playerCount: number
  characters: readonly CharacterId[]
  seed: string
  ascension: number
  maxAscension: number
  onPlayerCount: (count: number) => void
  onCharacter: (seat: number, character: CharacterId) => void
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
  characters,
  seed,
  ascension,
  maxAscension,
  onPlayerCount,
  onCharacter,
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
          <select aria-label="Ascension" value={ascension} onChange={(event) => onAscension(Number(event.target.value))}>
            {Array.from({ length: maxAscension + 1 }, (_, level) => <option key={level}>{level}</option>)}
          </select>
        </label>
        <fieldset className="start-menu__party">
          <legend>Characters</legend>
          {characters.slice(0, playerCount).map((character, seat) => {
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
      </section>
      <p className="start-menu__version">v0.1 · unofficial fan project</p>
    </main>
  )
}
