import { useEffect, useRef, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CombatState } from '../game/combat.ts'
import { ASCENSION_RULES, hasPendingRelicAcquisition, victoryIsTerminal } from '../game/run.ts'
import { relicDef } from '../game/relics.ts'
import type { Room } from '../game/map.ts'
import { ROOM_LABEL } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { useRoomSession } from '../multiplayer/useRoomSession.ts'
import type { PublicSeat, VisibleCombat, VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import { useVoiceChat } from '../multiplayer/useVoiceChat.ts'
import { CombatScreen } from './CombatScreen.tsx'
import { IconValue } from './Icon.tsx'
import { MapScreen } from './MapScreen.tsx'
import { OnlineCampfireScreen } from './OnlineCampfireScreen.tsx'
import { OnlineRewardScreen } from './OnlineRewardScreen.tsx'
import { OutsidePotionBar } from './OutsidePotionBar.tsx'
import { RelicBar } from './RelicChip.tsx'
import { RunSummary } from './RunSummary.tsx'
import { CardMorph, CardMorphAnnouncement } from './CardMorph.tsx'
import { useCardMorphs } from './useCardMorphs.ts'
import type { SummarySeat } from './RunSummary.tsx'
import { RelicResolvePanel } from './RelicResolvePanel.tsx'
import { CourierPanel, RoomScreen } from './RoomScreen.tsx'
import { ACT_IV_UNLOCK_BOXES } from '../game/campaign.ts'
import { NeowScreen } from './NeowScreen.tsx'
import { QuickSetupScreen } from './QuickSetupScreen.tsx'
import { currentQuickSetupStep } from '../game/meta.ts'
import { DAILY_MODIFIERS } from '../game/meta.ts'
import { MetaRunOptions } from './MetaRunOptions.tsx'
import { AchievementsScreen } from './AchievementsScreen.tsx'
import { shouldAnimateOnlineOpeningHand } from './board-signals.ts'

const CHARACTERS = [
  ['ironclad', 'Ironclad'],
  ['silent', 'Silent'],
  ['defect', 'Defect'],
  ['watcher', 'Watcher'],
] as const

type Props = {
  onLocal: () => void
  sfxEnabled: boolean
  onToggleSfx: () => void
}

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

/**
 * A seat for the end-of-run summary.
 *
 * `deck` is left undefined rather than defaulted to `[]`: the server sends only
 * the local seat's deck, and an empty array would render every teammate as
 * "0 cards" with no build — a confident lie. Undefined makes the summary omit
 * those lines for seats it cannot see.
 */
function onlineSummarySeat(player: VisiblePlayer): SummarySeat {
  return {
    id: player.id,
    name: player.name,
    character: player.character,
    hp: player.hp,
    maxHp: player.maxHp,
    gold: player.gold,
    dead: player.dead,
    relics: player.relics,
    deck: player.deck ?? undefined,
  }
}

export function pendingCardCopyLabel(copy: NonNullable<VisibleCombat['pendingCardCopy']>): string {
  const name = cardDef(copy.card.defId).name
  const source = copy.sourceNames[0]
  return copy.sourceNames.length > 1
    ? `a ${name} copy (${source})`
    : copy.card.scryDamageBonus !== undefined
      ? `Scry-played ${name}`
      : copy.virtualOnly
        ? `a ${name} copy (${source})`
        : `the original ${name} after a ${source} copy`
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

function wingChoices(map: { position: string | null; rows: string[][]; rooms: Record<string, Room> }, player?: VisiblePlayer): Room[] {
  if (!player?.relics.some((relic) => relic.defId === 'wing_boots' && (relic.uses ?? 0) > 0) || map.position === null) return []
  const current = map.rooms[map.position]
  if (!current) return []
  const normal = new Set(current.exits)
  return (map.rows[current.row + 1] ?? []).filter((id) => !normal.has(id)).map((id) => map.rooms[id])
    .filter((room): room is Room => room !== undefined)
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

export function OnlineGame({ onLocal, sfxEnabled, onToggleSfx }: Props) {
  const room = useRoomSession()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [character, setCharacter] = useState<(typeof CHARACTERS)[number][0]>('ironclad')
  const [achievementsOpen, setAchievementsOpen] = useState(false)
  const snapshot = room.snapshot
  const runPhase = snapshot?.run?.phase
  const previousRunPhase = useRef(runPhase)
  const animateOpeningHand = shouldAnimateOnlineOpeningHand(
    previousRunPhase.current,
    runPhase,
    room.connection === 'connected',
  )
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

  useEffect(() => {
    previousRunPhase.current = runPhase
  }, [runPhase])

  // MUST stay above the early returns below — this component bails out for the
  // reconnecting and entry screens, and a hook called after those would run on
  // some renders and not others.
  //
  // The server sends the local seat's own deck (`deck: mine ? player.deck : null`
  // in rooms.mjs) and nulls every other seat's, so the same deck diff the local
  // shell uses works here, for the viewer only — the one player whose upgrade
  // this client should be animating.
  const morph = useCardMorphs(
    snapshot?.run?.players.find((seat) => seat.id === snapshot.you.playerId)?.deck ?? undefined,
    snapshot?.run?.campaign.runId,
    snapshot?.run?.phase,
  )

  if (!snapshot && room.activeCode) {
    return (
      <main className="online-entry online-reconnecting sts-scope">
        <button type="button" className="online-entry__back" onClick={() => { room.forget(); onLocal() }}>← Solo table</button>
        <section className="online-entry__panel">
          <span className="online-entry__eyebrow">Party room {room.activeCode}</span>
          <h1>Reconnecting</h1>
          <p>Your seat is preserved. The table will return when the connection does.</p>
          {/* Labelled, because on this screen the chip's raw value is the same
              word as the heading directly above it — "Reconnecting" printed
              twice, 40px apart, with nothing between. */}
          <span className={`connection connection--${room.connection}`}>Link: {room.connection}</span>
          {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}
        </section>
      </main>
    )
  }

  if (!snapshot) {
    return (
      <main className="online-entry sts-scope">
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
    const connected = room.connection === 'connected'
    const partyLeader = snapshot.seats[0]
    const isPartyLeader = partyLeader?.playerId === snapshot.you.playerId
    if (achievementsOpen) return <AchievementsScreen onBack={() => setAchievementsOpen(false)} />
    return (
      <main className="online-lobby sts-scope">
        <header>
          <button type="button" onClick={async () => { voice.stop(); if (await room.leave()) onLocal() }}>← Leave room</button>
          <span className={`connection connection--${room.connection}`}>{room.connection}</span>
        </header>
        <section className="online-lobby__table">
          <span className="online-entry__eyebrow">Party room</span>
          <h1>{snapshot.code}</h1>
          <button type="button" onClick={() => void navigator.clipboard.writeText(snapshot.code).catch(() => {})}>Copy room code</button>
          <VoiceControls voice={voice} seats={snapshot.seats} connected={room.connection === 'connected'} />
          <button type="button" onClick={() => setAchievementsOpen(true)}>Achievements</button>
          <div className="online-lobby__seats">
            {Array.from({ length: 4 }, (_, index) => <Seat key={index} seat={snapshot.seats[index]} />)}
          </div>
          <label>
            Your character
            <select disabled={!connected} value={snapshot.you.character} onChange={(event) => room.chooseCharacter(event.target.value as typeof character)}>
              {CHARACTERS.map(([id, label]) => <option key={id} value={id} disabled={taken.has(id)}>{label}</option>)}
            </select>
          </label>
          <details className="online-lobby__settings">
            <summary>Settings</summary>
            <label>
              Ascension
              <select disabled={!connected} value={snapshot.ascension} onChange={(event) => room.chooseAscension(Number(event.target.value))}>{Array.from({ length: snapshot.campaignProgress.highestAscension + 1 }, (_, level) => <option key={level}>{level}</option>)}</select>
            </label>
            {/* `run-modifiers` is what carries the disclosure's styling; the
                bare `ascension-rules` class has no rules of its own, so this
                summary rendered as clickable plain text. */}
            <details className="ascension-rules run-modifiers">
              <summary>Ascension {snapshot.ascension} modifiers</summary>
              <ol>{ASCENSION_RULES.slice(1, snapshot.ascension + 1).map((rule) => <li key={rule}>{rule}</li>)}</ol>
            </details>
            {snapshot.seats.length > 1 ? <label>Choose Your Relic<input type="checkbox" disabled={!connected} checked={snapshot.chooseYourRelic} onChange={(event) => room.chooseRelicRule(event.target.checked)} /></label> : null}
            {snapshot.seats.length > 1 ? <label>Last Stand
              <input type="checkbox" aria-label="Last Stand" disabled={!connected || !isPartyLeader}
                checked={snapshot.lastStand} onChange={(event) => room.chooseLastStandRule(event.target.checked)} />
              {!isPartyLeader ? <small>{partyLeader?.name ?? 'The party leader'} controls this rule.</small> : null}
            </label> : null}
            <button className="sfx-toggle" type="button" data-sfx="none" aria-pressed={sfxEnabled} onClick={onToggleSfx}>
              Sound effects {sfxEnabled ? 'on' : 'off'}
            </button>
            <fieldset disabled={!connected || !isPartyLeader} className="online-lobby__meta">
              <legend>Official run setup</legend>
              <MetaRunOptions
                mode={snapshot.metaOptions.mode}
                dailyModifiers={[]}
                customModifierIds={snapshot.metaOptions.modifiers}
                quickStartAct={snapshot.metaOptions.quickStartAct}
                actIVUnlocked={snapshot.campaignProgress.actIV >= ACT_IV_UNLOCK_BOXES}
                onModeChange={(mode) => room.chooseRunMeta({ mode })}
                onCustomModifierChange={room.chooseRunModifier}
                onQuickStartActChange={(quickStartAct) => room.chooseRunMeta({ quickStartAct })}
              />
            </fieldset>
          </details>
          <button type="button" disabled={!connected || !ready || !isPartyLeader} onClick={room.start}>
            {connected && ready ? 'Enter the Spire' : 'Waiting for every seat to connect'}
          </button>
          {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}
        </section>
      </main>
    )
  }

  const run = snapshot.run
  const viewer = run.players.find((player) => player.id === snapshot.you.playerId)
  const pendingAcquisition = hasPendingRelicAcquisition(run)
  const roomsCleared = Object.values(run.map.rooms).filter((mapRoom) => mapRoom.visited).length
  const cardChoiceSeat = snapshot.seats.find((seat) => seat.playerId === snapshot.cardChoicePlayerId)
  const foreignCardChoice = cardChoiceSeat !== undefined && cardChoiceSeat.playerId !== snapshot.you.playerId
  const foreignCardCopy = foreignCardChoice && run.combat?.pendingCardCopy?.playerId === cardChoiceSeat?.playerId
  const triggerOwner = snapshot.seats.find((seat) =>
    seat.playerId === run.combat?.pendingTriggers[0]?.playerId)
  const foreignTrigger = triggerOwner !== undefined && triggerOwner.playerId !== snapshot.you.playerId
  const discardOwner = snapshot.seats.find((seat) => seat.playerId === snapshot.startTurnDiscard?.playerId)
  const foreignStartTurnDiscard = discardOwner !== undefined && discardOwner.playerId !== snapshot.you.playerId
  const combatViewer = run.combat?.players.find((player) => player.id === snapshot.you.playerId)
  const roomKind = run.map.position ? run.map.rooms[run.map.position]?.kind : undefined
  const waitingForCatchUpMerchant = run.phase === 'room' && run.roomState?.kind === 'merchant' &&
    run.setup?.kind === 'catch-up' && !run.setup.playerIds.includes(snapshot.you.playerId)
  const combat = run.combat ? {
    ...run.combat,
    rng: { seed: 0, calls: 0 },
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    playedCardsThisTurn: run.combat.playedCardsThisTurn ?? [],
    potionDeck: [],
    potionLimit: run.combat.potionLimit,
    lastStand: run.combat.lastStand,
    summonSupply: {},
    pendingSummons: run.combat.pendingSummons ?? [],
    pendingDistilled: run.combat.pendingDistilled ? {
      ...run.combat.pendingDistilled,
      cards: run.combat.pendingDistilled.cards ?? [],
    } : undefined,
    pendingRelicScry: run.combat.pendingRelicScry ? {
      ...run.combat.pendingRelicScry,
      cards: run.combat.pendingRelicScry.cards ?? [],
    } : undefined,
    players: run.combat.players.map(playerForUi),
  } satisfies CombatState : null

  return (
    <main className={`app-shell app-shell--online sts-scope${run.phase === 'combat' ? ' app-shell--combat' : ''}${run.phase === 'neow' ? ' app-shell--neow' : ''}`}>
      <header className="app-shell__header">
        <h1>Slay the Spire</h1>
        <div className="run-status">
          <span className="pip">Room {snapshot.code}</span>
          <span className={`connection connection--${room.connection}`}>{room.connection}</span>
          <span className="pip">Act {run.act}</span>
          {run.ascension > 0 ? <span className="pip">Ascension {run.ascension}</span> : null}
          {/* See App.tsx: HP belongs in the header on every screen, not only in combat. */}
          {viewer ? <span className="pip pip--hp" role="img" aria-label={`Health ${viewer.hp} of ${viewer.maxHp}`}>{viewer.hp}/{viewer.maxHp}</span> : null}
          {viewer ? <span className="pip"><IconValue name="gold" value={viewer.gold} size={20} /></span> : null}
          {viewer ? <RelicBar relics={viewer.relics} label={`${viewer.name}'s relics`} /> : null}
        </div>
        <details className="game-settings">
          <summary>Party</summary>
          <div className="setup">
          {run.meta.modifierIds.length > 0 ? <details className="ascension-rules run-modifiers">
            <summary>{run.meta.mode === 'daily' ? 'Daily Climb' : 'Custom Run'} · {run.meta.modifierIds.length} modifiers</summary>
            <ul>{run.meta.modifierIds.map((id) => {
              const modifier = DAILY_MODIFIERS.find((candidate) => candidate.id === id)!
              return <li key={id}><strong>{modifier.name}</strong> — {modifier.rule}</li>
            })}</ul>
          </details> : null}
          {snapshot.seats.map((seat) => <span className="pip" key={seat.playerId}>{seat.name} {seat.connected ? '●' : '○'}</span>)}
          <VoiceControls voice={voice} seats={snapshot.seats} connected={room.connection === 'connected'} />
          <button className="sfx-toggle" type="button" data-sfx="none" aria-pressed={sfxEnabled} onClick={onToggleSfx}>
            Sound effects {sfxEnabled ? 'on' : 'off'}
          </button>
          <button type="button" onClick={() => { voice.stop(); onLocal() }}>Solo table</button>
          </div>
        </details>
      </header>

      {room.connection !== 'connected' ? <p className="online-banner">Reconnecting… your seat is preserved.</p> : null}
      {foreignCardChoice && cardChoiceSeat?.connected
        ? <p className="online-banner" role="status">{cardChoiceSeat.name} is resolving {
          foreignCardCopy
            ? pendingCardCopyLabel(run.combat!.pendingCardCopy!)
            : 'a revealed card'
        }…</p>
        : null}
      {foreignCardChoice && cardChoiceSeat && !cardChoiceSeat.connected ? (
        <p className="online-banner" role="status">
          {cardChoiceSeat.name} disconnected during a revealed card.{' '}
          <button type="button" onClick={() => room.act({ kind: 'endTurn' })}>Resolve card and end turn</button>
        </p>
      ) : null}
      {foreignTrigger ? <p className="online-banner" role="status">
        Waiting for {triggerOwner.name} to resolve a triggered ability…
      </p> : null}
      {foreignStartTurnDiscard ? <p className="online-banner" role="status">
        Waiting for {discardOwner.name} to discard for Tools of the Trade…
      </p> : null}
      {room.error ? <p className="online-error" role="alert">{room.error}</p> : null}

      <div className="online-mutations" inert={room.connection !== 'connected' || foreignCardChoice || foreignTrigger || foreignStartTurnDiscard || undefined}
        aria-disabled={room.connection !== 'connected' || foreignCardChoice || foreignTrigger || foreignStartTurnDiscard || undefined}>
      {run.phase === 'combat' && combat ? (
        <><div className="courier-combat-lock" inert={Boolean(run.courier.offer) || undefined} aria-disabled={Boolean(run.courier.offer) || undefined}><CombatScreen
          state={combat}
          viewerId={snapshot.you.playerId}
          drawCount={combatViewer?.drawCount}
          decidedPlayerIds={snapshot.endTurnDecided}
          partyEndTurnAbilities={snapshot.endTurnAbilities}
          savedEndTurnOrder={snapshot.endTurnOrder}
          endTurnCoordinatorId={snapshot.endTurnCoordinatorId}
          partyStartTurnAbilities={snapshot.startTurnAbilities}
          partyStartTurnScryAbilities={snapshot.startTurnScryAbilities}
          startTurnCoordinatorId={snapshot.startTurnCoordinatorId}
          partyStartTurnScry={snapshot.startTurnScry}
          partyStartTurnDiscard={snapshot.startTurnDiscard}
          savedDiscardOrder={snapshot.discardOrder}
          cardPreview={snapshot.cardPreview}
          authoritativeVersion={snapshot.version}
          authoritativeRefresh={room.refreshEpoch}
          authoritativeRestoration={room.restorationEpoch}
          authoritativeConnected={room.connection === 'connected'}
          animateOpeningHand={animateOpeningHand}
          mutationsEnabled={!run.courier.offer && room.connection === 'connected' &&
            !foreignCardChoice && !foreignTrigger && !foreignStartTurnDiscard}
          autoAdvance={!run.courier.offer && room.connection === 'connected' && snapshot.seats.find((seat) => seat.connected &&
            !combat.players.find((player) => player.id === seat.playerId)?.dead)?.playerId === snapshot.you.playerId}
          onAction={room.act}
        /></div><CourierPanel players={combat.players} viewerId={snapshot.you.playerId} ascension={run.ascension} usedBy={run.courier.usedBy} offer={run.courier.offer} pledge={snapshot.courierPledge} online onReveal={(kind) => room.act({ kind: 'courierReveal', itemKind: kind })} onResolve={(decision, payments, discardPotionId) => room.act({ kind: 'courierResolve', playerId: run.courier.offer?.playerId, decision, payments, discardPotionId })} /></>
      ) : null}
      {run.phase !== 'combat' && run.phase !== 'defeat' && run.phase !== 'neow' &&
      !victoryIsTerminal(run, snapshot.campaignProgress) && !pendingAcquisition ? (
        <OutsidePotionBar players={run.players.map(playerForUi)} viewerId={snapshot.you.playerId}
          potionLimit={run.ascension >= 4 ? 2 : 3}
          onTrade={(potionId, playerId) => room.act({ kind: 'tradePotion', potionId, playerId })}
          onUse={(potionId, replacePotionId) => room.act({ kind: 'usePotionOutsideCombat', potionId, replacePotionId })} />
      ) : null}
      {run.phase === 'map' ? <><MapScreen map={run.map} choices={pendingAcquisition ? [] : choices(run.map)}
        blocked={pendingAcquisition} onEnter={(roomId) => room.act({ kind: 'enterRoom', roomId })} />
        {!pendingAcquisition && wingChoices(run.map, viewer).length > 0 ? <section className="room-screen"><strong>Wing Boots</strong>
          {wingChoices(run.map, viewer).map((target) => <button type="button" key={target.id}
            onClick={() => room.act({ kind: 'enterRoom', roomId: target.id, useWingBoots: true })}>Ignore paths to {target.kind}</button>)}
        </section> : null}</> : null}
      {snapshot.pendingRelic && viewer?.deck ? <RelicResolvePanel key={snapshot.pendingRelic.relicId}
        pending={snapshot.pendingRelic} deck={viewer.deck}
        onResolve={(cardUids, rewardIndices) => room.act({ kind: 'resolvePendingRelic', cardUids, rewardIndices })} /> : null}
      {run.phase !== 'neow' && !snapshot.pendingRelic && snapshot.pendingRelicStatus ? <section className="room-screen" role="status">
        Waiting for {snapshot.pendingRelicStatus.playerName} to resolve{' '}
        {relicDef(snapshot.pendingRelicStatus.relicId).name}.
      </section> : null}
      {run.phase === 'neow' && run.neow ? <NeowScreen
        players={run.players}
        progress={run.neow.players}
        viewerId={snapshot.you.playerId}
        potionLimit={run.ascension >= 4 ? 2 : 3}
        enabled={room.connection === 'connected' && !pendingAcquisition}
        disabledMessage={room.connection !== 'connected'
          ? 'Reconnecting… your Blessing is preserved.'
          : snapshot.pendingRelicStatus
            ? `Waiting for ${snapshot.pendingRelicStatus.playerName} to resolve ${relicDef(snapshot.pendingRelicStatus.relicId).name}.`
            : undefined}
        onGold={(_playerId, gain) => room.act({ kind: 'neow', stage: 'redGold', gain })}
        onReveal={(_playerId, _stage, sources) => {
          // `NeowScreen` reports "no prismatic choice" as an empty array, which
          // is what the local engine wants — `revealNeowReward` defaults
          // `sources` to `[]`. The wire contract is narrower: the server takes
          // the key absent or exactly 3 sources, and rejected `[]` with a 409
          // "Choose a valid Neow reveal", so Reveal was enabled, did nothing on
          // click, and Skip unseen was the only way past Neow online.
          //
          // Translated at the boundary between the two contracts rather than in
          // NeowScreen, which is shared with the local shell and whose array the
          // engine reads directly.
          room.act({ kind: 'neow', stage: 'reveal', sources: sources.length ? sources : undefined })
        }}
        onReward={(_playerId, choice, stage) => room.act({ kind: 'neow', stage, choice })}
        onEffect={(_playerId, gain, decision) => room.act({ kind: 'neow', stage: 'effect', gain, cardUids: decision.cardUids ?? [] })}
        onChoose={(_playerId, optionIndex, decision) => room.act({
          kind: 'neow', stage: 'option', optionIndex, cardUids: decision.cardUids ?? [],
        })}
        onArmCardGain={morph.armGain}
      /> : null}
      {run.phase === 'setup' && run.setup && !pendingAcquisition ? <QuickSetupScreen
        setup={run.setup}
        players={run.players.map(playerForUi)}
        currentStep={currentQuickSetupStep(run.setup)}
        enabled={room.connection === 'connected' && run.setup.playerIds[run.setup.playerIndex] === snapshot.you.playerId}
        disabledMessage={room.connection !== 'connected'
          ? 'Reconnecting… setup progress is preserved.'
          : `Waiting for ${snapshot.seats.find((seat) => seat.playerId === run.setup?.playerIds[run.setup.playerIndex])?.name ?? 'the active player'}.`}
        onAdvance={(cardUids) => room.act({ kind: 'setupStep', cardUids: cardUids ?? [] })}
      /> : null}
      {run.phase === 'reward' && !pendingAcquisition ? (
        <OnlineRewardScreen
          run={run}
          viewerId={snapshot.you.playerId}
          choice={snapshot.rewardChoice}
          decided={snapshot.rewardDecided}
          confirmed={snapshot.rewardConfirmed}
          onAction={room.act}
        />
      ) : null}
      {run.phase === 'betweenCombat' ? (
        <section className="room-screen between-combat">
          <h2>Another boss approaches</h2>
          <p className="muted">Choose your row before the second Ascension 13 boss.</p>
          <label>Your row
            <select value={viewer?.row ?? 0} onChange={(event) => room.act({ kind: 'switchBetweenCombatRow', row: Number(event.target.value) })}>
              {run.players.map((_seat, row) => <option value={row} key={row}>Row {row + 1}</option>)}
            </select>
          </label>
          <button type="button" disabled={pendingAcquisition}
            onClick={() => room.act({ kind: 'startPendingBoss' })}>Face the next boss</button>
        </section>
      ) : null}
      {run.phase === 'room' && roomKind === 'campfire' && viewer ? (
        <OnlineCampfireScreen player={viewer} saved={snapshot.campfireChoice} decided={snapshot.campfireDecided} seats={snapshot.seats} onAction={room.act}
          rubyAvailable={snapshot.campaignProgress.actIV >= ACT_IV_UNLOCK_BOXES && !run.campaign.keys.ruby}
          restAllowed={!run.meta.modifierIds.includes('night_terrors')} />
      ) : null}
      {waitingForCatchUpMerchant ? <section className="room-screen" role="status">Waiting for the Catch Up players to finish their Merchant visit.</section> : null}
      {run.phase === 'room' && run.roomState && viewer && !waitingForCatchUpMerchant ? (
        <RoomScreen
          room={run.roomState}
          players={run.players.map(playerForUi)}
          viewerId={snapshot.you.playerId}
          ascension={run.ascension}
          onPurchase={(purchase) => room.act({ kind: 'merchantPurchase', purchase })}
          onRemove={(playerId, cardUid, payments) => room.act({ kind: 'merchantRemove', playerId, cardUid, payments })}
          onFinishMerchant={() => room.act({ kind: 'merchantFinish' })}
          onRelic={(playerId, decision) => room.act({ kind: 'relicReward', playerId, decision })}
          onEvent={(playerId, decision) => room.act({ kind: 'event', playerId, decision })}
          eventCanSkip={snapshot.eventCanSkip}
          onSkipEvent={(playerId) => room.act({ kind: 'eventSkip', playerId })}
          sapphireAvailable={snapshot.campaignProgress.actIV >= ACT_IV_UNLOCK_BOXES && !run.campaign.keys.sapphire}
          merchantPledges={snapshot.merchantPledges}
          onWithdraw={(key) => room.act({ kind: 'merchantWithdraw', key })}
          eventForwardRooms={Object.values(run.map.rooms).filter((candidate) => candidate.row > (run.map.position ? run.map.rooms[run.map.position]?.row ?? -1 : -1)).map((candidate) => ({ id: candidate.id, label: `Floor ${candidate.row + 1} · ${ROOM_LABEL[candidate.kind]}` }))}
          eventPledge={snapshot.eventPledge}
          onCancelEventPayment={() => room.act({ kind: 'eventCancel' })}
          onArmCardGain={morph.armGain}
        />
      ) : null}
      {run.phase === 'room' && roomKind !== 'campfire' && !run.roomState ? (
        <section className="room-screen">
          <h2>{roomKind ?? 'room'}</h2>
          <button type="button" onClick={() => room.act({ kind: 'leaveRoom' })}>Back to the map</button>
        </section>
      ) : null}
      {run.phase === 'victory' && !run.campaign.finalized ? (
        <section className="room-screen">
          <h2>{run.act >= 4 ? 'The Spire is conquered' : `Act ${run.act} complete`}</h2>
          <RunSummary act={run.act} roomsCleared={roomsCleared}
            ascension={run.ascension} seats={run.players.map(onlineSummarySeat)} />
          {run.lastStand && run.players.some((player) => player.dead) && run.act < 4 ? (
            <p role="status">Last Stand won the Act, but a fallen hero means the party cannot continue to the next Act.</p>
          ) : null}
          {!(run.lastStand && run.players.some((player) => player.dead)) && (run.act < 3 || (run.act === 3 && Object.values(run.campaign.keys).every(Boolean) && snapshot.campaignProgress.actIV >= ACT_IV_UNLOCK_BOXES))
            ? <button type="button" disabled={pendingAcquisition}
              onClick={() => room.act({ kind: 'advanceAct' })}>Climb to Act {run.act + 1}</button> : null}
          <button type="button" disabled={pendingAcquisition}
            onClick={() => room.act({ kind: 'finishRun' })}>Stop and record result</button>
        </section>
      ) : null}
      {run.phase === 'defeat' && !run.campaign.finalized ? <section className="room-screen"><h2 className="room-screen__defeat">The party has fallen</h2><RunSummary act={run.act} roomsCleared={roomsCleared} ascension={run.ascension} seats={run.players.map(onlineSummarySeat)} /><button type="button" onClick={() => room.act({ kind: 'finishRun' })}>Record campaign result</button></section> : null}

      {run.campaign.finalized ? <section className="campaign-end"><span>Campaign journal</span><h2>Marks earned</h2><p>{snapshot.campaignProgress.unspentMarks} shared mark{snapshot.campaignProgress.unspentMarks === 1 ? '' : 's'} remain. {snapshot.seats[0]?.playerId === snapshot.you.playerId ? 'Assign them before the next run.' : `Waiting for ${snapshot.seats[0]?.name ?? 'the journal keeper'}.`}</p>{snapshot.seats[0]?.playerId === snapshot.you.playerId ? <div>{snapshot.campaignProgress.unspentMarks > 0 && snapshot.campaignProgress.colorless < 3 ? <button type="button" onClick={() => room.act({ kind: 'allocateCampaign', colorless: 1, actIV: 0, expectedUnspentMarks: snapshot.campaignProgress.unspentMarks, expectedRunId: run.campaign.runId })}>Mark Colorless · {snapshot.campaignProgress.colorless}/3</button> : null}{snapshot.campaignProgress.unspentMarks > 0 && snapshot.campaignProgress.actIV < 5 ? <button type="button" onClick={() => room.act({ kind: 'allocateCampaign', colorless: 0, actIV: 1, expectedUnspentMarks: snapshot.campaignProgress.unspentMarks, expectedRunId: run.campaign.runId })}>Mark Act IV · {snapshot.campaignProgress.actIV}/5</button> : null}{snapshot.campaignProgress.unspentMarks === 0 ? <button type="button" onClick={() => room.act({ kind: 'returnToLobby' })}>Prepare next run →</button> : null}</div> : null}</section> : null}

      {/* Not on Neow: it is a full-bleed painted scene with seat cards in the
          bottom-left and Skip keys in the bottom-right, so the fixed log tab
          covers content in either corner and there is no scroller to move it
          clear. The log is supplementary and is on every other screen. */}
      {run.phase !== 'combat' && run.phase !== 'neow' ? <details className="log">
        <summary>Run log</summary>
        {run.log.slice(-6).map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
      </details> : null}
      </div>
      {/* OUTSIDE `.online-mutations`, which carries `inert` whenever another seat
          holds a card choice, a pending trigger or a discard. `inert` takes its
          subtree out of the accessibility tree, so an `aria-live` region nested
          in it never announces — and the whole reason this text lives apart from
          `CardMorph` is that the visual is deliberately `aria-hidden` + `inert`
          while the sentence has to survive. The local shell already had them
          under `<main>`; this matches it. Both are positioned out of flow, so
          moving them changes no layout.

          See the local shell for why the announcement is `aria-live` and not a
          second `role="status"`. The overlay is deliberately NOT keyed — see
          CardMorph, which keys its inner stage instead so the veil survives a
          queue. */}
      {morph.current ? <CardMorph request={morph.current} onDone={morph.dismiss} /> : null}
      <CardMorphAnnouncement request={morph.current} name={(card) => faceOf(cardDef(card.defId), card.upgraded).name} />
    </main>
  )
}
