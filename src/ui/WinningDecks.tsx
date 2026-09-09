import { useEffect, useRef, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardDef } from '../game/cards.ts'
import type { CharacterId } from '../game/types.ts'
import { loadWinningDecks, type WinningDeck, type WinningDeckPage, type WinningDeckSort } from '../leaderboard.ts'
import { CardCollectionDialog } from './CardCollectionOverlay.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'

const COLUMNS = [['character', 'Character'], ['ascension', 'Ascension'], ['cardCount', 'Card count'],
  ['username', 'Username'], ['recordedAt', 'Won at']] as const

export function WinningDecks({ character, ascension }: { character: CharacterId | 'all'; ascension: number | 'all' }) {
  const [sort, setSort] = useState<WinningDeckSort>('recordedAt')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const section = useRef<HTMLElement>(null)
  const sortFocus = useRef<WinningDeckSort | null>(null)
  useEffect(() => {
    if (sortFocus.current) {
      section.current?.querySelector<HTMLButtonElement>(`[data-sort="${sortFocus.current}"]`)?.focus({ preventScroll: true })
      sortFocus.current = null
    }
  }, [sort, direction])
  return <section ref={section} className="winning-decks" aria-label="Winning decks">
    <WinningDeckRows key={`${character}:${ascension}:${sort}:${direction}`} {...{ character, ascension, sort, direction }}
      onSort={(column) => {
        sortFocus.current = column
        if (sort === column) setDirection(value => value === 'asc' ? 'desc' : 'asc')
        else { setSort(column); setDirection(column === 'recordedAt' ? 'desc' : 'asc') }
      }} />
  </section>
}

function WinningDeckRows({ character, ascension, sort, direction, onSort }: {
  character: CharacterId | 'all'; ascension: number | 'all'; sort: WinningDeckSort; direction: 'asc' | 'desc'
  onSort: (sort: WinningDeckSort) => void
}) {
  const [page, setPage] = useState<WinningDeckPage | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deckError, setDeckError] = useState('')
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<WinningDeck | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ character, ascension: String(ascension), sort, direction })
    if (cursor !== null) params.set('cursor', cursor)
    loadWinningDecks(params, controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(previous => ({ ...result,
        rows: [...(previous?.rows ?? []), ...result.rows.filter(row => !previous?.rows.some(old => old.id === row.id))],
      }))
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load winning decks.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [character, ascension, sort, direction, cursor, retry])

  useEffect(() => {
    const button = more.current
    if (!button || loading || error || !page?.nextCursor) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setCursor(page.nextCursor)
    }, { root: scroll.current })
    observer.observe(button)
    return () => observer.disconnect()
  }, [page, loading, error])

  const openDeck = (run: WinningDeck, button: HTMLButtonElement | null) => {
    try { run.cards.forEach(card => { cardDef(card.defId); if (card.attachedGemId) cardDef(card.attachedGemId) }) }
    catch { setDeckError('This deck contains cards unavailable in this version. Please refresh the game and try again.'); return }
    setDeckError('')
    opener.current = button
    setSelected(run)
  }

  return <>
    <div ref={scroll} className="leaderboard__table-wrap winning-decks__scroll" aria-busy={loading}>
      <table className="winning-decks__table">
        <thead><tr>{COLUMNS.map(([key, label]) => <th key={key} scope="col"
          aria-sort={sort === key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
          <button type="button" data-sort={key} onClick={() => onSort(key)}>{label} <span aria-hidden="true">{sort === key ? direction === 'asc' ? '↑' : '↓' : '↕'}</span></button>
        </th>)}</tr></thead>
        <tbody>{page?.rows.map(run => <tr key={run.id} onClick={event => openDeck(run, event.currentTarget.querySelector('button'))}>
          <td><button type="button" className="winning-decks__open" aria-label={`View ${run.username}'s ${CHARACTER_LABEL[run.character]} winning deck`}>
            <img src={assetPath(`menu/compendium-icons/${run.character}.webp`)} alt="" />{CHARACTER_LABEL[run.character]}
          </button></td>
          <td>{run.ascension}</td><td>{run.cardCount}</td><td className="winning-decks__username">{run.username}</td>
          <td><time dateTime={Number.isNaN(new Date(run.recordedAt).getTime()) ? undefined : new Date(run.recordedAt).toISOString()}>{new Date(run.recordedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></td>
        </tr>)}</tbody>
      </table>
      {error && <div className="leaderboard__message" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
      {!loading && !error && page?.total === 0 && <div className="leaderboard__message"><strong>No winning decks yet.</strong><span>Decks are saved for runs that beat Act III or beyond.</span></div>}
      {loading && <p className="winning-decks__status" role="status">Loading winning decks…</p>}
      {!error && page?.nextCursor !== null && page && <button ref={more} type="button" className="winning-decks__more" disabled={loading}
        onClick={() => setCursor(page.nextCursor)}>Load 20 more</button>}
      {page && page.total > 0 && <p className="winning-decks__status">{page.rows.length} of {page.total} winning decks</p>}
    </div>
    {deckError && <div className="leaderboard__message" role="alert"><span>{deckError}</span><button type="button" onClick={() => setDeckError('')}>Dismiss</button></div>}
    {selected && <CardCollectionDialog label={`${selected.username} · ${CHARACTER_LABEL[selected.character]} · A${selected.ascension}`}
      cards={selected.cards.map((card, index) => ({ ...card, uid: `${selected.id}:${index}` }))}
      onClose={() => { setSelected(null); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })) }} />}
  </>
}
