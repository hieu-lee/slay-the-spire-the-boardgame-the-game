import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { potionLimit } from "../../game/acquisition.ts";
import { assetPath, enemyImagePath } from "../../game/assets.ts";
import { CARDS, cardIsCurse } from "../../game/cards.ts";
import { enemyLabel, startTurnScryAbilities, startTurnScryPreview } from "../../game/combat.ts";
import { enemyDef } from "../../game/enemies.ts";
import type { EventDecision, EventRoomState } from "../../game/event-room.ts";
import type { EventEffect } from "../../game/events.ts";
import { potionDef, relicDef } from "../../game/relics.ts";
import type { RewardSource } from "../../game/run.ts";
import { CHARACTER_IDS } from "../../game/types.ts";
import type { Player, RelicInstance } from "../../game/types.ts";
import type { ActionOutcome } from "../../multiplayer/useRoomSession.ts";
import { Card } from "../Card.tsx";
import { CardPicker, PickerConfirmButton } from "../CardPicker.tsx";
import { CardRewardPicker } from "../CardRewardPicker.tsx";
import { rolledTable } from "../die-outcomes.ts";
import { defaultLootChoices, freePotionSlots, hasSozu, lootHolders, planEventPotions } from "../event-loot.ts";
import { EventDie, forgetShownRolls } from "../EventDie.tsx";
import { ItemImage } from "../ItemImage.tsx";
import { MapScreen } from "../MapScreen.tsx";
import { PotionTooltipAnchor } from "../PotionIcon.tsx";
import { relicNote, relicOptionLabel, RelicOptionText, RelicTooltipAnchor } from "../RelicChip.tsx";
import { rewardSourceLabel } from "../reward-source.ts";
import { RewardItem } from "../RewardScreen.tsx";
import { useHoverUnavailable } from "../touch-input.ts";
import { Price } from "./Price.tsx";
import { canFillCardSlots, eventCardSlots, type PublicPlayerCounts, type RoomScreenProps } from "./shared.ts";

export function EventScreen({
  room,
  players,
  viewerId,
  ascension,
  onEvent,
  onPreparedHermitSetup,
  onPreparedStartTurnScryOrder,
  onPreparedStartTurnScry,
  eventMap,
  eventBossDefId,
  eventPledge,
  onWithdraw,
  onCancelEventPayment,
  eventCanSkip = false,
  unavailableEventOptionIds = [],
  onSkipEvent,
  onArmCardGain,
}: RoomScreenProps & { room: EventRoomState }) {
  // Touch layouts already include the rules in the button's visible text.
  const printsRulesInline = useHoverUnavailable();
  const relicDescription = (relic: RelicInstance, withCost = false) =>
    printsRulesInline ? undefined : relicOptionLabel(relic.defId, withCost, relicNote(relic));
  const player =
    players.find((candidate) => candidate.id === viewerId) ?? players[0]!;
  const automaticSkip = useRef("");
  const [automaticSkipRetry, setAutomaticSkipRetry] = useState(0);
  // On mount: a child die's own unmount cleanup runs after its parent's, so
  // forgetting on the way out would be undone by the die it just unmounted.
  useEffect(() => { forgetShownRolls(); }, []);
  useEffect(() => {
    if (!eventCanSkip) {
      automaticSkip.current = "";
      return;
    }
    const key = `${room.card.instanceId}/${player.id}`;
    if (automaticSkip.current === key) return;
    automaticSkip.current = key;
    const pending = onSkipEvent?.(player.id);
    if (!pending) return;
    let timer = 0;
    const rearm = (outcome?: ActionOutcome) => {
      if (automaticSkip.current !== key) return;
      if (outcome?.status === "accepted") return;
      const next = outcome?.snapshot;
      const nextRoom = next?.run?.roomState;
      if (next && (nextRoom?.kind !== "event" || nextRoom.card.instanceId !== room.card.instanceId || !next.eventCanSkip)) return;
      timer = window.setTimeout(() => {
        if (automaticSkip.current !== key) return;
        automaticSkip.current = "";
        setAutomaticSkipRetry((attempt) => attempt + 1);
      }, 250);
    };
    void pending.then(rearm, () => rearm());
    return () => window.clearTimeout(timer);
  }, [automaticSkipRetry, eventCanSkip, player.id, room.card.instanceId]);
  const [cards, setCards] = useState<string[]>([]);
  const [pickerCardUids, setPickerCardUids] = useState<string[]>([]);
  const [tradeCardDraft, setTradeCardDraft] = useState({ stage: "", uid: "" });
  const [relicId, setRelicId] = useState("");
  const [potionIndexes, setPotionIndexes] = useState<number[]>([]);
  const [goldPaymentSelected, setGoldPaymentSelected] = useState(false);
  const [potionRecipientIds, setPotionRecipientIds] = useState<string[]>([]);
  const [potionReplacementIds, setPotionReplacementIds] = useState<(string | null)[]>([]);
  const [rewardItemChoices, setRewardItemChoices] = useState<('take' | 'skip' | '')[]>([]);
  const [targetPlayerId, setTargetPlayerId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [rewardSources, setRewardSources] = useState<RewardSource[]>([]);
  const [rareRewardSources, setRareRewardSources] = useState<RewardSource[]>([]);
  const [guardianGemIds, setGuardianGemIds] = useState<string[]>([]);
  const [preparedScryOrder, setPreparedScryOrder] = useState<string[]>([]);
  const [preparedScryPicked, setPreparedScryPicked] = useState<string[]>([]);
  const focusedEvent = useRef("");
  const focusedEventOption = useRef<HTMLButtonElement | null>(null);
  const focusedEventOptionId = useRef("");
  const eventOptions = useRef<HTMLDivElement>(null);
  const eventResolver = useRef<HTMLDivElement>(null);
  // The Compendium overlay can replay effects; only a real Event-stage change clears its draft.
  const draftStages = useRef<Record<string, string>>({});
  const rewardOffers = room.rewardOffers?.[player.id];
  const guardianGemOffers = room.guardianGemOffers?.[player.id] ?? [];
  const eventArt = { "--event-art": `url('${new URL(assetPath(`noncombat/events/${room.card.id}.webp`), window.location.href).href}')` } as CSSProperties;
  const itemOffers = room.itemOffers?.[player.id];
  const pendingTrade = room.pendingTrade;
  const pendingTradeStage = pendingTrade
    ? `${room.card.instanceId}/${pendingTrade.actorId}/${pendingTrade.targetId}/${pendingTrade.kind}/${pendingTrade.offeredId}`
    : "";
  const tradeCardUid = tradeCardDraft.stage === pendingTradeStage ? tradeCardDraft.uid : "";
  const pendingDecision = room.pendingDecisions?.[player.id];
  const decided = room.decisions[player.id];
  const draftOptionIds = decided ? [] : pendingDecision?.optionIds ?? selectedOptions;
  const selectionOpen = draftOptionIds.length > 0;
  const itemOfferStage = JSON.stringify([itemOffers, pendingDecision?.rewardItemIds?.length ?? 0]);
  const rewardOfferStage = JSON.stringify([rewardOffers, guardianGemOffers, pendingDecision?.rewardIndexes?.length ?? 0]);
  const [rewardIndexes, setRewardIndexes] = useState<number[]>(() =>
    Array(room.rewardOffers?.[player.id]?.length ?? 0).fill(-2),
  );
  const eventDraftStage = `${player.id}/${room.card.instanceId}`;
  useEffect(() => {
    if (draftStages.current.event === eventDraftStage) return;
    draftStages.current.event = eventDraftStage;
    focusedEvent.current = "";
    focusedEventOption.current = null;
    focusedEventOptionId.current = "";
    setCards([]);
    setPickerCardUids([]);
    setRelicId("");
    setPotionIndexes([]);
    setGoldPaymentSelected(false);
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
    // A face-up Relic, or a Potion with a free slot waiting, is taken unless the
    // player says otherwise; only a Potion that would overflow asks first.
    setRewardItemChoices(defaultLootChoices(itemOffers ?? [],
      offerHolderIds.map((id) => players.find((seat) => seat.id === id && !seat.dead)), lootFreeSlots));
    setPotionRecipientIds(Array(itemOffers?.filter((offer) => offer.kind === 'potion').length ?? 0).fill(''));
    setPotionReplacementIds(Array(itemOffers?.filter((offer) => offer.kind === 'potion').length ?? 0).fill(null));
  }, [itemDraftStage]);
  const rewardDraftStage = `${eventDraftStage}/${rewardOfferStage}`;
  useEffect(() => {
    if (draftStages.current.reward === rewardDraftStage) return;
    draftStages.current.reward = rewardDraftStage;
    setRewardIndexes(Array(rewardOffers?.length ?? 0).fill(-2));
    setGuardianGemIds([]);
  }, [rewardDraftStage]);
  const pendingDie = room.pendingRolls?.[player.id]?.at(-1);
  const latestDie = pendingDie ?? room.dieRolls[player.id]?.at(-1);
  const eventDie = latestDie ? <EventDie face={latestDie} rollKey={`${room.card.instanceId}/${player.id}/${room.dieRolls[player.id]?.length ?? 0}/${latestDie}`}
    results={rolledTable(room.card.options, pendingDecision?.optionIds ?? decided?.optionIds ?? draftOptionIds)} /> : null;
  const repeatScrap = room.card.id === "scrap_ooze" && Boolean(pendingDecision) && (pendingDie ?? 3) <= 2;
  const resolverOpen = selectionOpen && !repeatScrap;
  const focusResolverOpen = resolverOpen || Boolean(pendingTrade || itemOffers || rewardOffers);
  const eventStage = `${room.card.instanceId}/${player.id}/${pendingDie ?? ""}/${JSON.stringify(pendingDecision ?? null)}`;
  useEffect(() => {
    if (focusResolverOpen) {
      requestAnimationFrame(() => {
        const resolver = eventResolver.current;
        if (!resolver || resolver.contains(document.activeElement)) return;
        resolver.querySelector<HTMLElement>(
          '[role="button"]:not([aria-disabled="true"]), button:not(:disabled):not(.room), select:not(:disabled), input:not(:disabled)',
        )?.focus();
      });
      return;
    }
    const buttons = [...(eventOptions.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const button = buttons.find((candidate) => candidate.dataset.eventOption === focusedEventOptionId.current) ?? buttons[0];
    if (!button) return;
    const stageChanged = focusedEvent.current !== eventStage;
    const focusedDisabled = Boolean(focusedEventOption.current?.disabled) &&
      (document.activeElement === focusedEventOption.current || document.activeElement === document.body);
    const focusMissing = !focusedEventOption.current?.isConnected || document.activeElement === document.body;
    if (!stageChanged && !focusedDisabled && !focusMissing) return;
    focusedEvent.current = eventStage;
    requestAnimationFrame(() => {
      button.focus();
      focusedEventOption.current = button;
    });
  }, [eventStage, room.decisions, focusResolverOpen]);
  const activeEffects = (effects: readonly EventEffect[]): EventEffect[] => effects.flatMap((effect) => [
    effect,
    ...(effect.tag === "roll-d6" && pendingDie ? activeEffects(effect.results?.[pendingDie as 1 | 2 | 3 | 4 | 5 | 6] ?? []) : []),
  ]);
  const effects = draftOptionIds.flatMap((id) =>
    activeEffects(room.card.options.find((choice) => choice.id === id)?.effects ?? []),
  );
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
  const selectedChoiceEffects = effects;
  const selectedPrismaticReward = hasPrismaticShard && selectedChoiceEffects.some((effect) =>
    (effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source !== "colorless") && !effect.random,
  );
  const selectedPrismaticRare = selectedChoiceEffects.some((effect) =>
    effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source === "rare",
  );
  const trade = effects.some((effect) => effect.tag === "trade-card" || effect.tag === "trade-relic");
  const tradeCard = effects.some((effect) => effect.tag === "trade-card");
  const tradeRelic = effects.some((effect) => effect.tag === "trade-relic");
  const canTradeWith = (candidate: Player) => candidate.id !== player.id && !candidate.dead &&
    (!tradeCard || candidate.deck.some((card) => card.defId !== "ascenders_bane") || ((candidate as PublicPlayerCounts).tradableDeckCount ?? 0) > 0) &&
    (!tradeRelic || candidate.relics.length > 0);
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
      effect.tag === "lose-relic" && !effect.random && (room.card.id !== "face_trader" || Boolean(pendingDecision)) ||
      effect.tag === "trade-relic" ||
      effect.filter?.includes("Relic"),
  );
  // Only the events that pay out by the relic's cost print it in the picker.
  // Mirrors how event-room.ts resolves `relic-cost`, so the number on the option
  // is the gold the player will actually receive.
  //
  const paysRelicCost = effects.some(
    (effect) => effect.tag === "gain-gold" && effect.amount === "relic-cost",
  );
  const needsPotion = effects.some(
    (effect) => effect.tag === "lose-potion" || effect.filter?.includes("Potion"),
  );
  const maximumPotions = effects.filter((effect) =>
    effect.tag === "lose-potion" || effect.tag === "pay-gold" && effect.filter?.includes("Potion"),
  ).length;
  const draftCardSlots = draftOptionIds.flatMap((id) => eventCardSlots(
    room.card.options.find((choice) => choice.id === id)?.effects ?? [], pendingDie, player, players,
  ));
  const maximumCards = draftCardSlots.length;
  const effectiveCardUids = pendingDecision?.cardUids?.length ? pendingDecision.cardUids : cards;
  const effectiveRelicId = pendingDecision?.relicIds?.[0] ?? relicId;
  const effectivePotionIds = pendingDecision?.potionIds?.length
    ? pendingDecision.potionIds
    : potionIndexes.map((index) => player.potions[index]!).filter(Boolean);
  // A plain "one player" payout with a single living player can only go to them.
  const livingPlayers = players.filter((candidate) => !candidate.dead);
  const soleTargetId = needsTarget && !trade && !otherCharacter && livingPlayers.length === 1 ? livingPlayers[0]!.id : "";
  const effectiveTargetPlayerId = pendingDecision?.targetPlayerId ?? (targetPlayerId || soleTargetId);
  // Who keeps each revealed item when it is not passed on, earlier staged
  // reveals first; the offers on screen are the tail of that list.
  const lootHolderIds = lootHolders({
    cardId: room.card.id, options: room.card.options, optionIds: pendingDecision?.optionIds ?? [], rolls: room.pendingRolls?.[player.id],
    actorId: player.id, targetId: effectiveTargetPlayerId, livingIds: players.filter((candidate) => !candidate.dead).map((candidate) => candidate.id),
  });
  const offerHolderIds = (itemOffers ?? []).map((_offer, index) => lootHolderIds[(pendingDecision?.rewardItemKinds?.length ?? 0) + index] ?? player.id);
  const lootFreeSlots = freePotionSlots(players, (seat) => potionLimit(ascension, seat), player.id, lootHolderIds, pendingDecision);
  const effectiveRoomId = pendingDecision?.roomId ?? roomId;
  const portalRow = eventMap?.position ? eventMap.rooms[eventMap.position]?.row ?? -1 : -1;
  const forwardRooms = eventMap ? Object.values(eventMap.rooms).filter((candidate) => candidate.row > portalRow) : [];
  const effectiveRewardSources = pendingDecision?.rewardSources?.length ? pendingDecision.rewardSources : rewardSources;
  const effectiveRareRewardSources = pendingDecision?.rewardSources?.length ? pendingDecision.rewardSources : rareRewardSources;
  const cardPickerSteps = effects.flatMap((effect) =>
    effect.tag === "remove-card" || effect.tag === "transform-card" || effect.tag === "upgrade-card" || effect.tag === "trade-card"
      ? eventCardSlots([effect], pendingDie, player, players).map((matches) => ({
        matches,
        verb: effect.tag === "remove-card" ? "Remove" as const
          : effect.tag === "transform-card" ? "Transform" as const
            : effect.tag === "upgrade-card" ? "Upgrade" as const : "Trade" as const,
      }))
      : [],
  ).slice(0, maximumCards);
  const ancientWritingSimplicity = room.card.id === "ancient_writing" && draftOptionIds.includes("simplicity");
  const firstPickerCard = player.deck.find((card) => card.uid === cards[0]);
  const cardPickerStep = ancientWritingSimplicity && cards.length < maximumCards
    ? cards.length === 0
      ? { matches: (card: Player["deck"][number]) => cardPickerSteps.some((step) => step.matches(card)), verb: "Upgrade" as const }
      : cardPickerSteps.find((step) => !firstPickerCard || !step.matches(firstPickerCard))
    : cardPickerSteps[cards.length];
  const remainingPickerSteps = cardPickerSteps.slice(cards.length);
  const nextPickerVerb = remainingPickerSteps.findIndex((step) => step.verb !== cardPickerStep?.verb);
  const pickerSelectionCount = nextPickerVerb < 0 ? remainingPickerSteps.length : nextPickerVerb;
  const pickerSelectionLabel = `${pickerSelectionCount} card${pickerSelectionCount === 1 ? "" : "s"}`;
  const usesCardPicker = selectionOpen && !pendingDecision?.cardUids?.length && maximumCards > 0 && cardPickerSteps.length === maximumCards && Boolean(cardPickerStep);
  const futurePickerSlots = ancientWritingSimplicity ? [] : cardPickerSteps.slice(cards.length + 1).map((step) => step.matches);
  const pickerCards = player.deck.filter((card) => card.defId !== "ascenders_bane" && cardPickerStep?.matches(card) &&
    (!room.revealedCards?.[player.id] || room.revealedCards[player.id]?.includes(card.uid)) && !cards.includes(card.uid) &&
    canFillCardSlots(player.deck.filter((candidate) => candidate.uid !== card.uid && !cards.includes(candidate.uid)), futurePickerSlots));
  const clearChoiceDraft = () => {
    setCards([]);
    setRelicId("");
    setPotionIndexes([]);
    setGoldPaymentSelected(false);
    setTargetPlayerId("");
    setRoomId("");
    setSelectedOptions([]);
    setRewardSources([]);
    setRareRewardSources([]);
  };
  const selectedCardsInvalid = room.card.id === "ancient_writing" && draftOptionIds.includes("simplicity")
    ? draftCardSlots.some((matches) => !effectiveCardUids.some((uid) => {
        const card = player.deck.find((candidate) => candidate.uid === uid);
        return Boolean(card && matches(card));
      }))
    : effectiveCardUids.some((uid, cardIndex) => {
        const card = player.deck.find((candidate) => candidate.uid === uid);
        return !card || !draftCardSlots[cardIndex]?.(card);
      });
  const selectedMissingTarget = needsTarget && (!effectiveTargetPlayerId ||
    (trade && !players.some((candidate) => candidate.id === effectiveTargetPlayerId && canTradeWith(candidate))));
  const selectedMissingRelic = effects.some((effect, effectIndex) =>
    effect.tag === "trade-relic" && !effectiveRelicId ||
    effect.tag === "lose-relic" && (effect.random
      ? player.relics.length === 0 && !effects.slice(0, effectIndex).some((prior) => prior.tag === "gain-relic")
      : room.card.id !== "forgotten_altar" && !effectiveRelicId));
  const requiredPotions = effects.filter((effect) => effect.tag === "lose-potion").length;
  const selectedMissingPotion = requiredPotions > 0 && effectivePotionIds.length !== requiredPotions;
  const selectedPrismaticSourcesMissing = selectedPrismaticReward &&
    (selectedPrismaticRare ? effectiveRareRewardSources.length !== 3 : effectiveRewardSources.length !== 3);
  const selectedCost = effects.reduce((sum, effect) =>
    sum + (effect.tag === "pay-gold" && typeof effect.amount === "number" ? effect.amount : 0), 0);
  const paymentLocked = Boolean(pendingDecision && room.pendingRolls?.[player.id] &&
    draftOptionIds.every((id) => pendingDecision.optionIds.includes(id)));
  const hasPaymentChoice = effects.some((effect) => effect.tag === "pay-gold" &&
    effect.filter?.includes("or lose one Relic or Potion"));
  const selectedItemPayment = hasPaymentChoice &&
    (Boolean(effectiveRelicId) || effectivePotionIds.length > 0);
  const availableGold = livingPlayers.reduce((sum, candidate) => sum + candidate.gold, 0);
  const selectedMissingPayment = hasPaymentChoice && !paymentLocked &&
    Number(goldPaymentSelected) + Number(player.relics.some((relic) => relic.defId === effectiveRelicId)) +
      effectivePotionIds.length !== 1;
  const selectedUnaffordable = !paymentLocked && !selectedItemPayment && selectedCost >
    availableGold;
  const selectedOptionInvalidated = room.card.id === "big_fish" && draftOptionIds.some((id) =>
    Object.entries({ ...room.decisions, ...room.pendingDecisions })
      .some(([playerId, decision]) => playerId !== player.id && decision.optionIds.includes(id)));
  const selectedOptionUnavailable = draftOptionIds.some((id) =>
    unavailableEventOptionIds.includes(id) || Boolean(room.partyOptionIds && !room.partyOptionIds.includes(id)));
  const nonCardSelectionReady = !selectedMissingTarget && !selectedMissingRelic && !selectedMissingPotion &&
    !selectedPrismaticSourcesMissing && !selectedMissingPayment && !selectedUnaffordable && !selectedOptionInvalidated && !selectedOptionUnavailable &&
    (room.card.id !== "secret_portal" || Boolean(effectiveRoomId));
  const selectionReady = effectiveCardUids.length === maximumCards && !selectedCardsInvalid && nonCardSelectionReady;
  const paymentFor = (optionIds: string[]) => {
    if (paymentLocked && optionIds.every((id) => pendingDecision?.optionIds.includes(id))) return undefined;
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
  const submit = (optionIds: string[], selectedRewardSources = rewardSources,
    selectedRewardIndexes = rewardIndexes, selectedGuardianGemIds = guardianGemIds,
    selectedCardUids = effectiveCardUids, overrides: Partial<EventDecision> = {}) =>
    onEvent(player.id, {
      optionIds,
      cardUids: selectedCardUids,
      relicIds: pendingDecision?.relicIds?.length ? pendingDecision.relicIds : relicId ? [relicId] : [],
      potionIds: pendingDecision?.potionIds?.length ? pendingDecision.potionIds : potionIndexes.map((index) => player.potions[index]!).filter(Boolean),
      potionRecipientIds,
      potionReplacementIds,
      rewardItemChoices: rewardItemChoices.length ? rewardItemChoices as ('take' | 'skip')[] : undefined,
      targetPlayerId: pendingDecision?.targetPlayerId ?? (targetPlayerId || soleTargetId || undefined),
      roomId: roomId || undefined,
      rewardIndexes: selectedRewardIndexes,
      guardianGemIds: selectedGuardianGemIds,
      rewardSources: selectedRewardSources,
      payments: paymentFor(optionIds),
      ...overrides,
    });
  if (eventPledge) {
    const remaining = eventPledge.cost - Object.values(eventPledge.payments).reduce((sum, amount) => sum + amount, 0);
    const mine = eventPledge.payments[player.id] ?? 0;
    const contribution = Math.min(Math.max(0, player.gold - mine), remaining);
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title"><div className="event-panel"><div className="room-banner"><span>Event payment</span><h2 id="event-title">{room.card.name}</h2><p>{remaining} Gold still needed. Each player authorizes only their own contribution.</p></div><button type="button" className="room-proceed" disabled={contribution <= 0} onClick={() => onEvent(eventPledge.actorId, { ...eventPledge.decision, payments: { [player.id]: mine + contribution } })}>Contribute ◉ {contribution}</button>{eventPledge.actorId === player.id && onCancelEventPayment ? <button type="button" onClick={onCancelEventPayment}>Cancel payment</button> : null}</div></section>;
  }
  if (pendingTrade) {
    const isTarget = pendingTrade.targetId === player.id;
    const tradeCards = player.deck.filter((card) => card.defId !== "ascenders_bane");
    return <><section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title"><div ref={eventResolver} className="event-panel event-panel--resolver">
      <div className="room-banner"><span>Event exchange</span><h2 id="event-title">{room.card.name}</h2>
        <p>{isTarget ? `${players.find((candidate) => candidate.id === pendingTrade.actorId)?.name ?? "A teammate"} offers ${pendingTrade.kind === "card" ? CARDS[pendingTrade.offeredId]?.name : relicDef(pendingTrade.offeredId).name}. Choose what to give back.` : "Waiting for your teammate to choose what they give back."}</p>
      </div>
      {isTarget ? <>
        {pendingTrade.kind === "relic" ? (
          <fieldset className="event-cards"><legend>Your relic</legend>{player.relics.map((relic, index) =>
            <RelicTooltipAnchor key={`${relic.defId}-${index}`} relic={relic} className="event-relic-choice">
            <button type="button" aria-pressed={relicId === relic.defId}
              aria-description={relicDescription(relic)} onClick={() => setRelicId(relic.defId)}>
              <ItemImage kind="relic" id={relic.defId} />{relicDef(relic.defId).name}
              <RelicOptionText id={relic.defId} note={relicNote(relic)} />
            </button></RelicTooltipAnchor>)}</fieldset>
        ) : <p role="status">Choose your card in the full-deck picker.</p>}
        {pendingTrade.kind === "relic" ? <div className="event-options"><button type="button" disabled={!relicId} onClick={() => submit(["accept_trade"])}>Complete exchange</button><button type="button" onClick={() => submit(["reject_trade"])}>Decline</button></div> : null}
      </> : <p role="status">Exchange pending…</p>}
    </div></section>{isTarget && pendingTrade.kind === "card" ? createPortal(<CardPicker
      cards={tradeCards}
      verb="Trade"
      selectionLabel="1 card"
      selectedCardUids={tradeCardUid ? [tradeCardUid] : []}
      onSelect={(uid) => setTradeCardDraft({ stage: pendingTradeStage, uid: tradeCardUid === uid ? "" : uid })}
      onClear={() => setTradeCardDraft({ stage: pendingTradeStage, uid: "" })}
      onBack={() => {
        setTradeCardDraft({ stage: "", uid: "" });
        submit(["reject_trade"]);
      }}
      onConfirm={() => {
        if (!tradeCardUid) return;
        setTradeCardDraft({ stage: "", uid: "" });
        submit(["accept_trade"], rewardSources, rewardIndexes, guardianGemIds, [tradeCardUid]);
      }}
      confirmLabel="Complete exchange"
      backLabel="Decline trade"
      confirmDisabled={!tradeCardUid}
    />, document.body) : null}</>;
  }
  if (itemOffers) {
    const pending = pendingDecision;
    const pendingEffects = room.card.options.filter((option) => pending?.optionIds.includes(option.id)).flatMap((option) => activeEffects(option.effects));
    const pendingCards = Math.max(0, ...room.card.options.filter((option) => pending?.optionIds.includes(option.id)).map((option) => eventCardSlots(option.effects, pendingDie, player, players).length));
    const pendingRelic = pendingEffects.some((effect) => effect.tag === "lose-relic" && !effect.random);
    const pendingTarget = pendingEffects.some((effect) => effect.target === "one-player");
    const receiversFor = (holderId: string) => players.filter((candidate) => candidate.id !== player.id && candidate.id !== holderId &&
      !candidate.dead && !hasSozu(candidate) && (lootFreeSlots.get(candidate.id) ?? 0) > 0);
    const potionOfferIndexes = itemOffers.flatMap((offer, index) => offer.kind === "potion" ? [index] : []);
    // A teammate chosen here can fill their belt meanwhile; a stale choice falls
    // back to the holder instead of stranding a pressed Take with no control.
    const recipientIds = potionOfferIndexes.map((offerIndex, at) => {
      const id = potionRecipientIds[at] ?? "";
      return receiversFor(offerHolderIds[offerIndex]!).some((candidate) => candidate.id === id) ? id : "";
    });
    const potionPlan = planEventPotions({
      offers: itemOffers, choices: rewardItemChoices, recipients: recipientIds, replacements: potionReplacementIds,
      actorId: player.id, holders: offerHolderIds, players, free: lootFreeSlots,
    });
    const replacementIds = potionReplacementIds.map((id, at) => potionPlan.swaps[at] ? id : null);
    // A held Potion an earlier swap already gives up is not offered again.
    const swapChoices = (at: number) => {
      const spent = new Map<string, number>();
      replacementIds.slice(0, at).forEach((id) => { if (id) spent.set(id, (spent.get(id) ?? 0) + 1); });
      return player.potions.map((id, heldIndex) => ({ id, heldIndex })).filter(({ id }) => {
        const used = spent.get(id) ?? 0;
        if (used > 0) spent.set(id, used - 1);
        return used === 0;
      });
    };
    const effectiveCards = pending?.cardUids ?? cards;
    const effectiveRelic = pending?.relicIds?.[0] ?? relicId;
    const effectiveTarget = pending?.targetPlayerId ?? (targetPlayerId || soleTargetId);
    const choose = (index: number, choice: "take" | "skip") =>
      setRewardItemChoices((current) => current.map((value, at) => at === index ? choice : value));
    let potionIndex = -1;
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
      <div className="event-art" aria-hidden="true" />
      <div ref={eventResolver} className="event-panel event-panel--loot">
        <div className="room-banner"><span>Event reward</span><h2 id="event-title">{room.card.name}</h2></div>
        {eventDie}
        {pendingRelic ? <fieldset className="event-cards"><legend>Your relic</legend>{player.relics.map((relic, index) =>
          <RelicTooltipAnchor key={`${relic.defId}-${index}`} relic={relic} className="event-relic-choice">
            <button type="button" disabled={Boolean(pending?.relicIds)} aria-pressed={effectiveRelic === relic.defId}
              aria-description={relicDescription(relic)} onClick={() => setRelicId(relic.defId)}>
              <ItemImage kind="relic" id={relic.defId} />{relicDef(relic.defId).name}<RelicOptionText id={relic.defId} note={relicNote(relic)} />
            </button>
          </RelicTooltipAnchor>)}</fieldset> : null}
        {pendingTarget && !soleTargetId ? <label>Reward recipient<select required disabled={Boolean(pending?.targetPlayerId)} value={effectiveTarget} onChange={(event) => setTargetPlayerId(event.target.value)}><option value="">Choose one</option>{players.filter((candidate) => !candidate.dead).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label> : null}
        <div className="event-items item-offer-list">{itemOffers.map((offer, index) => {
          if (offer.kind === 'potion') potionIndex += 1;
          const at = potionIndex;
          const holder = players.find((candidate) => candidate.id === offerHolderIds[index] && !candidate.dead);
          const receivers = offer.kind === 'potion' ? receiversFor(offerHolderIds[index]!) : [];
          const recipient = offer.kind === 'potion' ? players.find((candidate) => candidate.id === potionPlan.recipients[at] && !candidate.dead) : player;
          const takeBlocked = offer.kind === 'potion' && Boolean(holder) && potionPlan.blocked[at]!;
          const fullBelt = takeBlocked && recipient && !hasSozu(recipient) ? recipient : undefined;
          const title = offer.kind === 'relic' ? relicDef(offer.id).name : potionDef(offer.id).name;
          const swap = offer.kind === 'potion' && potionPlan.swaps[at];
          const holderSozu = Boolean(holder && hasSozu(holder));
          return <div className="event-loot" key={`${offer.kind}-${offer.id}-${index}`} role="group" aria-label={title} data-choice={rewardItemChoices[index] || undefined}>
            <RewardItem kind={offer.kind} id={offer.id} title={title}>
              <button type="button" disabled={takeBlocked} aria-pressed={rewardItemChoices[index] === 'take'} onClick={() => choose(index, 'take')}>Take</button>
              <button type="button" aria-pressed={rewardItemChoices[index] === 'skip'} onClick={() => choose(index, 'skip')}>Skip</button>
            </RewardItem>
            {offer.kind === 'potion' && (receivers.length > 0 || holderSozu) ? <label className="event-loot__pass">Pass to<select aria-label="Pass to" required={holderSozu} value={recipientIds[at] ?? ''} onChange={(event) => setPotionRecipientIds((current) => current.map((id, idIndex) => idIndex === at ? event.target.value : id))}><option value="">{holderSozu ? 'Choose a recipient' : holder && holder.id !== player.id ? holder.name : 'Keep it'}</option>{receivers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label> : null}
            {fullBelt ? <p className="event-loot__note">{fullBelt.id === player.id ? 'Your belt is full' : `${fullBelt.name}’s belt is full`}</p> : null}
            {swap ? <fieldset className="event-potion-replacement" aria-label="Replace">
              <legend>Belt full · swap out</legend>
              {swapChoices(at).map(({ id, heldIndex }) => <PotionTooltipAnchor key={`${id}-${heldIndex}`} id={id} confirmLabel="swap it out">
                <button type="button" aria-pressed={potionReplacementIds[at] === id}
                  aria-description={potionDef(id).text}
                  onClick={() => setPotionReplacementIds((current) => current.map((held, idIndex) => idIndex === at ? id : held))}>
                  <ItemImage kind="potion" id={id} /><span className="visually-hidden">{potionDef(id).name}</span>
                </button>
              </PotionTooltipAnchor>)}
            </fieldset> : null}
          </div>;
        })}</div>
        <button type="button" className="room-proceed" disabled={rewardItemChoices.some((choice) => !choice) || !potionPlan.legal || effectiveCards.length < pendingCards || (pendingRelic && !effectiveRelic) || (pendingTarget && !effectiveTarget)} onClick={() => submit(pending?.optionIds ?? [], undefined, undefined, undefined, undefined, { potionRecipientIds: recipientIds.map((id, at) => rewardItemChoices[potionOfferIndexes[at]!] === 'take' ? id : ''), potionReplacementIds: replacementIds })}>Resolve rewards →</button>
      </div>
    </section>;
  }
  const stagedBy = [...Object.keys(room.itemOffers ?? {}), ...Object.keys(room.rewardOffers ?? {})].find((id) => id !== player.id);
  if (stagedBy) {
    const owner = players.find((candidate) => candidate.id === stagedBy)?.name ?? "A teammate";
    const itemNames = room.itemOffers?.[stagedBy]?.map((offer) => offer.kind === "relic" ? relicDef(offer.id).name : potionDef(offer.id).name) ?? [];
    return <section className="room-stage event-stage" style={eventArt}><div className="event-panel"><div className="room-banner"><span>Event reward</span><h2>{room.card.name}</h2>{itemNames.length ? <p><strong>{owner} revealed:</strong> {itemNames.join(", ")}</p> : null}<p role="status">{room.rewardOffers?.[stagedBy] ? `${owner} is resolving a private Card Reward…` : `Waiting for ${owner} to resolve that reward…`}</p></div></div></section>;
  }
  if (room.card.id === "lab" && room.labChoices?.[player.id] && !room.pendingRolls?.[player.id]) return <section className="room-stage event-stage" style={eventArt}><div className="event-panel"><div className="room-banner"><span>Lab</span><h2>Potions collected</h2><p role="status">Waiting for every player to resolve their Potion.</p></div></div></section>;
  const unresolvedReward = rewardOffers?.findIndex((_offer, index) => (rewardIndexes[index] ?? -2) < -1) ?? -1;
  const needsRewardGem = (indexes: number[]) => rewardOffers?.some((offer, index) => {
    const choice = indexes[index] ?? -1;
    return choice >= 0 && Boolean(CARDS[offer[choice]!]?.guardian?.socket && guardianGemOffers[index]?.length);
  }) ?? false;
  if (rewardOffers && unresolvedReward >= 0) return <CardRewardPicker choices={rewardOffers[unresolvedReward]!}
    uidPrefix={`event-reward-${unresolvedReward}`} onChoose={(choice) => {
      const next = rewardIndexes.map((value, index) => index === unresolvedReward ? choice : value);
      setGuardianGemIds([]);
      setRewardIndexes(next);
      if (next.every((index) => index >= -1) && !needsRewardGem(next))
        submit(room.pendingDecisions?.[player.id]?.optionIds ?? [], rewardSources, next, []);
    }} onSkip={() => {
      const next = rewardIndexes.map((value, index) => index === unresolvedReward ? -1 : value);
      setGuardianGemIds([]);
      setRewardIndexes(next);
      if (next.every((index) => index >= -1) && !needsRewardGem(next))
        submit(room.pendingDecisions?.[player.id]?.optionIds ?? [], rewardSources, next, []);
    }} />;
  if (rewardOffers)
    return (
      <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
        <div ref={eventResolver} className="event-panel event-panel--resolver">
          <div className="room-banner">
            <span>Event reward</span>
            <h2 id="event-title">Choose your reward</h2>
            <p>
              Choose a Gem for the card you selected.
            </p>
          </div>
          {rewardOffers.map((offer, offerIndex) => (
            <fieldset className="event-cards" key={offerIndex}>
              <legend>Reward {offerIndex + 1}</legend>
              {offer.map((id, index) => (
                <Card
                  key={`${offerIndex}-${id}-${index}`}
                  card={{ uid: `event-reward-${offerIndex}-${index}`, defId: id, upgraded: false }}
                  selected={rewardIndexes[offerIndex] === index}
                  onClick={() => {
                    setGuardianGemIds([]);
                    setRewardIndexes((current) =>
                      current.map((value, at) =>
                        at === offerIndex ? index : value,
                      ),
                    );
                  }}
                />
              ))}
              {CARDS[offer[rewardIndexes[offerIndex] ?? -1]!]?.guardian?.socket && guardianGemOffers[offerIndex]?.length ? (
                <div className="event-cards" aria-label="Choose a Gem">
                  {guardianGemOffers[offerIndex]!.map((id) => <Card key={id}
                    card={{ uid: `event-gem-${offerIndex}-${id}`, defId: id, upgraded: false }}
                    selected={guardianGemIds[offerIndex] === id}
                    onClick={() => setGuardianGemIds((current) => {
                      const next = [...current];
                      next[offerIndex] = id;
                      return next;
                    })} />)}
                </div>
              ) : null}
              <button type="button" aria-pressed={rewardIndexes[offerIndex] === -1} onClick={() => {
                setGuardianGemIds([]);
                setRewardIndexes((current) => current.map((value, at) => at === offerIndex ? -1 : value));
              }}>Skip this reward</button>
            </fieldset>
          ))}
          <button
            className="room-proceed"
            type="button"
            disabled={
              rewardIndexes.length !== rewardOffers.length ||
              rewardIndexes.some((index) => index < -1) ||
              rewardOffers.some((offer, index) => CARDS[offer[rewardIndexes[index] ?? -1]!]?.guardian?.socket &&
                !guardianGemOffers[index]?.includes(guardianGemIds[index]!))
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
  const openingHand = room.preparedCombat?.players.find((candidate) => candidate.id === player.id)?.hand ?? [];
  const preparedEnemies = room.preparedCombat?.enemies ?? [];
  const encounterPreview = preparedEnemies.length > 0 ? <fieldset className="event-encounter-preview">
    <legend>Prepared encounter</legend>
    {preparedEnemies.filter((enemy) => !enemy.dead).map((enemy) => {
      const def = enemyDef(enemy.defId, enemy.ascension);
      return <figure key={enemy.uid}>
        <img src={enemyImagePath(def)} alt="" />
        <figcaption><strong>{def.name}</strong><span>Row {enemy.row + 1} · {enemy.hp}/{enemy.maxHp} HP</span></figcaption>
      </figure>;
    })}
  </fieldset> : null;
  const preparedSetup = room.preparedCombat?.pendingHermitSetupLoads?.[0];
  const localPreparedScries = room.preparedCombat ? startTurnScryAbilities(room.preparedCombat) : [];
  const preparedScries = room.preparedStartTurnScryAbilities ?? localPreparedScries;
  const localPreparedScry = room.preparedCombat ? startTurnScryPreview(room.preparedCombat) : undefined;
  const preparedScry = room.preparedStartTurnScry ?? localPreparedScry;
  const preparedScryIds = preparedScryOrder.length === preparedScries.length &&
    preparedScryOrder.every((id) => preparedScries.some((ability) => ability.id === id))
    ? preparedScryOrder : preparedScries.map((ability) => ability.id);
  const effectivePreparedScryPicked = preparedScryPicked.filter((uid) =>
    preparedScry?.cards?.some((card) => card.uid === uid));
  if (preparedSetup) {
    const owner = players.find((candidate) => candidate.id === preparedSetup.playerId);
    const setupHand = preparedSetup.playerId === player.id ? openingHand : [];
    const targetedCurses = ["hermit_grudge", "hermit_malice", "hermit_horror"];
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
      <div className="event-art" aria-hidden="true" />
      <div className="event-panel event-panel--resolver">
        <div className="room-banner"><span>Event</span><h2 id="event-title">{room.card.name}</h2>
          <p>{preparedSetup.playerId === player.id
            ? "Hermit start of combat — choose a card from your opening hand to Load into the Chamber."
            : `Waiting for ${owner?.name ?? "the Hermit"} to finish their private setup Load.`}</p></div>
        {encounterPreview}
        {setupHand.length > 0 ? <fieldset className="event-cards"><legend>Load 1 card</legend>
          {setupHand.map((card) => targetedCurses.includes(card.defId)
            ? <div key={card.uid} className="event-cards__option">
              <Card card={card} className="card--preview" playable={false} />
              {room.preparedCombat?.enemies.filter((enemy) => !enemy.dead).map((enemy) =>
                <button type="button" key={enemy.uid} onClick={() => onPreparedHermitSetup?.(card.uid, enemy.uid)}>
                  Load {CARDS[card.defId]?.name} at {enemyLabel(preparedEnemies, enemy)}
                </button>)}
            </div>
            : <div key={card.uid} className="event-cards__option">
              <Card card={card} className="card--preview" playable={false} />
              <button type="button" onClick={() => onPreparedHermitSetup?.(card.uid, null)}>
                Load {CARDS[card.defId]?.name}
              </button>
            </div>)}
        </fieldset> : null}
      </div>
    </section>;
  }
  if (preparedScries.length > 0 || preparedScry) {
    const coordinatorId = room.preparedStartTurnCoordinatorId ?? player.id;
    const scryOwner = players.find((candidate) => candidate.id === preparedScry?.playerId);
    return <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
      <div className="event-art" aria-hidden="true" />
      <div className="event-panel event-panel--resolver">
        <div className="room-banner"><span>Event</span><h2 id="event-title">{room.card.name}</h2>
          <p>{preparedScries.length > 0
            ? coordinatorId === player.id ? "Order the pre-draw Scries before revealing opening hands." : "Waiting for the Scry order."
            : preparedScry?.playerId === player.id ? `${preparedScry.label} — choose any revealed cards to discard.`
              : `Waiting for ${scryOwner?.name ?? "the Scry owner"} to finish their private Scry.`}</p></div>
        {encounterPreview}
        {preparedScries.length > 0 && coordinatorId === player.id ? <fieldset className="event-cards"><legend>Pre-draw Scry order</legend>
          {preparedScryIds.map((id, index) => {
            const ability = preparedScries.find((candidate) => candidate.id === id)!;
            return <div key={id}><strong>{ability.label}</strong>
              <button type="button" disabled={index === 0} onClick={() => setPreparedScryOrder((current) => {
                const order = current.length === preparedScries.length ? [...current] : preparedScries.map((candidate) => candidate.id);
                [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                return order;
              })}>Earlier</button>
              <button type="button" disabled={index === preparedScryIds.length - 1} onClick={() => setPreparedScryOrder((current) => {
                const order = current.length === preparedScries.length ? [...current] : preparedScries.map((candidate) => candidate.id);
                [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                return order;
              })}>Later</button></div>;
          })}
          <button type="button" onClick={() => onPreparedStartTurnScryOrder?.(preparedScryIds)}>Confirm Scry order</button>
        </fieldset> : null}
        {preparedScry?.playerId === player.id && preparedScry.cards ? <fieldset className="event-cards"><legend>{preparedScry.label} · Scry {preparedScry.amount}</legend>
          {preparedScry.cards.map((card) => <Card key={card.uid} card={card}
            selected={effectivePreparedScryPicked.includes(card.uid)}
            onClick={() => setPreparedScryPicked((picked) => picked.includes(card.uid)
              ? picked.filter((uid) => uid !== card.uid) : [...picked, card.uid])} />)}
          <button type="button" onClick={() => onPreparedStartTurnScry?.(preparedScry.id, effectivePreparedScryPicked)}>
            {effectivePreparedScryPicked.length > 0 ? `Discard ${effectivePreparedScryPicked.length} and draw` : "Keep all and draw"}
          </button>
        </fieldset> : null}
      </div>
    </section>;
  }
  return (
    <section className="room-stage event-stage" style={eventArt} aria-labelledby="event-title">
      <div className="event-art" aria-hidden="true" />
      <div ref={eventResolver} className={`event-panel${resolverOpen ? " event-panel--resolver" : ""}`} data-roll={eventDie ? true : undefined}>
        <div className="room-banner">
          <span>Event</span>
          <h2 id="event-title">{room.card.name}</h2>
          {repeatScrap ? <p className="event-retry" role="status">Nothing caught. Reach in again, or leave.</p>
            : room.card.prompt ?? room.card.rule ? <p>{room.card.prompt ?? room.card.rule}</p> : null}
          {eventDie}
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
        {encounterPreview}
        {openingHand.length > 0 ? <fieldset className="event-cards"><legend>Your opening hand · choose for the party</legend>{openingHand.map((card) => <Card key={card.uid} card={card} className="card--preview" playable={false} />)}</fieldset> : null}
        {resolverOpen ? <p className="event-choice-summary">
          {draftOptionIds.map((id) => room.card.options.find((choice) => choice.id === id))
            .filter((choice) => choice)
            .map((choice) => `[${choice!.label}] ${choice!.description}`)
            .join(" · ")}
        </p> : null}
        <div className="event-selectors">
          {hasPrismaticShard && hasPrismaticCardReward ? <fieldset className="event-cards"><legend>Prismatic Shard · Card Reward · choose 3 reward decks</legend>
            {availableCardSources.map((source) => <label key={source}>
              <input type="checkbox" checked={effectiveRewardSources.includes(source)}
                disabled={Boolean(pendingDecision?.rewardSources?.length) || !rewardSources.includes(source) && rewardSources.length >= 3}
                onChange={(event) => setRewardSources((current) => event.target.checked ? [...current, source] : current.filter((id) => id !== source))} />
              {rewardSourceLabel(source)}
            </label>)}
          </fieldset> : null}
          {hasPrismaticShard && hasPrismaticRareReward ? <fieldset className="event-cards"><legend>Prismatic Shard · Rare Reward · choose 3 reward decks</legend>
            {availableRareSources.map((source) => <label key={source}>
              <input type="checkbox" checked={effectiveRareRewardSources.includes(source)}
                disabled={Boolean(pendingDecision?.rewardSources?.length) || !rareRewardSources.includes(source) && rareRewardSources.length >= 3}
                onChange={(event) => setRareRewardSources((current) => event.target.checked ? [...current, source] : current.filter((id) => id !== source))} />
              {rewardSourceLabel(source)}
            </label>)}
          </fieldset> : null}
          {needsTarget && !soleTargetId ? <label>
            Target player
            <select
              required
              disabled={Boolean(pendingDecision?.targetPlayerId)}
              value={effectiveTargetPlayerId}
              onChange={(event) => setTargetPlayerId(event.target.value)}
            >
              <option value="">None</option>
              {players
                .filter((candidate) => !candidate.dead && (!(trade || otherCharacter) || candidate.id !== player.id) && (!trade || canTradeWith(candidate)) && (!otherCharacter || availableCardSources.includes(candidate.character)))
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              {otherCharacter ? CHARACTER_IDS
                .filter((character) => availableCardSources.includes(character) && !players.some((candidate) => candidate.character === character))
                .map((character) => <option key={character} value={character}>{rewardSourceLabel(character)} reward deck</option>) : null}
            </select>
          </label> : null}
          {hasPaymentChoice && !paymentLocked ? <fieldset className="event-cards"><legend>Gold payment</legend>
            <button type="button" aria-pressed={goldPaymentSelected} disabled={selectedCost > availableGold}
              onClick={() => {
                setGoldPaymentSelected((current) => !current);
                setRelicId("");
                setPotionIndexes([]);
              }}>Pay <Price value={selectedCost} /></button>
          </fieldset> : null}
          {needsRelic && !paymentLocked && player.relics.length ? (
            <fieldset className="event-cards"><legend>Your relic</legend>
              {player.relics.map((relic, index) => <RelicTooltipAnchor key={`${relic.defId}-${index}`} relic={relic} className="event-relic-choice">
                <button type="button"
                disabled={Boolean(pendingDecision?.relicIds?.length)}
                aria-pressed={effectiveRelicId === relic.defId} aria-description={relicDescription(relic, paysRelicCost)}
                onClick={() => { setGoldPaymentSelected(false); setRelicId((current) => current === relic.defId ? '' : relic.defId); setPotionIndexes([]); }}>
                <ItemImage kind="relic" id={relic.defId} />{relicDef(relic.defId).name}
                {paysRelicCost ? <span>{relicDef(relic.defId).cost ?? 0} Gold</span> : null}
                <RelicOptionText id={relic.defId} note={relicNote(relic)} />
              </button></RelicTooltipAnchor>)}
            </fieldset>
          ) : null}
          {needsPotion && !paymentLocked && player.potions.length ? (
            <fieldset className="event-cards"><legend>Your potions</legend>
              {player.potions.map((id, index) => <button type="button" disabled={Boolean(pendingDecision?.potionIds?.length)} aria-pressed={pendingDecision?.potionIds?.length ? effectivePotionIds.includes(id) : potionIndexes.includes(index)} key={`${id}-${index}`} onClick={() => { setGoldPaymentSelected(false); setRelicId(""); setPotionIndexes((current) => current.includes(index) ? current.filter((value) => value !== index) : maximumPotions === 1 ? [index] : [...current, index].slice(-maximumPotions)); }}><ItemImage kind="potion" id={id} />{potionDef(id).name}</button>)}
            </fieldset>
          ) : null}
          {resolverOpen && room.card.id === "secret_portal" && eventMap ? (
            <div className="portal-map" role="group" aria-label="Forward room">
              <MapScreen map={eventMap} choices={forwardRooms} pick pickedId={effectiveRoomId || undefined}
                bossDefId={eventBossDefId} disabled={Boolean(pendingDecision?.roomId)} onEnter={setRoomId} />
            </div>
          ) : null}
        </div>
        {(!resolverOpen || room.card.id === "knowing_skull") ? <div className={`event-options${repeatScrap ? " event-options--retry" : ""}`} ref={eventOptions}>
          {room.card.options.map((option) => {
            const choice = room.card.id === "face_trader" && option.id === "exchange" && players.length === 1
              ? { ...option, label: "Leave", description: "No other player to exchange with." }
              : option;
            const cardSlots = eventCardSlots(choice.effects, pendingDie, player, players);
            const choiceEffects = activeEffects(choice.effects);
            const curses = player.deck.filter((card) => cardIsCurse(card.defId));
            const curseCountNote = choiceEffects.some((effect) => effect.tag === "remove-curses")
              ? ` (Currently ${curses.length} ${curses.length === 1 ? "curse" : "curses"}.${
                curses.some((card) => card.defId === "ascenders_bane") ? " Ascender's Bane cannot be removed." : ""})`
              : "";
            const choiceTradeCard = choiceEffects.some((effect) => effect.tag === "trade-card");
            const choiceTradeRelic = choiceEffects.some((effect) => effect.tag === "trade-relic");
            const choiceTradePossible = choiceTradeCard ? cardSlots.length > 0 : !choiceTradeRelic ||
              player.relics.length > 0 && players.some((candidate) => candidate.id !== player.id && !candidate.dead && candidate.relics.length > 0);
            const choiceNeedsTarget = choiceEffects.some((effect) => effect.target === "one-player" || effect.source === "other-character" ||
              (effect.tag === "trade-card" || effect.tag === "trade-relic") && choiceTradePossible);
            const selected = selectedOptions.includes(choice.id);
            const knowing = room.card.id === "knowing_skull";
            const lockedOption =
              room.partyOptionIds && !room.partyOptionIds.includes(choice.id);
            const uniqueOptionTaken = room.card.id === "big_fish" && Object.entries({ ...room.decisions, ...room.pendingDecisions })
              .some(([playerId, decision]) => playerId !== player.id && decision.optionIds.includes(choice.id));
            const missingRedMask = choice.effects.some((effect) => effect.filter === "party has Red Mask") &&
              !players.some((candidate) => candidate.relics.some((relic) => relic.defId === "red_mask"));
            const prismaticReward = hasPrismaticShard && choiceEffects.some((effect) =>
              (effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source !== "colorless") && !effect.random,
            );
            const prismaticRare = choiceEffects.some((effect) => effect.tag === "rare-reward" || effect.tag === "card-reward" && effect.source === "rare");
            const choiceCost = choiceEffects.reduce((sum, effect) =>
              sum + (effect.tag === "pay-gold" && typeof effect.amount === "number" ? effect.amount : 0), 0);
            const itemAlternative = choiceEffects.some((effect) => effect.filter?.includes("or lose one Relic or Potion")) &&
              (player.relics.length > 0 || player.potions.length > 0);
            const unaffordable = choiceCost > players.filter((candidate) => !candidate.dead)
              .reduce((sum, candidate) => sum + candidate.gold, 0) && !itemAlternative;
            const missingRequiredItem =
              choiceEffects.some((effect, effectIndex) => effect.tag === "lose-relic" &&
                player.relics.length === 0 && !choiceEffects.slice(0, effectIndex).some((prior) => prior.tag === "gain-relic")) ||
              choiceEffects.filter((effect) => effect.tag === "lose-potion").length > player.potions.length;
            const unavailablePrismaticSources = prismaticReward &&
              (prismaticRare ? availableRareSources.length : availableCardSources.length) < 3;
            const choiceUnavailable = unavailableEventOptionIds.includes(choice.id) || lockedOption || uniqueOptionTaken ||
              missingRedMask || unaffordable || missingRequiredItem || unavailablePrismaticSources;
            const needsResolver = cardSlots.length > 0 || choiceNeedsTarget ||
              choiceEffects.some((effect) => effect.tag === "pay-gold" && effect.filter?.includes("or lose one Relic or Potion")) ||
              choiceEffects.some((effect) => effect.tag === "lose-relic" && !effect.random &&
                !(room.card.id === "face_trader" && choice.id === "take_and_give" && !pendingDecision) ||
                effect.tag === "lose-potion" || effect.filter?.includes("Relic") && player.relics.length > 0 ||
                effect.filter?.includes("Potion") && player.potions.length > 0) ||
              prismaticReward || room.card.id === "secret_portal";
            // ponytail: `choiceEffects` only expands a `roll-d6` branch once `pendingDie` is
            // set, which happens AFTER this option is clicked — so a random card/rare reward
            // nested inside a die-roll outcome would never arm the gain reveal. No event does
            // that today (grep `random: true` in events.ts); if one ever does, arm from the
            // roll's own resolution instead of here.
            const grantsRandomCard = choiceEffects.some((effect) => (effect.tag === "card-reward" || effect.tag === "rare-reward") && effect.random === true);
            return (
              <button
                type="button"
                data-event-option={choice.id}
                onFocus={(event) => {
                  focusedEventOption.current = event.currentTarget;
                  focusedEventOptionId.current = choice.id;
                }}
                aria-pressed={knowing ? selected : undefined}
                key={choice.id}
                disabled={Boolean(decided) || choiceUnavailable && !(knowing && selected)}
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
                  if (needsResolver) {
                    clearChoiceDraft();
                    setSelectedOptions([choice.id]);
                    return;
                  }
                  if (grantsRandomCard) onArmCardGain?.();
                  submit([choice.id], prismaticRare ? rareRewardSources : rewardSources);
                }}
              >
                {repeatScrap ? <strong>{choice.id === "reach_inside" ? "Reach again" : choice.label}</strong> : <>
                  <strong>[{choice.label}]</strong>
                  <span>{choice.description}{curseCountNote}</span>
                </>}
              </button>
            );
          })}
        </div> : null}
        {resolverOpen && room.card.id !== "knowing_skull" ? (
          <div className="event-resolve-actions">
            {!pendingDecision ? <button type="button" className="ribbon-back" aria-label="Back to choices" onClick={clearChoiceDraft}><span aria-hidden="true"></span></button> : null}
            {maximumCards > 0 ? <PickerConfirmButton className="event-card-confirm" label="Confirm choice" disabled={!selectionReady} onClick={() => {
              if (selectedChoiceEffects.some((effect) =>
                (effect.tag === "card-reward" || effect.tag === "rare-reward") && effect.random === true)) onArmCardGain?.();
              submit(draftOptionIds, selectedPrismaticRare ? effectiveRareRewardSources : effectiveRewardSources);
            }} /> : <button type="button" className="room-proceed" disabled={!selectionReady} onClick={() => {
              if (selectedChoiceEffects.some((effect) =>
                (effect.tag === "card-reward" || effect.tag === "rare-reward") && effect.random === true)) onArmCardGain?.();
              submit(draftOptionIds, selectedPrismaticRare ? effectiveRareRewardSources : effectiveRewardSources);
            }}>Confirm choice →</button>}
          </div>
        ) : null}
        {room.card.id === "knowing_skull" ? (
          <button
            type="button"
            className="room-proceed"
            disabled={Boolean(decided) || selectedOptions.length < 1 || selectedOptions.length > 2 ||
              selectedOptions.some((id) => unavailableEventOptionIds.includes(id)) ||
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
      {usesCardPicker && cardPickerStep ? createPortal(<CardPicker
        cards={pickerCards}
        verb={cardPickerStep.verb}
        selectionLabel={pickerSelectionLabel}
        selectedCardUids={pickerCardUids}
        onSelect={(uid) => setPickerCardUids((current) => current.includes(uid) ? [] : [uid])}
        onClear={() => setPickerCardUids([])}
        onBack={clearChoiceDraft}
        onConfirm={() => {
          const uid = pickerCardUids[0];
          if (!uid) return;
          const chosen = [...cards, uid];
          setCards(chosen);
          setPickerCardUids([]);
          if (chosen.length === maximumCards && nonCardSelectionReady) {
            if (selectedChoiceEffects.some((effect) =>
              (effect.tag === "card-reward" || effect.tag === "rare-reward") && effect.random === true)) onArmCardGain?.();
            submit(draftOptionIds, selectedPrismaticRare ? effectiveRareRewardSources : effectiveRewardSources,
              rewardIndexes, guardianGemIds, chosen);
          } else if (chosen.length === maximumCards) requestAnimationFrame(() => {
              eventResolver.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
            });
        }}
        confirmLabel="Confirm Event card"
        backLabel={selectedOptionInvalidated || selectedOptionUnavailable || selectedUnaffordable ? "Back to choices" : "Back"}
        confirmDisabled={pickerCardUids.length !== 1 || Boolean(pendingDecision?.cardUids?.length) ||
          selectedOptionInvalidated || selectedOptionUnavailable || selectedUnaffordable}
        disabled={Boolean(pendingDecision?.cardUids?.length)}
      />, document.body) : null}
      {eventCanSkip ? <p className="room-proceed" role="status">No legal choice · leaving event automatically…</p> : null}
    </section>
  );
}
