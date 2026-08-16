// What the run amounted to, on the screen that ends it.
//
// Both endings used to be a heading and a button — "The party has fallen", then
// nothing. The digital game closes a run with a reckoning: how far you climbed,
// what you were carrying, what the deck had become. All of it is already in the
// run state; none of it was on screen.
import { RelicBar } from './RelicChip.tsx'
import { IconValue } from './Icon.tsx'
import { CHARACTER_LABEL, deckHighlights } from './run-summary-data.ts'
import type { SummarySeat } from './run-summary-data.ts'

// Re-exported so call sites keep importing the summary from one place.
export { summarySeat } from './run-summary-data.ts'
export type { SummarySeat } from './run-summary-data.ts'

/**
 * The end-of-run reckoning.
 *
 * Identical on victory and defeat by design — losing on floor 40 and winning on
 * floor 40 deserve the same accounting, and each shell already supplies its own
 * heading ("Act N complete" / "The party has fallen") above it. A `victory` vs
 * `defeat` modifier class was carried here for a while and styled nothing; the
 * outcome is legible from the heading and from the red `--dead` seat cards.
 */
export function RunSummary({ act, roomsCleared, ascension, seats }: {
  act: number
  roomsCleared: number
  ascension: number
  seats: readonly SummarySeat[]
}) {
  return (
    <div className="run-summary">
      <dl className="run-summary__tallies">
        <div><dt>Act</dt><dd>{act}</dd></div>
        <div><dt>Rooms this act</dt><dd>{roomsCleared}</dd></div>
        <div><dt>Ascension</dt><dd>{ascension}</dd></div>
      </dl>
      <ul className="run-summary__seats">
        {seats.map((seat) => {
          const highlights = seat.deck ? deckHighlights(seat.deck) : []
          const character = CHARACTER_LABEL[seat.character] ?? seat.character
          return (
            <li key={seat.id} className={`run-summary__seat${seat.dead ? ' run-summary__seat--dead' : ''}`}>
              <div className="run-summary__seat-head">
                <strong>{seat.name}</strong>
                {/* Solo seats are named after their character, so printing both
                    read "Ironclad IRONCLAD". Only shown when it adds something —
                    which in multiplayer, where players name themselves, it does. */}
                {character.toLowerCase() === seat.name.toLowerCase() ? null
                  : <span className="run-summary__character">{character}</span>}
                {seat.dead ? <span className="run-summary__fallen">Fallen</span> : null}
              </div>
              <div className="run-summary__stats">
                {/* `role="img"` because a bare span is `role="generic"`, where
                    `aria-label` is prohibited and screen readers drop it — the
                    seat would announce "62 slash 80" with no idea it is health.
                    Gold needs no wrapper: `IconValue` already carries its own
                    visually-hidden unit. */}
                <span className="run-summary__hp" role="img" aria-label={`Health ${seat.hp} of ${seat.maxHp}`}>{seat.hp}/{seat.maxHp}</span>
                <IconValue name="gold" value={seat.gold} size={18} />
                {seat.deck ? <span className="run-summary__deck-size">{seat.deck.length} cards</span> : null}
              </div>
              <RelicBar relics={seat.relics} label={`${seat.name}'s relics`} />
              {highlights.length ? (
                <p className="run-summary__deck">
                  {highlights.map((entry) => `${entry.count}× ${entry.name}`).join(' · ')}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
