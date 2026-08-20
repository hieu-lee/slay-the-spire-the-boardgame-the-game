import { useEffect, useRef, useState } from 'react'

export type GiveUpVote = {
  runId: string
  deadlineAt: number
  remainingMs: number
  receivedAt?: number
  eligiblePlayerIds: string[]
  votes: Record<string, boolean>
}

export function GiveUpPanel({ vote, players, playerId, onVote, onCancel, onExpire }: {
  vote?: GiveUpVote
  players: { id: string; name: string }[]
  playerId: string
  onVote: (yes: boolean) => void
  onCancel?: () => void
  onExpire?: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [remaining, setRemaining] = useState(() => vote
    ? Math.max(0, vote.remainingMs - (performance.now() - (vote.receivedAt ?? performance.now())))
    : null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  })

  useEffect(() => {
    if (!vote) return undefined
    const receivedAt = vote.receivedAt ?? performance.now()
    let timer: number | undefined
    const update = () => {
      const next = Math.max(0, vote.remainingMs - (performance.now() - receivedAt))
      setRemaining(next)
      if (next === 0 && timer !== undefined) {
        onExpire?.()
        clearInterval(timer)
        timer = undefined
      }
    }
    timer = window.setInterval(update, 100)
    update()
    return () => { if (timer !== undefined) clearInterval(timer) }
  }, [onExpire, vote?.deadlineAt])

  if (remaining === 0) return null
  const eligible = vote?.eligiblePlayerIds ?? [playerId]
  const ownVote = vote?.votes[playerId]
  return (
    <dialog ref={dialogRef} className="choice-modal give-up-panel" aria-labelledby="give-up-title"
      onCancel={(event) => { event.preventDefault(); onCancel?.() }}>
      <section className="choice-modal__panel">
        <h2 id="give-up-title">Give up this run?</h2>
        {vote ? <>
          <p role="timer">{Math.ceil((remaining ?? 0) / 1000)}s remaining</p>
          <ul>{eligible.map((id) => {
            const answer = vote.votes[id]
            return <li key={id}>{players.find((player) => player.id === id)?.name ?? id}: {
              answer === true ? 'Yes' : answer === false ? 'No' : 'Waiting'
            }</li>
          })}</ul>
        </> : <p>This ends the run immediately.</p>}
        <div className="give-up-panel__actions">
          <button type="button" disabled={ownVote === true} onClick={() => onVote(true)}>Yes, give up</button>
          <button type="button" disabled={ownVote === false} onClick={() => onVote(false)}>{vote ? 'No' : 'Cancel'}</button>
        </div>
      </section>
    </dialog>
  )
}
