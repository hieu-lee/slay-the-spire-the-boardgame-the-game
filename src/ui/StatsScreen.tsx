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
  ['deckType', 'Deck Type'], ['averageFloors', 'Average Floors Reached'],
  ['averageDamage', 'Average Damage'], ['averageBlock', 'Average Block %'],
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

function CardFilter({ bucket, label, hint, choices, selected, onAdd, onRemove }: {
  bucket: Bucket; label: string; hint: string; choices: typeof CHOICES
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
    <div className="stats__filter-heading"><strong>{label}</strong><span>{hint}</span></div>
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

function Metric({ label, value, foot }: { label: string; value: string; foot: string }) {
  return <div className="stats__metric"><span>{label}</span><strong>{value}</strong><small>{foot}</small></div>
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
  const title = character === 'all' ? 'Every hero' : CHARACTER_LABEL[character]
  return <main className="stats" aria-labelledby="stats-title">
    <aside className="stats__rail">
      <button type="button" className="stats__back" onClick={onBack} aria-label="Back to main menu">← <span>BACK TO MENU</span></button>
      <div className="stats__brand"><span className="stats__sigil" aria-hidden="true">✦</span><span>THE SPIRE<br /><strong>ARCHIVE</strong></span></div>
      <div className="stats__rail-title"><span>01 / EXPLORE</span><h1 id="stats-title">Stats<span>.</span></h1>
        <p>Every run leaves a pattern.<br />Find the ones worth keeping.</p></div>
      <div className="stats__rail-filters"><p className="stats__overline">THE HEROES</p>
        <div className="stats__heroes" role="group" aria-label="Filter by hero">
          <button type="button" aria-pressed={character === 'all'} onClick={() => setCharacter('all')}><span className="stats__all-icon" aria-hidden="true">✦</span>All heroes</button>
          {HEROES.map((hero) => <button type="button" key={hero} aria-pressed={character === hero} onClick={() => setCharacter(hero)}>
            <img src={assetPath(`menu/compendium-icons/${hero}.webp`)} alt="" />{CHARACTER_LABEL[hero]}</button>)}
        </div>
        <div className="stats__rail-selects">
          <label>ASCENSION <select value={ascension} onChange={(event) => setAscension(event.target.value === 'all' ? 'all'
            : event.target.value.endsWith('+') ? event.target.value as `${number}+` : Number(event.target.value))}>
            <option value="all">All ascensions</option>
            <optgroup label="At least">
              {Array.from({ length: 11 }, (_, value) => <option key={`${value}+`} value={`${value}+`}>Ascension {value}+</option>)}
            </optgroup>
            <optgroup label="Exact level">
              {Array.from({ length: 14 }, (_, value) => <option key={value} value={value}>Ascension {value}</option>)}
            </optgroup>
          </select></label>
          <label>RUN MODE <select value={mode} onChange={(event) => setMode(event.target.value as StatsFilters['mode'])}>
            <option value="all">All modes</option><option value="standard">Standard</option><option value="daily">Daily</option><option value="custom">Custom</option>
          </select></label>
        </div>
      </div>
      <div className="stats__rail-foot"><span>✧</span> DECK LABORATORY <small>Observe. Compare. Discover.</small></div>
    </aside>

    <section className="stats__body" aria-label="Stats explorer"
      style={{ backgroundImage: `linear-gradient(115deg, #0c171af2, #101b1ff2), url("${assetPath('menu/compendium-archive.webp')}")` }}>
      <header className="stats__top"><div><span className="stats__overline">THE ARCHIVE / STATS EXPLORER</span><h2>Explore the <em>possibilities.</em></h2>
        <p>Build a question about the deck. Let the runs answer it.</p></div>
        <div className="stats__live"><span aria-hidden="true">●</span> LIVE RUN DATA</div>
      </header>
      <div className="stats__scroll">
        <section className="stats__workbench" aria-label="Deck filters">
          <div className="stats__section-heading"><div><span className="stats__overline">01 — ASK A QUESTION</span><h3>Deck filters</h3></div>
            <div className="stats__editor-tabs" role="group" aria-label="Filter editor"><button type="button" aria-pressed={editor === 'builder'} onClick={() => setEditor('builder')}>Visual builder</button>
              <button type="button" aria-pressed={editor === 'expression'} onClick={() => setEditor('expression')}>Expression</button></div></div>
          {editor === 'builder' ? <div className="stats__filters">
            <CardFilter bucket="all" label="ALL OF THESE" hint="Include every card" choices={CHOICES} selected={buckets.all} onAdd={(choice) => addChoice('all', choice)} onRemove={(choice) => removeChoice('all', choice)} />
            <CardFilter bucket="any" label="ANY OF THESE" hint="At least one card" choices={CHOICES} selected={buckets.any} onAdd={(choice) => addChoice('any', choice)} onRemove={(choice) => removeChoice('any', choice)} />
            <CardFilter bucket="none" label="NONE OF THESE" hint="Exclude these cards" choices={CHOICES} selected={buckets.none} onAdd={(choice) => addChoice('none', choice)} onRemove={(choice) => removeChoice('none', choice)} />
          </div> : <div className="stats__expression"><label htmlFor="stats-expression">COMBINE CARDS WITH AND · OR · NOT · ( )</label>
            <div><input id="stats-expression" value={expression} onChange={(event) => setExpression(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') applyExpression() }}
              placeholder={'("Dual Cast" or "Dual Cast+") and not ("Strike" or "Strike+")'} />
              <button type="button" onClick={applyExpression}>Apply ↗</button></div>
            <small>Use card names; quote names with spaces. “Strike” matches every hero; @strike_defect matches Defect only, any upgrade.</small>
            {expressionError && <p role="alert">{expressionError}</p>}
          </div>}
          {editor === 'builder' && builderError && <p className="stats__filter-error" role="alert">{builderError}</p>}
          {(buckets.all.length + buckets.any.length + buckets.none.length > 0 && editor === 'builder' || editor === 'expression' && appliedExpression) &&
            <button type="button" className="stats__clear" onClick={() => { setBuckets({ all: [], any: [], none: [] }); setBuilderError(''); setAppliedExpression(null); appliedText.current = ''; setExpression(''); setExpressionError('') }}>Clear filters ×</button>}
        </section>

        <div className="stats__metrics" aria-label="Filtered run averages">
          <Metric label="MATCHING RUNS" value={snapshot?.runs.toLocaleString() ?? '—'} foot={snapshot?.pending ? `${snapshot.pending} awaiting deck type` : 'submitted solo decks'} />
          <Metric label="AVG. FLOORS REACHED" value={decimal(snapshot?.averageFloors)} foot="per recorded run" />
          <Metric label="AVG. DAMAGE" value={decimal(snapshot?.averageDamage)} foot="dealt per fight" />
          <Metric label="AVG. BLOCK %" value={percent(snapshot?.averageBlock)} foot="of incoming damage" />
        </div>

        <section className="stats__results" aria-label="Deck type statistics">
          <div className="stats__section-heading"><div><span className="stats__overline">02 — DISCOVER THE PATTERNS</span><h3>Deck archetypes <span>/{title}</span></h3></div>
            <div className="stats__result-actions">{snapshot?.pending ? <button type="button" onClick={() => setRetry((current) => current + 1)}>↻ Refresh {snapshot.pending} pending</button> : null}
              <span className="stats__result-count">{rows.length} TYPES</span></div></div>
          <p className="stats__explain">Click an archetype to open a random deck from matching runs. Damage is dealt per fight; block is the share of incoming damage prevented.</p>
          {loading ? <div className="stats__message" role="status">Reading the run archive…</div>
            : error ? <div className="stats__message" role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
              : rows.length === 0 ? <div className="stats__message"><strong>No matching archetypes yet.</strong><span>{snapshot?.pending ? `${snapshot.pending} deck${snapshot.pending === 1 ? ' is' : 's are'} awaiting classification. Results refresh automatically; check the server key or daily budget if this persists.` : 'Try a different card combination, hero, or ascension.'}</span></div>
                : <div className="stats__table-scroll"><table className="stats__table"><thead><tr>{COLUMNS.map(([column, label]) => <th key={column} scope="col" aria-sort={sort === column ? descending ? 'descending' : 'ascending' : undefined}>
                  <button type="button" onClick={() => {
                    if (sort === column) setDescending(!descending)
                    else { setSort(column); setDescending(column !== 'deckType') }
                  }}>{label} <span aria-hidden="true">{sort === column ? descending ? '↓' : '↑' : '↕'}</span></button></th>)}</tr></thead>
                  <tbody>{rows.map((row) => <tr key={row.deckType} onClick={(event) => {
                    const button = event.currentTarget.querySelector<HTMLButtonElement>('button')
                    if (button) openDeck(row.deckType, button)
                  }}><th scope="row"><button type="button" className="stats__row-button" onClick={(event) => { event.stopPropagation(); openDeck(row.deckType, event.currentTarget) }}>
                    <img src={assetPath(`menu/compendium-icons/${row.character}.webp`)} alt="" /><span><strong>{row.deckType}</strong><small>{row.runs} run{row.runs === 1 ? '' : 's'} sampled</small></span><span className="stats__row-arrow" aria-hidden="true">↗</span></button></th>
                    <td>{decimal(row.averageFloors)}</td><td>{decimal(row.averageDamage)}</td><td>{percent(row.averageBlock)}</td></tr>)}</tbody></table></div>}
        </section>

        <section className="stats__next" aria-label="Next card comparison">
          <div className="stats__section-heading"><div><span className="stats__overline">03 — GO DEEPER</span><h3>What if you had this card?</h3></div><span className="stats__result-count">NEXT CARD DELTA</span></div>
          <p className="stats__explain">Within these matching runs, compare decks with each card to decks without it. Correlation, not a promise of improvement.</p>
          {snapshot && snapshot.nextCards.length > 0 ? <div className="stats__next-list">{snapshot.nextCards.map((entry) => {
            const card = CARDS[entry.defId]
            return <button type="button" key={entry.defId} className="stats__next-card" onClick={() => addNextCard(entry.defId)} title="Add this card to the required filters">
              {card && <img src={cardThumbPath(card, false)} alt="" loading="lazy" />}
              <span className="stats__next-name"><strong>{card?.name ?? entry.defId}</strong><small>{entry.runs} runs · any upgrade</small></span>
              <span className="stats__next-delta" data-positive={entry.deltaFloors != null && entry.deltaFloors >= 0}> {delta(entry.deltaFloors)} <small>floors</small></span>
              <span className="stats__next-extra">{delta(entry.deltaDamage)} dmg · {delta(entry.deltaBlock, '%')} block</span><span aria-hidden="true">＋</span>
            </button>
          })}</div> : <div className="stats__message stats__message--compact">More varied decks are needed to compare next cards.</div>}
        </section>
      </div>
      {deckLoading && <div className="stats__deck-loading" role="status">Drawing a deck from the archive…</div>}
      {deckError && <div className="stats__deck-loading" role="alert">{deckError} <button type="button" onClick={() => setDeckError('')}>Dismiss</button></div>}
      {sample && <CardCollectionDialog label={`${sample.deckType} · a random run`} cards={sample.cards.map((card, index) => ({ ...card, uid: `stats:${index}` }))}
        onClose={() => { setSample(null); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })) }} />}
    </section>
  </main>
}
