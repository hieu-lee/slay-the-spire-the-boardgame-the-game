import { useEffect, useState } from 'react'
import type { CombatState } from '../game/combat.ts'
import {
  advanceAct,
  createRun,
  enterRoom,
  leaveRoom,
  resolveCampfire,
  revealCardReward,
  revealItemReward,
  resolveCardReward,
  resolveCombat,
  roomChoices,
  useRunPotion,
  tradeRunPotion,
  startPendingBoss,
  switchBetweenCombatRow,
} from '../game/run.ts'
import type { RunState } from '../game/run.ts'
import { seedFromString } from '../game/rng.ts'
import type { CharacterId } from '../game/types.ts'
import { hasRoomSession } from '../multiplayer/useRoomSession.ts'
import { CombatScreen } from './CombatScreen.tsx'
import { MapScreen } from './MapScreen.tsx'
import { CampfireScreen } from './CampfireScreen.tsx'
import { BetweenCombatScreen } from './BetweenCombatScreen.tsx'
import { RewardScreen } from './RewardScreen.tsx'
import { Icon, IconValue } from './Icon.tsx'
import { OnlineGame } from './OnlineGame.tsx'
import { RunPotionBar } from './RunPotionBar.tsx'
import { StartMenu } from './StartMenu.tsx'
import { CompendiumScreen } from './CompendiumScreen.tsx'

const ROSTER: { character: CharacterId; name: string }[] = [
  { character: 'ironclad', name: 'Ironclad' },
  { character: 'silent', name: 'Silent' },
  { character: 'defect', name: 'Defect' },
  { character: 'watcher', name: 'Watcher' },
]

function newRun(playerCount: number, seedText: string, ascension = 0): RunState {
  const party = ROSTER.slice(0, playerCount).map((entry, index) => ({
    id: `p${index + 1}`,
    name: entry.name,
    character: entry.character,
  }))
  return createRun(seedFromString(seedText), party, ascension)
}

export function App() {
  const [online, setOnline] = useState(hasRoomSession)
  const [localOpen, setLocalOpen] = useState(false)
  return (
    <>
      <div className="game-mode" hidden={online}>
        <LocalGame open={localOpen} onOpen={() => setLocalOpen(true)} onOnline={() => setOnline(true)} />
      </div>
      {online ? <OnlineGame onLocal={() => setOnline(false)} /> : null}
    </>
  )
}

function LocalGame({ open, onOpen, onOnline }: { open: boolean; onOpen: () => void; onOnline: () => void }) {
  const [playerCount, setPlayerCount] = useState(2)
  const [seedText, setSeedText] = useState('spire')
  const [ascension, setAscension] = useState(0)
  const [run, setRun] = useState<RunState>(() => newRun(2, 'spire'))
  const [viewerId, setViewerId] = useState('p1')
  const [compendium, setCompendium] = useState(false)

  /** The settings the run in progress was actually built from. */
  const [built, setBuilt] = useState({ count: 2, seed: 'spire', ascension: 0 })

  function restart(count: number, seed: string, nextAscension = 0) {
    setPlayerCount(count)
    setSeedText(seed)
    setAscension(nextAscension)
    setViewerId('p1')
    setBuilt({ count, seed, ascension: nextAscension })
    setRun(newRun(count, seed, nextAscension))
  }

  /**
   * Starts a new run, but never by accident.
   *
   * The seed field used to restart on BLUR, so any stray click out of it threw
   * away the combat in progress — no change to the value required, no warning.
   * Now it only acts on a real change, and asks first if a run is underway.
   */
  function restartIfWanted(count: number, seed: string, nextAscension: number) {
    if (count === built.count && seed === built.seed && nextAscension === built.ascension) return
    const underway = run.phase !== 'map' || run.map.position !== null
    if (underway && !window.confirm('Start a new run? The one in progress will be lost.')) {
      setPlayerCount(built.count)
      setSeedText(built.seed)
      setAscension(built.ascension)
      return
    }
    restart(count, seed, nextAscension)
  }

  // A debug bridge for the Playwright suite: drive real clicks, assert real
  // state. Screenshots are for review; assertions read from here.
  useEffect(() => {
    const bridge = {
      getRun: () => run,
      /** The combat state, or null outside a fight. */
      getState: () => run.combat,
      setRun: (next: RunState) => setRun(next),
      reset: (count: number, seed: string, nextAscension = 0) => restart(count, seed, nextAscension),
      setViewer: (id: string) => setViewerId(id),
    }
    ;(window as unknown as { __STS_DEBUG__?: typeof bridge }).__STS_DEBUG__ = bridge
  }, [run])

  // A finished combat folds back into the run on its own; the player should not
  // have to click through a screen that only says "you won".
  useEffect(() => {
    if (run.combat && (run.combat.phase === 'won' || run.combat.phase === 'lost')) {
      const timer = setTimeout(() => setRun((current) => resolveCombat(current)), 900)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [run.combat])

  const viewer = run.players.find((player) => player.id === viewerId) ?? run.players[0]
  const roomKind = run.map.position ? run.map.rooms[run.map.position]?.kind : undefined

  if (!open) {
    if (compendium) return <CompendiumScreen onBack={() => setCompendium(false)} />
    return <StartMenu
      playerCount={playerCount}
      seed={seedText}
      ascension={ascension}
      onPlayerCount={setPlayerCount}
      onSeed={setSeedText}
      onAscension={setAscension}
      onStart={() => { restart(playerCount, seedText, ascension); onOpen() }}
      onOnline={onOnline}
      onCompendium={() => setCompendium(true)}
    />
  }

  return (
    <main className="app-shell">
      <header className="app-shell__header">
        <h1>Slay the Spire</h1>
        <div className="run-status">
          <span className="pip">Act {run.act}</span>
          {run.ascension > 0 ? <span className="pip">Ascension {run.ascension}</span> : null}
          {viewer ? (
            <>
              <span className="pip" title="Gold">
                <IconValue name="gold" value={viewer.gold} size={20} />
              </span>
              {viewer.relics.map((relic) => (
                <span className="pip" key={relic.defId} title={relic.defId}>
                  <Icon name="relic" size={20} />
                </span>
              ))}
            </>
          ) : null}
        </div>
        <div className="setup">
          <label>
            Players
            <select
              value={playerCount}
              onChange={(event) => restartIfWanted(Number(event.target.value), seedText, ascension)}
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
              onBlur={() => restartIfWanted(playerCount, seedText, ascension)}
            />
          </label>
          <label>
            Ascension
            <select value={ascension}
              onChange={(event) => restartIfWanted(playerCount, seedText, Number(event.target.value))}>
              {Array.from({ length: 14 }, (_, level) => <option key={level}>{level}</option>)}
            </select>
          </label>
          <label>
            Seat
            <select value={viewerId} onChange={(event) => setViewerId(event.target.value)}>
              {run.players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => restart(playerCount, seedText, ascension)}>
            New run
          </button>
          <button type="button" onClick={onOnline}>Play online</button>
        </div>
      </header>

      {viewer && !run.combat && run.phase !== 'defeat' ? (
        <RunPotionBar player={viewer} players={run.players} ascension={run.ascension}
          onUse={(potionId, discardPotionId) => setRun((current) => useRunPotion(current, viewer.id, potionId, discardPotionId))}
          onTrade={(potionId, toPlayerId) => setRun((current) => tradeRunPotion(current, viewer.id, toPlayerId, potionId))} />
      ) : null}

      {run.phase === 'combat' && run.combat ? (
        <CombatScreen
          state={run.combat}
          viewerId={viewerId}
          onChange={(next: CombatState) => setRun((current) => ({ ...current, combat: next }))}
        />
      ) : null}

      {run.phase === 'map' ? (
        <MapScreen
          map={run.map}
          choices={roomChoices(run)}
          onEnter={(roomId) => setRun((current) => enterRoom(current, roomId))}
        />
      ) : null}

      {run.phase === 'reward' ? (
        <RewardScreen
          players={run.players}
          ascension={run.ascension}
          rewards={run.rewards}
          onReveal={(playerId) => setRun((current) => revealCardReward(current, playerId))}
          onRevealItem={(playerId, kind) => setRun((current) => revealItemReward(current, playerId, kind))}
          onResolve={(playerId, decision) => setRun((current) => resolveCardReward(current, playerId, decision))}
        />
      ) : null}

      {run.phase === 'betweenCombat' ? (
        <BetweenCombatScreen players={run.players}
          onSwitchRow={(playerId, row) => setRun((current) => switchBetweenCombatRow(current, playerId, row))}
          onContinue={() => setRun((current) => startPendingBoss(current))} />
      ) : null}

      {run.phase === 'room' && roomKind === 'campfire' ? (
        <CampfireScreen
          players={run.players}
          onResolve={(choices) => setRun((current) => resolveCampfire(current, choices))}
        />
      ) : null}

      {run.phase === 'room' && roomKind !== 'campfire' ? (
        <section className="room-screen">
          <h2>{roomKind ?? 'room'}</h2>
          <p className="muted">
            {roomKind} rooms are on the map but have no interaction yet — walking in and out is all
            they do. Shops, treasure and events are still to come.
          </p>
          <button type="button" onClick={() => setRun((current) => leaveRoom(current))}>
            Back to the map
          </button>
        </section>
      ) : null}

      {run.phase === 'victory' ? (
        <section className="room-screen">
          <h2>{run.act >= 4 ? 'The Spire is conquered' : `Act ${run.act} complete`}</h2>
          {run.act < 4 ? (
            <button type="button" onClick={() => setRun((current) => advanceAct(current))}>
              Climb to Act {run.act + 1}
            </button>
          ) : null}
        </section>
      ) : null}

      {run.phase === 'defeat' ? (
        <section className="room-screen">
          <h2 className="room-screen__defeat">The party has fallen</h2>
          <button type="button" onClick={() => restart(playerCount, seedText, ascension)}>
            Try again
          </button>
        </section>
      ) : null}

      <aside className="log" aria-label="Run log">
        {run.log.slice(-6).map((line, i) => (
          <p key={`${i}-${line}`}>{line}</p>
        ))}
      </aside>
    </main>
  )
}
