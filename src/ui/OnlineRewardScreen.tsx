import { useState } from 'react'
import { cardDef, cardIsCurse } from '../game/cards.ts'
import type { VisibleRun } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'
import { ItemImage } from './ItemImage.tsx'
import { RewardItem } from './RewardScreen.tsx'
import { potionDef, relicDef } from '../game/relics.ts'
import type { RewardSource } from '../game/run.ts'
import { rewardSourceLabel } from './reward-source.ts'
import { potionLimit } from '../game/acquisition.ts'

type Props = {
  run: VisibleRun
  viewerId: string
  choice?: number | null
  decided: string[]
  confirmed: string[]
  onAction: (action: object) => void
}

export function OnlineRewardScreen({ run, viewerId, choice, decided, confirmed, onAction }: Props) {
  const [upgradePreviews, setUpgradePreviews] = useState<Record<string, boolean>>({})
  const [sources, setSources] = useState<RewardSource[]>([])
  // Item rewards are settled by the table, so they still gate everyone. Whether
  // a TEAMMATE has picked their card does not: one player reconsidering used to
  // reopen the confirmation for all four, which is what made this feel like two
  // rounds of clicking instead of one.
  const itemsSettled = run.rewards.every((offer) => !offer.transformReward &&
    offer.potion === false && (offer.relic ?? false) === false && (offer.bossRelics ?? false) === false)
  const cardOffers = run.rewards.filter((offer) => offer.cardReward)
  const confirmedCount = cardOffers.filter((offer) => confirmed.includes(offer.playerId)).length
  const iConfirmed = confirmed.includes(viewerId)
  const iDecided = decided.includes(viewerId)

  return (
    <section className="reward-screen">
      <h2 className="reward-screen__title">Rewards!</h2>
      {/* Only when there IS a card to choose: a boss-relic, relic-only or
          potion-only reward printed card instructions with no cards on it. */}
      {cardOffers.length > 0
        ? <p className="muted">Revealed cards are shared knowledge. Choose only for your own deck.</p>
        : null}
      <div className="reward-screen__players">
        {run.rewards.map((offer) => {
          const player = run.players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          const mine = player.id === viewerId
          const selectedSources = sources.filter((source) => offer.availableSources?.includes(source))
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.relic === null ? (
                <RewardItem kind="relic" title="Relic reward" note={mine ? 'Still face down.' : 'Not revealed yet.'}>
                  {mine ? <>
                    <button type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'reveal' })}>Reveal Relic</button>
                    <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'skip' })}>Skip Relic unseen</button>
                  </> : null}
                </RewardItem>
              ) : typeof offer.relic === 'string' ? (
                <RewardItem kind="relic" id={offer.relic} title={relicDef(offer.relic).name}>
                  {mine ? <>
                    <button type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'gain' })}>Gain Relic</button>
                    <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'skip' })}>Skip</button>
                  </> : null}
                </RewardItem>
              ) : null}
              {Array.isArray(offer.bossRelics) ? <div className="reward-boss"><strong>Choose a boss Relic</strong>
                <div className="reward-boss__row">
                  {offer.bossRelics.map((id) => <button className="reward-boss__pick" disabled={!mine} type="button" key={id} onClick={() => onAction({ kind: 'bossRelicReward', choice: 'gain', relicId: id })}>
                    <ItemImage kind="relic" id={id} /><strong>{relicDef(id).name}</strong>
                    <span className="room-item-text">{relicDef(id).text}</span></button>)}
                </div>
                {mine ? <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'bossRelicReward', choice: 'skip' })}>Skip</button> : null}</div> : null}
              {offer.potion === null ? (
                <RewardItem kind="potion" title="Potion reward" note={mine ? 'Still face down.' : 'Not revealed yet.'}>
                  {mine ? <>
                    <button type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'reveal' })}>Reveal Potion</button>
                    <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'skip' })}>Skip unseen</button>
                  </> : null}
                </RewardItem>
              ) : typeof offer.potion === 'string' ? (
                <RewardItem kind="potion" id={offer.potion} title={potionDef(offer.potion).name}>
                  {mine ? <>
                    <button type="button" disabled={player.potions.length >= potionLimit(run.ascension, player) ||
                      player.relics.some((relic) => relic.defId === 'sozu')}
                      onClick={() => onAction({ kind: 'potionReward', choice: 'gain' })}>Gain</button>
                    <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'skip' })}>Skip</button>
                    {player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
                      disabled={player.relics.some((relic) => relic.defId === 'sozu')}
                      onClick={() => onAction({ kind: 'potionReward', choice: 'replace', potionId: held })}><ItemImage kind="potion" id={held} />Replace {potionDef(held).name}</button>)}
                    {run.players.filter((target) => target.id !== player.id && !target.dead &&
                      target.potions.length < potionLimit(run.ascension, target) &&
                      !target.relics.some((relic) => relic.defId === 'sozu')).map((target) => <button type="button" key={target.id}
                      onClick={() => onAction({ kind: 'potionReward', choice: 'pass', playerId: target.id })}>Pass to {target.name}</button>)}
                  </> : null}
                </RewardItem>
              ) : null}
              {offer.transformReward ? mine ? <div className="reward-screen__transform">
                <strong>Transform a card</strong>
                <div className="reward-screen__cards">{(player.deck ?? []).filter((card) => !cardIsCurse(card.defId)).map((card) =>
                  <Card key={card.uid} card={card} playable
                    onClick={() => onAction({ kind: 'transformReward', cardUid: card.uid })} />)}</div>
                <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'transformReward', cardUid: null })}>Skip Transform</button>
              </div> : <span className="muted">{player.name} is choosing a card to Transform.</span> : null}
              {!offer.cardReward ? null : <>
              {offer.upgraded && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  {mine ? (
                    offer.prismatic ? <fieldset className="reward-screen__sources"><legend>Choose 3 different reward decks</legend>
                      {(offer.availableSources ?? []).map((source) => <label key={source}><input type="checkbox"
                        checked={selectedSources.includes(source)} onChange={(event) => setSources(() => event.target.checked
                          ? selectedSources.length < 3 ? [...selectedSources, source] : selectedSources
                          : selectedSources.filter((candidate) => candidate !== source))} /> {rewardSourceLabel(source)}</label>)}
                      <button type="button" disabled={selectedSources.length !== 3}
                        onClick={() => onAction({ kind: 'cardReward', choice: 'reveal', sources: selectedSources })}>Reveal chosen decks</button>
                    </fieldset> : <button type="button" onClick={() => onAction({ kind: 'cardReward', choice: 'reveal' })}>
                      Reveal 3
                    </button>
                  ) : <span className="muted">Not revealed yet</span>}
                </div>
              ) : (
                <>
                <div className="reward-screen__cards">
                  {offer.choices.map((defId, index) => {
                    const key = `${player.id}-${index}`
                    const showingUpgrade = upgradePreviews[key] ?? offer.upgraded
                    return (
                      <div className="reward-screen__choice" key={key}>
                        {offer.rareChoiceIndices?.includes(index) && (
                          <span className="reward-screen__rare">Golden Ticket · Rare</span>
                        )}
                        <Card
                          card={{ uid: `reward-${key}`, defId, upgraded: showingUpgrade }}
                          playable={mine}
                          selected={mine && choice === index}
                          onClick={mine ? () => onAction({ kind: 'cardReward', choice: index }) : undefined}
                        />
                        <button
                          type="button"
                          aria-pressed={showingUpgrade}
                          onClick={() => setUpgradePreviews((current) => ({ ...current, [key]: !showingUpgrade }))}
                        >
                          Show {cardDef(defId).name} {showingUpgrade ? 'base' : 'upgrade'}
                        </button>
                      </div>
                    )
                  })}
                </div>
                <span className="reward-screen__scroll-hint muted">
                  {offer.choices.length} choices · scroll to see all
                </span>
                </>
              )}
              </>}
              {offer.cardReward && (mine ? (
                <button
                  type="button"
                  className={`reward-screen__skip ${choice === null ? 'is-chosen' : ''}`}
                  onClick={() => onAction({ kind: 'cardReward', choice: null })}
                >
                  {choice === null ? '✓ ' : ''}Skip card
                </button>
              ) : (
                <span className="muted">{decided.includes(player.id) ? 'Chosen' : 'Choosing…'}</span>
              ))}
            </div>
          )
        })}
      </div>
      {/* One button, and it stays live after you press it — the count is what
          tells you who the party is still waiting on, and pressing again is how
          you take your own confirmation back to change your card. */}
      <button
        className="reward-screen__collect"
        type="button"
        aria-pressed={iConfirmed}
        disabled={!itemsSettled || !iDecided}
        onClick={() => onAction({ kind: 'cardReward', choice: iConfirmed ? 'unconfirm' : 'confirm' })}
      >
        {iConfirmed ? '✓ ' : ''}Confirm rewards {confirmedCount}/{cardOffers.length}
      </button>
      {iConfirmed && confirmedCount < cardOffers.length ? (
        <p className="muted" role="status">Waiting for the party. Press again to change your card.</p>
      ) : null}
    </section>
  )
}
