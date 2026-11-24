import type { Dispatch, PointerEvent, ReactNode, RefObject, SetStateAction } from 'react'
import { assetPath } from '../../game/assets.ts'
import { cardDef, faceOf, type CardDef } from '../../game/cards.ts'
import {
  enemyLabel,
  livingEnemies,
  remainingRoundHpLoss,
  type CombatPresentationEvent,
  type CombatState,
  type EndTurnAbility,
  type PendingTriggerAbility,
  type StartTurnAbility,
} from '../../game/combat.ts'
import { enemyDef } from '../../game/enemies.ts'
import { potionDef } from '../../game/relics.ts'
import { playerVisualId, type VisualId } from '../../game/skins.ts'
import type { CardInstance, Enemy, OrbType, Player } from '../../game/types.ts'
import { healthBand } from '../board-signals.ts'
import { slimeCommandText } from '../Card.tsx'
import { CombatAnimation } from '../CombatAnimation.tsx'
import { enemyAttackArrivalMsFor, enemyAttackTargetPlayerIds } from '../combat-vfx.ts'
import { EnemyCard } from '../EnemyCard.tsx'
import heroArtHeads from '../hero-art-head.json'
import { PotionIcon } from '../PotionIcon.tsx'
import { PowerRow } from '../PowerRow.tsx'
import rigMetadata from '../rig-animation-metadata.json' with { type: 'json' }
import { OrbRow, TokenRow } from '../TokenRow.tsx'
import { describeSeat, paintedLeft } from './helpers.ts'
import {
  CharacterAttackPose,
  GuardianPortrait,
  MonogatariAttackPose,
  MonogatariEvokePose,
  StagedAttackPose,
  isMonogatariVisual,
  slimeAssetSlug,
  slimeFallbackAsset,
} from './portraits.tsx'
import type { StagedAttackSpec } from './staged-attacks.ts'
import type {
  ActiveCombatVfx,
  CardDrag,
  CharacterAttackMotion,
  EndTurnEffectDrag,
  Pending,
} from './types.ts'
import type { MonogatariEvokeLatch } from './useAttackPosePreload.ts'
import {
  CombatVfx,
  DefectEvokeVfx,
  StagedImpacts,
  isEndTurnLightning,
  splitAttackWeights,
  stagedAttackOf,
  stagedIdleAsset,
} from './vfx.tsx'

export function GroundedCombatVfx({
  enemies,
  activeVfx,
  orbEndTurnRevealDelayMs,
}: {
  enemies: readonly Enemy[]
  activeVfx: readonly ActiveCombatVfx[]
  orbEndTurnRevealDelayMs: ReadonlyMap<number, number>
}) {
  return (
    <>
      {enemies.flatMap((enemy) => activeVfx
        .filter(({ event }) => event.enemyIds.includes(enemy.uid) && isEndTurnLightning(event))
        .map((active) => <CombatVfx
          key={`${enemy.uid}-${active.event.seq}-${active.recipe.asset}`}
          active={active}
          role="target"
          targetEnemyId={enemy.uid}
          revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)}
        />))}
    </>
  )
}

export type CombatStageProps = {
  state: CombatState
  viewer: Player
  viewerId: string
  rows: readonly number[]
  bosses: readonly Enemy[]
  stageEnemies: readonly Enemy[]
  facingEnemies: readonly Enemy[]
  liveFacingEnemies: readonly Enemy[]
  boardRef: RefObject<HTMLDivElement | null>
  viewerRowRef: RefObject<HTMLDivElement | null>
  setPointedEnemyUid: Dispatch<SetStateAction<string | null>>
  prefersReducedMotion: boolean
  characterAttacksActive: boolean
  falling: ReadonlySet<string>
  targetPresentationTimings: ReadonlyMap<string, { event?: CombatPresentationEvent; contact: number }>
  visualResetKey: string
  hits: ReadonlyMap<string, { beat: number; damage: number; delayMs: number }[]>
  enemyVfxFor: (enemy: Enemy) => ReactNode
  actorVfxFor: (playerId: string) => ActiveCombatVfx[]
  playerVfxFor: (playerId: string) => ActiveCombatVfx[]
  orbEndTurnRevealDelayMs: ReadonlyMap<number, number>
  livePresentationEvents: readonly CombatPresentationEvent[]
  finishSlimeCommand: (seq: number) => void
  expiredCultistPhase: string | null
  activeEnemyPhaseKey: string | null
  onCultistThrowPrepared: (enemyUid: string, arrivalWithinMs: number) => void
  onCultistThrowStart: (enemyUid: string) => void
  onCultistThrowSkipped: (enemyUid: string) => void
  characterAttackAssets: string
  characterAttackBlobs: ReadonlyMap<string, Blob | true>
  stagedPosesReady: (visual: VisualId, spec: StagedAttackSpec, seq: number) => boolean
  monogatariPosesReady: (visual: string, seq: number) => boolean
  monogatariEvokeReady: (event: Extract<CombatPresentationEvent, { kind: 'orb' }>) => boolean
  monogatariEvokesReadyByEvent: { current: Map<string, MonogatariEvokeLatch> }
  characterAttacks: Record<string, CharacterAttackMotion[]>
  slimeCommandMotions: Record<string, { seq: number; x: number; y: number }>
  setSlimeLayoutVersion: Dispatch<SetStateAction<number>>
  showSlimeCard: (card: CardInstance, anchor: HTMLElement) => void
  hideSlimeCard: () => void
  pendingStartEnemy: StartTurnAbility | undefined
  pendingStartPlayer: StartTurnAbility | undefined
  pendingStartEvoke: StartTurnAbility | undefined
  startEnemyChoiceAvailable: (enemyUid: string) => boolean
  pendingShivProgress: { options: readonly { uid: string }[] } | null | undefined
  isEndTurnEnemyTarget: (enemy: Enemy) => boolean
  cardDrag: CardDrag | null
  cardDragTargetRow: number | undefined
  endTurnEffectDrag: EndTurnEffectDrag | null
  armedEndTurnAbilityId: string | null
  isStartTurnEnemyTarget: (enemyUid: string) => boolean
  pendingTrigger: PendingTriggerAbility | null | undefined
  triggerHermitChoicesReady: boolean
  triggerSlimeEnemyUids: readonly string[]
  triggerSlimeEnemyAmount: number
  isEnemyRowClickTargetable: (enemy: Enemy) => boolean
  isRowLaneClickTargetable: (row: number) => boolean
  rowLaneClickLabel: (row: number) => string
  onRowLaneClick: (row: number) => void
  pendingPotion: string | null
  pendingPotionNeedsEnemy: boolean
  pendingPotionOverflow: number
  pendingPowerNeedsEnemy: boolean
  pendingPowerNeedsAlly: boolean
  pendingPowerDef: CardDef | null
  pendingHermitPower: boolean
  powerLoadUids: readonly string[]
  spendingShiv: boolean
  spendingSoulburn: boolean
  pending: Pending | null
  slimeEnemyChoicesRequired: (pending: Pending) => number
  loadedTargetCount: (pending: Pending) => number
  pendingEvokeTarget: number
  pendingEvokeUsesRows: boolean
  pendingEvokeTargetUids: ReadonlySet<string>
  enemyChoicesDone: boolean
  independentEnemyPending: boolean
  independentPlayerPending: boolean
  slayerTargetAllowed: (enemy: Enemy) => boolean
  choiceSatisfied: boolean
  switchChoiceReady: boolean
  onEnemyClick: (enemy: Enemy) => void
  onAllyClick: (ally: Player) => void
  onEndTurnOrbPointerDown: (player: Player, event: PointerEvent<HTMLDivElement>) => void
  onEndTurnEffectPointerMove: (event: PointerEvent<HTMLElement>) => void
  finishEndTurnEffectDrag: (event: PointerEvent<HTMLElement>) => void
  cancelEndTurnEffectDrag: (event: PointerEvent<HTMLElement>) => void
  evokePlannedOrbs: (OrbType | null)[] | undefined
  evokeChoiceOptions: readonly { slot: number }[] | undefined
  evokeChoicePlayerId: string
  creativeAiEffect: { anyNumber?: boolean } | undefined
  powerOrbSlots: number[]
  endTurnEffect: EndTurnAbility | undefined
  canResolveEndTurn: boolean
  chooseStartTurnEvoke: (slot: number) => void
  onEvokeClick: (slot: number) => void
  chooseCreativeAiOrb: (slot: number) => void
  endTurnTargetForOrb: (playerId: string, slot: number) => string | null
  suppressEndTurnOrbClick: { current: string | null }
  resolveTurnEffectTarget: (abilityId: string, targetUid: string) => void
}

export function CombatStage({
  state,
  viewer,
  viewerId,
  rows,
  bosses,
  stageEnemies,
  facingEnemies,
  liveFacingEnemies,
  boardRef,
  viewerRowRef,
  setPointedEnemyUid,
  prefersReducedMotion,
  characterAttacksActive,
  falling,
  targetPresentationTimings,
  visualResetKey,
  hits,
  enemyVfxFor,
  actorVfxFor,
  playerVfxFor,
  orbEndTurnRevealDelayMs,
  livePresentationEvents,
  finishSlimeCommand,
  expiredCultistPhase,
  activeEnemyPhaseKey,
  onCultistThrowPrepared,
  onCultistThrowStart,
  onCultistThrowSkipped,
  characterAttackAssets,
  characterAttackBlobs,
  stagedPosesReady,
  monogatariPosesReady,
  monogatariEvokeReady,
  monogatariEvokesReadyByEvent,
  characterAttacks,
  slimeCommandMotions,
  setSlimeLayoutVersion,
  showSlimeCard,
  hideSlimeCard,
  pendingStartEnemy,
  pendingStartPlayer,
  pendingStartEvoke,
  startEnemyChoiceAvailable,
  pendingShivProgress,
  isEndTurnEnemyTarget,
  cardDrag,
  cardDragTargetRow,
  endTurnEffectDrag,
  armedEndTurnAbilityId,
  isStartTurnEnemyTarget,
  pendingTrigger,
  triggerHermitChoicesReady,
  triggerSlimeEnemyUids,
  triggerSlimeEnemyAmount,
  isEnemyRowClickTargetable,
  isRowLaneClickTargetable,
  rowLaneClickLabel,
  onRowLaneClick,
  pendingPotion,
  pendingPotionNeedsEnemy,
  pendingPotionOverflow,
  pendingPowerNeedsEnemy,
  pendingPowerNeedsAlly,
  pendingPowerDef,
  pendingHermitPower,
  powerLoadUids,
  spendingShiv,
  spendingSoulburn,
  pending,
  slimeEnemyChoicesRequired,
  loadedTargetCount,
  pendingEvokeTarget,
  pendingEvokeUsesRows,
  pendingEvokeTargetUids,
  enemyChoicesDone,
  independentEnemyPending,
  independentPlayerPending,
  slayerTargetAllowed,
  choiceSatisfied,
  switchChoiceReady,
  onEnemyClick,
  onAllyClick,
  onEndTurnOrbPointerDown,
  onEndTurnEffectPointerMove,
  finishEndTurnEffectDrag,
  cancelEndTurnEffectDrag,
  evokePlannedOrbs,
  evokeChoiceOptions,
  evokeChoicePlayerId,
  creativeAiEffect,
  powerOrbSlots,
  endTurnEffect,
  canResolveEndTurn,
  chooseStartTurnEvoke,
  onEvokeClick,
  chooseCreativeAiOrb,
  endTurnTargetForOrb,
  suppressEndTurnOrbClick,
  resolveTurnEffectTarget,
}: CombatStageProps) {
  function isEnemyDisabled(enemy: Enemy): boolean {
    return Boolean(pendingStartEnemy?.id.startsWith('facing:') && !startEnemyChoiceAvailable(enemy.uid) ||
      pendingShivProgress && !pendingShivProgress.options.some((option) => option.uid === enemy.uid))
  }

  function isEnemyTargeted(enemy: Enemy): boolean {
    return (isEndTurnEnemyTarget(enemy) ||
      cardDrag?.targetUid === enemy.uid ||
      cardDragTargetRow !== undefined && (cardDragTargetRow === enemy.row || enemy.isBoss) ||
      isStartTurnEnemyTarget(enemy.uid) ||
      (pendingTrigger?.playerId === viewer.id && triggerHermitChoicesReady &&
        (pendingTrigger.targets?.some((target) => target.uid === enemy.uid) ||
          triggerSlimeEnemyUids.length < triggerSlimeEnemyAmount)) ||
      isEnemyRowClickTargetable(enemy) ||
      ((pendingPotionNeedsEnemy || pendingPowerNeedsEnemy || (pendingPowerDef && pendingPowerDef.target !== 'row' &&
        (!pendingHermitPower || pendingPowerDef.id === 'hermit_black_wind' && powerLoadUids.length === 1)) || pendingPotionOverflow > 0) || spendingShiv || spendingSoulburn ||
      Boolean(pending && (pending.slimeEnemyUids.length < slimeEnemyChoicesRequired(pending) ||
        pending.hermitEnemyUids.length < loadedTargetCount(pending) ||
        pending.soulburnEnemyUids.length < pending.soulburnChoices)) || (
      ((pendingEvokeTarget < 0 && (pending?.needsEnemy === true && !enemyChoicesDone || independentEnemyPending) &&
        slayerTargetAllowed(enemy) && (!pendingShivProgress ||
          pendingShivProgress.options.some((option) => option.uid === enemy.uid))) ||
        (pendingEvokeTarget >= 0 && !pendingEvokeUsesRows && pendingEvokeTargetUids.has(enemy.uid))) && choiceSatisfied
    ))) && !enemy.dead
  }

  function splitAttackEventsFor(enemy: Enemy) {
    return (state.presentationEvents ?? []).flatMap(event => {
      const weights = event.enemyIds.includes(enemy.uid) && splitAttackWeights(state, event)
      return weights ? [{ seq: event.seq, weights,
        damage: event.enemyHpLoss ? event.enemyHpLoss[enemy.uid] ?? 0 : undefined }] : []
    })
  }

  return (
    <div
      className="board"
      data-rows={rows.length}
      data-slime-formation={state.players.some(player => player.character === 'slime_boss') || undefined}
      data-crowded={livingEnemies(state).length >= 3 || undefined}
      data-character-attack-assets-ready={characterAttackAssets.split('|').filter(src => characterAttackBlobs.has(src)).length || undefined}
      ref={boardRef}
      tabIndex={0}
      aria-label="Combat board"
      onPointerOver={(event) => {
        const enemyUid = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-enemy-id]')?.dataset.enemyId : undefined
        if (enemyUid) setPointedEnemyUid(enemyUid)
      }}
    >
      {bosses.length > 0 ? (
        <div className="board__bosses">
          {bosses.map((enemy, index) => (
            <EnemyCard
              key={enemy.uid}
              enemy={enemy}
              enemies={state.enemies}
              label={enemyLabel(state.enemies, enemy)}
              die={state.die}
              acting={state.phase === 'enemy' && !prefersReducedMotion}
              animateArt={!prefersReducedMotion}
              deferBossAttack={characterAttacksActive}
              falling={falling.has(enemy.uid)}
              visualContactMs={prefersReducedMotion ? 0 : targetPresentationTimings.get(enemy.uid)?.contact}
              visualEventSeq={targetPresentationTimings.get(enemy.uid)?.event?.seq}
              visualResetKey={visualResetKey}
              stageVisualDamage={!prefersReducedMotion}
              splitAttackEvents={splitAttackEventsFor(enemy)}
              hitBeats={hits.get(enemy.uid)}
              vfx={enemyVfxFor(enemy)}
              rangedTargetPlayerIds={enemyAttackTargetPlayerIds(state, enemy)}
              cancelPendingThrow={state.phase === 'enemy' && enemyAttackArrivalMsFor(enemy.defId) !== undefined && expiredCultistPhase === activeEnemyPhaseKey}
              onThrowPrepared={onCultistThrowPrepared}
              onThrowStart={onCultistThrowStart}
              onThrowSkipped={onCultistThrowSkipped}
              // Stage slots count from the right; bosses retain printed left-to-right order.
              stageIndex={stageEnemies.length + bosses.length - 1 - index}
              // A boss stands in every row, so the only reading that means
              // anything to the person looking at the screen is their own.
              defender={viewer}
              disabled={isEnemyDisabled(enemy)}
              targeted={isEnemyTargeted(enemy)}
              onClick={onEnemyClick}
            />
          ))}
        </div>
      ) : null}

      {rows.map((row) => {
        const occupant = state.players.find((player) => player.row === row)
        const facingEnemy = liveFacingEnemies.find((enemy) => enemy.uid === occupant?.facingEnemyUid)
        const facingName = facingEnemy ? enemyDef(facingEnemy.defId, facingEnemy.ascension).name : undefined
        const facingAway = occupant?.facingEnemyUid === null && state.startTurnStage !== 'facing' && liveFacingEnemies.length === 1
        const facingDescription = facingName ? `Facing ${facingName}` : facingAway
          ? `Facing away from ${enemyDef(liveFacingEnemies[0]!.defId, liveFacingEnemies[0]!.ascension).name}` : undefined
        const occupantVisual = occupant ? playerVisualId(occupant) : undefined
        const occupantAttackVisual = isMonogatariVisual(occupantVisual) ? occupant?.character : occupantVisual
        const foes = stageEnemies.filter((enemy) => enemy.row === row)
        const emptyRowTargetable = foes.length === 0 && isRowLaneClickTargetable(row)
        const actorEvents = occupant ? actorVfxFor(occupant.id) : []
        const monogatariEvokes = !prefersReducedMotion && !occupant?.dead && occupantVisual === 'monogatari_defect'
          ? actorEvents.flatMap(({ event }) => event.kind === 'orb' && event.sourceId === 'orb-evoke' &&
            event.orb !== 'frost' && event.enemyIds.length > 0 ? [event] : []) : []
        const evokePose = monogatariEvokes.filter(monogatariEvokeReady).at(-1)
        const evokeHoldCast = evokePose ? monogatariEvokesReadyByEvent.current
          .get(`${state.combatId}:${evokePose.seq}`)?.holdCast ?? false : false
        const actorVfx = actorEvents.filter(({ event }) => event.enemyIds.length === 0 &&
          !(occupant?.character === 'defect' && event.kind === 'orb' && event.sourceId === 'orb-evoke'))
        const characterAttackMotions = occupant ? characterAttacks[occupant.id] ?? [] : []
        const characterAttack = characterAttackMotions.filter(attack => !attack.interrupted).at(-1)
        const latestCharacterAttackSeq = characterAttack?.active.event.seq
        const slimeSpawnEvent = !prefersReducedMotion && occupant?.character === 'slime_boss'
          ? livePresentationEvents.filter((event) => event.kind === 'card' &&
              event.actorId === occupant.id && occupant.slimes.some((slime) => slime.card.defId === event.sourceId)).at(-1)
          : undefined
        const slimeCommandEvents = new Map(livePresentationEvents.flatMap((event) =>
          event.kind === 'slime' && event.actorId === occupant?.id
            ? [[event.slimeUid, event] as const]
            : []))
        const occupantHeat = occupant?.character === 'hexaghost'
          ? Math.max(0, Math.min(6, occupant.heat))
          : 0
        const rigId = occupant?.character === 'hexaghost' ? `hexaghost-heat-${occupantHeat}`
          : occupant?.character === 'guardian' && occupant.guardianMode === 'defense' ? 'guardian-defense'
          : occupantVisual
        const characterAttackAsset = assetPath(`combat/rigged/hero-${rigId}-attack.webp`)
        const stagedSpec = occupantVisual ? stagedAttackOf(occupantVisual) : undefined
        const characterIdleAsset = occupantVisual === 'watcher'
          ? assetPath('combat/characters/watcher-hero.webp')
          : stagedSpec || isMonogatariVisual(occupantVisual) ? stagedIdleAsset(occupantVisual!)
          : assetPath(`combat/rigged/hero-${rigId}-idle.webp`)
        const characterArtScale = prefersReducedMotion || occupant?.dead || occupantVisual === 'watcher' ? 1
          : stagedSpec ? stagedSpec.displayScale
          : (rigMetadata as Record<string, { scale?: number }>)[`hero-${rigId}`]?.scale ?? 1
        // Where the painted head ends, so held potions and Orbs float just above it.
        const animatedPortrait = !prefersReducedMotion && !occupant?.dead && !slimeSpawnEvent
        const heroHeads = heroArtHeads as Record<string, number[]>
        // A skin may paint its own summon drawing (`<skin>-spawn.webp`) and calibrate its head; otherwise the idle drawing shows.
        const heroHead = ((slimeSpawnEvent && heroHeads[`${occupantVisual}-spawn`]) || (rigId ? heroHeads[rigId] : undefined))?.[animatedPortrait ? 0 : 1]
        const guardianShiftHead = occupantVisual === 'guardian' ? heroHeads['guardian-transition']?.[0] : undefined
        return (
          <div
            className={['row', occupant?.id === viewerId ? 'row--viewer' : ''].filter(Boolean).join(' ')}
            key={row}
            ref={occupant?.id === viewerId ? viewerRowRef : undefined}
            style={{
              '--stage-row': rows.indexOf(row),
              '--stage-player-index': state.players.filter((player) => player.row > row).length,
            } as React.CSSProperties}
          >
            <div className="row__seat">
              {occupant ? (
                <>
                  <div className="seat__interactive" data-player-id={occupant.id} data-character={occupantVisual}
                    style={heroHead === undefined ? undefined : {
                      '--hero-art-head-height': `calc(var(--stage-actor-width) * ${+(heroHead * (slimeSpawnEvent ? 1 : characterArtScale)).toFixed(4)})`,
                      '--hero-shift-head-height': guardianShiftHead === undefined ? undefined
                        : `calc(var(--stage-actor-width) * ${guardianShiftHead})`,
                    } as React.CSSProperties}
                    onPointerDown={(event) => onEndTurnOrbPointerDown(occupant, event)}
                    onPointerMove={onEndTurnEffectPointerMove}
                    onPointerUp={finishEndTurnEffectDrag}
                    onPointerCancel={cancelEndTurnEffectDrag}
                    onLostPointerCapture={cancelEndTurnEffectDrag}>
                    <button
                    type="button"
                    className={[
                      'seat',
                      occupant.id === viewerId ? 'seat--viewer' : '',
                      occupant.dead ? 'seat--dead' : '',
                      falling.has(occupant.id) ? 'seat--falling' : '',
                      characterAttack ? `seat--attack-${occupantAttackVisual}` : '',
                      (!occupant.dead && ((pendingPotion !== null && potionDef(pendingPotion).supportTarget === 'anyPlayer') ||
                        pendingPowerNeedsAlly ||
                        pendingStartPlayer?.players?.some((player) => player.id === occupant.id) ||
                        cardDrag?.needsPlayer ||
                        (independentPlayerPending && enemyChoicesDone && choiceSatisfied) ||
                        (pending?.needsAlly && pending.playerId === null && enemyChoicesDone && choiceSatisfied) ||
                        (switchChoiceReady && occupant.id !== viewerId))
                      )
                        ? 'seat--targetable'
                        : '',
                      cardDrag?.targetPlayerId === occupant.id ||
                        endTurnEffectDrag?.targetUid === occupant.id ||
                        armedEndTurnAbilityId === pendingStartPlayer?.id &&
                          pendingStartPlayer.players?.some((player) => player.id === occupant.id)
                        ? 'seat--targeted' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onAllyClick(occupant)}
                    data-player-id={occupant.id}
                    data-stance={occupant.stance}
                    data-attack-target={characterAttack?.targetId}
                    style={characterAttack ? {
                      '--attack-x': `${characterAttack.x}px`,
                      '--attack-y': `${characterAttack.y}px`,
                      '--silent-attack-duration': `${1900 + Math.max(0,
                        ...characterAttackMotions.map((attack) => attack.targets.length - 1)) * 70}ms`,
                    } as React.CSSProperties : undefined}
                    aria-label={`${describeSeat(occupant)}${facingDescription ? `. ${facingDescription}` : ''}${pendingStartPlayer?.players?.some((player) =>
                      player.id === occupant.id) ? `. Target for ${pendingStartPlayer.label}` : ''}`}
                  >
                    <span className="seat__portrait" aria-hidden="true" style={{ '--character-art-scale': characterArtScale } as React.CSSProperties}>
                      {occupant.character === 'watcher' && occupant.stance !== 'neutral' ? (
                        <span className={`stance-aura stance-aura--${occupant.stance}`} />
                      ) : null}
                      {occupantVisual === 'guardian' && occupant.guardianMode ? (
                        <GuardianPortrait
                          mode={occupant.guardianMode}
                          animate={!prefersReducedMotion && !occupant.dead}
                          restartKey={characterAttack?.active.event.seq ?? 'idle'}
                        />
                      ) : !prefersReducedMotion && !occupant.dead && !slimeSpawnEvent ? (
                        <CombatAnimation
                          key={`${occupantVisual}-${occupantHeat}`}
                          src={characterIdleAsset}
                          data-vfx-seq={characterAttack?.active.event.seq}
                          onError={(image) => { image.style.display = 'none' }}
                        />
                      ) : (
                        <img
                          key={`${occupantVisual}-${occupantHeat}-${slimeSpawnEvent?.seq ?? characterAttack?.active.event.seq ?? 'idle'}`}
                          data-static-art={Boolean(slimeSpawnEvent) || undefined}
                          src={assetPath(occupantVisual === 'hexaghost'
                            ? `combat/characters/hexaghost-heat-${occupantHeat}.webp`
                            : `combat/characters/${occupantVisual}-${slimeSpawnEvent ? 'spawn' : 'hero'}.webp`)}
                          data-vfx-seq={characterAttack?.active.event.seq}
                          alt=""
                          onError={(event) => {
                            if (slimeSpawnEvent && event.currentTarget.dataset.fallback !== 'true') {
                              event.currentTarget.dataset.fallback = 'true'
                              event.currentTarget.src = assetPath(`combat/characters/${occupantVisual}-hero.webp`)
                            } else event.currentTarget.style.display = 'none'
                          }}
                        />
                      )}
                      {characterAttackMotions.map((characterAttack) => (
                        <span
                          className={`character-attack character-attack--${occupantAttackVisual}${isMonogatariVisual(occupantVisual) ? ` character-attack--${occupantVisual}` : ''}`}
                          data-attack-seq={characterAttack.active.event.seq}
                          data-attack-target-count={characterAttack.targets.length}
                          data-guardian-mode={occupantVisual === 'guardian' ? occupant.guardianMode ?? 'attack' : undefined}
                          key={characterAttack.active.event.seq}
                          style={{
                            '--attack-x': `${characterAttack.x}px`,
                            '--attack-y': `${characterAttack.y}px`,
                            ...(occupantVisual === 'monogatari_defect' ? {
                              '--monogatari-cast-x': `${monogatariPosesReady(occupantVisual, characterAttack.active.event.seq) ? 71 : 49.7}%`,
                              '--monogatari-cast-height': `${monogatariPosesReady(occupantVisual, characterAttack.active.event.seq) ? 52.2 : 51.8}cqw`,
                            } : {}),
                          } as React.CSSProperties}
                        >
                          {characterAttack.active.event.seq === latestCharacterAttackSeq || occupantVisual === 'hermit' ? (
                            isMonogatariVisual(occupantVisual) ? <MonogatariAttackPose
                              visual={occupantVisual!} ready={monogatariPosesReady(occupantVisual!, characterAttack.active.event.seq)}
                            /> : occupantVisual === 'ironclad' ? <>
                              <span className="character-attack__pose character-attack__pose--ironclad-ready">
                                <img src={assetPath('combat/characters/ironclad-ready.webp')} alt="" />
                              </span>
                              <span className="character-attack__pose character-attack__pose--ironclad-impact">
                                <img src={assetPath('combat/characters/ironclad-impact.webp')} alt="" />
                              </span>
                            </> : occupantVisual === 'watcher' ? <>
                              <span className="character-attack__pose character-attack__pose--watcher-charge">
                                <img src={assetPath('combat/characters/watcher-ready.webp')} alt="" />
                              </span>
                              <span className="character-attack__pose character-attack__pose--watcher-cast">
                                <img src={assetPath('combat/characters/watcher-thrust.webp')} alt="" />
                              </span>
                            </> : stagedSpec ? <StagedAttackPose
                              visual={occupantVisual!} spec={stagedSpec}
                              ready={stagedPosesReady(occupantVisual!, stagedSpec, characterAttack.active.event.seq)}
                            /> : <CharacterAttackPose
                              key={characterAttack.active.event.seq}
                              attackSeq={characterAttack.active.event.seq}
                              hermitEvent={occupantVisual === 'hermit' ? characterAttack.active.event : undefined}
                              firing={characterAttack.active.event.seq === latestCharacterAttackSeq}
                              assetPath={characterAttackAsset}
                              fallbackAsset={characterIdleAsset}
                              asset={characterAttackBlobs.get(characterAttackAsset)}
                            />
                          ) : null}
                          {occupantVisual === 'watcher' ? (
                            <>
                              {characterAttack.targets.map((target, index) => (
                                <span
                                  className="character-attack__meteor"
                                  data-attack-target-id={target.id}
                                  key={target.id}
                                  style={{
                                    '--attack-target-x': `${target.x}px`,
                                    '--attack-target-y': `${target.y}px`,
                                    '--attack-start-x': `${target.startX}px`,
                                    '--attack-start-y': `${target.startY}px`,
                                    '--attack-delay': `${index * 70}ms`,
                                  } as React.CSSProperties}
                                >
                                  <img
                                    className="character-attack__meteor-art"
                                    src={assetPath('combat/vfx/actions/watcher-meteor.webp')}
                                    alt=""
                                  />
                                  <img
                                    className="character-attack__meteor-impact"
                                    src={assetPath('combat/vfx/actions/watcher-meteor-impact.webp')}
                                    alt=""
                                  />
                                </span>
                              ))}
                            </>
                          ) : null}
                          {occupantAttackVisual === 'ironclad' &&
                          characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                            <span className="character-attack__swing" />
                          ) : null}
                          {stagedSpec ? <StagedImpacts event={characterAttack.active.event} visual={occupantVisual!} spec={stagedSpec} /> : null}
                          {occupant?.character === 'defect' &&
                          characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                            <>
                              <span className="character-attack__core">
                                <img src={assetPath('combat/vfx/actions/defect-face-orb.webp')} alt="" />
                              </span>
                            </>
                          ) : null}
                          {(occupantVisual === 'silent' || occupant?.character === 'defect')
                            ? characterAttack.targets.map((target, index) => (
                              <span
                                className={occupantVisual === 'silent'
                                  ? 'character-attack__dagger'
                                  : 'character-attack__bolt'}
                                data-attack-target-id={target.id}
                                key={target.id}
                                style={{
                                  '--attack-target-x': `${target.x}px`,
                                  '--attack-target-y': `${target.y}px`,
                                  '--attack-delay': `${index * 70}ms`,
                                } as React.CSSProperties}
                              >
                                {occupantVisual === 'silent'
                                  ? <img src={assetPath('combat/vfx/actions/silent-knife.webp')} alt="" />
                                  : <img src={assetPath('combat/vfx/actions/defect-face-orb.webp')} alt="" />}
                              </span>
                            ))
                            : null}
                          {occupantVisual === 'hexaghost'
                            ? characterAttack.targets.map((target, index) => (
                              <span
                                className="character-attack__hexaghost-flame"
                                data-attack-target-id={target.id}
                                key={target.id}
                                style={{
                                  '--attack-target-x': `${target.x}px`,
                                  '--attack-target-y': `${target.y}px`,
                                  '--attack-delay': `${index * 70}ms`,
                                } as React.CSSProperties}
                              >
                                <img src={assetPath('combat/vfx/actions/hexaghost-flame.webp')} alt="" />
                              </span>
                            ))
                            : null}
                        </span>
                      ))}
                      {evokePose ? <MonogatariEvokePose key={`pose-${evokePose.seq}`} event={evokePose} holdCast={evokeHoldCast} /> : null}
                      {!prefersReducedMotion && !occupant.dead && occupant?.character === 'defect' ? actorEvents.map(({ event }) =>
                        event.kind === 'orb' && event.sourceId === 'orb-evoke'
                          ? <DefectEvokeVfx key={`evoke-${event.seq}`} event={event} visual={occupantVisual}
                            handCast={monogatariEvokes.includes(event) && monogatariEvokeReady(event)} /> : null) : null}
                      {actorVfx.map((active) => (
                        <CombatVfx key={`actor-${active.event.seq}-${active.recipe.asset}`} active={active} role="actor"
                          revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)} />
                      ))}
                      {playerVfxFor(occupant.id).map((active) => (
                        <CombatVfx key={`target-${active.event.seq}-${active.recipe.asset}`} active={active} role="target"
                          revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)} />
                      ))}
                    </span>
                    {(hits.get(occupant.id) ?? []).map((hit) => (
                      <span
                        className="hit-vfx"
                        key={hit.beat}
                        aria-hidden="true"
                        style={{ '--hit-delay': `${hit.delayMs}ms` } as React.CSSProperties}
                      >
                        <strong>{hit.damage}</strong>
                      </span>
                    ))}
                    <span className="seat__name">
                      <span className="seat__label">{occupant.name}</span>
                      {facingDescription ? (
                        <span className="seat__facing" title={facingDescription}>
                          → {facingName?.replace(/^Spire /, '') ?? 'Away'}
                        </span>
                      ) : null}
                    </span>
                    <span className="bar">
                      <span
                        className="bar__fill bar__fill--hp"
                        data-health={healthBand(occupant.hp, occupant.maxHp)}
                        style={{ width: `${Math.round((occupant.hp / occupant.maxHp) * 100)}%` }}
                      />
                      <span className="bar__label">
                        {occupant.hp}/{occupant.maxHp}
                      </span>
                    </span>
                    <span className="seat__meta">
                    {occupant.strengthLossAtEndOfTurn > 0 ? (
                      <span className="seat__pending">
                        −{occupant.strengthLossAtEndOfTurn} Strength at end of turn
                      </span>
                    ) : null}
                    {occupant.drawLocked ? (
                      <span className="seat__pending">Cannot draw more cards this turn</span>
                    ) : null}
                    {occupant.cardPlayLocked ? (
                      <span className="seat__pending">No additional cards this turn</span>
                    ) : null}
                    {(occupant.freeAttacksThisTurn ?? 0) > 0 ? (
                      <span className="seat__pending">Swivel · next Attack costs 0 this turn</span>
                    ) : null}
                    {(occupant.doubledAttacksThisTurn ?? 0) > 0 ? (
                      <span className="seat__pending">
                        Double Tap · next {occupant.doubledAttacksThisTurn} Attack{
                          occupant.doubledAttacksThisTurn === 1 ? '' : 's'
                        } played twice
                      </span>
                    ) : null}
                    {(occupant.tripledAttacksThisTurn ?? 0) > 0 ? (
                      <span className="seat__pending">
                        Blasphemy · next {occupant.tripledAttacksThisTurn} Attack{
                          occupant.tripledAttacksThisTurn === 1 ? '' : 's'
                        } played three times
                      </span>
                    ) : null}
                    {(occupant.doubledCardsThisTurn ?? 0) > 0 ? (
                      <span className="seat__pending">
                        Echo Form · next {occupant.doubledCardsThisTurn} Attack or Skill card{
                          occupant.doubledCardsThisTurn === 1 ? '' : 's'
                        } played twice
                      </span>
                    ) : null}
                    {(occupant.doubledSkillsThisTurn ?? 0) > 0 ? (
                      <span className="seat__pending">
                        Burst · next {occupant.doubledSkillsThisTurn} Skill{
                          occupant.doubledSkillsThisTurn === 1 ? '' : 's'
                        } played twice
                      </span>
                    ) : null}
                    {remainingRoundHpLoss(occupant) !== undefined ? (
                      <span className="seat__pending">
                        {occupant.powers.some((power) => power.defId === 'wraith_form') ? 'Wraith Form' : 'Apparition'} · {remainingRoundHpLoss(occupant)} HP loss remaining
                      </span>
                    ) : null}
                    {occupant.potions.length > 0 ? (
                      <span className="seat__potions">
                        {occupant.potions.map((id, index) => <PotionIcon id={id} focusable={false}
                          key={`${id}-${index}`} />)}
                      </span>
                    ) : null}
                    </span>
                  </button>
                  {occupant.character === 'slime_boss' && occupant.slimes.length > 0 ? (
                    <span className="slime-party combat__slime-status" role="list"
                      aria-label={`${occupant.name}'s Slimes`}>
                      {occupant.slimes.map((slime) => {
                        const def = faceOf(cardDef(slime.card.defId), slime.card.upgraded)
                        const name = def.name.replace(/ Slime\+?$/, '')
                        const commandReady = def.slimeCommandLimit === undefined ||
                          slime.commandsThisTurn < def.slimeCommandLimit
                        const commandText = slimeCommandText(def, slime.level)
                        const slug = slimeAssetSlug(def.id)
                        const commandEvent = prefersReducedMotion
                          ? undefined
                          : slimeCommandEvents.get(slime.card.uid)
                        const commandMotion = occupant
                          ? slimeCommandMotions[`${occupant.id}:${slime.card.uid}`]
                          : undefined
                        const activeCommandMotion = commandEvent && commandMotion?.seq === commandEvent.seq
                          ? commandMotion
                          : undefined
                        const activeCommandEvent = activeCommandMotion ? commandEvent : undefined
                        return <span
                            key={`${slime.card.uid}:${activeCommandEvent?.seq ?? 'idle'}`}
                            className={[
                              'slime-party__actor combat__slime-chip',
                              commandReady ? '' : 'slime-party__actor--spent',
                              activeCommandEvent ? 'slime-party__actor--commanding' : '',
                            ].filter(Boolean).join(' ')}
                            role="listitem"
                            tabIndex={0}
                            onMouseEnter={(event) => showSlimeCard(slime.card, event.currentTarget)}
                            onMouseLeave={(event) => {
                              if (document.activeElement !== event.currentTarget) hideSlimeCard()
                            }}
                            onFocus={(event) => showSlimeCard(slime.card, event.currentTarget)}
                            onBlur={hideSlimeCard}
                            onAnimationEnd={(event) => {
                              if (event.target === event.currentTarget && event.animationName === 'slime-party-command' && activeCommandEvent) {
                                finishSlimeCommand(activeCommandEvent.seq)
                              }
                            }}
                            data-slime-uid={slime.card.uid}
                            data-slime-def={def.id}
                            data-slime-level={slime.level}
                            data-slime-vigor={slime.vigor > 0 ? `+${slime.vigor}` : ''}
                            style={activeCommandMotion ? {
                              '--slime-command-x': `${activeCommandMotion.x}px`,
                              '--slime-command-y': `${activeCommandMotion.y}px`,
                            } as React.CSSProperties : undefined}
                            aria-label={`${def.name}, level ${slime.level}, Strength ${slime.vigor}, ` +
                              `${slime.commandsThisTurn} Commands this turn, ` +
                              `${commandReady ? 'ready to Command' : 'Command limit reached'}, ` + commandText}>
                            <img
                              className="slime-party__art"
                              key={slime === occupant.slimes[0] ? 'first' : 'following'}
                              src={assetPath(`combat/slimes/${slug}.webp`)}
                              onLoad={(event) => {
                                const image = event.currentTarget
                                const party = image.closest<HTMLElement>('.slime-party')
                                if (party?.firstElementChild === image.parentElement) {
                                  const inset = String(0.025 + 0.95 * paintedLeft(image))
                                  if (party.style.getPropertyValue('--slime-first-inset') !== inset) {
                                    party.style.setProperty('--slime-first-inset', inset)
                                    setSlimeLayoutVersion(version => version + 1)
                                  }
                                }
                              }}
                              alt=""
                              onError={(event) => {
                                if (event.currentTarget.dataset.fallback === 'true') {
                                  event.currentTarget.style.display = 'none'
                                  return
                                }
                                event.currentTarget.dataset.fallback = 'true'
                                event.currentTarget.src = assetPath(slimeFallbackAsset(def.id))
                              }}
                            />
                            {activeCommandEvent ? (
                              <img
                                className="slime-party__command"
                                key={activeCommandEvent.seq}
                                data-command-seq={activeCommandEvent.seq}
                                src={assetPath(`combat/slimes/${slug}.webp`)}
                                alt=""
                                onError={(event) => {
                                  event.currentTarget.style.display = 'none'
                                  const idle = event.currentTarget.parentElement?.querySelector<HTMLElement>('.slime-party__art')
                                  if (idle) idle.style.opacity = '1'
                                }}
                              />
                            ) : null}
                            <span className="slime-party__level" aria-hidden="true">{slime.level}</span>
                            <span className="slime-party__summary" aria-hidden="true">
                              {name} · L{slime.level} · Strength {slime.vigor} · Cmd {slime.commandsThisTurn}
                            </span>
                          </span>
                      })}
                    </span>
                  ) : null}
                  <OrbRow
                    player={evokePlannedOrbs && occupant.id === evokeChoicePlayerId
                      ? { ...occupant, orbs: evokePlannedOrbs }
                      : occupant}
                    targetVerb={evokeChoiceOptions && occupant.id === evokeChoicePlayerId ? 'Evoke'
                      : creativeAiEffect && occupant.id === viewer.id ? 'Remove' : undefined}
                    selectedSlots={creativeAiEffect?.anyNumber && occupant.id === viewer.id ? powerOrbSlots : undefined}
                    targetableSlots={evokeChoiceOptions && occupant.id === evokeChoicePlayerId
                      ? evokeChoiceOptions.map((option) => option.slot)
                      : creativeAiEffect && occupant.id === viewer.id
                      ? occupant.orbs.flatMap((orb, slot) => orb ? [slot] : [])
                      : endTurnEffect?.orbChoice && canResolveEndTurn && occupant.id === endTurnEffect.playerId
                      ? endTurnEffect.targets?.flatMap((target) => {
                        const slot = Number(target.uid.slice(4))
                        return target.uid.startsWith('orb:') && Number.isInteger(slot) ? [slot] : []
                      })
                      : []}
                    onTarget={(slot) => {
                      if (evokeChoiceOptions && occupant.id === evokeChoicePlayerId) {
                        if (pendingStartEvoke) chooseStartTurnEvoke(slot)
                        else onEvokeClick(slot)
                        return
                      }
                      if (creativeAiEffect && occupant.id === viewer.id) {
                        chooseCreativeAiOrb(slot)
                        return
                      }
                      const targetUid = endTurnTargetForOrb(occupant.id, slot)
                      if (targetUid && suppressEndTurnOrbClick.current === targetUid) {
                        suppressEndTurnOrbClick.current = null
                        return
                      }
                      if (targetUid && endTurnEffect) {
                        resolveTurnEffectTarget(endTurnEffect.id, targetUid)
                      }
                    }}
                  />
                  </div>
                  <div className="seat__status-strip" data-guardian-mode={occupant.guardianMode ?? undefined} tabIndex={0}
                    aria-label={`${occupant.name} combat effects`}>
                    <TokenRow
                      block={occupant.block}
                      strength={occupant.strength}
                      vigorSpent={occupant.vigorSpentThisTurn}
                      vulnerable={occupant.vulnerable}
                      weak={occupant.weak}
                      shivs={occupant.shivs}
                      miracles={occupant.miracles}
                      clawCubes={occupant.clawCubesGainedThisCombat}
                    />
                    <PowerRow powers={occupant.powers} />
                  </div>
                </>
              ) : null}
            </div>
            <div className={`row__enemies${emptyRowTargetable ? ' row__enemies--targetable' : ''}`}
              data-enemies={foes.length} data-row={emptyRowTargetable ? row : undefined}
              role={emptyRowTargetable ? 'button' : undefined}
              tabIndex={emptyRowTargetable ? 0 : undefined}
              aria-label={emptyRowTargetable ? `${rowLaneClickLabel(row)}${bosses.some((enemy) => !enemy.dead)
                ? ' (the boss is hit)' : ''}` : undefined}
              onClick={emptyRowTargetable ? () => onRowLaneClick(row) : undefined}
              onKeyDown={emptyRowTargetable ? (event) => {
                if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  onRowLaneClick(row)
                }
              } : undefined}>
              {foes.length > 0 ? (
                foes.map((enemy) => (
                  <EnemyCard
                    key={enemy.uid}
                    enemy={enemy}
                    enemies={state.enemies}
                    label={enemyLabel(state.enemies, enemy)}
                    die={state.die}
                    acting={state.phase === 'enemy' && !prefersReducedMotion}
                    animateArt={!prefersReducedMotion}
                    deferBossAttack={characterAttacksActive}
                    falling={falling.has(enemy.uid)}
                    visualContactMs={prefersReducedMotion ? 0 : targetPresentationTimings.get(enemy.uid)?.contact}
                    visualEventSeq={targetPresentationTimings.get(enemy.uid)?.event?.seq}
                    visualResetKey={visualResetKey}
                    stageVisualDamage={!prefersReducedMotion}
                    splitAttackEvents={splitAttackEventsFor(enemy)}
                    hitBeats={hits.get(enemy.uid)}
                    vfx={enemyVfxFor(enemy)}
                    rangedTargetPlayerIds={enemyAttackTargetPlayerIds(state, enemy)}
                    cancelPendingThrow={state.phase === 'enemy' && enemyAttackArrivalMsFor(enemy.defId) !== undefined && expiredCultistPhase === activeEnemyPhaseKey}
                    onThrowPrepared={onCultistThrowPrepared}
                    onThrowStart={onCultistThrowStart}
                    onThrowSkipped={onCultistThrowSkipped}
                    stageIndex={stageEnemies.findIndex((candidate) => candidate.uid === enemy.uid)}
                    rowLabel={state.players.length === 1 || facingEnemies.some((facing) => facing.uid === enemy.uid) ? undefined : occupant?.name}
                    defender={facingEnemies.some((facing) => facing.uid === enemy.uid)
                      ? state.players.find((player) => !player.dead && player.id === viewerId && player.facingEnemyUid === enemy.uid) ??
                        state.players.find((player) => !player.dead && player.facingEnemyUid === enemy.uid)
                      : occupant}
                    disabled={isEnemyDisabled(enemy)}
                    targeted={isEnemyTargeted(enemy)}
                    onClick={onEnemyClick}
                  />
                ))
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
