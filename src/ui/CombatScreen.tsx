import { useMemo, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { endPlayerTurn, enemyTurn, playCard, startPlayerTurn } from '../game/combat.ts'
import type { CombatState } from '../game/combat.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { Icon, IconValue, dieIcon } from './Icon.tsx'
import { EnemyCard } from './EnemyCard.tsx'
import { TokenRow } from './TokenRow.tsx'

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

const TARGETED_EFFECTS = ['hit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison']

function requirementsOf(def: CardDef): Omit<Pending, 'card' | 'picked'> {
  const needsEnemy = def.effects.some((effect) => TARGETED_EFFECTS.includes(effect.kind))
  const needsAlly = !needsEnemy && def.supportTarget === 'anyPlayer'
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

function canAfford(player: Player, card: CardInstance): boolean {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  if (def.unplayable) return false
  return def.cost === 'X' || def.cost <= player.energy
}

export function CombatScreen({ state, viewerId, onChange }: CombatScreenProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const viewer = state.players.find((player) => player.id === viewerId)
  const rows = useMemo(() => rowsOf(state), [state])
  const bosses = state.enemies.filter((enemy) => enemy.isBoss)

  if (!viewer) return <p className="muted">No seat for {viewerId}.</p>

  const over = state.phase === 'won' || state.phase === 'lost'
  const choiceSatisfied = pending?.choice ? pending.picked.length === pending.choice.amount : true

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
      const picked = already
        ? pending.picked.filter((uid) => uid !== card.uid)
        : [...pending.picked, card.uid].slice(-pending.choice.amount)
      const next = { ...pending, picked }
      setPending(next)
      // True Grit exhausts a card AND blocks any player, so satisfying the
      // choice must not skip the ally step.
      if (!next.needsEnemy && !next.needsAlly && picked.length === pending.choice.amount) {
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
    const next: Pending = { card, ...requirementsOf(def), picked: [] }
    setPending(next)
    // Only resolve on the spot when there is genuinely nothing left to pick.
    if (!next.needsEnemy && !next.needsAlly && !next.choice) commit(next, null, viewer!)
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
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${pending.choice.amount} card${
          pending.choice.amount === 1 ? '' : 's'
        } — ${pending.picked.length}/${pending.choice.amount} chosen`
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
        <span className={`combat__phase combat__phase--${state.phase}`}>{state.phase}</span>
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
          {state.turn === 0 && state.phase === 'player' ? (
            <button type="button" onClick={() => onChange(startPlayerTurn(state))}>
              Begin combat
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

      <div className="board">
        {bosses.length > 0 ? (
          <div className="board__bosses">
            {bosses.map((enemy) => (
              <EnemyCard
                key={enemy.uid}
                enemy={enemy}
                die={state.die}
                targeted={pending?.needsEnemy === true && choiceSatisfied}
                onClick={onEnemyClick}
              />
            ))}
          </div>
        ) : null}

        {rows.map((row) => {
          const occupant = state.players.find((player) => player.row === row)
          const foes = state.enemies.filter((enemy) => enemy.row === row && !enemy.isBoss)
          return (
            <div className="row" key={row}>
              <div className="row__seat">
                {occupant ? (
                  <button
                    type="button"
                    className={[
                      'seat',
                      occupant.id === viewerId ? 'seat--viewer' : '',
                      occupant.dead ? 'seat--dead' : '',
                      pending && !pending.needsEnemy && choiceSatisfied ? 'seat--targetable' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onAllyClick(occupant)}
                    aria-label={`${occupant.name}, ${occupant.hp} of ${occupant.maxHp} hit points, row ${row}`}
                  >
                    <span className="seat__name">{occupant.name}</span>
                    <span className="bar">
                      <span
                        className="bar__fill bar__fill--hp"
                        style={{ width: `${Math.round((occupant.hp / occupant.maxHp) * 100)}%` }}
                      />
                      <span className="bar__label">
                        {occupant.hp}/{occupant.maxHp}
                      </span>
                    </span>
                    <TokenRow
                      block={occupant.block}
                      strength={occupant.strength}
                      shivs={occupant.shivs}
                      miracles={occupant.miracles}
                    />
                    {occupant.stance !== 'neutral' ? (
                      <span className={`stance stance--${occupant.stance}`}>{occupant.stance}</span>
                    ) : null}
                  </button>
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
                      die={state.die}
                      targeted={pending?.needsEnemy === true && choiceSatisfied}
                      onClick={onEnemyClick}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

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
