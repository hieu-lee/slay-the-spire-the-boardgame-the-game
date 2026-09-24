import { useEffect, useMemo, useRef, useState } from 'react'
import { assetPath, cardThumbPath } from '../game/assets.ts'
import { CARDS } from '../game/cards.ts'
import type { CharacterId } from '../game/types.ts'
import { loadSampleDeck, loadStats, type SampleDeck, type StatsFilters, type StatsQuery, type StatsSnapshot } from '../stats.ts'
import { joinQueries, parseStatsExpression, validateStatsQuery, type CardChoice } from '../stats-query.ts'
import { CardCollectionDialog } from './CardCollectionOverlay.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'

const HEROES = ['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'] as const
const COLUMNS = [
  ['deckType', 'Deck'], ['averageFloors', 'Floors'],
  ['averageDamage', 'Damage'], ['averageBlock', 'Block'],
] as const
const CHOICES: (CardChoice & { owner: string })[] = Object.values(CARDS).flatMap((card) => [
  { id: card.id, label: card.name, upgraded: false, owner: card.owner },
  ...(card.upgrade ? [{ id: card.id, label: `${card.name}+`, upgraded: true, owner: card.owner }] : []),
]).sort((left, right) => left.label.localeCompare(right.label) || left.owner.localeCompare(right.owner))

type Bucket = 'all' | 'any' | 'none'
type Sort = typeof COLUMNS[number][0]
const choiceKey = (choice: CardChoice) => `${choice.id}:${choice.upgraded}`
const cardQuery = (choice: CardChoice): StatsQuery => ({ op: 'card', id: choice.id, upgraded: choice.upgraded })
const visualQueryFor = (buckets: Record<Bucket, CardChoice[]>) => joinQueries('and', [
  ...buckets.all.map(cardQuery),
  ...(buckets.any.length ? [joinQueries('or', buckets.any.map(cardQuery))!] : []),
  ...buckets.none.map((choice): StatsQuery => ({ op: 'not', value: cardQuery(choice) })),
])
const decimal = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1)
const percent = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value * 100)}%`
const delta = (value: number | null, suffix = '') => value == null ? '—' : `${value >= 0 ? '+' : ''}${(value * (suffix === '%' ? 100 : 1)).toFixed(1)}${suffix}`

function CardFilter({ bucket, label, choices, selected, onAdd, onRemove }: {
  bucket: Bucket; label: string; choices: typeof CHOICES
  selected: CardChoice[]; onAdd: (choice: CardChoice) => void; onRemove: (choice: CardChoice) => void
}) {
  const [search, setSearch] = useState('')
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const needle = search.toLowerCase().trim()
  const available = choices.filter((choice) => !selected.some((entry) => choiceKey(entry) === choiceKey(choice)) &&
    `${choice.label} ${choice.id === 'corpse_explosion' ? 'explosive corps' : ''}`.toLowerCase().includes(needle)).sort((left, right) => {
    const rank = (choice: CardChoice) => choice.label.toLowerCase() === needle ? 0 : choice.label.toLowerCase().startsWith(needle) ? 1 : 2
    return rank(left) - rank(right)
  }).slice(0, 7)
  const pick = (choice: CardChoice) => { onAdd(choice); setSearch(''); input.current?.focus(); setFocused(false) }
  return <div className="stats__filter" data-bucket={bucket}>
    <strong className="stats__filter-label">{label}</strong>
    <div className="stats__filter-content">
      {selected.map((choice) => <button type="button" className="stats__chip" key={choiceKey(choice)}
        title={`Remove ${choice.label}`} aria-label={`Remove ${choice.label} from ${label}`} onClick={() => onRemove(choice)}>
        {CARDS[choice.id] && <img src={cardThumbPath(CARDS[choice.id]!, Boolean(choice.upgraded))} alt="" />}
        {choice.label}<span aria-hidden="true">×</span>
      </button>)}
      <div className="stats__search" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }} onKeyDown={(event) => {
        if (event.key === 'Escape') { setFocused(false); input.current?.focus() }
      }}>
        <input ref={input} type="search" value={search} aria-label={`Find a card for ${label}`} placeholder="Search cards…"
          autoComplete="off" onChange={(event) => { setSearch(event.target.value); setFocused(true) }} onFocus={() => setFocused(true)}
          onKeyDown={(event) => { if (event.key === 'Enter' && available[0]) { event.preventDefault(); pick(available[0]) } }} />
        {focused && available.length > 0 && <div className="stats__suggestions" role="listbox" aria-label={`${label} suggestions`}>
          {available.map((choice) => <button type="button" role="option" aria-selected="false" key={choiceKey(choice)}
            onMouseDown={(event) => event.preventDefault()} onClick={() => pick(choice)}>
            <img src={cardThumbPath(CARDS[choice.id]!, Boolean(choice.upgraded))} alt="" loading="lazy" />
            <span>{choice.label}<small>{CHARACTER_LABEL[choice.owner] ?? choice.owner}</small></span><span aria-hidden="true">＋</span>
          </button>)}
        </div>}
      </div>
    </div>
  </div>
}

function Metric({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="stats__metric menu-board menu-board--mauve"><img src={assetPath(icon)} alt="" />
    <span>{label}</span><strong>{value}</strong></div>
}

export function StatsScreen({ onBack }: { onBack: () => void }) {
  const [character, setCharacter] = useState<CharacterId | 'all'>('all')
  const [ascension, setAscension] = useState<StatsFilters['ascension']>('all')
  const [mode, setMode] = useState<StatsFilters['mode']>('all')
  const [editor, setEditor] = useState<'builder' | 'expression'>('builder')
  const [buckets, setBuckets] = useState<Record<Bucket, CardChoice[]>>({ all: [], any: [], none: [] })
  const [builderError, setBuilderError] = useState('')
  const [expression, setExpression] = useState('')
  const [appliedExpression, setAppliedExpression] = useState<StatsQuery | null>(null)
  const [expressionError, setExpressionError] = useState('')
  const appliedText = useRef('')
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [sort, setSort] = useState<Sort>('averageFloors')
  const [descending, setDescending] = useState(true)
  const [sample, setSample] = useState<SampleDeck | null>(null)
  const [deckError, setDeckError] = useState('')
  const [deckLoading, setDeckLoading] = useState(false)
  const deckRequest = useRef<AbortController | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)

  const visualQuery = useMemo(() => visualQueryFor(buckets), [buckets])
  const query = editor === 'builder' ? visualQuery : appliedExpression
  const filters = useMemo(() => ({ character, ascension, mode, query }), [character, ascension, mode, query])

  useEffect(() => { setSnapshot(null) }, [filters])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    loadStats(filters, controller.signal).then(setSnapshot).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not open the archive.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, retry])
  useEffect(() => () => deckRequest.current?.abort(), [])
  useEffect(() => {
    if (!snapshot?.pending || loading) return
    const timer = setInterval(() => { if (!document.hidden) setRetry((current) => current + 1) }, 15_000)
    return () => clearInterval(timer)
  }, [snapshot, loading])
  useEffect(() => {
    deckRequest.current?.abort()
    setDeckLoading(false)
    setDeckError('')
    setSample(null)
  }, [filters])

  const rows = useMemo(() => [...(snapshot?.rows ?? [])].sort((left, right) => {
    const compared = sort === 'deckType' ? left.deckType.localeCompare(right.deckType)
      : (left[sort] ?? -1) - (right[sort] ?? -1)
    return compared * (descending ? -1 : 1) || right.runs - left.runs || left.deckType.localeCompare(right.deckType)
  }), [snapshot, sort, descending])

  const addChoice = (bucket: Bucket, choice: CardChoice) => {
    if (buckets[bucket].some((entry) => choiceKey(entry) === choiceKey(choice))) return
    const next = { ...buckets, [bucket]: [...buckets[bucket], choice] }
    try { validateStatsQuery(visualQueryFor(next)); setBuckets(next); setBuilderError('') }
    catch (reason) { setBuilderError(reason instanceof Error ? reason.message : 'Too many filters') }
  }
  const removeChoice = (bucket: Bucket, choice: CardChoice) => {
    setBuckets((current) => ({ ...current,
      [bucket]: current[bucket].filter((entry) => choiceKey(entry) !== choiceKey(choice)),
    }))
    setBuilderError('')
  }
  const openDeck = (type: string, button: HTMLButtonElement) => {
    deckRequest.current?.abort()
    const controller = new AbortController()
    deckRequest.current = controller
    opener.current = button
    setDeckError('')
    setDeckLoading(true)
    loadSampleDeck(type, filters, controller.signal).then(setSample).catch((reason) => {
      if (!controller.signal.aborted) setDeckError(reason instanceof Error ? reason.message : 'Could not open the deck.')
    }).finally(() => { if (!controller.signal.aborted) setDeckLoading(false) })
  }
  const applyExpression = () => {
    try {
      const parsed = parseStatsExpression(expression, CHOICES)
      validateStatsQuery(parsed)
      setExpressionError('')
      setAppliedExpression(parsed)
      appliedText.current = expression.trim()
      setRetry((current) => current + 1)
    } catch (reason) { setExpressionError(reason instanceof Error ? reason.message : 'Invalid expression') }
  }
  const addNextCard = (defId: string) => {
    const card = CARDS[defId]
    if (editor === 'builder') {
      addChoice('all', { id: defId, label: `${card?.name ?? defId} (any upgrade)`, upgraded: null })
      return
    }
    const nextQuery = joinQueries('and', [
      ...(appliedExpression ? [appliedExpression] : []), { op: 'card', id: defId, upgraded: null },
    ])
    try { validateStatsQuery(nextQuery) }
    catch (reason) { setExpressionError(reason instanceof Error ? reason.message : 'Too many filters'); return }
    const addition = `@${defId}`
    appliedText.current = `${appliedText.current ? `(${appliedText.current}) and ` : ''}${addition}`
    setExpression(appliedText.current)
    setAppliedExpression(nextQuery)
    setExpressionError('')
  }
  const hasFilters = editor === 'builder' ? buckets.all.length + buckets.any.length + buckets.none.length > 0 : Boolean(appliedExpression)
  const clearFilters = () => {
    setBuckets({ all: [], any: [], none: [] }); setBuilderError('')
    setAppliedExpression(null); appliedText.current = ''; setExpression(''); setExpressionError('')
  }
  return <main className="stats menu-ground" aria-labelledby="stats-title">
    <aside className="stats__rail menu-board menu-board--slate">
      <button type="button" className="stats__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true" /></button>
      <h1 id="stats-title">Stats</h1>
      <div className="stats__rail-filters">
        <div className="stats__heroes" role="group" aria-label="Filter by hero">
          <button type="button" title="All heroes" aria-pressed={character === 'all'} onClick={() => setCharacter('all')}><span className="stats__all-icon" aria-hidden="true">✦</span><span className="stats__hero-name">All heroes</span></button>
          {HEROES.map((hero) => <button type="button" key={hero} title={CHARACTER_LABEL[hero]} aria-pressed={character === hero} onClick={() => setCharacter(hero)}>
            <img src={assetPath(`menu/compendium-icons/${hero}.webp`)} alt="" /><span className="stats__hero-name">{CHARACTER_LABEL[hero]}</span></button>)}
        </div>
        <div className="stats__rail-selects">
          <label><span className="visually-hidden">Ascension</span><select value={ascension} onChange={(event) => setAscension(event.target.value === 'all' ? 'all'
            : event.target.value.endsWith('+') ? event.target.value as `${number}+` : Number(event.target.value))}>
            <option value="all">All ascensions</option>
            <optgroup label="At least">
              {Array.from({ length: 11 }, (_, value) => <option key={`${value}+`} value={`${value}+`}>Ascension {value}+</option>)}
            </optgroup>
            <optgroup label="Exact level">
              {Array.from({ length: 14 }, (_, value) => <option key={value} value={value}>Ascension {value}</option>)}
            </optgroup>
          </select></label>
          <label><span className="visually-hidden">Run mode</span><select value={mode} onChange={(event) => setMode(event.target.value as StatsFilters['mode'])}>
            <option value="all">All modes</option><option value="standard">Standard</option><option value="daily">Daily</option><option value="custom">Custom</option>
          </select></label>
        </div>
      </div>
    </aside>

    <section className="stats__body" aria-label="Stats explorer">
      <div className="stats__scroll">
        <section className="menu-board stats__panel stats__workbench" aria-label="Deck filters">
          <header className="stats__section-heading"><h2>Deck filters</h2>
            <div className="stats__heading-actions">
              {hasFilters && <button type="button" className="stats__clear" onClick={clearFilters}>Clear filters</button>}
              <div className="stats__editor-tabs" role="group" aria-label="Filter editor"><button type="button" aria-pressed={editor === 'builder'} onClick={() => setEditor('builder')}>Visual builder</button>
                <button type="button" aria-pressed={editor === 'expression'} onClick={() => setEditor('expression')}>Expression</button></div>
            </div></header>
          {editor === 'builder' ? <div className="stats__filters">
            <CardFilter bucket="all" label="All of these" choices={CHOICES} selected={buckets.all} onAdd={(choice) => addChoice('all', choice)} onRemove={(choice) => removeChoice('all', choice)} />
            <CardFilter bucket="any" label="Any of these" choices={CHOICES} selected={buckets.any} onAdd={(choice) => addChoice('any', choice)} onRemove={(choice) => removeChoice('any', choice)} />
            <CardFilter bucket="none" label="None of these" choices={CHOICES} selected={buckets.none} onAdd={(choice) => addChoice('none', choice)} onRemove={(choice) => removeChoice('none', choice)} />
          </div> : <div className="stats__expression">
            <div><input value={expression} aria-label="Card expression" onChange={(event) => setExpression(event.target.value)}
              title={'Combine cards with and, or, not and ( ). Quote names with spaces; @strike_defect matches one hero\'s card, any upgrade.'}
              onKeyDown={(event) => { if (event.key === 'Enter') applyExpression() }}
              placeholder={'("Dual Cast" or "Dual Cast+") and not @strike_defect'} />
              <button type="button" onClick={applyExpression}>Apply</button></div>
            {expressionError && <p role="alert">{expressionError}</p>}
          </div>}
          {editor === 'builder' && builderError && <p className="stats__filter-error" role="alert">{builderError}</p>}
        </section>

        <div className="stats__metrics" aria-label="Filtered run averages">
          <Metric icon="icons/card-reward.png" label="Runs" value={snapshot?.runs.toLocaleString() ?? '—'} />
          <Metric icon="menu/map-scroll.png" label="Floors" value={decimal(snapshot?.averageFloors)} />
          <Metric icon="icons/attack.png" label="Damage" value={decimal(snapshot?.averageDamage)} />
          <Metric icon="icons/block.png" label="Block" value={percent(snapshot?.averageBlock)} />
        </div>

        <section className="menu-board stats__panel" aria-label="Deck type statistics">
          <header className="stats__section-heading"><h2>Deck archetypes</h2>
            {snapshot?.pending ? <button type="button" className="stats__refresh" onClick={() => setRetry((current) => current + 1)}>↻ Refresh {snapshot.pending} pending</button> : null}</header>
          {loading ? <div className="stats__message" role="status">Loading…</div>
            : error ? <div className="stats__message" role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
              : rows.length === 0 ? <div className="stats__message"><strong>No matching decks</strong><span>{snapshot?.pending ? `${snapshot.pending} awaiting classification. Check the server Codex login or daily budget if this persists.` : 'Try a different filter.'}</span></div>
                : <div className="stats__table-scroll"><table className="stats__table"><thead><tr>{COLUMNS.map(([column, label]) => <th key={column} scope="col" aria-sort={sort === column ? descending ? 'descending' : 'ascending' : undefined}>
                  <button type="button" onClick={() => {
                    if (sort === column) setDescending(!descending)
                    else { setSort(column); setDescending(column !== 'deckType') }
                  }}>{label} <span aria-hidden="true">{sort === column ? descending ? '↓' : '↑' : '↕'}</span></button></th>)}</tr></thead>
                  <tbody>{rows.map((row) => <tr key={row.deckType} onClick={(event) => {
                    const button = event.currentTarget.querySelector<HTMLButtonElement>('button')
                    if (button) openDeck(row.deckType, button)
                  }}><th scope="row"><button type="button" className="stats__row-button" title={row.deckType} onClick={(event) => { event.stopPropagation(); openDeck(row.deckType, event.currentTarget) }}>
                    <img src={assetPath(`menu/compendium-icons/${row.character}.webp`)} alt="" /><span><strong>{row.deckType}</strong><small>{row.runs} run{row.runs === 1 ? '' : 's'}</small></span><span className="stats__row-arrow" aria-hidden="true">›</span></button></th>
                    <td>{decimal(row.averageFloors)}</td><td>{decimal(row.averageDamage)}</td><td>{percent(row.averageBlock)}</td></tr>)}</tbody></table></div>}
        </section>

        <section className="menu-board stats__panel stats__next" aria-label="Next card comparison">
          <header className="stats__section-heading"><h2>Card impact</h2></header>
          {snapshot && snapshot.nextCards.length > 0 ? <div className="stats__next-list">{snapshot.nextCards.map((entry) => {
            const card = CARDS[entry.defId]
            return <button type="button" key={entry.defId} className="stats__next-card" onClick={() => addNextCard(entry.defId)} title="Add to filters">
              {card && <img src={cardThumbPath(card, false)} alt="" loading="lazy" />}
              <span className="stats__next-name"><strong>{card?.name ?? entry.defId}</strong><small><span>{entry.runs} runs</span><span>{delta(entry.deltaDamage)} dmg</span><span>{delta(entry.deltaBlock, '%')} block</span></small></span>
              <span className="stats__next-delta" data-positive={entry.deltaFloors != null && entry.deltaFloors >= 0}>{delta(entry.deltaFloors)} <small>floors</small></span><span className="stats__next-add" aria-hidden="true">＋</span>
            </button>
          })}</div> : <div className="stats__message stats__message--compact">Not enough runs yet</div>}
        </section>
      </div>
      {deckLoading && <div className="stats__deck-loading" role="status">Drawing a deck…</div>}
      {deckError && <div className="stats__deck-loading" role="alert">{deckError} <button type="button" onClick={() => setDeckError('')}>Dismiss</button></div>}
      {sample && <CardCollectionDialog label={`${sample.deckType} · random run`} cards={sample.cards.map((card, index) => ({ ...card, uid: `stats:${index}` }))}
        onClose={() => { setSample(null); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })) }} />}
    </section>
  </main>
}
