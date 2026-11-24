import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { assetPath } from "../../game/assets.ts";
import type { RelicRewardState } from "../../game/noncombat.ts";
import { relicDef } from "../../game/relics.ts";
import { playerVisualId } from "../../game/skins.ts";
import type { ActionOutcome } from "../../multiplayer/useRoomSession.ts";
import { useReducedEffects } from "../combat-screen/hooks.ts";
import { ItemImage } from "../ItemImage.tsx";
import { PotionTooltipAnchor } from "../PotionIcon.tsx";
import { ItemLootChoice } from "../RewardScreen.tsx";
import { treasureHandPath, treasurePlayerColor } from "../TreasureEffects.tsx";
import type { RoomScreenProps } from "./shared.ts";

export function RelicRoomScreen({
  room,
  players,
  viewerId,
  onRelic,
  sapphireAvailable = false,
}: RoomScreenProps & { room: RelicRewardState }) {
  const reducedMotion = useReducedEffects();
  const openingId = useId();
  const keyboardOpening = useRef(false);
  const [opened, setOpened] = useState(Object.keys(room.decisions).length > 0);
  const [playOpening, setPlayOpening] = useState(false);
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
  const canChooseSapphire = room.kind === "treasure" && sapphireAvailable;
  const automaticSkip = decided === undefined && (room.sharedOffers ? firstSharedOffer < 0 : !relic) &&
    !(canChooseSapphire && fullReward && Object.values(room.decisions).every((choice) => choice === "sapphire"));
  const automaticSkipKey = `${room.kind}/${player.id}/${JSON.stringify(room.offers)}/${JSON.stringify(room.sharedOffers)}/${JSON.stringify(room.decisions)}`;
  const automaticSkipSent = useRef("");
  const [automaticSkipRetry, setAutomaticSkipRetry] = useState(0);
  useEffect(() => {
    if (!automaticSkip) {
      automaticSkipSent.current = "";
      return;
    }
    if (automaticSkipSent.current === automaticSkipKey) return;
    automaticSkipSent.current = automaticSkipKey;
    const pending = onRelic(player.id, "skip");
    if (!pending) return;
    let timer = 0;
    const rearm = (outcome?: ActionOutcome) => {
      if (automaticSkipSent.current !== automaticSkipKey) return;
      if (outcome?.status === "accepted") return;
      const next = outcome?.snapshot?.run?.roomState;
      if (next && (next.kind !== "treasure" && next.kind !== "elite" || next.decisions[player.id] !== undefined)) return;
      timer = window.setTimeout(() => {
        if (automaticSkipSent.current !== automaticSkipKey) return;
        automaticSkipSent.current = "";
        setAutomaticSkipRetry((attempt) => attempt + 1);
      }, 250);
    };
    void pending.then(rearm, () => rearm());
    return () => window.clearTimeout(timer);
  }, [automaticSkip, automaticSkipKey, automaticSkipRetry, player.id]);
  const firstAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (decided === undefined && (!opened || keyboardOpening.current)) firstAction.current?.focus();
  }, [decided, firstSharedOffer, player.id, relic, opened]);
  if (room.kind === "elite") return <section className="reward-screen reward-screen--loot" aria-label="Elite loot">
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players"><div className="reward-screen__player">
      {(room.sharedOffers ?? [relic]).map((id, index) => id ? <ItemLootChoice key={`${index}-${id}`} kind="relic" id={id}
        disabled={decided !== undefined || Boolean(room.sharedOffers && Object.values(room.decisions).includes(index))}
        confirmLabel="claim this relic" onClick={() => onRelic(player.id, room.sharedOffers ? index : "take")} /> : null)}
      {decided !== undefined ? <p role="status">Choice locked. Waiting for the party…</p>
        : automaticSkip ? <p role="status">No relic remains · skipping automatically…</p> : null}
    </div></div>
    {decided === undefined && !automaticSkip ? <button type="button" className="reward-screen__skip" onClick={() => onRelic(player.id, "skip")}>Skip</button> : null}
  </section>;
  return (
    <section
      className="room-stage treasure-stage"
      aria-labelledby="treasure-title"
    >
      <div className="treasure-scene">
      <div className="room-banner" data-visible={opened}>
        <span className="visually-hidden">Treasure room</span>
        <h2 id="treasure-title">Choose the Relic YOU Want!</h2>
        <p>
          {room.sharedOffers ? "Each player chooses one relic from the chest." : "Every player resolves their own face-up relic."}
          {canChooseSapphire
            ? " The Sapphire Key requires everyone to skip."
            : ""}
        </p>
      </div>
        {[...new Set(players.flatMap((seat) => [treasureHandPath(playerVisualId(seat)), treasureHandPath(playerVisualId(seat), true)]))].map((href) => <link key={href} rel="preload" as="image" href={href} />)}
        <img className="treasure-ground" src={assetPath("noncombat/treasure/background.webp")} alt="" />
        <img className="treasure-chest" src={`${assetPath(`noncombat/treasure/${!opened ? "chest-closed" : reducedMotion || !playOpening ? "chest-open" : "chest-opening"}.webp`)}${playOpening && !reducedMotion ? `?opening=${encodeURIComponent(openingId)}` : ""}`} alt="A vine-covered treasure chest" />
        {!opened ? <button className="treasure-open" type="button" ref={firstAction} onClick={(event) => { keyboardOpening.current = event.detail === 0; setPlayOpening(true); setOpened(true); }}>Open treasure chest</button> : null}
        {opened && playOpening && !reducedMotion ? <div className="treasure-coins" aria-hidden="true">{Array.from({ length: 22 }, (_, index) => <img key={index} src={assetPath("noncombat/treasure/coin.webp")} alt="" style={{ "--coin-x": `${Math.sin(index * 2.4) * 190}px`, "--coin-y": `${-100 - index % 5 * 24}px`, "--coin-delay": `${100 + index % 7 * 65}ms` } as CSSProperties} />)}</div> : null}
        {opened ? <div className="treasure-offers" aria-label={room.sharedOffers ? "Shared relic choices" : "Party relics"}>
          {(room.sharedOffers ?? room.playerIds.map((id) => room.offers[id])).map((id, index) => {
            const ownerId = room.playerIds[index]!;
            const claimedBy = room.sharedOffers
              ? room.playerIds.find((pid) => room.decisions[pid] === index)
              : room.decisions[ownerId] === "take" ? ownerId : undefined;
            const owner = players.find((candidate) => candidate.id === (claimedBy ?? ownerId));
            const unavailable = room.sharedOffers ? Boolean(claimedBy) : room.decisions[ownerId] !== undefined;
            const canTake = Boolean(id) && decided === undefined && !unavailable && Boolean(room.sharedOffers || ownerId === player.id);
            return <div className="treasure-offer" key={`${index}-${id}`} style={{ "--relic-delay": `${index * 100}ms`, "--claim-color": treasurePlayerColor(index) } as CSSProperties}>
              {id && !claimedBy ? <PotionTooltipAnchor key={id} id={id} name={relicDef(id).name} text={relicDef(id).text} kindLabel="Relic" confirmLabel={canTake ? "take this relic" : undefined} hoverable>
                <button type="button" ref={canTake && (room.sharedOffers ? index === firstSharedOffer : true) ? firstAction : undefined}
                  data-treasure-slot={room.sharedOffers ? index : ownerId} className="treasure-offer__relic"
                  aria-label={`${relicDef(id).name}. ${relicDef(id).text}`}
                  aria-disabled={!canTake}
                  onClick={() => { if (canTake) onRelic(player.id, room.sharedOffers ? index : "take"); }}>
                  <ItemImage kind="relic" id={id} />
                </button>
              </PotionTooltipAnchor> : claimedBy ? <span className="treasure-offer__relic" data-treasure-slot={room.sharedOffers ? index : ownerId} data-taken="true" aria-hidden="true" /> : <span className="treasure-offer__empty">✦</span>}
              {!room.sharedOffers && !unavailable ? <small>{owner?.name ?? ownerId}</small> : null}
            </div>;
          })}
        </div> : null}
      </div>
      {opened ? <div className="treasure-actions">
        {!room.sharedOffers ? <button
          type="button"
          disabled={!relic || decided !== undefined}
          onClick={() => onRelic(player.id, "take")}
        >
          Take relic
        </button> : null}
        {!automaticSkip ? <button
          ref={room.sharedOffers ? firstSharedOffer < 0 ? firstAction : undefined : !relic ? firstAction : undefined}
          type="button"
          disabled={decided !== undefined}
          onClick={() => onRelic(player.id, "skip")}
        >
          Skip
        </button> : <p role="status">No Relic or Sapphire choice remains · skipping automatically…</p>}
        {canChooseSapphire ? (
          <button
            type="button"
            disabled={!fullReward || decided !== undefined}
            onClick={() => onRelic(player.id, "sapphire")}
          >
            ◆ Skip for Sapphire Key
          </button>
        ) : null}
      </div> : null}
      {decided !== undefined ? (
        <p className="treasure-status" role="status">Choice locked. Waiting for the party…</p>
      ) : null}
    </section>
  );
}
