import { useEffect, useRef, useState, type CSSProperties } from "react";
import { merchantCardCost, merchantRelicCost, potionLimit } from "../../game/acquisition.ts";
import { assetPath } from "../../game/assets.ts";
import { CARDS } from "../../game/cards.ts";
import type { MerchantPurchase, MerchantState } from "../../game/noncombat.ts";
import { potionDef, relicDef } from "../../game/relics.ts";
import { playerVisualId } from "../../game/skins.ts";
import type { Player } from "../../game/types.ts";
import { Card } from "../Card.tsx";
import { hasSozu } from "../event-loot.ts";
import { ItemImage } from "../ItemImage.tsx";
import { Price } from "./Price.tsx";
import type { RoomScreenProps } from "./shared.ts";

export function MerchantScreen({
  room,
  players,
  viewerId,
  ascension,
  onPurchase,
  onRemove,
  onFinishMerchant,
  onResumeMerchant,
  merchantPledges = {},
  merchantReady = [],
  connectedPlayerIds,
  onWithdraw,
}: RoomScreenProps & { room: MerchantState }) {
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
  const [shopOpen, setShopOpen] = useState(false);
  const [localReady, setLocalReady] = useState<string[]>([]);
  const [point, setPoint] = useState<{ key: number; x: number; y: number; angle: number; width: number; height: number } | null>(null);
  const merchantStage = useRef<HTMLElement>(null);
  const pointKey = useRef(0);
  const visitors = players.filter((candidate) => Object.hasOwn(room.cards, candidate.id));
  const eligiblePlayers = visitors.filter((candidate) => !connectedPlayerIds || connectedPlayerIds.includes(candidate.id));
  const ready = onWithdraw ? merchantReady : localReady;
  const readyCount = ready.filter((id) => eligiblePlayers.some((candidate) => candidate.id === id)).length;
  const pointAt = (target: HTMLElement | null) => {
    const stage = merchantStage.current;
    if (!stage || !target) return;
    const frame = stage.getBoundingClientRect();
    const item = target.getBoundingClientRect();
    const x = item.left - frame.left + stage.scrollLeft + item.width / 2;
    setPoint({ key: pointKey.current += 1, x, y: item.top - frame.top + stage.scrollTop + item.height * 0.55,
      angle: (x / frame.width - 0.5) * 10, width: stage.scrollWidth, height: stage.scrollHeight });
  };
  const pointAtTarget = (id: string) => pointAt(merchantStage.current?.querySelector<HTMLElement>(`[data-merchant-target="${id}"]`) ?? null);
  const validDiscardPotionId = buyer.potions.includes(discardPotionId) ? discardPotionId : "";
  const buyerHasSozu = hasSozu(buyer);
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
  const removalAffordable = players.reduce((sum, candidate) => sum + unpledgedGold(candidate, removalKey), 0) >= removalRemaining;
  const removalUnavailable = removalUsed || (!removalPending && !removalAffordable) || Boolean(onWithdraw && buyer.id !== player.id &&
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
  if (!shopOpen) {
    const proceed = () => {
      if (ready.includes(player.id)) return;
      if (onWithdraw) return onFinishMerchant();
      const next = [...ready, player.id];
      setLocalReady(next);
      if (eligiblePlayers.every((candidate) => next.includes(candidate.id))) onFinishMerchant();
    };
    return (
      <section className="merchant-arrival" aria-labelledby="merchant-arrival-title">
        {/* The scene box matches the backdrop art's projected rectangle, so the party
            and the Merchant keep their carpets at every viewport aspect ratio. */}
        <div className="merchant-arrival__scene">
          <div className="merchant-arrival__party" aria-label="Party at the merchant">
            {eligiblePlayers.map((candidate) => (
              <figure key={candidate.id} data-character={playerVisualId(candidate)} aria-label={`${candidate.name}, ${candidate.character}`}>
                <img
                  src={assetPath(`noncombat/merchant/characters/${playerVisualId(candidate)}-standing.webp`)}
                  alt=""
                  loading="eager"
                  decoding="async"
                />
              </figure>
            ))}
          </div>
          <button type="button" className="merchant-arrival__merchant" onClick={() => {
            setShopOpen(true);
            if (onResumeMerchant) onResumeMerchant();
            else if (ready.includes(player.id)) setLocalReady((current) => current.filter((id) => id !== player.id));
          }} aria-label="Enter merchant shop">
            <img src={assetPath("noncombat/merchant/merchant-seated.webp")} alt="The Merchant sits behind a spread of wares" />
          </button>
        </div>
        <div className="merchant-arrival__title">
          <span>Merchant</span>
          <h2 id="merchant-arrival-title">The Merchant</h2>
          <p>Visit the Merchant, then proceed when every traveler is ready.</p>
        </div>
        <button type="button" className="room-proceed" disabled={ready.includes(player.id) || Object.keys(merchantPledges).length > 0} onClick={proceed}>
          {ready.includes(player.id) ? `Waiting for party · ${readyCount}/${eligiblePlayers.length}` : `Proceed · ${readyCount}/${eligiblePlayers.length} ready`}
        </button>
      </section>
    );
  }
  return (
    <section
      ref={merchantStage}
      className="room-stage merchant-stage merchant-shop-stage"
      aria-labelledby="merchant-title"
    >
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
            const cost = id ? merchantRelicCost(id, slot) : null;
            const funding =
              cost === null ? null : pledge(buyer.id, "relic", slot, cost);
            return (
              <button
                className="merchant-item"
                data-merchant-target={`relic-${slot}`}
                key={slot}
                type="button"
                disabled={!id || !funding || !canPledge(funding) || sharedReserved("relic", slot, funding.key) || Boolean(onWithdraw && buyer.id !== player.id && !merchantPledges[funding.key])}
                onClick={(event) => {
                  if (id && funding) {
                    pointAt(event.currentTarget);
                    onPurchase({
                      buyerId: buyer.id,
                      section: "relic",
                      slot,
                      payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                    });
                  }
                }}
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
            const beltFull = buyer.potions.length >= potionLimit(ascension, buyer);
            return (
              <button
                className="merchant-item"
                data-merchant-target={`potion-${slot}`}
                key={slot}
                type="button"
                disabled={buyerHasSozu || !id || !funding || !canPledge(funding) || sharedReserved("potion", slot, funding.key) || Boolean(onWithdraw && buyer.id !== player.id && !pending) || (beltFull && !replacement && buyer.id !== player.id)}
                onClick={(event) => {
                  if (beltFull && !replacement) {
                    setDiscardPotionId("");
                    setPotionReplacementSlot(slot);
                    return;
                  }
                  if (id && funding) {
                    pointAt(event.currentTarget);
                    onPurchase({
                      buyerId: buyer.id,
                      section: "potion",
                      slot,
                      payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                      potionRecipientId: pending?.potionRecipientId ?? buyer.id,
                      discardPotionId: replacement || undefined,
                    });
                  }
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
            const cost = merchantCardCost(id) ?? 0;
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
              <div className="merchant-card" key={slot} role="group" data-merchant-target={`card-${slot}`}
                aria-label={id ? `${card?.name ?? 'Card'}, ${cost} Gold` : 'Sold'}>
                {id ? (
                  <Card
                    card={{ uid: `merchant-card-${buyer.id}-${slot}`, defId: id, upgraded: false }}
                    playable={!blocked}
                    onClick={() => {
                      pointAtTarget(`card-${slot}`);
                      onPurchase({
                        buyerId: buyer.id,
                        section: "card",
                        slot,
                        payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                      });
                    }}
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
              const cost = merchantCardCost(id ?? "") ?? 0;
              const funding = pledge(buyer.id, "colorless", slot, cost);
              // Same treatment as the card shelf above.
              const blocked = !id || !canPledge(funding) || sharedReserved("colorless", slot, funding.key) || Boolean(onWithdraw && buyer.id !== player.id && !merchantPledges[funding.key]);
              return (
                // Same reason as the card shelf above.
                <div className="merchant-card" key={slot} role="group" data-merchant-target={`colorless-${slot}`}
                  aria-label={id ? `${card?.name ?? 'Card'}, ${cost} Gold` : 'Sold'}>
                  {id ? (
                    <Card
                      card={{ uid: `merchant-colorless-${buyer.id}-${slot}`, defId: id, upgraded: false }}
                      playable={!blocked}
                      onClick={() => {
                        pointAtTarget(`colorless-${slot}`);
                        onPurchase({
                          buyerId: buyer.id,
                          section: "colorless",
                          slot,
                          payments: pay(additional(funding.remaining, funding.key, funding.mine), funding.key),
                        });
                      }}
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
        <div className="merchant-removal" data-merchant-target="removal">
          <button type="button" className="merchant-removal__service"
            disabled={removalUnavailable} onClick={() => setRemovalOpen(true)}>
            <span className="merchant-removal__cards" aria-hidden="true">▱</span>
            <strong>Card Removal Service</strong>
            <Price value={room.removalUsed.includes(buyer.id) ? null : removalCost} />
          </button>
        </div>
      </div>
      {point ? <div className="merchant-hand-layer" aria-hidden="true" style={{ width: point.width, height: point.height }}>
        <img key={point.key} className="merchant-hand" src={assetPath("noncombat/merchant/merchant-hand.webp")} alt=""
          onAnimationEnd={() => setPoint(null)}
          style={{ "--merchant-point-x": `${point.x}px`, "--merchant-point-y": `${point.y}px`, "--merchant-point-angle": `${point.angle}deg` } as CSSProperties} />
      </div> : null}
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
              pointAtTarget(`potion-${potionReplacementSlot}`);
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
              (!removalPending && (!removeUid || Boolean(onWithdraw && buyer.id !== player.id) || !removalAffordable)) ||
              (additional(removalRemaining, removalKey) <= 0 && (onWithdraw ? buyer.id !== player.id || Boolean(removalPending) : true)) ||
              removalUsed
            }
            onClick={() => {
              onRemove(buyer.id, removalUid, pay(additional(removalRemaining, removalKey), removalKey));
              pointAtTarget("removal");
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
      <button type="button" className="room-proceed" onClick={() => setShopOpen(false)}>
        ← Leave shop
      </button>
    </section>
  );
}
