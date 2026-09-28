import { useEffect, useRef, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardDef } from '../game/cards.ts'
import { dailyDate } from '../daily-date.ts'
import type { CharacterId } from '../game/types.ts'
import { DailyRankingRefused, loadDailyLeaderboard, type DailyClimbBoard, type DailyClimbRow } from '../leaderboard.ts'
import { CardCollectionDialog } from './CardCollectionOverlay.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'
import { useUtcDay } from './useUtcDay.ts'

const DAY_MS = 86_400_000
// The shared-seed Daily Climb began here; no board exists before it.
const FIRST_DAY = '2026-09-01'
const shiftDay = (date: string, days: number) => dailyDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
const formatDay = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`
const decimal = (value: number | null) => value === null ? '—' : value.toFixed(1)

/** One UTC day's shared-seed ranking, ordered by floors reached. */
export function DailyLeaderboard({ characters }: { characters: CharacterId[] }) {
  const [today] = useUtcDay()
  const [date, setDate] = useState(today)
  const [board, setBoard] = useState<DailyClimbBoard | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [request, setRequest] = useState(0)
  const [deckError, setDeckError] = useState('')
  const [selected, setSelected] = useState<DailyClimbRow | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)

  const heroes = characters.join(',')
  useEffect(() => {
    let current = true
    setBoard(null)
    setFailed(null)
    setDeckError('')
    // Rapid day or hero clicks settle before one request spends the read limit.
    const timer = window.setTimeout(() => {
      loadDailyLeaderboard(date, heroes ? heroes.split(',') as CharacterId[] : []).then((value) => { if (current) setBoard(value) })
        .catch((error) => {
          if (!current) return
          const reason = error instanceof DailyRankingRefused ? error.reason : null
          setFailed(reason === 'rateLimited' ? 'Too many requests — wait a moment'
            : reason === 'notDeployed' ? 'The daily ranking arrives with the next archive server update'
            : reason === 'rejected' ? 'The archive could not read this request' : 'Archive unreachable')
        })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [date, heroes, request])

  const rows = board?.rows ?? []
  const openDeck = (row: DailyClimbRow, button: HTMLButtonElement) => {
    try { row.cards.forEach((card) => { cardDef(card.defId); if (card.attachedGemId) cardDef(card.attachedGemId) }) }
    catch { setDeckError('This deck contains cards unavailable in this version. Please refresh the game and try again.'); return }
    setDeckError('')
    opener.current = button
    setSelected(row)
  }

  return <section className="daily-board" aria-label="Daily Climb ranking">
    <nav className="daily-board__days" aria-label="Daily Climb day">
      <button type="button" aria-label="Previous day" disabled={date <= FIRST_DAY} onClick={() => setDate((value) => shiftDay(value, -1))}>‹</button>
      <p><strong>{date === today ? 'Today' : formatDay(date)}</strong><small>{date} · A10 · shared seed{board ? ` · ${board.total} climber${board.total === 1 ? '' : 's'}` : ''}</small></p>
      <button type="button" aria-label="Next day" disabled={date >= today} onClick={() => setDate((value) => shiftDay(value, 1))}>›</button>
    </nav>
    {failed ? <div className="leaderboard__message" role="alert"><strong>{failed}</strong><button type="button" onClick={() => setRequest((value) => value + 1)}>Try again</button></div>
      : !board ? <div className="leaderboard__message" aria-live="polite"><span className="leaderboard__spinner" aria-hidden="true"></span><strong>Loading…</strong></div>
      : rows.length === 0 ? <div className="leaderboard__message"><strong>No climbs yet</strong><span>Finish a Daily Climb to claim the first place.</span></div>
      : <div className="leaderboard__table-wrap"><table className="daily-board__table">
        <thead><tr><th scope="col" title="Rank">#</th><th scope="col">Player</th><th scope="col" title="Hero">Hero</th>
          <th scope="col" title="Floors reached">Floors</th><th scope="col" title="Damage / fight">Dmg</th>
          <th scope="col" title="Blocked">Block</th><th scope="col">Deck</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.rank}:${row.username}`}>
          <td data-label="Rank"><span className="leaderboard__rank">{row.rank}</span></td>
          <th scope="row" className="daily-board__player">{row.username}</th>
          <td data-label="Hero"><span className="leaderboard__party-icons" title={CHARACTER_LABEL[row.character]}>
            <img src={assetPath(`menu/compendium-icons/${row.character}.webp`)} alt={CHARACTER_LABEL[row.character]} /></span></td>
          <td data-label="Floors reached"><strong>{row.floorsCleared}</strong></td>
          <td data-label="Damage / fight">{decimal(row.averageDamagePerFight)}</td>
          <td data-label="Damage blocked">{percent(row.damageBlockedRate)}</td>
          <td data-label="Deck">{row.cards.length ? <button type="button" className="daily-board__deck"
            aria-label={`View ${row.username}'s ${CHARACTER_LABEL[row.character]} deck`}
            onClick={(event) => openDeck(row, event.currentTarget)}>{row.cards.length} card{row.cards.length === 1 ? '' : 's'}</button> : '—'}</td>
        </tr>)}</tbody>
      </table></div>}
    {deckError && <div className="leaderboard__message" role="alert"><span>{deckError}</span><button type="button" onClick={() => setDeckError('')}>Dismiss</button></div>}
    {selected && <CardCollectionDialog label={`${selected.username} · ${CHARACTER_LABEL[selected.character]} · Daily Climb ${date}`}
      cards={selected.cards.map((card, index) => ({ ...card, uid: `${date}:${selected.rank}:${index}` }))}
      onClose={() => { setSelected(null); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })) }} />}
  </section>
}
