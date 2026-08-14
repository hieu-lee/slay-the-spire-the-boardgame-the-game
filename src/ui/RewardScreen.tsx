import { useState } from 'react'
import { cardDef } from '../game/cards.ts'
import type { CardRewardOffer, RewardSource } from '../game/run.ts'
import type { PotionRewardDecision } from '../game/run.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'

type RewardScreenProps = {
  players: Player[]
  rewards: CardRewardOffer[]
  onReveal: (playerId: string, sources?: readonly RewardSource[]) => void
  onRevealPotion: (playerId: string) => void
  onPotion: (playerId: string, decision: PotionRewardDecision) => void
  onRelic: (playerId: string, choice: 'reveal' | 'gain' | 'skip') => void
  onBossRelic: (playerId: string, relicId: string | null) => void
  onTransform: (playerId: string, cardUid: string | null) => void
  onResolve: (decisions: Record<string, number | null>) => void
  potionLimit: number
}

/** Every living player takes one revealed card or skips (rulebook p.8). */
export function RewardScreen({ players, rewards, onReveal, onRevealPotion, onPotion, onRelic, onBossRelic, onTransform, onResolve, potionLimit }: RewardScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, number | null>>({})
  const [upgradePreviews, setUpgradePreviews] = useState<Record<string, boolean>>({})
  const [sources, setSources] = useState<Record<string, RewardSource[]>>({})
  const settled = rewards.every((offer) => (!offer.cardReward || offer.playerId in decisions) && !offer.transformReward &&
    offer.potion === false && (offer.relic ?? false) === false && (offer.bossRelics ?? false) === false)

  return (
    <section className="reward-screen">
      <h2 className="reward-screen__title">Rewards!</h2>
      <p className="muted">Choose one revealed card for each player, or skip it.</p>
      <div className="reward-screen__players">
        {rewards.map((offer) => {
          const player = players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          const selectedSources = (sources[player.id] ?? []).filter((source) => offer.availableSources?.includes(source))
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.relic === null ? <p><button type="button" onClick={() => onRelic(player.id, 'reveal')}>Reveal Relic</button>{' '}
                <button className="reward-screen__skip" type="button" onClick={() => onRelic(player.id, 'skip')}>Skip Relic unseen</button></p>
                : typeof offer.relic === 'string' ? <div className="reward-screen__relic"><strong>{relicDef(offer.relic).name}</strong>
                  <span>{relicDef(offer.relic).text}</span><button type="button" onClick={() => onRelic(player.id, 'gain')}>Gain Relic</button>
                  <button className="reward-screen__skip" type="button" onClick={() => onRelic(player.id, 'skip')}>Skip</button></div> : null}
              {Array.isArray(offer.bossRelics) ? <div className="reward-screen__relic"><strong>Choose a boss Relic</strong>
                {offer.bossRelics.map((id) => <button type="button" key={id} onClick={() => onBossRelic(player.id, id)}>{relicDef(id).name} — {relicDef(id).text}</button>)}
                <button className="reward-screen__skip" type="button" onClick={() => onBossRelic(player.id, null)}>Skip</button></div> : null}
              {offer.potion === null ? (
                <p><button type="button" onClick={() => onRevealPotion(player.id)}>Reveal Potion</button>{' '}
                  <button type="button" onClick={() => onPotion(player.id, { kind: 'skip' })}>Skip Potion unseen</button></p>
              ) : typeof offer.potion === 'string' ? (
                <div className="reward-screen__potion">
                  <strong>{potionDef(offer.potion).name}</strong>
                  <button type="button" disabled={player.potions.length >= potionLimit || player.relics.some((relic) => relic.defId === 'sozu')}
                    onClick={() => onPotion(player.id, { kind: 'gain' })}>Gain</button>
                  <button type="button" onClick={() => onPotion(player.id, { kind: 'skip' })}>Skip</button>
                  {player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
                    disabled={player.relics.some((relic) => relic.defId === 'sozu')}
                    onClick={() => onPotion(player.id, { kind: 'replace', potionId: held })}>Replace {potionDef(held).name}</button>)}
                  {players.filter((target) => target.id !== player.id && !target.dead && target.potions.length < potionLimit &&
                    !target.relics.some((relic) => relic.defId === 'sozu')).map((target) =>
                    <button type="button" key={target.id} onClick={() => onPotion(player.id, { kind: 'pass', playerId: target.id })}>Pass to {target.name}</button>)}
                </div>
              ) : null}
              {offer.transformReward ? <div className="reward-screen__transform">
                <strong>Transform a card</strong>
                <div className="reward-screen__cards">{player.deck.filter((card) => cardDef(card.defId).owner !== 'curse').map((card) =>
                  <Card key={card.uid} card={card} playable actionLabel="Transform" onClick={() => onTransform(player.id, card.uid)} />)}</div>
                <button className="reward-screen__skip" type="button" onClick={() => onTransform(player.id, null)}>Skip Transform</button>
              </div> : null}
              {!offer.cardReward ? null : <>
              {offer.upgraded && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  {offer.prismatic ? <fieldset className="reward-screen__sources"><legend>Choose 3 different reward decks</legend>
                    {(offer.availableSources ?? []).map((source) => <label key={source}>
                      <input type="checkbox" checked={selectedSources.includes(source)}
                        onChange={(event) => setSources((current) => {
                          const selected = selectedSources
                          return { ...current, [player.id]: event.target.checked
                            ? selected.length < 3 ? [...selected, source] : selected
                            : selected.filter((candidate) => candidate !== source) }
                        })} /> {source === 'colorless' ? 'Colorless' : source[0]!.toUpperCase() + source.slice(1)}
                    </label>)}
                    <button type="button" disabled={selectedSources.length !== 3}
                      onClick={() => onReveal(player.id, selectedSources)}>Reveal chosen decks</button>
                  </fieldset> : <button type="button" onClick={() => onReveal(player.id)}>Reveal 3 for {player.name}</button>}
                  <span className="muted">or skip without looking</span>
                </div>
              ) : (
                <>
                  <div className="reward-screen__cards">
                    {offer.choices.map((defId, index) => {
                      const key = `${player.id}-${index}`
                      const previewing = upgradePreviews[key] ?? offer.upgraded
                      const name = cardDef(defId).name
                      return (
                        <div className="reward-screen__choice" key={`${index}-${defId}`}>
                          {offer.rareChoiceIndices?.includes(index) && (
                            <span className="reward-screen__rare">Golden Ticket · Rare</span>
                          )}
                          <Card
                            card={{
                              uid: `reward-${player.id}-${index}`,
                              defId,
                              upgraded: previewing,
                            }}
                            selected={decisions[player.id] === index}
                            onClick={() => setDecisions((current) => ({ ...current, [player.id]: index }))}
                          />
                          <button
                            type="button"
                            aria-pressed={previewing}
                            onClick={() => setUpgradePreviews((current) => ({ ...current, [key]: !previewing }))}
                          >
                            Show {name} {previewing ? 'base' : 'upgrade'}
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
              <button
                type="button"
                className={`reward-screen__skip ${decisions[player.id] === null ? 'is-chosen' : ''}`}
                aria-pressed={decisions[player.id] === null}
                onClick={() => setDecisions((current) => ({ ...current, [player.id]: null }))}
              >
                {decisions[player.id] === null ? '✓ ' : ''}
                {offer.choices === null ? `Skip ${player.name}'s reward unseen` : `Skip ${player.name}'s card`}
              </button>
              </>}
            </div>
          )
        })}
      </div>
      <button className="reward-screen__collect" type="button" disabled={!settled} onClick={() => onResolve(decisions)}>
        {settled ? 'Collect rewards' : 'Everyone must choose'}
      </button>
    </section>
  )
}
