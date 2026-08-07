import { useEffect, useState } from 'react'
import { createCombat, startPlayerTurn } from '../game/combat.ts'
import type { CombatState } from '../game/combat.ts'
import { STARTER_DECKS } from '../game/cards.ts'
import { enemyDef, startingHp } from '../game/enemies.ts'
import { createRng, shuffle, seedFromString } from '../game/rng.ts'
import type { CharacterId, CardInstance, Enemy, Player } from '../game/types.ts'
import { CombatScreen } from './CombatScreen.tsx'

const ROSTER: { character: CharacterId; name: string; maxHp: number }[] = [
  { character: 'ironclad', name: 'Ironclad', maxHp: 10 },
  { character: 'silent', name: 'Silent', maxHp: 9 },
  { character: 'defect', name: 'Defect', maxHp: 9 },
  { character: 'watcher', name: 'Watcher', maxHp: 9 },
]

let uidCounter = 0
const instance = (defId: string): CardInstance => ({
  uid: `c${uidCounter++}`,
  defId,
  upgraded: false,
})

function buildPlayer(index: number, seed: number): Player {
  const entry = ROSTER[index] ?? ROSTER[0]!
  const deck = STARTER_DECKS[entry.character].map(instance)
  return {
    id: `p${index + 1}`,
    name: entry.name,
    character: entry.character,
    row: index,
    hp: entry.maxHp,
    maxHp: entry.maxHp,
    block: 0,
    energy: 3,
    deck,
    draw: shuffle(createRng(seed + index), [...deck]),
    hand: [],
    discard: [],
    exhaust: [],
    powers: [],
    strength: 0,
    shivs: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
    dead: false,
  }
}

function buildEnemy(defId: string, row: number, playerCount: number, n: number): Enemy {
  const def = enemyDef(defId)
  const hp = startingHp(def, playerCount)
  return {
    uid: `e${n}`,
    defId,
    row,
    isBoss: def.isBoss === true,
    hp,
    maxHp: hp,
    block: 0,
    strength: 0,
    vulnerable: 0,
    weak: 0,
    poison: 0,
    actionIndex: 0,
    dead: false,
  }
}

/** One enemy per player row, which is how a normal encounter is laid out (p.10). */
function newCombat(playerCount: number, seedText: string): CombatState {
  uidCounter = 0
  const seed = seedFromString(seedText)
  const players = Array.from({ length: playerCount }, (_, i) => buildPlayer(i, seed))
  const pool = ['cultist', 'jaw_worm', 'red_louse']
  const enemies = players.map((player, i) =>
    buildEnemy(pool[i % pool.length]!, player.row, playerCount, i),
  )
  return startPlayerTurn(createCombat(createRng(seed), players, enemies))
}

export function App() {
  const [playerCount, setPlayerCount] = useState(2)
  const [seedText, setSeedText] = useState('spire')
  const [state, setState] = useState<CombatState>(() => newCombat(2, 'spire'))
  const [viewerId, setViewerId] = useState('p1')

  function restart(count: number, seed: string) {
    setPlayerCount(count)
    setSeedText(seed)
    setViewerId('p1')
    setState(newCombat(count, seed))
  }

  // A debug bridge for the Playwright suite: drive real clicks, assert real
  // state. Screenshots are for review; assertions read from here.
  useEffect(() => {
    const bridge = {
      getState: () => state,
      setState: (next: CombatState) => setState(next),
      // Goes through the same path as the button so the header controls stay in
      // step with the board; a bridge that desynced the UI would make every
      // screenshot a lie.
      reset: (count: number, seed: string) => restart(count, seed),
      setViewer: (id: string) => setViewerId(id),
    }
    ;(window as unknown as { __STS_DEBUG__?: typeof bridge }).__STS_DEBUG__ = bridge
  }, [state])

  return (
    <main className="app-shell">
      <header className="app-shell__header">
        <h1>Slay the Spire</h1>
        <div className="setup">
          <label>
            Players
            <select
              value={playerCount}
              onChange={(event) => restart(Number(event.target.value), seedText)}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
              onBlur={() => restart(playerCount, seedText)}
            />
          </label>
          <label>
            Seat
            <select value={viewerId} onChange={(event) => setViewerId(event.target.value)}>
              {state.players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => restart(playerCount, seedText)}>
            New combat
          </button>
        </div>
      </header>

      <CombatScreen state={state} viewerId={viewerId} onChange={setState} />

      <aside className="log" aria-label="Combat log">
        {state.log.slice(-8).map((line, i) => (
          <p key={`${i}-${line}`}>{line}</p>
        ))}
      </aside>
    </main>
  )
}
