import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { assetPath } from '../game/assets.ts'
import { SKIN_PRICES } from '../game/coins.ts'
import { SKIN_LABELS, skinsOf, visualId } from '../game/skins.ts'
import type { SkinId } from '../game/skins.ts'
import { CHARACTER_IDS } from '../game/types.ts'
import type { CharacterId } from '../game/types.ts'
import { onSkinPreferenceChange, savedSkinChoices, setPreferredSkin } from '../skin-preference.ts'
import { hasAccountPlay, loadProfileStats, logOut, savedProfile, type ProfileStats } from '../profile.ts'
import { ownsSkin } from '../wallet.ts'
import { CoinAmount, formatCoins } from './Coins.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'
import { useWallet } from './useWallet.ts'

const percent = (value: number, total: number) => total ? `${Math.round(value / total * 100)}%` : '—'

function Metric({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="profile__metric menu-board menu-board--mauve"><img src={assetPath(icon)} alt="" />
    <span>{label}</span><strong>{value}</strong></div>
}

const SECTIONS = [
  { id: 'record', label: 'Record', icon: 'menu/stats-ledger.png' },
  { id: 'skins', label: 'Skins', icon: 'menu/profile-medallion.png' },
] as const
type Section = (typeof SECTIONS)[number]['id']

/** Every hero with at least one skin, so a new skin in `skins.ts` shows up here on its own. */
const SKIN_HEROES = CHARACTER_IDS.filter((id) => skinsOf(id).length > 0)

/**
 * One hero's looks: the default plus each owned skin as a radio group, worn on a single
 * click, then each skin not bought yet as a locked tile that opens the Shop's Skins tab.
 */
function SkinRow({ character, worn, onShop }: { character: CharacterId; worn: SkinId | undefined; onShop: () => void }) {
  const wallet = useWallet()
  const looks: (SkinId | undefined)[] = [undefined, ...skinsOf(character).filter((skin) => ownsSkin(wallet, skin))]
  const locked = skinsOf(character).filter((skin) => !ownsSkin(wallet, skin))
  const tiles = useRef<(HTMLButtonElement | null)[]>([])
  const label = CHARACTER_LABEL[character] ?? character
  const wear = (index: number) => {
    setPreferredSkin(character, looks[index])
    tiles.current[index]?.focus()
  }
  const keys = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? looks.length - 1
      : step === undefined ? null : (index + step + looks.length) % looks.length
    if (next === null) return
    event.preventDefault()
    wear(next)
  }
  return <div className="profile-skins__hero">
    <h3 id={`profile-skins-${character}`}><img src={assetPath(`menu/compendium-icons/${character}.webp`)} alt="" />{label}</h3>
    <div className="profile-skins__looks">
      <div className="profile-skins__radios" role="radiogroup" aria-labelledby={`profile-skins-${character}`}>{looks.map((skin, index) => {
        const selected = skin === worn
        const name = skin ? SKIN_LABELS[skin] : 'Default'
        return <button type="button" role="radio" key={skin ?? 'default'} className="profile-skin" aria-checked={selected}
          aria-label={`${label}, ${name}`} tabIndex={selected ? 0 : -1} onClick={() => wear(index)} onKeyDown={(event) => keys(event, index)}
          ref={(element) => { tiles.current[index] = element }}>
          <span className="profile-skin__art"><img src={assetPath(`menu/character-select/portrait-${visualId(character, skin)}.png`)} alt="" draggable={false} /></span>
          <span className="profile-skin__name">{name}</span>
          {selected ? <span className="profile-skin__check" aria-hidden="true">✓</span> : null}
        </button>
      })}</div>
      {locked.map((skin) => <button type="button" key={skin} className="profile-skin profile-skin--locked" data-skin={skin}
        aria-label={`${label}, ${SKIN_LABELS[skin]}, locked: ${formatCoins(SKIN_PRICES[skin])} coins. Open the Shop`} onClick={onShop}>
        <span className="profile-skin__art">
          <img src={assetPath(`menu/character-select/portrait-${skin}.png`)} alt="" draggable={false} />
          <span className="profile-skin__veil" aria-hidden="true">
            <img className="profile-skin__lock" src={assetPath('shop/lock.webp')} alt="" draggable={false} />
            <CoinAmount coins={SKIN_PRICES[skin]} size={22} className="profile-skin__price" />
          </span>
        </span>
        <span className="profile-skin__name">{SKIN_LABELS[skin]}</span>
      </button>)}
    </div>
  </div>
}

export function ProfileScreen({ onBack, onShop }: { onBack: () => void; onShop: () => void }) {
  const profile = savedProfile()
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [error, setError] = useState('')
  const [request, setRequest] = useState(0)
  const [section, setSection] = useState<Section>('record')
  const [worn, setWorn] = useState(savedSkinChoices)
  const tabs = useRef(new Map<Section, HTMLButtonElement>())
  // Another tab, or this one, changed a choice.
  useEffect(() => onSkinPreferenceChange(() => setWorn(savedSkinChoices())), [])
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
  const choose = (next: Section) => {
    setSection(next)
    tabs.current.get(next)?.focus()
  }
  const tabKeys = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    choose(event.key === 'Home' ? 'record' : event.key === 'End' ? 'skins' : section === 'record' ? 'skins' : 'record')
  }
  return <main className="profile menu-ground">
    <aside className="profile__rail menu-board menu-board--slate">
      <button type="button" className="profile__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
      <h1>Profile</h1>
      <p className="profile__name" title={profile.username}>{profile.username}</p>
      {stats?.firstRunAt ? <p className="profile__since">Climbing since {new Date(stats.firstRunAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</p> : null}
      <div className="profile__tabs" role="tablist" aria-label="Profile sections" aria-orientation="vertical">
        {SECTIONS.map(({ id, label, icon }) => <button type="button" role="tab" className="profile__tab" key={id} id={`profile-tab-${id}`}
          aria-selected={section === id} aria-controls={`profile-panel-${id}`} tabIndex={section === id ? 0 : -1}
          onClick={() => setSection(id)} onKeyDown={tabKeys} ref={(element) => { if (element) tabs.current.set(id, element); else tabs.current.delete(id) }}>
          <img src={assetPath(icon)} alt="" draggable={false} /><span>{label}</span>
        </button>)}
      </div>
      {hasAccountPlay() ? <p className="profile__warning">Logging out discards your saved run or room seat.</p> : null}
      <button type="button" className="profile__logout" onClick={logOut}>Log out</button>
    </aside>
    <section className="profile__panel profile__record menu-board" role="tabpanel" id="profile-panel-record" aria-labelledby="profile-tab-record"
      hidden={section !== 'record'}>
      <header><h2>Your record</h2></header>
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
    <section className="profile__panel profile__skins menu-board" role="tabpanel" id="profile-panel-skins" aria-labelledby="profile-tab-skins"
      hidden={section !== 'skins'}>
      <header><h2>Skins</h2></header>
      <div className="profile__scroll">{SKIN_HEROES.map((id) => <SkinRow key={id} character={id} worn={worn[id]} onShop={onShop} />)}</div>
    </section>
  </main>
}
