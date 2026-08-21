import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CARDS } from "../game/cards.ts";
import { potionDef, relicDef } from "../game/relics.ts";
import type { EventDecision, EventRoomState } from "../game/event-room.ts";
import type {
  CourierOffer,
  MerchantPurchase,
  MerchantState,
  RelicRewardState,
  TreasureDecision,
} from "../game/noncombat.ts";
import { courierCost } from "../game/noncombat.ts";
import { relicOptionLabel } from "./RelicChip.tsx";
import { Card } from "./Card.tsx";
import type { Player } from "../game/types.ts";
import type { EventEffect } from "../game/events.ts";
import type { RewardSource } from "../game/run.ts";
import { ItemImage } from "./ItemImage.tsx";

type Props = {
  room: MerchantState | RelicRewardState | EventRoomState;
  players: Player[];
  viewerId: string;
  ascension: number;
  onPurchase: (purchase: MerchantPurchase) => void;
  onRemove: (
    playerId: string,
    cardUid: string,
    payments: Record<string, number>,
  ) => void;
  onFinishMerchant: () => void;
  onRelic: (playerId: string, decision: TreasureDecision) => void;
  onEvent: (playerId: string, decision: EventDecision) => void;
  sapphireAvailable?: boolean;
  merchantPledges?: PropsPledgeMap;
  onWithdraw?: (key: string) => void;
  eventForwardRooms?: { id: string; label: string }[];
  eventPledge?: { actorId: string; optionId: string; cost: number; payments: Record<string, number>; decision: EventDecision };
  onCancelEventPayment?: () => void;
  eventCanSkip?: boolean;
  onSkipEvent?: (playerId: string) => void;
  /** Arms the next deck change to play as a reveal, for a card gained without ever being shown (a random card/rare reward). */
  onArmCardGain?: () => void;
};

type PropsPledgeMap = Record<
  string,
  {
    buyerId: string;
    section?: string;
    slot?: number;
    kind?: "removal";
    cardUid?: string;
    potionRecipientId?: string;
    discardPotionId?: string;
    payments: Record<string, number>;
  }
>;

type EventCardSlot = (card: Player["deck"][number]) => boolean;
type PublicPlayerCounts = { cardRewardCount?: number; deckCount?: number };

const hasSozu = (player: Player) => player.relics.some((relic) => relic.defId === "sozu");

function eventCardSlots(effects: readonly EventEffect[], die: number | undefined, player: Player, players: readonly Player[]): EventCardSlot[] {
  const slots: EventCardSlot[] = [];
  for (const effect of effects) {
    if (effect.tag === "roll-d6" && die) {
      slots.push(...eventCardSlots(effect.results?.[die as 1 | 2 | 3 | 4 | 5 | 6] ?? [], die, player, players));
      continue;
    }
    if (!["remove-card", "upgrade-card", "transform-card", "trade-card"].includes(effect.tag) || (effect.random && effect.filter !== "choose from three revealed cards")) continue;
    const matches: EventCardSlot = (card) => {
      const def = CARDS[card.defId];
      if (card.defId === "ascenders_bane") return false;
      if (effect.tag === "upgrade-card" && (card.upgraded || !def?.upgrade)) return false;
      if (effect.tag === "transform-card" && (def?.owner === "curse" || (player.cardRewards.length === 0 && ((player as PublicPlayerCounts).cardRewardCount ?? 0) === 0))) return false;
      if (effect.tag === "trade-card" && !players.some((candidate) => candidate.id !== player.id && !candidate.dead && (candidate.deck.some((entry) => entry.defId !== "ascenders_bane") || ((candidate as PublicPlayerCounts).deckCount ?? 0) > 0))) return false;
      if (effect.filter === "starter Strike") return def?.rarity === "starter" && def.name === "Strike";
      if (effect.filter === "rare or uncommon") return ["rare", "uncommon"].includes(def?.rarity ?? "");
      return true;
    };
    if (effect.filter === "one starter Strike and one starter Defend") {
      for (const name of ["Strike", "Defend"]) if (player.deck.some((card) => !card.upgraded && CARDS[card.defId]?.rarity === "starter" && CARDS[card.defId]?.name === name)) {
        slots.push((card) => !card.upgraded && CARDS[card.defId]?.rarity === "starter" && CARDS[card.defId]?.name === name);
      }
      continue;
    }
    slots.push(...Array<EventCardSlot>(Math.min(effect.count ?? 1, player.deck.filter(matches).length)).fill(matches));
  }
  const eligible = new Set(player.deck.filter((card) => slots.some((matches) => matches(card))).map((card) => card.uid));
  return slots.slice(0, eligible.size);
}

function Price({ value, sale = false }: { value: number | null; sale?: boolean }) {
  return (
    <span className={`room-price${sale ? " room-price--sale" : ""}`}>
      {value === null ? "Sold" : <>{sale ? <span className="room-price__sale-mark" aria-hidden="true">%</span> : null}
        <img src="/assets/relic-icons/old_coin.png" alt="" />{value}
        <span className="visually-hidden"> Gold{sale ? ", on sale" : ""}</span></>}
    </span>
  );
}

export function CourierPanel({ players, viewerId, ascension, usedBy, offer, pledge, online = false, onReveal, onResolve }: {
  players: Player[];
  viewerId: string;
  ascension: number;
  usedBy: string[];
  offer: CourierOffer | null;
  pledge?: { playerId: string; id: string; discardPotionId?: string; payments: Record<string, number> };
  online?: boolean;
  onReveal: (kind: CourierOffer['kind']) => void;
  onResolve: (decision: 'buy' | 'discard', payments?: Record<string, number>, discardPotionId?: string) => void;
}) {
  const viewer = players.find((player) => player.id === viewerId) ?? players[0]!;
  const owner = players.find((player) => player.id === offer?.playerId) ?? viewer;
  const [discardPotionId, setDiscardPotionId] = useState('');
  const livingPlayers = players.filter((player) => !player.dead);
  const ownsCourier = !viewer.dead && viewer.relics.some((relic) => relic.defId === 'the_courier');
  if (!offer && (!ownsCourier || usedBy.includes(viewer.id))) return null;
  if (!offer) return <aside className="courier-panel" aria-label="The Courier"><strong>The Courier</strong><span>Once this combat, inspect a deck.</span><button type="button" onClick={() => onReveal('relic')}>Look at Relic</button><button type="button" onClick={() => onReveal('potion')}>Look at Potion</button></aside>;
  const cost = courierCost(offer);
  const funded = Object.values(pledge?.payments ?? {}).reduce((sum, amount) => sum + amount, 0);
  const remaining = Math.max(0, (cost ?? 0) - funded);
  const mine = pledge?.payments[viewer.id] ?? 0;
  const contribution = viewer.dead ? 0 : online ? Math.min(Math.max(0, viewer.gold - mine), remaining) : livingPlayers.reduce((sum, player) => sum + player.gold, 0) >= remaining ? remaining : 0;
  const partyCanAfford = livingPlayers.reduce((sum, player) => sum + player.gold, 0) >= remaining;
  const payments = online ? { [viewer.id]: mine + contribution } : (() => {
    let left = remaining;
    return Object.fromEntries(livingPlayers.map((player): [string, number] => {
      const paid = Math.min(player.gold, left);
      left -= paid;
      return [player.id, paid];
    }).filter(([, paid]) => paid > 0));
  })();
  const potionBlocked = offer.kind === 'potion' && hasSozu(owner);
  const potionFull = offer.kind === 'potion' && owner.potions.length >= (ascension >= 4 ? 2 : 3);
  const canFund = !viewer.dead && !potionBlocked && cost !== null && (pledge ? contribution > 0 : (!online || viewer.id === owner.id) && partyCanAfford) && (!online || viewer.id === owner.id || Boolean(pledge)) && (!potionFull || Boolean(pledge?.discardPotionId ?? discardPotionId));
  return <aside className="courier-panel" aria-label="The Courier offer"><strong>The Courier · {offer.kind === 'relic' ? relicDef(offer.id).name : potionDef(offer.id).name}</strong><ItemImage kind={offer.kind} id={offer.id} card /><span className="room-item-text">{offer.kind === 'relic' ? relicDef(offer.id).text : potionDef(offer.id).text}</span><span>{potionBlocked ? 'Sozu prevents gaining Potions' : cost === null ? 'Cannot be bought' : `◉ ${cost}${funded ? ` · ${remaining} remaining` : ''}`}</span>{potionFull && !potionBlocked && viewer.id === owner.id && !pledge ? <fieldset className="item-replacement" aria-label="Replace Potion"><legend>Replace Potion</legend>{owner.potions.map((id, index) => <button type="button" key={`${id}-${index}`} aria-pressed={discardPotionId === id} onClick={() => setDiscardPotionId((current) => current === id ? '' : id)}><ItemImage kind="potion" id={id} card />{potionDef(id).name}</button>)}</fieldset> : null}<button type="button" disabled={!canFund} onClick={() => onResolve('buy', payments, pledge?.discardPotionId ?? (discardPotionId || undefined))}>Buy / pledge ◉ {contribution}</button>{viewer.id === owner.id ? <button type="button" onClick={() => onResolve('discard')}>Discard offer</button> : null}</aside>;
}

export function RoomScreen(props: Props) {
  if (props.room.kind === "merchant")
    return <MerchantScreen {...props} room={props.room} />;
  if (props.room.kind === "event")
    return <EventScreen {...props} room={props.room} />;
  return <RelicRoomScreen {...props} room={props.room} />;
}

function MerchantScreen({
  room,
  players,
  viewerId,
  ascension,
  onPurchase,
  onRemove,
  onFinishMerchant,
  merchantPledges = {},
  onWithdraw,
}: Props & { room: MerchantState }) {
  const player =
    players.find((candidate) => candidate.id === viewerId) ?? players[0]!;
  const [buyerId, setBuyerId] = useState(player.id);
  const buyer = players.find((candidate) => candidate.id === buyerId) ?? player;
  const [removeUid, setRemoveUid] = useState("");
  const [removalOpen, setRemovalOpen] = useState(false);
  const removalDialog = useRef<HTMLDialogElement>(null);
  const [potionReplacementSlot, setPotionReplacementSlot] = useState<number | null>(null);
  const potionReplacementDialog = useRef<HTMLDialogElement>(null);
  const [discardPotionId, setDiscardPotionId] = useState("");
  const validDiscardPotionId = buyer.potions.includes(discardPotionId) ? discardPotionId : "";
  const buyerHasSozu = hasSozu(buyer);
  const potionLimit = ascension >= 4 ? 2 : 3;
  const removalUsed = room.removalUsed.includes(buyer.id);
  const removalCost = ascension >= 8 ? 4 : 3;
  const removalKey = `remove/${buyer.id}`;
  const removalPending = merchantPledges[removalKey];
  const removalUid = removalPending?.cardUid ?? removeUid;
  const removalRemaining = Math.max(0, removalCost - Object.values(removalPending?.payments ?? {}).reduce((sum, amount) => sum + amount, 0));
  const unpledgedGold = (candidate: Player, key: string) => Math.max(0, candidate.gold - Object.entries(merchantPledges).reduce((sum, [pendingKey, pending]) => pendingKey === key ? sum : sum + (pending.payments[candidate.id] ?? 0), 0));
  const contribution = (remaining: number, key: string) => onWithdraw
    ? Math.min(unpledgedGold(player, key), remaining)
    : players.reduce((sum, candidate) => sum + candidate.gold, 0) >= remaining ? remaining : 0;
  const additional = (remaining: number, key: string, mine = merchantPledges[key]?.payments[player.id] ?? 0) => onWithdraw
    ? Math.min(Math.max(0, unpledgedGold(player, key) - mine), remaining)
    : contribution(remaining, key);
  const pay = (amount: number, key: string) => {
    if (onWithdraw) return { [player.id]: (merchantPledges[key]?.payments[player.id] ?? 0) + amount };
    let remaining = amount;
    return Object.fromEntries(players.map((candidate): [string, number] => {
      const paid = Math.min(candidate.gold, remaining);
      remaining -= paid;
      return [candidate.id, paid];
    }).filter(([, paid]) => paid > 0));
  };
  const pledge = (
    buyerId: string,
    section: MerchantPurchase["section"],
    slot: number,
    cost: number,
  ) => {
    const key = `${buyerId}/${section}/${slot}`;
    const funded = Object.values(merchantPledges[key]?.payments ?? {}).reduce(
      (sum, amount) => sum + amount,
      0,
    );
    return {
      key,
      remaining: Math.max(0, cost - funded),
      mine: merchantPledges[key]?.payments[player.id],
    };
  };
  const canPledge = (funding: ReturnType<typeof pledge>) => merchantPledges[funding.key]
    ? additional(funding.remaining, funding.key, funding.mine) > 0
    : buyer.id === player.id && players.reduce((sum, candidate) => sum + unpledgedGold(candidate, funding.key), 0) >= funding.remaining;
  const removalUnavailable = removalUsed || Boolean(onWithdraw && buyer.id !== player.id &&
    (!removalPending || additional(removalRemaining, removalKey) <= 0));
  const sharedReserved = (section: MerchantPurchase["section"], slot: number, key: string) =>
    ["relic", "potion", "colorless"].includes(section) && Object.entries(merchantPledges).some(([pendingKey, pending]) =>
      pendingKey !== key && pending.section === section && pending.slot === slot);
  const replacementPotionId = potionReplacementSlot === null ? null : room.potions[potionReplacementSlot];
  const replacementPotionCost = replacementPotionId ? (potionDef(replacementPotionId).cost ?? null) : null;
  const replacementPotionFunding = potionReplacementSlot === null || replacementPotionCost === null
    ? null : pledge(buyer.id, "potion", potionReplacementSlot, replacementPotionCost);
  const replacementPotionReserved = potionReplacementSlot !== null && replacementPotionFunding
    ? sharedReserved("potion", potionReplacementSlot, replacementPotionFunding.key)
    : false;
  useEffect(() => {
    const dialog = removalDialog.current;
    if (!dialog) return;
    if (removalOpen && !dialog.open) dialog.showModal();
    else if (!removalOpen && dialog.open) dialog.close();
  }, [removalOpen]);
  useEffect(() => {
    if (!removalUsed) return;
    setRemovalOpen(false);
    setRemoveUid("");
  }, [removalUsed]);
  useEffect(() => {
    const dialog = potionReplacementDialog.current;
    if (!dialog) return;
    if (potionReplacementSlot !== null && !room.potions[potionReplacementSlot]) {
      setPotionReplacementSlot(null);
      setDiscardPotionId("");
      return;
    }
    if (potionReplacementSlot !== null && !dialog.open) dialog.showModal();
    else if (potionReplacementSlot === null && dialog.open) dialog.close();
  }, [potionReplacementSlot, room.potions]);
  return (
    <section
      className="room-stage merchant-stage"
      aria-labelledby="merchant-title"
    >
      <img
        className="merchant-figure"
        src="/assets/noncombat/merchant.webp"
        alt="A traveling merchant welcomes the party"
      />
      <p className="merchant-greeting" aria-hidden="true">Welcome! I have just what you need.</p>
      <div className="room-banner">
        <span>Welcome, traveler</span>
        <h2 id="merchant-title">The Merchant</h2>
        <p>
          Shared gold can fund any purchase. Choose a seat above to shop for
          them.
        </p>
        <label className="merchant-buyer">
          Shopping for
          <select value={buyer.id} onChange={(event) => { setBuyerId(event.target.value); setRemoveUid(""); setDiscardPotionId(""); setRemovalOpen(false); setPotionReplacementSlot(null); }}>
            {players.filter((candidate) => !candidate.dead).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
      </div>
      <div className="merchant-board">
        <div className="merchant-shelf merchant-shelf--relics" aria-label="Relics">
          <h3>Relics</h3>
          {room.relics.map((id, slot) => {
            const cost = id
              ? Math.max(0, (relicDef(id).cost ?? 99) - (slot === 0 ? 1 : 0))
              : null;
            const funding =
              cost === null ? null : pledge(buyer.id, "relic", slot, cost);
            return (
              <button
                className="merchant-item"
                key={slot}
                type="button"
                disabled={!id || !funding || !canPledge(funding) || sharedReserved("relic", slot, funding.key) || Boolean(onWithdraw && buyer.id !== player.id && !merchantPledges[funding.key])}
                onClick={() =>
                  id &&
                  funding &&
                  onPurchase({
                    buyerId: buyer.id,
                    section: "relic",
                    slot,
                    payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                  })
                }
              >
                {/* An icon, not a card face: the digital game lays its stock on
                    the rug as icons and puts the rules in a hover tip. The name
                    and rules still ride along in the accessible name, in the tip
                    on a pointer, and printed under the icon on touch — a shopper
                    cannot price a relic they cannot read. */}
                {id ? <ItemImage kind="relic" id={id} /> : <span className="room-item-icon">◆</span>}
                {id ? <strong>{relicDef(id).name}</strong> : null}
                {id ? <span className="room-item-text">{relicDef(id).text}</span> : null}
                <Price value={id ? cost : null} sale={slot === 0 && Boolean(id)} />
                {id ? <span className="merchant-tooltip" role="tooltip" aria-hidden="true"><strong>{relicDef(id).name}</strong>{relicDef(id).text}</span> : null}
                {funding && funding.remaining < cost! ? (
                  <small>{funding.remaining} Gold still needed</small>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="merchant-shelf merchant-shelf--potions" aria-label="Potions">
          <h3>Potions</h3>
          {room.potions.map((id, slot) => {
            const cost = id ? (potionDef(id).cost ?? null) : null;
            const funding = cost === null ? null : pledge(buyer.id, "potion", slot, cost);
            const pending = funding ? merchantPledges[funding.key] : undefined;
            const replacement = pending?.discardPotionId ?? validDiscardPotionId;
            const beltFull = buyer.potions.length >= potionLimit;
            return (
              <button
                className="merchant-item"
                key={slot}
                type="button"
                disabled={buyerHasSozu || !id || !funding || !canPledge(funding) || sharedReserved("potion", slot, funding.key) || Boolean(onWithdraw && buyer.id !== player.id && !pending) || (beltFull && !replacement && buyer.id !== player.id)}
                onClick={() => {
                  if (beltFull && !replacement) {
                    setDiscardPotionId("");
                    setPotionReplacementSlot(slot);
                    return;
                  }
                  if (id && funding) onPurchase({
                    buyerId: buyer.id,
                    section: "potion",
                    slot,
                    payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                    potionRecipientId: pending?.potionRecipientId ?? buyer.id,
                    discardPotionId: replacement || undefined,
                  });
                }}
              >
                {id ? <ItemImage kind="potion" id={id} /> : <span className="room-item-icon">●</span>}
                {id ? <strong>{potionDef(id).name}</strong> : null}
                {id ? <span className="room-item-text">{potionDef(id).text}</span> : null}
                <Price value={cost} />
                {id && buyerHasSozu ? <small>Blocked by Sozu</small> : null}
                {id ? <span className="merchant-tooltip" role="tooltip" aria-hidden="true"><strong>{potionDef(id).name}</strong>{potionDef(id).text}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="merchant-cards" aria-label={`${buyer.name}'s cards`}>
          <h3>{buyer.name} · Card Rewards</h3>
          {room.cards[buyer.id]?.choices.map((id, slot) => {
            const card = CARDS[id];
            const cost =
              card?.rarity === "common"
                ? 2
                : card?.rarity === "uncommon"
                  ? 3
                  : 6;
            const funding = pledge(buyer.id, "card", slot, cost);
            // The shop shows the card itself, the way the reward screen two
            // rooms over already does — a name and a rarity word is not enough
            // to price a card against. `Card` renders its own <button>, so the
            // price sits beside it rather than the whole tile being one.
            const blocked = !id || !canPledge(funding) || Boolean(onWithdraw && buyer.id !== player.id && !merchantPledges[funding.key]);
            return (
              // Grouped and labelled with the gold PRICE, which used to live
              // inside the tile's own <button>. `Card` is the button now, and
              // its accessible name covers the card itself — name, type, rules,
              // energy cost — but nothing on it says what the shop charges. The
              // name repeats in the group label so the group has an identifying
              // one; the price is the part that would otherwise be lost.
              <div className="merchant-card" key={slot} role="group"
                aria-label={id ? `${card?.name ?? 'Card'}, ${cost} Gold` : 'Sold'}>
                {id ? (
                  <Card
                    card={{ uid: `merchant-card-${buyer.id}-${slot}`, defId: id, upgraded: false }}
                    playable={!blocked}
                    onClick={() =>
                      onPurchase({
                        buyerId: buyer.id,
                        section: "card",
                        slot,
                        payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                      })
                    }
                  />
                ) : (
                  <p className="merchant-card__sold">Sold</p>
                )}
                {/* No price under a sold slot: the plate already says "Sold", and
                    `Price` prints the same word again for a null value. */}
                {id ? <Price value={cost} /> : null}
              </div>
            );
          })}
        </div>
        {room.colorless.length ? (
          <div
            className="merchant-cards merchant-cards--colorless"
            aria-label="Colorless cards"
          >
            <h3>Colorless</h3>
            {room.colorless.map((id, slot) => {
              const card = id ? CARDS[id] : undefined;
              const cost = card?.rarity === "uncommon" ? 3 : 6;
              const funding = pledge(buyer.id, "colorless", slot, cost);
              // Same treatment as the card shelf above.
              const blocked = !id || !canPledge(funding) || sharedReserved("colorless", slot, funding.key) || Boolean(onWithdraw && buyer.id !== player.id && !merchantPledges[funding.key]);
              return (
                // Same reason as the card shelf above.
                <div className="merchant-card" key={slot} role="group"
                  aria-label={id ? `${card?.name ?? 'Card'}, ${cost} Gold` : 'Sold'}>
                  {id ? (
                    <Card
                      card={{ uid: `merchant-colorless-${buyer.id}-${slot}`, defId: id, upgraded: false }}
                      playable={!blocked}
                      onClick={() =>
                        onPurchase({
                          buyerId: buyer.id,
                          section: "colorless",
                          slot,
                          payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                        })
                      }
                    />
                  ) : (
                    <p className="merchant-card__sold">Sold</p>
                  )}
                  {id ? <Price value={cost} /> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="merchant-removal">
          <button type="button" className="merchant-removal__service"
            disabled={removalUnavailable} onClick={() => setRemovalOpen(true)}>
            <span className="merchant-removal__cards" aria-hidden="true">▱</span>
            <strong>Card Removal Service</strong>
            <Price value={room.removalUsed.includes(buyer.id) ? null : removalCost} />
          </button>
        </div>
      </div>
      <dialog ref={potionReplacementDialog} className="choice-modal merchant-potion-dialog" aria-labelledby="merchant-potion-title"
        onCancel={(event) => { event.preventDefault(); setPotionReplacementSlot(null); setDiscardPotionId(""); }}>
        <section className="choice-modal__panel">
          <header><div><span>Potion belt full</span><h2 id="merchant-potion-title">Choose a potion to replace</h2></div>
            <button type="button" onClick={() => { setPotionReplacementSlot(null); setDiscardPotionId(""); }}>Cancel</button></header>
          <fieldset className="merchant-potion-discard" aria-label="Replace potion"><legend>Replace potion</legend>{buyer.potions.map((id, index) => <button type="button" key={`${id}-${index}`} aria-pressed={validDiscardPotionId === id} onClick={() => setDiscardPotionId((current) => current === id ? '' : id)}><ItemImage kind="potion" id={id} />{potionDef(id).name}</button>)}</fieldset>
          <button type="button" className="merchant-potion-dialog__confirm"
            disabled={!validDiscardPotionId || !replacementPotionId || !replacementPotionFunding || replacementPotionReserved || !canPledge(replacementPotionFunding)}
            onClick={() => {
              if (potionReplacementSlot === null || !replacementPotionId || !replacementPotionFunding || replacementPotionReserved) return;
              const pending = merchantPledges[replacementPotionFunding.key];
              onPurchase({
                buyerId: buyer.id,
                section: "potion",
                slot: potionReplacementSlot,
                payments: pay(additional(replacementPotionFunding.remaining, replacementPotionFunding.key, replacementPotionFunding.mine), replacementPotionFunding.key),
                potionRecipientId: pending?.potionRecipientId ?? buyer.id,
                discardPotionId: validDiscardPotionId,
              });
              setPotionReplacementSlot(null);
              setDiscardPotionId("");
            }}>Confirm {replacementPotionId ? potionDef(replacementPotionId).name : "purchase"}</button>
        </section>
      </dialog>
      <dialog ref={removalDialog} className="choice-modal merchant-removal-dialog" aria-labelledby="merchant-removal-title"
        onCancel={(event) => { event.preventDefault(); setRemovalOpen(false); }}>
        <section className="choice-modal__panel">
          <header><div><span>Card Removal Service</span><h2 id="merchant-removal-title">Choose a card to remove</h2></div>
            <button type="button" onClick={() => setRemovalOpen(false)}>Cancel</button></header>
          <div className="campfire__deck" role="group" aria-label="Card to remove">
            {buyer.deck.filter((card) => card.defId !== "ascenders_bane").map((card) => <Card key={card.uid}
              card={card} playable={!removalPending?.cardUid} selected={removalUid === card.uid}
              onClick={() => setRemoveUid(card.uid)} />)}
          </div>
          <button type="button" className="merchant-removal-dialog__confirm"
            disabled={
              (!removalPending && (!removeUid || Boolean(onWithdraw && buyer.id !== player.id) || players.reduce((sum, candidate) => sum + unpledgedGold(candidate, removalKey), 0) < removalRemaining)) ||
              (additional(removalRemaining, removalKey) <= 0 && (onWithdraw ? buyer.id !== player.id || Boolean(removalPending) : true)) ||
              removalUsed
            }
            onClick={() => {
              onRemove(buyer.id, removalUid, pay(additional(removalRemaining, removalKey), removalKey));
              setRemovalOpen(false);
            }}>
            {removalPending ? `Pledge · ◉ ${additional(removalRemaining, removalKey)}` : `Remove selected card · ◉ ${removalCost}`}
          </button>
        </section>
      </dialog>
      {Object.entries(merchantPledges).some(
        ([, pending]) => player.id in pending.payments,
      ) ? (
        <div
          className="merchant-pledges"
          aria-label="Your pending contributions"
        >
          <h3>Pending contributions</h3>
          {Object.entries(merchantPledges)
            .filter(([, pending]) => player.id in pending.payments)
            .map(([key, pending]) => (
              <button type="button" key={key} onClick={() => onWithdraw?.(key)}>
                {pending.buyerId === player.id
                  ? `Cancel ${pending.kind === "removal" ? "card removal" : `${pending.section} purchase`} and return all contributions`
                  : `Withdraw ${pending.payments[player.id]} Gold from ${pending.kind === "removal" ? "card removal" : pending.section}`}
              </button>
            ))}
        </div>
      ) : null}
      <button type="button" className="room-proceed" disabled={Object.keys(merchantPledges).length > 0 || Boolean(onWithdraw && player.id !== players[0]?.id)} onClick={onFinishMerchant}>
        ← Leave merchant
      </button>
    </section>
  );
}

function RelicRoomScreen({
  room,
  players,
  viewerId,
  onRelic,
  sapphireAvailable = false,
}: Props & { room: RelicRewardState }) {
  const player =
    players.find((candidate) => candidate.id === viewerId) ?? players[0]!;
  const relic = room.offers[player.id];
  const decided = room.decisions[player.id];
  const fullReward = room.sharedOffers
    ? room.sharedOffers.filter(Boolean).length >= room.playerIds.length
    : room.playerIds.every((id) => Boolean(room.offers[id]));
  const firstSharedOffer = room.sharedOffers?.findIndex(
    (id, index) => Boolean(id) && !Object.values(room.decisions).includes(index),
  ) ?? -1;
  const firstAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (decided === undefined) firstAction.current?.focus();
  }, [decided, firstSharedOffer, player.id, relic]);
  return (
    <section
      className="room-stage treasure-stage"
      aria-labelledby="treasure-title"
    >
      <div className="room-banner">
        <span>{room.kind === "elite" ? "Elite reward" : "Treasure room"}</span>
        <h2 id="treasure-title">Choose a Relic</h2>
        <p>
          Every player resolves their own face-up relic.
          {sapphireAvailable
            ? " The Sapphire Key requires everyone to skip."
            : ""}
        </p>
      </div>
      {room.sharedOffers ? <div className="treasure-shared" aria-label="Shared relic choices">{room.sharedOffers.map((id, index) => <button ref={index === firstSharedOffer ? firstAction : undefined} type="button" disabled={!id || decided !== undefined || Object.values(room.decisions).includes(index)} key={`${id}-${index}`} onClick={() => onRelic(player.id, index)}>{id ? <ItemImage kind="relic" id={id} card /> : <span>✦</span>}<strong>{id ? relicDef(id).name : "Taken"}</strong>{/* A <span>, not the <p> its siblings use: this one is inside a <button>, whose content model is phrasing only. The prose still folds into the button's accessible name, which is the point of putting it there. */}<span className="room-item-text">{id ? relicDef(id).text : ""}</span></button>)}</div> : <div className="treasure-relic">
        {relic ? <ItemImage kind="relic" id={relic} card /> : <span>✦</span>}
        <strong>{relic ? relicDef(relic).name : "No relic remains"}</strong>
        <p className="room-item-text">{relic ? relicDef(relic).text : ""}</p>
      </div>}
      <div className="treasure-actions">
        {!room.sharedOffers ? <button
          ref={relic ? firstAction : undefined}
          type="button"
          disabled={!relic || decided !== undefined}
          onClick={() => onRelic(player.id, "take")}
        >
          Take relic
        </button> : null}
        <button
          ref={room.sharedOffers ? firstSharedOffer < 0 ? firstAction : undefined : !relic ? firstAction : undefined}
          type="button"
          disabled={decided !== undefined}
          onClick={() => onRelic(player.id, "skip")}
        >
          Skip
        </button>
        {sapphireAvailable ? (
          <button
            type="button"
            disabled={!fullReward || decided !== undefined}
            onClick={() => onRelic(player.id, "sapphire")}
          >
            ◆ Skip for Sapphire Key
          </button>
        ) : null}
      </div>
      {decided !== undefined ? (
        <p role="status">Choice locked. Waiting for the party…</p>
      ) : null}
    </section>
  );
}

function EventScreen({
  room,
  players,
  viewerId,
  ascension,
  onEvent,
  eventForwardRooms = [],
  eventPledge,
  onWithdraw,
  onCancelEventPayment,
  eventCanSkip = false,
  onSkipEvent,
  onArmCardGain,
}: Props & { room: Extract<Props["room"], { kind: "event" }> }) {
  const player =
    players.find((candidate) => candidate.id === viewerId) ?? players[0]!;
  const [cards, setCards] = useState<string[]>([]);
  const [relicId, setRelicId] = useState("");
  const [potionIndexes, setPotionIndexes] = useState<number[]>([]);
  const [potionRecipientIds, setPotionRecipientIds] = useState<string[]>([]);
  const [potionReplacementIds, setPotionReplacementIds] = useState<(string | null)[]>([]);
  const [rewardItemChoices, setRewardItemChoices] = useState<('take' | 'skip' | '')[]>([]);
  const [targetPlayerId, setTargetPlayerId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [rewardSources, setRewardSources] = useState<RewardSource[]>([]);
  const [rareRewardSources, setRareRewardSources] = useState<RewardSource[]>([]);
  const focusedEvent = useRef("");
  const focusedEventOption = useRef<HTMLButtonElement | null>(null);
  const eventOptions = useRef<HTMLDivElement>(null);
  // The Compendium overlay can replay effects; only a real Event-stage change clears its draft.
  const draftStages = useRef<Record<string, string>>({});
  const rewardOffers = room.rewardOffers?.[player.id];
  const eventArt = { "--event-art": `url('/assets/noncombat/events/${room.card.id}.webp')` } as CSSProperties;
  const itemOffers = room.itemOffers?.[player.id];
  const pendingTrade = room.pendingTrade;
  const pendingDecision = room.pendingDecisions?.[player.id];
  const itemOfferStage = JSON.stringify([itemOffers, pendingDecision?.rewardItemIds?.length ?? 0]);
  const rewardOfferStage = JSON.stringify([rewardOffers, pendingDecision?.rewardIndexes?.length ?? 0]);
  const [rewardIndexes, setRewardIndexes] = useState<number[]>(() =>
    Array(room.rewardOffers?.[player.id]?.length ?? 0).fill(-2),
  );
  const eventDraftStage = `${player.id}/${room.card.instanceId}`;
  useEffect(() => {
    if (draftStages.current.event === eventDraftStage) return;
    draftStages.current.event = eventDraftStage;
    setCards([]);
    setRelicId("");
    setPotionIndexes([]);
    setPotionRecipientIds([]);
    setPotionReplacementIds([]);
    setRewardItemChoices([]);
    setTargetPlayerId("");
    setRoomId("");
    setSelectedOptions([]);
    setRewardSources([]);
    setRareRewardSources([]);
  }, [eventDraftStage]);
  const itemDraftStage = `${eventDraftStage}/${itemOfferStage}`;
  useEffect(() => {
    if (draftStages.current.item === itemDraftStage) return;
    draftStages.current.item = itemDraftStage;
    setRewardItemChoices(Array(itemOffers?.length ?? 0).fill(''));
    setPotionRecipientIds(Array(itemOffers?.filter((offer) => offer.kind === 'potion').length ?? 0).fill(''));
    setPotionReplacementIds(Array(itemOffers?.filter((offer) => offer.kind === 'potion').length ?? 0).fill(null));
  }, [itemDraftStage]);
  const rewardDraftStage = `${eventDraftStage}/${rewardOfferStage}`;
  useEffect(() => {
    if (draftStages.current.reward === rewardDraftStage) return;
    draftStages.current.reward = rewardDraftStage;
    setRewardIndexes(Array(rewardOffers?.length ?? 0).fill(-2));
  }, [rewardDraftStage]);
  const pendingDie = room.pendingRolls?.[player.id]?.at(-1);
  const eventStage = `${room.card.instanceId}/${player.id}/${pendingDie ?? ""}/${JSON.stringify(pendingDecision ?? null)}`;
  useEffect(() => {
    const button = eventOptions.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    if (!button) return;
    const stageChanged = focusedEvent.current !== eventStage;
    const focusedDisabled = Boolean(focusedEventOption.current?.disabled) &&
      (document.activeElement === focusedEventOption.current || document.activeElement === document.body);
    if (!stageChanged && !focusedDisabled) return;
    focusedEvent.current = eventStage;
    requestAnimationFrame(() => {
      button.focus();
      focusedEventOption.current = button;
    });
  }, [eventStage, room.decisions]);
  const activeEffects = (effects: readonly EventEffect[]): EventEffect[] => effects.flatMap((effect) => [
    effect,
    ...(effect.tag === "roll-d6" && pendingDie ? activeEffects(effect.results?.[pendingDie as 1 | 2 | 3 | 4 | 5 | 6] ?? []) : []),
  ]);
  const effects = room.card.options.flatMap((choice) => activeEffects(choice.effects));
  const hasPrismaticShard = player.relics.some((relic) => relic.defId === "prismatic_shard");
  const hasPrismaticCardReward = effects.some((effect) =>
    effect.tag === "card-reward" && effect.source !== "colorless" && effect.source !== "rare" && !effect.random,
  );
  const hasPrismaticRareReward = effects.some((effect) =>
    (effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source === "rare") && !effect.random,
  );
  const availableCardSources = room.availableRewardSources?.card ?? [];
  const availableRareSources = room.availableRewardSources?.rare ?? [];
  const availableCardSourcesKey = availableCardSources.join(",");
  const availableRareSourcesKey = availableRareSources.join(",");
  const cardSourcesDraftStage = `${eventDraftStage}/${availableCardSourcesKey}`;
  const rareSourcesDraftStage = `${eventDraftStage}/${availableRareSourcesKey}`;
  useEffect(() => {
    if (draftStages.current.cardSources === cardSourcesDraftStage) return;
    draftStages.current.cardSources = cardSourcesDraftStage;
    setRewardSources([]);
  }, [cardSourcesDraftStage]);
  useEffect(() => {
    if (draftStages.current.rareSources === rareSourcesDraftStage) return;
    draftStages.current.rareSources = rareSourcesDraftStage;
    setRareRewardSources([]);
  }, [rareSourcesDraftStage]);
  const selectedChoiceEffects = selectedOptions.flatMap((id) =>
    activeEffects(room.card.options.find((choice) => choice.id === id)?.effects ?? []),
  );
  const selectedPrismaticReward = hasPrismaticShard && selectedChoiceEffects.some((effect) =>
    (effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source !== "colorless") && !effect.random,
  );
  const selectedPrismaticRare = selectedChoiceEffects.some((effect) =>
    effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source === "rare",
  );
  const trade = effects.some((effect) => effect.tag === "trade-card" || effect.tag === "trade-relic");
  const otherCharacter = effects.some((effect) => effect.source === "other-character");
  const needsTarget = effects.some(
    (effect) =>
      effect.target === "one-player" ||
      effect.source === "other-character" ||
      effect.tag === "trade-card" ||
      effect.tag === "trade-relic",
  );
  const needsRelic = effects.some(
    (effect) =>
      effect.tag === "lose-relic" ||
      effect.tag === "trade-relic" ||
      effect.filter?.includes("Relic"),
  );
  // Only the events that pay out by the relic's cost print it in the picker.
  // Mirrors how event-room.ts resolves `relic-cost`, so the number on the option
  // is the gold the player will actually receive.
  //
  // ponytail: card-scoped, like `needsRelic` above — `effects` is every option's
  // effects, not the chosen one's. The Moai Head is the only card in the game
  // that pays by relic cost, and its other option touches no relic, so the two
  // cannot disagree today. A card offering "lose a relic for gold" alongside a
  // plain "lose a relic" would need this narrowed to the selected option.
  const paysRelicCost = effects.some(
    (effect) => effect.tag === "gain-gold" && effect.amount === "relic-cost",
  );
  const needsPotion = effects.some(
    (effect) => effect.tag === "lose-potion" || effect.filter?.includes("Potion"),
  );
  const maximumPotions = Math.max(0, ...room.card.options.map((choice) => activeEffects(choice.effects)
    .filter((effect) => effect.tag === "lose-potion" || effect.tag === "pay-gold" && effect.filter?.includes("Potion")).length));
  const maximumCards = useMemo(
    () =>
      Math.max(
        0,
        ...room.card.options.map((choice) =>
          eventCardSlots(choice.effects, pendingDie, player, players).length,
        ),
      ),
    [room.card, pendingDie, player, players],
  );
  const decided = room.decisions[player.id];
  const selectableCards = player.deck.filter(
    (card) =>
      card.defId !== "ascenders_bane" &&
      (!room.revealedCards?.[player.id] ||
        room.revealedCards?.[player.id]?.includes(card.uid)),
  );
  const toggle = (uid: string) =>
    setCards((current) =>
      current.includes(uid)
        ? current.filter((id) => id !== uid)
        : current.length < maximumCards
          ? [...current, uid]
          : current,
    );
  const paymentFor = (optionIds: string[]) => {
    if (pendingDecision && room.pendingRolls?.[player.id] && optionIds.every((id) => pendingDecision.optionIds.includes(id))) return undefined;
    const effects = optionIds.flatMap((id) => room.card.options.find((candidate) => candidate.id === id)?.effects ?? []);
    const cost = effects.reduce((sum, effect) => sum + (effect.tag === "pay-gold" && typeof effect.amount === "number" ? effect.amount : 0), 0);
    if (cost === 0 || (effects.some((effect) => effect.filter?.includes("or lose one Relic or Potion")) && (relicId || potionIndexes.length))) return undefined;
    if (onWithdraw) return { [player.id]: Math.min(player.gold, cost) };
    let remaining = cost;
    return Object.fromEntries(players.map((candidate): [string, number] => {
      const paid = Math.min(candidate.gold, remaining);
      remaining -= paid;
      return [candidate.id, paid];
    }).filter(([, paid]) => paid > 0));
  };
  const submit = (optionIds: string[], selectedRewardSources = rewardSources) =>
    onEvent(player.id, {
      optionIds,
      cardUids: pendingDecision?.cardUids?.length ? pendingDecision.cardUids : cards,
      relicIds: pendingDecision?.relicIds?.length ? pendingDecision.relicIds : relicId ? [relicId] : [],
      potionIds: pendingDecision?.potionIds?.length ? pendingDecision.potionIds : potionIndexes.map((index) => player.potions[index]!).filter(Boolean),
      potionRecipientIds,
      potionReplacementIds,
      rewardItemChoices: rewardItemChoices.length ? rewardItemChoices as ('take' | 'skip')[] : undefined,
      targetPlayerId: pendingDecision?.targetPlayerId ?? (targetPlayerId || undefined),
      roomId: roomId || undefined,
      rewardIndexes,
      rewardSources: selectedRewardSources,
      payments: paymentFor(optionIds),
    });
  if (eventPledge) {
    const remaining = eventPledge.cost - Object.values(eventPledge.payments).reduce((sum, amount) => sum + amount, 0);
    const mine = eventPledge.payments[player.id] ?? 0;
    const contribution = Math.min(Math.max(0, player.gold - mine), remaining);
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title"><div className="event-panel"><div className="room-banner"><span>Event payment</span><h2 id="event-title">{room.card.name}</h2><p>{remaining} Gold still needed. Each player authorizes only their own contribution.</p></div><button type="button" className="room-proceed" disabled={contribution <= 0} onClick={() => onEvent(eventPledge.actorId, { ...eventPledge.decision, payments: { [player.id]: mine + contribution } })}>Contribute ◉ {contribution}</button>{eventPledge.actorId === player.id && onCancelEventPayment ? <button type="button" onClick={onCancelEventPayment}>Cancel payment</button> : null}</div></section>;
  }
  if (pendingTrade) {
    const isTarget = pendingTrade.targetId === player.id;
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title"><div className="event-panel">
      <div className="room-banner"><span>Event exchange</span><h2 id="event-title">{room.card.name}</h2>
        <p>{isTarget ? `${players.find((candidate) => candidate.id === pendingTrade.actorId)?.name ?? "A teammate"} offers ${pendingTrade.kind === "card" ? CARDS[pendingTrade.offeredId]?.name : relicDef(pendingTrade.offeredId).name}. Choose what to give back.` : "Waiting for your teammate to choose what they give back."}</p>
      </div>
      {isTarget ? <>
        {pendingTrade.kind === "card" ? (
          <div className="campfire__deck" role="group" aria-label="Your card">
            {player.deck.filter((card) => card.defId !== "ascenders_bane").map((card) => (
              <Card key={card.uid} card={card} selected={cards[0] === card.uid} onClick={() => setCards([card.uid])} />
            ))}
          </div>
        ) : (
          <fieldset className="event-cards"><legend>Your relic</legend>{player.relics.map((relic, index) =>
            <button type="button" key={`${relic.defId}-${index}`} aria-pressed={relicId === relic.defId}
              title={relicOptionLabel(relic.defId)} onClick={() => setRelicId(relic.defId)}>
              <ItemImage kind="relic" id={relic.defId} card />{relicDef(relic.defId).name}
            </button>)}</fieldset>
        )}
        <div className="event-options"><button type="button" disabled={pendingTrade.kind === "card" ? !cards[0] : !relicId} onClick={() => submit(["accept_trade"])}>Complete exchange</button><button type="button" onClick={() => submit(["reject_trade"])}>Decline</button></div>
      </> : <p role="status">Exchange pending…</p>}
    </div></section>;
  }
  if (itemOffers) {
    const pending = pendingDecision;
    const pendingEffects = room.card.options.filter((option) => pending?.optionIds.includes(option.id)).flatMap((option) => activeEffects(option.effects));
    const pendingCards = Math.max(0, ...room.card.options.filter((option) => pending?.optionIds.includes(option.id)).map((option) => eventCardSlots(option.effects, pendingDie, player, players).length));
    const pendingRelic = pendingEffects.some((effect) => effect.tag === "lose-relic" && !effect.random);
    const pendingTarget = pendingEffects.some((effect) => effect.target === "one-player");
    const potionChoicesLegal = (() => {
      const limit = ascension >= 4 ? 2 : 3;
      const free = new Map(players.map((candidate) => [candidate.id, limit - candidate.potions.length]));
      const replacements = new Map<string, number>();
      let potionAt = 0;
      for (const [index, offer] of itemOffers.entries()) {
        if (offer.kind !== "potion") continue;
        const at = potionAt++;
        if (rewardItemChoices[index] !== "take") continue;
        const recipientId = potionRecipientIds[at] || player.id;
        const recipient = players.find((candidate) => candidate.id === recipientId && !candidate.dead);
        if (!recipient || hasSozu(recipient)) return false;
        const available = free.get(recipientId) ?? 0;
        if (available > 0) {
          free.set(recipientId, available - 1);
          continue;
        }
        const replacementId = recipientId === player.id ? potionReplacementIds[at] : null;
        if (!replacementId) return false;
        const used = replacements.get(replacementId) ?? 0;
        if (player.potions.filter((id) => id === replacementId).length <= used) return false;
        replacements.set(replacementId, used + 1);
      }
      return true;
    })();
    const effectiveCards = pending?.cardUids ?? cards;
    const effectiveRelic = pending?.relicIds?.[0] ?? relicId;
    const effectiveTarget = pending?.targetPlayerId ?? targetPlayerId;
    let potionIndex = -1;
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title"><div className="event-panel"><div className="room-banner"><span>Event reward</span><h2 id="event-title">{room.card.name}</h2><p>These rewards are face-up. Choose each one, then resolve the Event.</p></div>{pendingCards > 0 ? <fieldset className="event-cards event-cards--deck"><legend>Locked Event cards</legend>{selectableCards.map((card) => <Card key={card.uid} card={card} playable={!pending?.cardUids} selected={effectiveCards.includes(card.uid)} onClick={() => toggle(card.uid)} />)}</fieldset> : null}{pendingRelic ? <fieldset className="event-cards"><legend>Your relic</legend>{player.relics.map((relic, index) => <button type="button" key={`${relic.defId}-${index}`} disabled={Boolean(pending?.relicIds)} aria-pressed={effectiveRelic === relic.defId} title={relicOptionLabel(relic.defId)} onClick={() => setRelicId(relic.defId)}><ItemImage kind="relic" id={relic.defId} card />{relicDef(relic.defId).name}</button>)}</fieldset> : null}{pendingTarget ? <label>Reward recipient<select disabled={Boolean(pending?.targetPlayerId)} value={effectiveTarget} onChange={(event) => setTargetPlayerId(event.target.value)}><option value="">Choose one</option>{players.filter((candidate) => !candidate.dead).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label> : null}<div className="event-cards">{itemOffers.map((offer, index) => {
      if (offer.kind === 'potion') potionIndex += 1;
      const at = potionIndex;
      const recipient = offer.kind === 'potion' ? players.find((candidate) => candidate.id === (potionRecipientIds[at] || player.id) && !candidate.dead) : player;
      const takeBlocked = offer.kind === 'potion' && (!recipient || hasSozu(recipient));
      return <fieldset key={`${offer.kind}-${offer.id}-${index}`}><legend>{offer.kind === 'relic' ? relicDef(offer.id).name : potionDef(offer.id).name}</legend><ItemImage kind={offer.kind} id={offer.id} card /><p className="room-item-text">{offer.kind === 'relic' ? relicDef(offer.id).text : potionDef(offer.id).text}</p><button type="button" disabled={takeBlocked} aria-pressed={rewardItemChoices[index] === 'take'} onClick={() => setRewardItemChoices((current) => current.map((choice, choiceIndex) => choiceIndex === index ? 'take' : choice))}>Take</button><button type="button" aria-pressed={rewardItemChoices[index] === 'skip'} onClick={() => setRewardItemChoices((current) => current.map((choice, choiceIndex) => choiceIndex === index ? 'skip' : choice))}>Skip</button>{offer.kind === 'potion' ? <><label>Pass to<select aria-label="Pass to" value={potionRecipientIds[at] ?? ''} onChange={(event) => setPotionRecipientIds((current) => current.map((id, idIndex) => idIndex === at ? event.target.value : id))}><option value="">{hasSozu(player) ? 'Choose a recipient' : 'Keep or replace yours'}</option>{players.filter((candidate) => candidate.id !== player.id && !candidate.dead && !hasSozu(candidate) && candidate.potions.length < (ascension >= 4 ? 2 : 3)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>{!hasSozu(player) ? <fieldset aria-label="Replace"><legend>Replace</legend><button type="button" aria-pressed={!potionReplacementIds[at]} onClick={() => setPotionReplacementIds((current) => current.map((id, idIndex) => idIndex === at ? null : id))}>None</button>{player.potions.map((id, heldIndex) => <button type="button" key={`${id}-${heldIndex}`} aria-pressed={potionReplacementIds[at] === id} onClick={() => setPotionReplacementIds((current) => current.map((held, idIndex) => idIndex === at ? id : held))}><ItemImage kind="potion" id={id} card />{potionDef(id).name}</button>)}</fieldset> : null}</> : null}</fieldset>;
    })}</div><button type="button" className="room-proceed" disabled={rewardItemChoices.some((choice) => !choice) || !potionChoicesLegal || effectiveCards.length < pendingCards || (pendingRelic && !effectiveRelic) || (pendingTarget && !effectiveTarget)} onClick={() => submit(pending?.optionIds ?? [])}>Resolve rewards →</button></div></section>;
  }
  const stagedBy = [...Object.keys(room.itemOffers ?? {}), ...Object.keys(room.rewardOffers ?? {})].find((id) => id !== player.id);
  if (stagedBy) {
    const names = [
      ...(room.rewardOffers?.[stagedBy]?.flat().map((id) => CARDS[id]?.name) ?? []),
      ...(room.itemOffers?.[stagedBy]?.map((offer) => offer.kind === "relic" ? relicDef(offer.id).name : potionDef(offer.id).name) ?? []),
    ];
    return <section className="room-stage event-stage" style={eventArt}><div className="event-panel"><div className="room-banner"><span>Event reward</span><h2>{room.card.name}</h2><p><strong>{players.find((candidate) => candidate.id === stagedBy)?.name ?? "A teammate"} revealed:</strong> {names.join(", ")}</p><p role="status">Waiting for that face-up reward to resolve…</p></div></div></section>;
  }
  if (room.card.id === "lab" && room.labChoices?.[player.id] && !room.pendingRolls?.[player.id]) return <section className="room-stage event-stage" style={eventArt}><div className="event-panel"><div className="room-banner"><span>Lab</span><h2>Potions collected</h2><p role="status">Waiting for every player to resolve their Potion.</p></div></div></section>;
  if (rewardOffers)
    return (
      <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
        <div className="event-panel">
          <div className="room-banner">
            <span>Event reward</span>
            <h2 id="event-title">Choose your reward</h2>
            <p>
              Revealed rewards are face-up for the party. Take one or skip.
            </p>
          </div>
          {Object.entries(room.rewardOffers ?? {}).filter(([id]) => id !== player.id).map(([id, offers]) => <p key={id} className="event-party-reveal"><strong>{players.find((candidate) => candidate.id === id)?.name ?? 'Teammate'}:</strong> {offers.flat().map((cardId) => CARDS[cardId]?.name).join(', ')}</p>)}
          {rewardOffers.map((offer, offerIndex) => (
            <fieldset className="event-cards" key={offerIndex}>
              <legend>Reward {offerIndex + 1}</legend>
              {offer.map((id, index) => (
                <Card
                  key={`${offerIndex}-${id}-${index}`}
                  card={{ uid: `event-reward-${offerIndex}-${index}`, defId: id, upgraded: false }}
                  selected={rewardIndexes[offerIndex] === index}
                  onClick={() =>
                    setRewardIndexes((current) =>
                      current.map((value, at) =>
                        at === offerIndex ? index : value,
                      ),
                    )
                  }
                />
              ))}
              <button type="button" aria-pressed={rewardIndexes[offerIndex] === -1} onClick={() => setRewardIndexes((current) => current.map((value, at) => at === offerIndex ? -1 : value))}>Skip this reward</button>
            </fieldset>
          ))}
          <button
            className="room-proceed"
            type="button"
            disabled={
              rewardIndexes.length !== rewardOffers.length ||
              rewardIndexes.some((index) => index < -1)
            }
            onClick={() =>
              submit(room.pendingDecisions?.[player.id]?.optionIds ?? [])
            }
          >
            Take rewards →
          </button>
        </div>
      </section>
    );
  const latestDie = room.dieRolls[player.id]?.at(-1);
  return (
    <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
      <div className="event-art" aria-hidden="true" />
      <div className="event-panel">
        <div className="room-banner">
          <span>Event</span>
          <h2 id="event-title">{room.card.name}</h2>
          <p>{room.card.prompt ?? room.card.rule ?? "Choose carefully."}</p>
          {latestDie ? (
            <p role="status">
              Die: {latestDie} · finish the revealed
              outcome
            </p>
          ) : null}
          {room.revealedRelics?.[player.id] ? (
            <p role="status">
              Revealed relic: {relicDef(room.revealedRelics[player.id]!).name}
            </p>
          ) : null}
          {Object.entries(room.itemOffers ?? {}).filter(([id]) => id !== player.id).map(([id, offers]) => (
            <p className="event-party-reveal" key={id}><strong>{players.find((candidate) => candidate.id === id)?.name ?? "Teammate"} revealed:</strong> {offers.map((offer) => offer.kind === "relic" ? relicDef(offer.id).name : potionDef(offer.id).name).join(", ")}</p>
          ))}
          {Object.entries(room.revealedCardDefs ?? {}).filter(([id]) => id !== player.id).map(([id, cardIds]) => (
            <p className="event-party-reveal" key={id}><strong>{players.find((candidate) => candidate.id === id)?.name ?? "Teammate"} revealed:</strong> {cardIds.map((id) => CARDS[id]?.name).join(", ")}</p>
          ))}
        </div>
        {maximumCards > 0 ? (
          <fieldset className="event-cards event-cards--deck">
            <legend>Choose cards as required by your option</legend>
            {selectableCards.map((card) => (
              <Card
                key={card.uid}
                card={card}
                selected={cards.includes(card.uid)}
                onClick={() => toggle(card.uid)}
              />
            ))}
          </fieldset>
        ) : null}
        <div className="event-selectors">
          {hasPrismaticShard && hasPrismaticCardReward ? <fieldset className="event-cards"><legend>Prismatic Shard · Card Reward · choose 3 reward decks</legend>
            {availableCardSources.map((source) => <label key={source}>
              <input type="checkbox" checked={rewardSources.includes(source)}
                disabled={!rewardSources.includes(source) && rewardSources.length >= 3}
                onChange={(event) => setRewardSources((current) => event.target.checked ? [...current, source] : current.filter((id) => id !== source))} />
              {source === "colorless" ? "Colorless" : source[0]!.toUpperCase() + source.slice(1)}
            </label>)}
          </fieldset> : null}
          {hasPrismaticShard && hasPrismaticRareReward ? <fieldset className="event-cards"><legend>Prismatic Shard · Rare Reward · choose 3 reward decks</legend>
            {availableRareSources.map((source) => <label key={source}>
              <input type="checkbox" checked={rareRewardSources.includes(source)}
                disabled={!rareRewardSources.includes(source) && rareRewardSources.length >= 3}
                onChange={(event) => setRareRewardSources((current) => event.target.checked ? [...current, source] : current.filter((id) => id !== source))} />
              {source === "colorless" ? "Colorless" : source[0]!.toUpperCase() + source.slice(1)}
            </label>)}
          </fieldset> : null}
          {needsTarget ? <label>
            Target player
            <select
              value={targetPlayerId}
              onChange={(event) => setTargetPlayerId(event.target.value)}
            >
              <option value="">None</option>
              {players
                .filter((candidate) => !candidate.dead && (!(trade || otherCharacter) || candidate.id !== player.id))
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              {otherCharacter ? (["ironclad", "silent", "defect", "watcher"] as const)
                .filter((character) => !players.some((candidate) => candidate.character === character))
                .map((character) => <option key={character} value={character}>{character.charAt(0).toUpperCase() + character.slice(1)} reward deck</option>) : null}
            </select>
          </label> : null}
          {needsRelic && player.relics.length ? (
            <fieldset className="event-cards"><legend>Your relic</legend>
              {player.relics.map((relic, index) => <button type="button" key={`${relic.defId}-${index}`}
                aria-pressed={relicId === relic.defId} title={relicOptionLabel(relic.defId, paysRelicCost)}
                onClick={() => { setRelicId((current) => current === relic.defId ? '' : relic.defId); setPotionIndexes([]); }}>
                <ItemImage kind="relic" id={relic.defId} card />{relicDef(relic.defId).name}
              </button>)}
            </fieldset>
          ) : null}
          {needsPotion && player.potions.length ? (
            <fieldset className="event-cards"><legend>Your potions</legend>
              {player.potions.map((id, index) => <button type="button" aria-pressed={potionIndexes.includes(index)} key={`${id}-${index}`} onClick={() => { setRelicId(""); setPotionIndexes((current) => current.includes(index) ? current.filter((value) => value !== index) : maximumPotions === 1 ? [index] : [...current, index].slice(-maximumPotions)); }}><ItemImage kind="potion" id={id} card />{potionDef(id).name}</button>)}
            </fieldset>
          ) : null}
          {room.card.id === "secret_portal" ? (
            <label>
              Forward room
              <select
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
              ><option value="">Choose a room</option>{eventForwardRooms.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select>
            </label>
          ) : null}
        </div>
      <div className="event-options" ref={eventOptions}>
          {room.card.options.map((choice) => {
            const cardSlots = eventCardSlots(choice.effects, pendingDie, player, players);
            const requiredCards = cardSlots.length;
            const choiceEffects = activeEffects(choice.effects);
            const choiceNeedsTarget = choiceEffects.some((effect) => effect.target === "one-player" || effect.source === "other-character" || effect.tag === "trade-card" || effect.tag === "trade-relic");
            const choiceTrades = choiceEffects.some((effect) => effect.tag === "trade-card" || effect.tag === "trade-relic");
            const missingTarget = choiceNeedsTarget && (!targetPlayerId || choiceTrades && !players.some((candidate) => candidate.id === targetPlayerId && candidate.id !== player.id && !candidate.dead));
            const missingRelic = choiceEffects.some((effect, effectIndex) =>
              effect.tag === "trade-relic" && !relicId ||
              effect.tag === "lose-relic" && (effect.random
                ? player.relics.length === 0 && !choiceEffects.slice(0, effectIndex).some((prior) => prior.tag === "gain-relic")
                : room.card.id !== "forgotten_altar" && room.card.id !== "face_trader" && !relicId));
            const requiredPotions = choiceEffects.filter((effect) => effect.tag === "lose-potion").length;
            const missingPotion = requiredPotions > 0 && potionIndexes.length !== requiredPotions;
            const paymentLocked = pendingDecision?.optionIds.includes(choice.id) && Boolean(room.pendingRolls?.[player.id]);
            const itemPayment = paymentLocked || choiceEffects.some((effect) => effect.tag === "pay-gold" && effect.filter?.includes("or lose one Relic or Potion")) && (Boolean(relicId) || potionIndexes.length > 0);
            const unaffordable = !paymentLocked && !itemPayment && choiceEffects.filter((effect) => effect.tag === "pay-gold")
              .reduce((sum, effect) => sum + (typeof effect.amount === "number" ? effect.amount : 0), 0) > players.filter((candidate) => !candidate.dead).reduce((sum, candidate) => sum + candidate.gold, 0);
            const selected = selectedOptions.includes(choice.id);
            const knowing = room.card.id === "knowing_skull";
            const lockedOption =
              room.partyOptionIds && !room.partyOptionIds.includes(choice.id);
            const uniqueOptionTaken = room.card.id === "big_fish" && Object.entries({ ...room.decisions, ...room.pendingDecisions })
              .some(([playerId, decision]) => playerId !== player.id && decision.optionIds.includes(choice.id));
            const missingRedMask = choice.effects.some((effect) => effect.filter === "party has Red Mask") &&
              !players.some((candidate) => candidate.relics.some((relic) => relic.defId === "red_mask"));
            const cardsInvalid = room.card.id === "ancient_writing" && choice.id === "simplicity"
              ? cardSlots.some((matches) => !cards.some((uid) => {
                  const card = player.deck.find((candidate) => candidate.uid === uid);
                  return Boolean(card && matches(card));
                }))
              : cards.some((uid, cardIndex) => {
                  const card = player.deck.find((candidate) => candidate.uid === uid);
                  return !card || !cardSlots[cardIndex]?.(card);
                });
            const prismaticReward = hasPrismaticShard && choiceEffects.some((effect) =>
              (effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source !== "colorless") && !effect.random,
            );
            const prismaticRare = choiceEffects.some((effect) => effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source === "rare");
            // ponytail: `choiceEffects` only expands a `roll-d6` branch once `pendingDie` is
            // set, which happens AFTER this option is clicked — so a random card/rare reward
            // nested inside a die-roll outcome would never arm the gain reveal. No event does
            // that today (grep `random: true` in events.ts); if one ever does, arm from the
            // roll's own resolution instead of here.
            const grantsRandomCard = choiceEffects.some((effect) => (effect.tag === "card-reward" || effect.tag === "rare-reward") && effect.random === true);
            return (
              <button
                type="button"
                onFocus={(event) => { focusedEventOption.current = event.currentTarget; }}
                aria-pressed={knowing ? selected : undefined}
                key={choice.id}
                disabled={
                  Boolean(decided) ||
                  lockedOption ||
                  uniqueOptionTaken ||
                  missingRedMask ||
                  missingTarget ||
                  missingRelic ||
                  missingPotion ||
                  unaffordable ||
                  prismaticReward && (prismaticRare ? rareRewardSources.length !== 3 : rewardSources.length !== 3) ||
                  (room.card.id === "secret_portal" && !roomId) ||
                  cards.length !== requiredCards || cardsInvalid
                }
                onClick={() => {
                  if (knowing) {
                    setSelectedOptions((current) =>
                      current.includes(choice.id)
                        ? current.filter((id) => id !== choice.id)
                        : current.length < 2
                          ? [...current, choice.id]
                          : current,
                    );
                    return;
                  }
                  if (grantsRandomCard) onArmCardGain?.();
                  submit([choice.id], prismaticRare ? rareRewardSources : rewardSources);
                }}
              >
                <strong>[{choice.label}]</strong>
                <span>{choice.description}</span>
              </button>
            );
          })}
        </div>
        {room.card.id === "knowing_skull" ? (
          <button
            type="button"
            className="room-proceed"
            disabled={selectedOptions.length < 1 || selectedOptions.length > 2 ||
              selectedPrismaticReward && (selectedPrismaticRare ? rareRewardSources.length !== 3 : rewardSources.length !== 3)}
            onClick={() => {
              if (selectedChoiceEffects.some((effect) => (effect.tag === "card-reward" || effect.tag === "rare-reward") && effect.random === true)) onArmCardGain?.();
              submit(selectedOptions, selectedPrismaticRare ? rareRewardSources : rewardSources);
            }}
          >
            Confirm chosen questions →
          </button>
        ) : null}
        {decided ? (
          <p role="status">Your choice is locked. Waiting for the party…</p>
        ) : null}
      </div>
      {eventCanSkip ? <button type="button" className="room-proceed" onClick={() => onSkipEvent?.(player.id)}>No legal choice · Leave event →</button> : null}
    </section>
  );
}
