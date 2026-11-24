import { CARDS, cardIsCurse } from "../../game/cards.ts";
import type { EventDecision, EventRoomState } from "../../game/event-room.ts";
import type { EventEffect } from "../../game/events.ts";
import type { SpireMap } from "../../game/map.ts";
import type {
  MerchantPurchase,
  MerchantState,
  RelicRewardState,
  TreasureDecision,
} from "../../game/noncombat.ts";
import type { Player } from "../../game/types.ts";
import type { ActionOutcome } from "../../multiplayer/useRoomSession.ts";

export type PropsPledgeMap = Record<
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

export type RoomScreenProps = {
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
  onResumeMerchant?: () => void;
  onRelic: (playerId: string, decision: TreasureDecision) => void | Promise<ActionOutcome>;
  onEvent: (playerId: string, decision: EventDecision) => void;
  onPreparedHermitSetup?: (cardUid: string, enemyUid: string | null) => void;
  onPreparedStartTurnScryOrder?: (order: string[]) => void;
  onPreparedStartTurnScry?: (sourceId: string, discardUids: string[]) => void;
  sapphireAvailable?: boolean;
  merchantPledges?: PropsPledgeMap;
  merchantReady?: string[];
  connectedPlayerIds?: string[];
  onWithdraw?: (key: string) => void;
  /** The map as the viewer sees it, for picking a Secret Portal destination. */
  eventMap?: SpireMap;
  eventBossDefId?: string | null;
  eventPledge?: { actorId: string; optionId: string; cost: number; payments: Record<string, number>; decision: EventDecision };
  onCancelEventPayment?: () => void;
  eventCanSkip?: boolean;
  unavailableEventOptionIds?: string[];
  onSkipEvent?: (playerId: string) => void | Promise<ActionOutcome>;
  /** Arms the next deck change to play as a reveal, for a card gained without ever being shown (a random card/rare reward). */
  onArmCardGain?: () => void;
};

export type EventCardSlot = (card: Player["deck"][number]) => boolean;
export type PublicPlayerCounts = { cardRewardCount?: number; tradableDeckCount?: number };

export function eventCardSlots(effects: readonly EventEffect[], die: number | undefined, player: Player, players: readonly Player[]): EventCardSlot[] {
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
      if (effect.tag === "transform-card" && (cardIsCurse(card.defId) || (player.cardRewards.length === 0 && ((player as PublicPlayerCounts).cardRewardCount ?? 0) === 0))) return false;
      if (effect.tag === "trade-card" && !players.some((candidate) => candidate.id !== player.id && !candidate.dead && (candidate.deck.some((entry) => entry.defId !== "ascenders_bane") || ((candidate as PublicPlayerCounts).tradableDeckCount ?? 0) > 0))) return false;
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

export function canFillCardSlots(cards: readonly Player["deck"][number][], slots: readonly EventCardSlot[]): boolean {
  const [slot, ...rest] = slots;
  return !slot || cards.some((card, index) => slot(card) && canFillCardSlots(cards.filter((_, at) => at !== index), rest));
}
