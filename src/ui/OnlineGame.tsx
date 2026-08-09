import { useEffect, useRef, useState } from 'react'
import type { CombatState } from '../game/combat.ts'
import type { Room } from '../game/map.ts'
import type { Player } from '../game/types.ts'
import { useRoomSession } from '../multiplayer/useRoomSession.ts'
import type { PublicSeat, VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import { useVoiceChat } from '../multiplayer/useVoiceChat.ts'
import { CombatScreen } from './CombatScreen.tsx'
import { IconValue } from './Icon.tsx'
import { MapScreen } from './MapScreen.tsx'
import { OnlineCampfireScreen } from './OnlineCampfireScreen.tsx'
import { OnlineRewardScreen } from './OnlineRewardScreen.tsx'

const CHARACTERS = [
  ['ironclad', 'Ironclad'],
  ['silent', 'Silent'],
  ['defect', 'Defect'],
  ['watcher', 'Watcher'],
] as const

type Props = { onLocal: () => void }

function playerForUi(player: VisiblePlayer): Player {
  return {
    ...player,
    deck: player.deck ?? [],
    draw: [],
    hand: player.hand ?? [],
    cardRewards: [],
    rareRewards: [],
  }
}

function choices(map: { position: string | null; rows: string[][]; rooms: Record<string, Room> }): Room[] {
  if (map.position === null) {
    const id = map.rows[0]?.[0]
    return id && map.rooms[id] ? [map.rooms[id]] : []
  }
  return map.rooms[map.position]?.exits
    .map((id) => map.rooms[id])
    .filter((room): room is Room => room !== undefined) ?? []
}

function Seat({ seat }: { seat?: PublicSeat }) {
  return (
    <div className={seat ? 'online-seat' : 'online-seat online-seat--empty'}>
      {seat ? (
        <>
          <span>{seat.name}</span>
          <small>{CHARACTERS.find(([id]) => id === seat.character)?.[1]} · {seat.connected ? 'online' : 'away'}</small>
        </>
      ) : <span>Open seat</span>}
    </div>
  )
}

function RemoteAudio({ stream }: { stream: MediaStream }) {
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    if (audio.current) audio.current.srcObject = stream
  }, [stream])
  return <audio ref={audio} autoPlay playsInline />
}

function VoiceControls({ voice, seats, connected }: {
  voice: ReturnType<typeof useVoiceChat>
  seats: PublicSeat[]
  connected: boolean
}) {
  if (!voice.available) return <span className="voice voice--unavailable">Voice unavailable</span>
  if (!voice.enabled) {
    return (
      <div className="voice">
        <button type="button" disabled={!connected || voice.starting} onClick={voice.start}>
          {voice.starting ? 'Opening microphone…' : 'Join voice'}
        </button>
        {voice.error ? <span className="online-error" role="alert">{voice.error}</span> : null}
      </div>
    )
  }
  const connectedPeers = Object.values(voice.peerStates).filter((state) => state === 'connected').length
  return (
    <div className="voice" aria-label="Party voice">
      <span className="voice__status">Voice {connectedPeers}/{Math.max(0, seats.length - 1)}</span>
      <button type="button" aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? 'Unmute' : 'Mute'}</button>
      <button type="button" onClick={voice.stop}>Leave voice</button>
      {voice.error ? <span className="online-error" role="alert">{voice.error}</span> : null}
      {Object.entries(voice.remoteStreams).map(([peerId, stream]) => <RemoteAudio key={peerId} stream={stream} />)}
    </div>
  )
}

export function OnlineGame({ onLocal }: Props) {
  const room = useRoomSession()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [character, setCharacter] = useState<(typeof CHARACTERS)[number][0]>('ironclad')
  const snapshot = room.snapshot
  const voice = useVoiceChat({
    roomCode: snapshot?.code,
    playerId: snapshot?.you.playerId,
    seats: snapshot?.seats ?? [],
    connected: room.connection === 'connected',
    sendSignal: room.sendVoiceSignal,
    onSignal: room.onVoiceSignal,
    loadIceServers: room.loadVoiceIceServers,
  })

  useEffect(() => {
    const phase = snapshot?.run?.combat?.phase
    if (room.connection !== 'connected' || (phase !== 'won' && phase !== 'lost')) return undefined
    const timer = setTimeout(() => room.act({ kind: 'resolveCombat' }), 900)
    return () => clearTimeout(timer)
  }, [room.act, room.connection, snapshot?.run?.combat?.phase])

  if (!snapshot && room.activeCode) {
    return (
      <main className="online-entry online-reconnecting">
        <button type="button" className="online-entry__back" onClick={() => { room.forget(); onLocal() }}>← Solo table</button>
        <section className="online-entry__panel">
          <span className="online-entry__eyebrow">Party room {room.activeCode}</span>
          <h1>Reconnecting</h1>
          <p>Your seat is preserved. The table will return when the connection does.</p>
          <span className={`connection connection--${room.connection}`}>{room.connection}</span>
          {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}
        </section>
      </main>
    )
  }

  if (!snapshot) {
    return (
      <main className="online-entry">
        <button type="button" className="online-entry__back" disabled={room.entering} onClick={() => { room.forget(); onLocal() }}>← Solo table</button>
        <section className="online-entry__panel">
          <span className="online-entry__eyebrow">Co-op expedition</span>
          <h1>Climb together</h1>
          <p>Open a room for up to four players, or enter the six-glyph code your party shared.</p>
          <label>
            Your name
            <input maxLength={24} autoComplete="nickname" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Character
            <select value={character} onChange={(event) => setCharacter(event.target.value as typeof character)}>
              {CHARACTERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <div className="online-entry__actions">
            <button type="button" disabled={!name.trim() || room.entering} onClick={() => room.enter({ name: name.trim(), character })}>
              Create room
            </button>
            <span>or</span>
            <input aria-label="Room code" placeholder="ROOM CODE" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
            <button type="button" disabled={!name.trim() || code.trim().length !== 6 || room.entering} onClick={() => room.enter({ name: name.trim(), character, code })}>
              Join
            </button>
          </div>
          {room.recoveries.length ? (
            <div className="online-entry__recoveries">
              <span>Saved expeditions</span>
              {room.recoveries.map((saved) => (
                <button type="button" key={saved.token} disabled={room.entering} onClick={() => room.resume(saved)}>Resume {saved.code}</button>
              ))}
            </div>
          ) : null}
          {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}
        </section>
      </main>
    )
  }

  if (!snapshot.run) {
    const taken = new Set(snapshot.seats.filter((seat) => seat.playerId !== snapshot.you.playerId).map((seat) => seat.character))
    const ready = snapshot.seats.length > 0 && snapshot.seats.every((seat) => seat.connected)
    return (
      <main className="online-lobby">
        <header>
          <button type="button" onClick={async () => { voice.stop(); if (await room.leave()) onLocal() }}>← Leave room</button>
          <span className={`connection connection--${room.connection}`}>{room.connection}</span>
        </header>
        <section className="online-lobby__table">
          <span className="online-entry__eyebrow">Party room</span>
          <h1>{snapshot.code}</h1>
          <button type="button" onClick={() => void navigator.clipboard.writeText(snapshot.code).catch(() => {})}>Copy room code</button>
          <VoiceControls voice={voice} seats={snapshot.seats} connected={room.connection === 'connected'} />
          <div className="online-lobby__seats">
            {Array.from({ length: 4 }, (_, index) => <Seat key={index} seat={snapshot.seats[index]} />)}
          </div>
          <label>
            Your character
            <select value={snapshot.you.character} onChange={(event) => room.chooseCharacter(event.target.value as typeof character)}>
              {CHARACTERS.map(([id, label]) => <option key={id} value={id} disabled={taken.has(id)}>{label}</option>)}
            </select>
          </label>
          <label>
            Ascension
            <input type="number" min={0} max={13} value={snapshot.ascension} onChange={(event) => room.chooseAscension(Number(event.target.value))} />
          </label>
          <button type="button" disabled={!ready} onClick={room.start}>
            {ready ? 'Enter the Spire' : 'Waiting for every seat to connect'}
          </button>
          {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}
        </section>
      </main>
    )
  }

  const run = snapshot.run
  const viewer = run.players.find((player) => player.id === snapshot.you.playerId)
  const combatViewer = run.combat?.players.find((player) => player.id === snapshot.you.playerId)
  const roomKind = run.map.position ? run.map.rooms[run.map.position]?.kind : undefined
  const combat = run.combat ? {
    ...run.combat,
    rng: { seed: 0, calls: 0 },
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    players: run.combat.players.map(playerForUi),
  } satisfies CombatState : null

  return (
    <main className="app-shell app-shell--online">
      <header className="app-shell__header">
        <h1>Slay the Spire</h1>
        <div className="run-status">
          <span className="pip">Room {snapshot.code}</span>
          <span className={`connection connection--${room.connection}`}>{room.connection}</span>
          <span className="pip">Act {run.act}</span>
          {run.ascension > 0 ? <span className="pip">Ascension {run.ascension}</span> : null}
          {viewer ? <span className="pip"><IconValue name="gold" value={viewer.gold} size={20} /></span> : null}
        </div>
        <div className="setup">
          {snapshot.seats.map((seat) => <span className="pip" key={seat.playerId}>{seat.name} {seat.connected ? '●' : '○'}</span>)}
          <VoiceControls voice={voice} seats={snapshot.seats} connected={room.connection === 'connected'} />
          <button type="button" onClick={() => { voice.stop(); onLocal() }}>Solo table</button>
        </div>
      </header>

      {room.connection !== 'connected' ? <p className="online-banner">Reconnecting… your seat is preserved.</p> : null}
      {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}

      <div className="online-mutations" inert={room.connection !== 'connected' || undefined} aria-disabled={room.connection !== 'connected' || undefined}>
      {run.phase === 'combat' && combat ? (
        <CombatScreen
          state={combat}
          viewerId={snapshot.you.playerId}
          drawCount={combatViewer?.drawCount}
          decidedPlayerIds={snapshot.endTurnDecided}
          partyEndTurnAbilities={snapshot.endTurnAbilities}
          savedEndTurnOrder={snapshot.endTurnOrder}
          endTurnCoordinatorId={snapshot.endTurnCoordinatorId}
          savedDiscardOrder={snapshot.discardOrder}
          authoritativeVersion={snapshot.version}
          authoritativeRefresh={room.refreshEpoch}
          onAction={room.act}
        />
      ) : null}
      {run.phase === 'map' ? <MapScreen map={run.map} choices={choices(run.map)} onEnter={(roomId) => room.act({ kind: 'enterRoom', roomId })} /> : null}
      {run.phase === 'reward' ? (
        <OnlineRewardScreen
          run={run}
          viewerId={snapshot.you.playerId}
          choice={snapshot.rewardChoice}
          decided={snapshot.rewardDecided}
          confirmed={snapshot.rewardConfirmed}
          onAction={room.act}
        />
      ) : null}
      {run.phase === 'room' && roomKind === 'campfire' && viewer ? (
        <OnlineCampfireScreen player={viewer} saved={snapshot.campfireChoice} decided={snapshot.campfireDecided} seats={snapshot.seats} onAction={room.act} />
      ) : null}
      {run.phase === 'room' && roomKind !== 'campfire' ? (
        <section className="room-screen">
          <h2>{roomKind ?? 'room'}</h2>
          <button type="button" onClick={() => room.act({ kind: 'leaveRoom' })}>Back to the map</button>
        </section>
      ) : null}
      {run.phase === 'victory' ? (
        <section className="room-screen">
          <h2>Act {run.act} complete</h2>
          <button type="button" onClick={() => room.act({ kind: 'advanceAct' })}>Climb to Act {run.act + 1}</button>
        </section>
      ) : null}
      {run.phase === 'defeat' ? <section className="room-screen"><h2 className="room-screen__defeat">The party has fallen</h2></section> : null}

      <aside className="log" aria-label="Run log">
        {run.log.slice(-6).map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
      </aside>
      </div>
    </main>
  )
}
