import { useEffect } from 'react'
import { assetPath } from '../../game/assets.ts'
import { CARD_PACKS } from '../../game/packs.ts'
import type { CardPackId } from '../../game/packs.ts'
import { visualId } from '../../game/skins.ts'
import type { CharacterId } from '../../game/types.ts'
import type { PublicSeat } from '../../multiplayer/useRoomSession.ts'
import { preferredSkin } from '../../skin-preference.ts'

export const CHARACTERS = [
  ['ironclad', 'Ironclad'],
  ['silent', 'Silent'],
  ['defect', 'Defect'],
  ['watcher', 'Watcher'],
  ['slime_boss', 'Slime Boss'],
  ['guardian', 'Guardian'],
  ['hexaghost', 'Hexaghost'],
  ['hermit', 'Hermit'],
] as const

/** Why a seat's boss coins were withheld; leaves on its own or when dismissed. */
export function ForeignSeatNotice({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 9_000)
    return () => clearTimeout(timer)
  }, [onDone])
  return <p className="coin-gain__notice" role="status">
    Another account signed in after this seat was taken, so its boss coins were not paid here.
    <button type="button" className="coin-gain__dismiss" aria-label="Dismiss" onClick={onDone}>×</button>
  </p>
}

/** "Ann Bo" → "AB", "Wanderer" → "WA": two letters that always fit a chip. */
const ownerInitials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join('') : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

/**
 * The Shop packs the next run will shuffle in: every pack somebody at the table
 * bought. One short chip per pack keeps the strip to a single line however many
 * players and names there are; whose each pack is lives in its tooltip and label.
 */
export function LobbyPacks({ packs, seats, you }: { packs: readonly CardPackId[]; seats: readonly PublicSeat[]; you: string }) {
  return <section className="online-lobby__packs" aria-labelledby="online-lobby-packs-title">
    <h2 id="online-lobby-packs-title">Slayer packs in play</h2>
    <ul>
      {packs.map((id) => {
        const owners = seats.filter((seat) => seat.cardPacks?.includes(id))
          .map((seat) => seat.playerId === you ? 'you' : seat.name)
        const label = `${CARD_PACKS[id].name}, from ${owners.join(', ')}`
        // Every chip carries the same compact marker, never a truncated name: "you",
        // one owner's initials, or a count. Full names are in the label and tooltip.
        const marker = owners.length > 1 ? `×${owners.length}` : owners[0] === 'you' ? 'you' : ownerInitials(owners[0] ?? '')
        return <li key={id} data-pack={id} title={label} aria-label={label}>
          <strong aria-hidden="true">{CARD_PACKS[id].name.replace(' Slayer Pack', '')}</strong>
          <small aria-hidden="true">{marker}</small>
        </li>
      })}
    </ul>
  </section>
}

/**
 * One place at the table.
 *
 * The character's own portrait rather than its name in small caps: four seats
 * spelling out "Ironclad · online" four times was most of the wall of text this
 * screen used to be, and the art says which class it is at a glance — the same
 * portrait the player will look at all run.
 */
export function Seat({ seat, you }: { seat?: PublicSeat; you?: boolean }) {
  const character = seat ? CHARACTERS.find(([id]) => id === seat.character) : undefined
  return (
    <div
      className={['online-seat', seat ? '' : 'online-seat--empty', you ? 'online-seat--you' : '']
        .filter(Boolean).join(' ')}
      // A bare div resolves to role=generic, where `aria-label` is prohibited
      // and silently dropped — the same trap `RelicChip` documents. The label is
      // the whole accessible content of the seat, so it has to survive.
      role="group"
      aria-label={seat
        ? `${seat.name}, ${character?.[1] ?? seat.character}${you ? ', you' : ''}, ${seat.connected ? 'online' : 'away'}`
        : 'Open seat'}
    >
      {seat ? (
        <>
          <span className="online-seat__portrait" aria-hidden="true">
            <img src={assetPath(`combat/characters/${visualId(seat.character, seat.skin)}.webp`)} alt=""
              onError={(event) => { event.currentTarget.style.display = 'none' }} />
          </span>
          <span className="online-seat__name" aria-hidden="true" title={seat.name}>{seat.name}</span>
          {seat.connected ? null : <span className="online-seat__class" aria-hidden="true"><em>away</em></span>}
        </>
      ) : <span className="online-seat__open" aria-hidden="true">+</span>}
    </div>
  )
}

/** The same close-cropped hero strip used by the polished solo screen. */
export function CharacterRoster({ character, onChoose, taken, disabled = false }: {
  character: CharacterId
  onChoose: (character: (typeof CHARACTERS)[number][0]) => void
  taken?: ReadonlySet<string>
  disabled?: boolean
}) {
  return (
    <div className="online-character-roster" role="group" aria-label="Choose your character">
      {CHARACTERS.map(([id, label]) => {
        const unavailable = Boolean(taken?.has(id) && id !== character)
        return <button type="button" className="online-character-roster__portrait" key={id} aria-label={label} aria-pressed={id === character}
          disabled={disabled || unavailable} onClick={() => onChoose(id)}>
          <img src={assetPath(`menu/character-select/portrait-${visualId(id, preferredSkin(id))}.png`)} alt="" />
        </button>
      })}
    </div>
  )
}
