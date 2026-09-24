import { useEffect, useMemo, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import type { CharacterId } from '../game/types.ts'
import { loadLeaderboard, type LeaderboardSnapshot } from '../leaderboard.ts'
import { WinningDecks } from './WinningDecks.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'

const HEROES = ['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'] as const

const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`
const decimal = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1)
const partyOf = (row: { character: CharacterId; characters?: CharacterId[] }) => row.characters ?? [row.character]

export function LeaderboardScreen({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'statistics' | 'decks'>('statistics')
  const [filters, setFilters] = useState<CharacterId[]>([])
  const [ascension, setAscension] = useState<number | 'all'>('all')
  const [snapshot, setSnapshot] = useState<LeaderboardSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [request, setRequest] = useState(0)

  useEffect(() => {
    let current = true
    setFailed(false)
    loadLeaderboard().then((value) => { if (current) setSnapshot(value) })
      .catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [request])

  const rows = useMemo(() => (snapshot?.rows ?? [])
    .filter((row) => filters.every((filter) => partyOf(row).includes(filter)) &&
      (ascension === 'all' || row.ascension === ascension)), [ascension, filters, snapshot])
  const filterTitle = filters.length === 0 ? 'All heroes' : tab === 'decks'
    ? filters.map((filter) => CHARACTER_LABEL[filter]).join(' or ')
    : `Parties with ${filters.map((filter) => CHARACTER_LABEL[filter]).join(' + ')}`

  return (
    <main className="leaderboard menu-ground">
      <aside className="leaderboard__rail menu-board menu-board--slate">
        <button type="button" className="leaderboard__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
        <h1>Leaderboard</h1>
        <div className="leaderboard__heroes" role="group" aria-label="Filter by character">
          <button type="button" aria-label="All heroes" aria-pressed={filters.length === 0} onClick={() => setFilters([])}>
            <span aria-hidden="true">◆</span>
          </button>
          {HEROES.map((character) => <button type="button" key={character} title={CHARACTER_LABEL[character]}
            aria-label={CHARACTER_LABEL[character]} aria-pressed={filters.includes(character)} onClick={() => setFilters((current) =>
              current.includes(character) ? current.filter((filter) => filter !== character) : [...current, character])}>
            <img src={assetPath(`menu/compendium-icons/${character}.webp`)} alt="" />
          </button>)}
        </div>
        <label className="leaderboard__ascension"><span className="visually-hidden">Ascension</span><select value={ascension}
          onChange={(event) => setAscension(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
          <option value="all">All ascensions</option>
          {Array.from({ length: 14 }, (_, value) => <option key={value} value={value}>Ascension {value}</option>)}
        </select></label>
        <div className="leaderboard__tabs" role="group" aria-label="Leaderboard view">
          <button type="button" aria-pressed={tab === 'statistics'} onClick={() => setTab('statistics')}>Win rates</button>
          <button type="button" aria-pressed={tab === 'decks'} onClick={() => setTab('decks')}>Winning decks</button>
        </div>
        <p className="leaderboard__count"><strong>{snapshot?.totalRuns ?? 0}</strong><span>run{snapshot?.totalRuns === 1 ? '' : 's'}</span></p>
      </aside>

      <section className="leaderboard__archive menu-board" aria-labelledby="leaderboard-title">
        <header><h2 id="leaderboard-title">{filterTitle}{ascension === 'all' ? '' : ` · A${ascension}`}</h2></header>
        {tab === 'decks' ? <WinningDecks characters={filters} ascension={ascension} /> : failed ? <div className="leaderboard__message" role="alert"><strong>Archive unreachable</strong><button type="button" onClick={() => setRequest((value) => value + 1)}>Try again</button></div>
          : !snapshot ? <div className="leaderboard__message" aria-live="polite"><span className="leaderboard__spinner" aria-hidden="true"></span><strong>Loading…</strong></div>
          : rows.length === 0 ? <div className="leaderboard__message"><strong>No runs yet</strong></div>
          : <div className="leaderboard__table-wrap"><table>
            <thead><tr><ShortHeader label="Rank" caption="#" /><th scope="col">Heroes</th><ShortHeader label="Ascension" caption="Asc." />
              <ShortHeader label="Runs" icon="icons/card-reward.png" /><ShortHeader label="Act III win rate" caption="Act III" />
              <ShortHeader label="Avg. floors" caption="Floors" icon="menu/map-scroll.png" /><ShortHeader label="Damage / fight" caption="Dmg" icon="icons/attack.png" />
              <ShortHeader label="Blocked" caption="Block" icon="icons/block.png" /><ShortHeader label="Act IV wins" caption="Act IV" /></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={`${partyOf(row).join(':')}:${row.ascension}`}>
              <td data-label="Rank"><span className="leaderboard__rank">{index + 1}</span></td>
              <th scope="row" aria-label={partyOf(row).map((character) => CHARACTER_LABEL[character]).join(', ')}><span className="leaderboard__party-icons" aria-hidden="true">{partyOf(row).map((character) =>
                <img key={character} src={assetPath(`menu/compendium-icons/${character}.webp`)} alt="" />)}</span></th>
              <td data-label="Ascension">{row.ascension}</td>
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

function ShortHeader({ label, caption, icon }: { label: string; caption?: string; icon?: string }) {
  return <th scope="col" title={label}>
    <span className="leaderboard__header-face" aria-hidden="true">{icon ? <img src={assetPath(icon)} alt="" /> : null}{caption}</span>
    <span className="visually-hidden">{label}</span>
  </th>
}
