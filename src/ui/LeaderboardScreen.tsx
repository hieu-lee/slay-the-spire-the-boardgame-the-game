import { useEffect, useMemo, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import type { CharacterId } from '../game/types.ts'
import { loadLeaderboard, type LeaderboardSnapshot } from '../leaderboard.ts'
import { CHARACTER_LABEL } from './run-summary-data.ts'

const HEROES = ['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'] as const
type Filter = CharacterId | 'all'

const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`
const decimal = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1)

export function LeaderboardScreen({ onBack }: { onBack: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [ascension, setAscension] = useState<number | 'all'>('all')
  const [snapshot, setSnapshot] = useState<LeaderboardSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [request, setRequest] = useState(0)
  const hero = filter === 'all' ? 'ironclad' : filter

  useEffect(() => {
    let current = true
    setFailed(false)
    loadLeaderboard().then((value) => { if (current) setSnapshot(value) })
      .catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [request])

  const rows = useMemo(() => (snapshot?.rows ?? [])
    .filter((row) => (filter === 'all' || row.character === filter) && (ascension === 'all' || row.ascension === ascension)), [ascension, filter, snapshot])

  return (
    <main className="leaderboard">
      <img className="leaderboard__wallpaper" src={assetPath(`menu/character-select/character-${hero}-wallpaper.webp`)} alt="" />
      <aside className="leaderboard__rail">
        <button type="button" className="leaderboard__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
        <p className="leaderboard__eyebrow">The Spire remembers</p>
        <h1>Leaderboard</h1>
        <div className="leaderboard__heroes" role="group" aria-label="Filter by character">
          <button type="button" aria-label="All heroes" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            <span aria-hidden="true">◆</span><small>All heroes</small>
          </button>
          {HEROES.map((character) => <button type="button" key={character} title={CHARACTER_LABEL[character]}
            aria-label={CHARACTER_LABEL[character]} aria-pressed={filter === character} onClick={() => setFilter(character)}>
            <img src={assetPath(`menu/compendium-icons/${character}.webp`)} alt="" /><small>{CHARACTER_LABEL[character]}</small>
          </button>)}
        </div>
        <label className="leaderboard__ascension"><span>Ascension</span><select value={ascension}
          onChange={(event) => setAscension(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
          <option value="all">All ascensions</option>
          {Array.from({ length: 14 }, (_, value) => <option key={value} value={value}>Ascension {value}</option>)}
        </select></label>
        <p className="leaderboard__count"><strong>{snapshot?.totalRuns ?? 0}</strong><span>solo run{snapshot?.totalRuns === 1 ? '' : 's'} chronicled</span></p>
      </aside>

      <section className="leaderboard__archive" aria-labelledby="leaderboard-title">
        <header>
          <div><p>Hall of Ascension</p><h2 id="leaderboard-title">{filter === 'all' ? 'All heroes' : CHARACTER_LABEL[filter]}{ascension === 'all' ? '' : ` · A${ascension}`}</h2></div>
          <span>Solo · all run modes</span>
        </header>
        {failed ? <div className="leaderboard__message" role="alert"><strong>The archive is beyond reach.</strong><span>Your finished run remains safely queued.</span><button type="button" onClick={() => setRequest((value) => value + 1)}>Try again</button></div>
          : !snapshot ? <div className="leaderboard__message" aria-live="polite"><span className="leaderboard__spinner" aria-hidden="true"></span><strong>Opening the archive…</strong></div>
          : rows.length === 0 ? <div className="leaderboard__message"><strong>No names are etched here yet.</strong><span>Finish a solo run to claim the first place.</span></div>
          : <div className="leaderboard__table-wrap"><table>
            <thead><tr><th scope="col">Rank</th><th scope="col">Hero &amp; ascension</th><th scope="col">Runs</th><th scope="col">Act III win rate</th><th scope="col">Avg. floors</th><th scope="col">Damage / fight</th><th scope="col">Blocked</th><th scope="col">Act IV wins</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={`${row.character}:${row.ascension}`}>
              <td data-label="Rank"><span className="leaderboard__rank">{index + 1}</span></td>
              <th scope="row"><img src={assetPath(`menu/compendium-icons/${row.character}.webp`)} alt="" /><span><strong>{CHARACTER_LABEL[row.character]}</strong><small>Ascension {row.ascension}</small></span></th>
              <td data-label="Runs">{row.runs}</td>
              <td data-label="Act III win rate"><strong>{percent(row.act3WinRate)}</strong><small>{row.act3Wins} / {row.act3Runs}</small></td>
              <td data-label="Floors cleared">{decimal(row.averageFloorsCleared)}</td>
              <td data-label="Damage / fight">{decimal(row.averageDamagePerFight)}</td>
              <td data-label="Damage blocked">{percent(row.averageDamageBlocked)}</td>
              <td data-label="Act IV wins"><strong>{row.act4Wins}</strong></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
    </main>
  )
}
