import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import {
  cardNeedsEnemy,
  endPlayerTurn,
  enemyTurn,
  needsRowLabel,
  playCard,
  startPlayerTurn,
} from '../game/combat.ts'
import type { CombatState } from '../game/combat.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { Icon, IconValue, dieIcon } from './Icon.tsx'
import { EnemyCard } from './EnemyCard.tsx'
import { PowerRow } from './PowerRow.tsx'
import { TokenRow } from './TokenRow.tsx'
import { healthBand, strikeClass } from './board-signals.ts'

type CombatScreenProps = {
  state: CombatState
  /** The seat this client controls. Everyone sees the same board. */
  viewerId: string
  onChange: (next: CombatState) => void
}

/** What a card still needs before it can be played. */
type Pending = {
  card: CardInstance
  needsEnemy: boolean
  /**
   * The card can land its support on someone other than the caster, as Defend+,
   * True Grit and Vigilance all can. Auto-committing these to the caster would
   * quietly remove the co-op play the card exists for.
   */
  needsAlly: boolean
  /** Cards that must be picked out of hand, as Survivor and True Grit require. */
  choice: { kind: 'discard' | 'exhaust'; amount: number } | null
  picked: string[]
}

/** A round divider in the log, styled apart from the events inside the round. */
const TURN_MARKER = /^Turn \d+ begins/

/**
 * The current round, newest first, plus the divider that opened it.
 *
 * Everything since the last divider — never a fixed tail. A tail silently drops
 * lines, and if the box happens not to overflow there is nothing on screen to
 * say so.
 */
function roundLog(log: readonly string[]): string[] {
  let start = -1
  for (let i = log.length - 1; i >= 0; i--) {
    if (TURN_MARKER.test(log[i]!)) {
      start = i
      break
    }
  }
  const round = start >= 0 ? log.slice(start) : log.slice(-12)
  return [...round].reverse()
}

/** The engine's phase names are for the engine; players get words. */
const PHASE_LABEL: Record<CombatState['phase'], string> = {
  player: 'Your turn',
  enemy: 'Enemies act',
  roundEnd: 'Round over',
  won: 'Victory',
  lost: 'Defeat',
}

function requirementsOf(def: CardDef, allies: number): Omit<Pending, 'card' | 'picked'> {
  // The same predicate the engine uses to decide whether to REFUSE the play.
  // Two copies of this list drifted apart once already: the UI would prompt for
  // an enemy and the engine would then throw the choice away.
  const needsEnemy = cardNeedsEnemy(def)
  // With one player on the board there is nobody to choose between, so asking
  // "who gets it" is a prompt with a single possible answer.
  const needsAlly = !needsEnemy && def.supportTarget === 'anyPlayer' && allies > 1
  const discard = def.effects.find((effect) => effect.kind === 'discard')
  const exhaust = def.effects.find((effect) => effect.kind === 'exhaustFromHand')
  const choice = discard
    ? { kind: 'discard' as const, amount: discard.amount }
    : exhaust
      ? { kind: 'exhaust' as const, amount: exhaust.amount }
      : null
  return { needsEnemy, needsAlly, choice }
}

/** Rows are the board's spatial unit: one per player, enemies sit in them. */
function rowsOf(state: CombatState): number[] {
  const rows = new Set<number>()
  for (const player of state.players) rows.add(player.row)
  for (const enemy of state.enemies) if (!enemy.isBoss) rows.add(enemy.row)
  return [...rows].sort((a, b) => b - a)
}

/**
 * The seat button's accessible name.
 *
 * An `aria-label` replaces the element's contents wholesale, so anything not
 * named here is invisible to a screen reader no matter how it is marked up —
 * which is how the tokens' own hidden labels ended up unreachable. Everything
 * shown on the seat has to be listed.
 */
function describeSeat(player: Player): string {
  const parts = [`${player.name}, ${player.hp} of ${player.maxHp} hit points, row ${player.row}`]
  const tokens: [string, number][] = [
    ['Block', player.block],
    ['Strength', player.strength],
    ['Vulnerable', player.vulnerable],
    ['Weak', player.weak],
    ['Shivs', player.shivs],
    ['Miracles', player.miracles],
  ]
  for (const [label, value] of tokens) if (value > 0) parts.push(`${label} ${value}`)
  for (const orb of player.orbs) if (orb) parts.push(`${orb} orb`)
  if (player.stance !== 'neutral') parts.push(`${player.stance} stance`)
  // Powers are deliberately NOT listed here. They render as a sibling list
  // outside this button, with their own labels — naming them here as well had
  // a screen reader announce every Power twice.
  if (player.dead) parts.push('defeated')
  return parts.join(', ')
}

function canAfford(player: Player, card: CardInstance): boolean {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  if (def.unplayable) return false
  // An evoke with nothing charged is refused by the engine, and a refusal is
  // reference-equality — the UI has no way to explain it. Better to grey the
  // card out than to let the click land and appear to do nothing at all.
  if (def.effects.some((effect) => effect.kind === 'evoke') && player.orbs.every((orb) => !orb)) {
    return false
  }
  return def.cost === 'X' || def.cost <= player.energy
}

/**
 * Ids of everyone whose hit points just dropped, for ~400ms.
 *
 * A hit that only changes a number is a hit the player misses entirely. The
 * flinch animation already existed in the stylesheet; nothing ever applied it.
 */
function useStruck(state: CombatState): { struck: Set<string>; beat: number } {
  const previous = useRef(new Map<string, number>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [struck, setStruck] = useState<Set<string>>(new Set())
  // Bumped on every hit. Two blows on the same target inside the window leave
  // the class name unchanged, and an unchanged class never restarts a CSS
  // animation — so the second hit was not felt at all.
  const [beat, setBeat] = useState(0)

  useEffect(() => {
    const now = new Map<string, number>()
    const hurt = new Set<string>()
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.hp)
      const before = previous.current.get(id)
      if (before !== undefined && entity.hp < before) hurt.add(id)
    }
    previous.current = now
    if (hurt.size === 0) return

    // The timer lives in a ref rather than being cancelled by this effect's
    // cleanup. Cleaning it up there meant any later state change that hurt
    // nobody killed the pending "stop flinching" timer without scheduling a
    // replacement — so the class stuck forever and, being unchanged, never
    // re-triggered the animation again for the rest of the combat.
    setStruck(hurt)
    setBeat((count) => count + 1)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setStruck(new Set())
    }, 380)
  }, [state])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return { struck, beat }
}

export function CombatScreen({ state, viewerId, onChange }: CombatScreenProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const viewerRowRef = useRef<HTMLDivElement | null>(null)
  const viewer = state.players.find((player) => player.id === viewerId)
  const rows = useMemo(() => rowsOf(state), [state])

  const { struck, beat } = useStruck(state)

  // A card staged but never targeted would otherwise keep prompting "Choose an
  // enemy" into the Enemy Turn, highlighting enemies that cannot be clicked —
  // and a staged card also belongs to the seat that staged it, so switching
  // seats must drop it rather than aim another player's hand at the board.
  useEffect(() => {
    setPending(null)
  }, [state.phase, viewerId])

  // Newest-first means a scrolled log stays where the player left it, so a new
  // line lands above the visible area and is never seen.
  const logRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0
  }, [state.log.length])
  const bosses = state.enemies.filter((enemy) => enemy.isBoss)

  // With a full party the board can outgrow the viewport. Rather than shrink
  // everything, keep the row the player actually controls on screen.
  //
  // A layout effect, not a plain one: this must run before paint, or the board
  // is briefly drawn scrolled to the wrong row and then jumps.
  // Also on a phase change: the log grows during the Enemy Turn and the pause,
  // which shrinks the board while `scrollTop` stays where it was — pushing the
  // row you control, and the enemy you are fighting, out of view exactly when
  // you are meant to be reading them.
  useLayoutEffect(() => {
    viewerRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [viewerId, state.turn, state.phase])

  // And again whenever the viewport changes shape. The scroll position is
  // measured in pixels against the old layout, so rotating a phone or resizing
  // a window left the player's own row — and the enemy they are fighting —
  // scrolled off the board.
  useEffect(() => {
    const reveal = () => viewerRowRef.current?.scrollIntoView({ block: 'nearest' })
    window.addEventListener('resize', reveal)
    return () => window.removeEventListener('resize', reveal)
  }, [])

  if (!viewer) return <p className="muted">No seat for {viewerId}.</p>

  const over = state.phase === 'won' || state.phase === 'lost'
  // Mirrors the engine: a cost is paid in full by whatever the hand can give.
  // Demanding the printed count left Survivor played as your LAST card staged
  // for ever — the engine accepts it, the UI could never commit it.
  const choiceNeeded = pending?.choice
    ? Math.min(pending.choice.amount, Math.max(0, viewer.hand.length - 1))
    : 0
  const choiceSatisfied = pending?.choice ? pending.picked.length === choiceNeeded : true

  function commit(next: Pending, enemy: Enemy | null, ally: Player | null) {
    const result = playCard(state, viewer!.id, next.card.uid, {
      enemyUid: enemy?.uid ?? null,
      playerId: ally?.id ?? viewer!.id,
      discardUids: next.choice?.kind === 'discard' ? next.picked : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' ? next.picked : undefined,
    })
    // Reference equality means the engine refused the play.
    if (result !== state) onChange(result)
    setPending(null)
  }

  function onCardClick(card: CardInstance) {
    // While a card is waiting on a choice, clicks in hand pick cards for it.
    if (pending?.choice && card.uid !== pending.card.uid) {
      const already = pending.picked.includes(card.uid)
      const need = Math.min(pending.choice.amount, Math.max(0, viewer!.hand.length - 1))
      const picked = already
        ? pending.picked.filter((uid) => uid !== card.uid)
        : [...pending.picked, card.uid].slice(-need)
      const next = { ...pending, picked }
      setPending(next)
      // True Grit exhausts a card AND blocks any player, so satisfying the
      // choice must not skip the ally step.
      if (!next.needsEnemy && !next.needsAlly && picked.length === need) {
        commit(next, null, viewer!)
      }
      return
    }

    // Clicking the staged card again cancels it.
    if (pending?.card.uid === card.uid) {
      setPending(null)
      return
    }

    const def = faceOf(cardDef(card.defId), card.upgraded)
    const living = state.players.filter((player) => !player.dead).length
    const next: Pending = { card, ...requirementsOf(def, living), picked: [] }
    setPending(next)
    // Only resolve on the spot when there is genuinely nothing left to pick —
    // including a cost the hand is too small to pay anything towards.
    const owed = next.choice
      ? Math.min(next.choice.amount, Math.max(0, viewer!.hand.length - 1))
      : 0
    if (!next.needsEnemy && !next.needsAlly && owed === 0) commit(next, null, viewer!)
  }

  function onEnemyClick(enemy: Enemy) {
    if (!pending || !pending.needsEnemy || !choiceSatisfied) return
    commit(pending, enemy, null)
  }

  function onAllyClick(ally: Player) {
    if (!pending || pending.needsEnemy || !choiceSatisfied) return
    commit(pending, null, ally)
  }

  // Ordered by what the player must do NEXT: an unsatisfied choice first, then
  // whatever target is still outstanding. Showing the choice text after it is
  // satisfied would leave the player stuck looking at a completed instruction.
  const prompt =
    pending?.choice && !choiceSatisfied
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${choiceNeeded} card${
          choiceNeeded === 1 ? '' : 's'
        } — ${pending.picked.length}/${choiceNeeded} chosen`
      : pending?.needsEnemy
        ? 'Choose an enemy'
        : pending?.needsAlly
          ? 'Choose who gets it'
          : null

  return (
    <div className="combat" data-phase={state.phase}>
      <header className="combat__bar">
        <span className="combat__turn">Turn {state.turn}</span>
        <span className="combat__die" title="The round's shared die">
          <Icon name={dieIcon(state.die)} size={26} decorative={false} />
        </span>
        <span className={`combat__phase combat__phase--${state.phase}`}>{PHASE_LABEL[state.phase]}</span>
        <span className="combat__actions">
          {state.phase === 'player' ? (
            <button type="button" onClick={() => onChange(endPlayerTurn(state))}>
              End turn
            </button>
          ) : null}
          {state.phase === 'enemy' ? (
            <button type="button" onClick={() => onChange(enemyTurn(state))}>
              Resolve enemies
            </button>
          ) : null}
          {/* The round has ended and the board is holding still so everyone can
              read what the enemies did. This is the only way into the next
              round; without it the combat simply stops after round one. */}
          {state.phase === 'roundEnd' ? (
            <button type="button" onClick={() => onChange(startPlayerTurn(state))}>
              Start turn {state.turn + 1}
            </button>
          ) : null}
        </span>
      </header>

      {over ? (
        <p className={`combat__result combat__result--${state.phase}`} role="status">
          {state.phase === 'won' ? 'Victory' : 'The party has fallen'}
        </p>
      ) : null}

      {prompt ? (
        <p className="prompt" role="status">
          {prompt}
          <button type="button" className="prompt__cancel" onClick={() => setPending(null)}>
            Cancel
          </button>
        </p>
      ) : null}

      <div className="board" data-rows={rows.length}>
        {bosses.length > 0 ? (
          <div className="board__bosses">
            {bosses.map((enemy) => (
              <EnemyCard
                key={enemy.uid}
                enemy={enemy}
                rowLabel={needsRowLabel(state.enemies, enemy)}
                die={state.die}
                struck={struck.has(enemy.uid)}
                beat={beat}
                targeted={pending?.needsEnemy === true && choiceSatisfied && !enemy.dead}
                onClick={onEnemyClick}
              />
            ))}
          </div>
        ) : null}

        {rows.map((row) => {
          const occupant = state.players.find((player) => player.row === row)
          const foes = state.enemies.filter((enemy) => enemy.row === row && !enemy.isBoss)
          return (
            <div
              className={['row', occupant?.id === viewerId ? 'row--viewer' : ''].filter(Boolean).join(' ')}
              key={row}
              ref={occupant?.id === viewerId ? viewerRowRef : undefined}
            >
              <div className="row__seat">
                {occupant ? (
                  <>
                    <button
                      type="button"
                      className={[
                        'seat',
                        occupant.id === viewerId ? 'seat--viewer' : '',
                        occupant.dead ? 'seat--dead' : '',
                        struck.has(occupant.id) ? strikeClass('seat', beat) : '',
                        pending && !pending.needsEnemy && choiceSatisfied ? 'seat--targetable' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onAllyClick(occupant)}
                      aria-label={describeSeat(occupant)}
                    >
                      <span className="seat__name">{occupant.name}</span>
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
                      <TokenRow
                        orbs={occupant.orbs}
                        block={occupant.block}
                        strength={occupant.strength}
                        vulnerable={occupant.vulnerable}
                        weak={occupant.weak}
                        shivs={occupant.shivs}
                        miracles={occupant.miracles}
                      />
                      {occupant.stance !== 'neutral' ? (
                        <span className={`stance stance--${occupant.stance}`}>{occupant.stance}</span>
                      ) : null}
                    </button>
                    <PowerRow powers={occupant.powers} />
                  </>
                ) : (
                  <span className="seat seat--empty">empty row</span>
                )}
              </div>
              <div className="row__enemies">
                {foes.length === 0 ? (
                  <span className="muted">clear</span>
                ) : (
                  foes.map((enemy) => (
                    <EnemyCard
                      key={enemy.uid}
                      enemy={enemy}
                      rowLabel={needsRowLabel(state.enemies, enemy)}
                      die={state.die}
                      struck={struck.has(enemy.uid)}
                      beat={beat}
                      targeted={pending?.needsEnemy === true && choiceSatisfied && !enemy.dead}
                      onClick={onEnemyClick}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* The round-end pause exists so the table can read what just happened.
          Without the combat log on screen the only trace of the Enemy Turn is
          a hit-point number quietly changing. */}
      {state.log.length > 0 ? (
        <ol className="combat__log" aria-label="Combat log" ref={logRef}>
          {/* Newest first, reversed HERE rather than with `column-reverse`:
              with the CSS trick the newest line is the last DOM child, so it
              is the one the scroll box pushes out of view and `li:first-child`
              highlights the oldest line instead.

              The whole round, not a fixed tail. A four-player enemy turn runs
              to fifteen lines, and a tail of ten dropped an entire "hit for 4"
              without the box even overflowing to hint that anything was
              missing. Scrolling is the only limiter. */}
          {roundLog(state.log).map((line, i) => (
            <li
              key={`${state.log.length - i}-${line}`}
              className={TURN_MARKER.test(line) ? 'combat__log-turn' : undefined}
            >
              {line}
            </li>
          ))}
        </ol>
      ) : null}

      <footer className="hand-area">
        <div className="hand-area__stats">
          <span className="pip pip--energy" title="Energy">
            <IconValue name="energy" value={viewer.energy} size={26} />
          </span>
          <span className="pip" title="Draw pile">
            <span className="pip__label">draw</span> {viewer.draw.length}
          </span>
          <span className="pip" title="Discard pile">
            <span className="pip__label">discard</span> {viewer.discard.length}
          </span>
          <span className="pip" title="Exhaust pile">
            <span className="pip__label">exhaust</span> {viewer.exhaust.length}
          </span>
        </div>
        <div className="hand">
          {viewer.hand.map((card) => (
            <Card
              key={card.uid}
              card={card}
              playable={
                state.phase === 'player' &&
                // While a card is staged, other cards stay clickable only as
                // choice targets; an unaffordable card must never be stageable
                // or it strands the player in a pending state it cannot commit.
                (canAfford(viewer, card) ||
                  pending?.card.uid === card.uid ||
                  (pending?.choice != null && card.uid !== pending.card.uid))
              }
              selected={pending?.card.uid === card.uid}
              picked={pending?.picked.includes(card.uid) === true}
              onClick={onCardClick}
            />
          ))}
          {viewer.hand.length === 0 ? <span className="muted">no cards in hand</span> : null}
        </div>
      </footer>
    </div>
  )
}
