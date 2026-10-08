import { useEffect, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { hasAccountPlay, loadProfileStats, logOut, savedProfile, type ProfileStats } from '../profile.ts'
import { CHARACTER_LABEL } from './run-summary-data.ts'

const percent = (value: number, total: number) => total ? `${Math.round(value / total * 100)}%` : '—'

function Metric({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="profile__metric menu-board menu-board--mauve"><img src={assetPath(icon)} alt="" />
    <span>{label}</span><strong>{value}</strong></div>
}

export function ProfileScreen({ onBack }: { onBack: () => void }) {
  const profile = savedProfile()
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [error, setError] = useState('')
  const [request, setRequest] = useState(0)
  useEffect(() => {
    if (!profile) return undefined
    let current = true
    setError('')
    loadProfileStats(profile).then((value) => { if (current) setStats(value) })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : 'Could not open your record.') })
    return () => { current = false }
    // The token identifies the profile; reloading on every render would refetch needlessly.
  }, [profile?.token, request]) // eslint-disable-line react-hooks/exhaustive-deps
  // Another tab may have logged out: there is no profile left to show.
  useEffect(() => { if (!profile) onBack() }, [profile, onBack])
  if (!profile) return null
  return <main className="profile menu-ground">
    <aside className="profile__rail menu-board menu-board--slate">
      <button type="button" className="profile__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
      <h1>Profile</h1>
      <p className="profile__name" title={profile.username}>{profile.username}</p>
      {stats?.firstRunAt ? <p className="profile__since">Climbing since {new Date(stats.firstRunAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</p> : null}
      {hasAccountPlay() ? <p className="profile__warning">Logging out discards your saved run or room seat.</p> : null}
      <button type="button" className="profile__logout" onClick={logOut}>Log out</button>
    </aside>
    <section className="profile__record menu-board" aria-labelledby="profile-record-title">
      <header><h2 id="profile-record-title">Your record</h2></header>
      {error ? <div className="profile__message" role="alert"><strong>{error}</strong>
        <button type="button" onClick={() => setRequest((value) => value + 1)}>Try again</button></div>
        : !stats ? <div className="profile__message" role="status"><strong>Loading…</strong></div>
        : stats.runs === 0 ? <div className="profile__message"><strong>No runs recorded yet</strong><span>Finish a run signed in as {profile.username} to start your record.</span></div>
        : <div className="profile__scroll">
          <div className="profile__metrics">
            <Metric icon="icons/card-reward.png" label="Runs" value={stats.runs.toLocaleString()} />
            <Metric icon="icons/attack.png" label="Act III wins" value={`${stats.act3Wins} · ${percent(stats.act3Wins, stats.runs)}`} />
            <Metric icon="icons/block.png" label="Act IV wins" value={stats.act4Wins.toLocaleString()} />
            <Metric icon="menu/map-scroll.png" label="Best floors" value={stats.bestFloors ? stats.bestFloors.toLocaleString() : '—'} />
            <Metric icon="icons/attack.png" label="Highest win" value={stats.bestAscensionWon === null ? '—' : `Ascension ${stats.bestAscensionWon}`} />
            <Metric icon="menu/map-scroll.png" label="Daily Climbs" value={stats.dailyClimbs.toLocaleString()} />
          </div>
          <h3 className="profile__heading">Heroes</h3>
          <ul className="profile__heroes">{stats.heroes.map((hero) => <li key={hero.character}>
            <img src={assetPath(`menu/compendium-icons/${hero.character}.webp`)} alt="" />
            <strong>{CHARACTER_LABEL[hero.character] ?? hero.character}</strong>
            <span>{hero.runs} run{hero.runs === 1 ? '' : 's'}</span>
            <span>{hero.wins} win{hero.wins === 1 ? '' : 's'} · {percent(hero.wins, hero.runs)}</span>
          </li>)}</ul>
        </div>}
    </section>
  </main>
}
