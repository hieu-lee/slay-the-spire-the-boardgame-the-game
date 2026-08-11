import type { Player } from '../game/types.ts'

type Props = {
  players: Player[]
  editablePlayerId?: string
  readyPlayerIds?: string[]
  onSwitchRow: (playerId: string, row: number) => void
  onContinue: () => void
}

export function BetweenCombatScreen({ players, editablePlayerId, readyPlayerIds, onSwitchRow, onContinue }: Props) {
  const living = players.filter((player) => !player.dead)
  return (
    <section className="reward-screen">
      <h2>Between bosses</h2>
      <p className="muted">Use or trade potions, switch rows, then face the next boss.</p>
      <div className="reward-screen__players">
        {living.map((player) => (
          <fieldset className="reward-screen__player" key={player.id}>
            <legend>{player.name}</legend>
            {[0, 1, 2, 3].map((row) => (
              <button type="button" key={row} disabled={editablePlayerId !== undefined && editablePlayerId !== player.id}
                aria-pressed={player.row === row} onClick={() => onSwitchRow(player.id, row)}>
                Row {row + 1}{player.row === row ? ' ✓' : ''}
              </button>
            ))}
          </fieldset>
        ))}
      </div>
      {readyPlayerIds ? <p className="muted">{readyPlayerIds.length}/{living.length} players ready</p> : null}
      <button type="button" disabled={editablePlayerId !== undefined && readyPlayerIds?.includes(editablePlayerId)} onClick={onContinue}>
        {readyPlayerIds ? 'Ready for the next boss' : 'Face the next boss'}
      </button>
    </section>
  )
}
