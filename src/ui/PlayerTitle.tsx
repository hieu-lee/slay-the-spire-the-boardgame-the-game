import type { CharacterId } from '../game/types.ts'
import { savedProfile } from '../profile.ts'
import { CHARACTER_LABEL } from './run-summary-data.ts'

export function PlayerTitle({ character }: { character?: CharacterId }) {
  return <h1 className="player-title"><span>{savedProfile()?.username}</span>{character && <small>the {CHARACTER_LABEL[character]}</small>}</h1>
}
