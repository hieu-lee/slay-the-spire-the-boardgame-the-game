import type { EventCard, EventEffect, EventOption } from '../events.ts'

/** Official public-v1.47 Downfall event decks from the decoded TTS save. */
export const DOWNFALL_EVENT_SOURCE = {
  manifest: 'Downfall expansion event decks',
  version: 'official public TTS v1.47',
  save: 'tmp/downfall-reference/downfall-workshop.json',
  method: 'All occupied event-sheet cells were cropped from the official TTS FaceURL assets and visually transcribed at 744x1039. No PC-mod text was used.',
} as const

export const DOWNFALL_EVENT_ICON_LEGEND = {
  '[event]': 'printed question-mark room icon',
  '[merchant]': 'printed merchant-bag room icon',
  '[encounter]': 'printed horned-skull encounter-room icon',
  '[treasure]': 'printed closed treasure-chest icon; semantic object name is not stated on the event faces',
  '[card-reward]': 'printed gray card/reward-stack icon',
  '[gold:N]': 'printed gold coin with the displayed numeral N',
  '[vulnerable]': 'printed broken-heart status icon',
  '[mode-shift]': 'printed pink spiral icon',
} as const

export type DownfallEventAct = 1 | 2 | 3

export type DownfallEventDeckSource = {
  act: DownfallEventAct
  sheet_id: string
  sheet_file: string
  face_url: string
  deck_guid: string
  occupied_indices: readonly number[]
  card_ids: readonly number[]
  expected_count: number
}

export const DOWNFALL_EVENT_DECK_SOURCES: readonly DownfallEventDeckSource[] = [
  {
    act: 1,
    sheet_id: '4672',
    sheet_file: 'tmp/downfall-reference/event-sheets/4672.img',
    face_url: 'https://steamusercontent-a.akamaihd.net/ugc/18261406273218264823/C64475E4830E4A8F0C5C14466E0047AF511B59A2/',
    deck_guid: '4ad297',
    occupied_indices: [0, 1, 2, 3, 4, 5, 6],
    card_ids: [467200, 467201, 467202, 467203, 467204, 467205, 467206],
    expected_count: 7,
  },
  {
    act: 2,
    sheet_id: '4671',
    sheet_file: 'tmp/downfall-reference/event-sheets/4671.img',
    face_url: 'https://steamusercontent-a.akamaihd.net/ugc/10584959676514582610/4F5B26E6297A20D456C5E595A25634AC5BBF90A6/',
    deck_guid: '5168e1',
    occupied_indices: [0, 1, 2, 3, 4, 5],
    card_ids: [467100, 467101, 467102, 467103, 467104, 467105],
    expected_count: 6,
  },
  {
    act: 3,
    sheet_id: '4673',
    sheet_file: 'tmp/downfall-reference/event-sheets/4673.img',
    face_url: 'https://steamusercontent-a.akamaihd.net/ugc/17774126072452709059/019C4C816258EE6531DC02F556DD8888569FE61B/',
    deck_guid: 'cdad92',
    occupied_indices: [0, 1, 2, 3],
    card_ids: [467300, 467301, 467302, 467303],
    expected_count: 4,
  },
] as const

export type DownfallEventCardSource = {
  sheet_id: string
  deck_guid: string
  card_guid: string
  card_id: number
  index: number
}

export type DownfallEventChoice = {
  label: string
  outcome: string
}

export type DownfallEventEntry = {
  title: string
  act: DownfallEventAct
  deck: string
  printed_marker: string
  sources: readonly DownfallEventCardSource[]
  multiplicity: number
  reused_base_status: { reused: boolean; kind: string }
  flavor_text?: string
  setup_text?: string
  speech_text?: string
  routing_text?: string
  choices: readonly DownfallEventChoice[]
  /** Exact audit notes for unnamed icons or source punctuation. */
  ambiguities: readonly string[]
}

export const DOWNFALL_EVENT_SOURCE_ENTRIES: readonly DownfallEventEntry[] = [
  {"title":"The Sssssrpent","act":1,"deck":"Act I event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"a950db","card_id":467200,"index":0}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity and face"},"flavor_text":"“I ask a simple question. The most fulfilling of lives is that in which you can buy anything! Do you agree?”","choices":[{"label":"Agree","outcome":"Gain [gold:8]. Gain a Curse."},{"label":"Stomp","outcome":"Gain [card-reward]. Lose 2 HP."},{"label":"Debate","outcome":"Remove a card from your deck. Lose all gold."}],"ambiguities":[]},
  {"title":"World of Goop","act":1,"deck":"Act I event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"d224f8","card_id":467201,"index":1}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity and face"},"flavor_text":"You fall into a puddle made of SLIME GOOP!! Frantically, you claw yourself out, but notice some of your gold is missing. You notice more left behind from unfortunate adventurers...","choices":[{"label":"Gather Gold","outcome":"Gain [gold:3]. Lose 2 HP."},{"label":"Reach Deeper","outcome":"Gain [treasure] and a Curse."},{"label":"Leave It","outcome":"Lose [gold:1]."}],"ambiguities":["The chest is preserved as a visual token because this face does not name the represented object."]},
  {"title":"Scrap Ooze","act":1,"deck":"Act I event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"87f337","card_id":467202,"index":2}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity and face"},"flavor_text":"Before you is an acidic slime that ate too much scrap for its own good. Inside the creature you see glints of light. Perhaps something magical?","choices":[{"label":"Reach Inside","outcome":"Roll the die. Lose 1 HP. On 1-2: Reach Inside again or Leave. On 3-4: Gain [gold:2]. On 5-6: Gain [treasure]."},{"label":"Leave","outcome":"Nothing happens."}],"ambiguities":["The 1-2 result line prints only the emphasized choice words Reach Inside and Leave; punctuation has been rendered as a colon in this structured transcription."]},
  {"title":"Dead Adventurer","act":1,"deck":"Act I event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"31037e","card_id":467203,"index":3}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity and face"},"flavor_text":"You find a dead adventurer...his pants are missing!","setup_text":"If this is the first [event], discard it and draw again. One choice for the party.","choices":[{"label":"Search","outcome":"Roll the die. On 1-2: Fight a [encounter]. On 3-4: Each player gains [gold:2]. On 5-6: One player gains [treasure]."},{"label":"Leave","outcome":"Nothing happens."}],"ambiguities":["The encounter and treasure results are icon-only on the face; labels in brackets describe the printed glyphs."]},
  {"title":"The Merchant","act":1,"deck":"Act I event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"41a838","card_id":467204,"index":4}],"multiplicity":1,"reused_base_status":{"reused":false,"kind":"Downfall-specific event-deck routing card using the base-game Merchant presentation"},"speech_text":"Do you like this rug? It's not for sale.","routing_text":"If this is the first [event], discard it and draw again. Treat this room as a [merchant].","choices":[],"ambiguities":[]},
  {"title":"Encounter!","act":1,"deck":"Act I event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"6af4e1","card_id":467205,"index":5},{"sheet_id":"4672","deck_guid":"4ad297","card_guid":"762582","card_id":467206,"index":6}],"multiplicity":2,"reused_base_status":{"reused":false,"kind":"Downfall-specific event-deck routing card"},"routing_text":"If this is the first [event], discard it and draw again. Fight! Treat this room as a [encounter].","choices":[],"ambiguities":[]},
  {"title":"Masked Bandits","act":2,"deck":"Act II event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4671","deck_guid":"5168e1","card_guid":"98ef3d","card_id":467100,"index":0}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity; face is marked beta art!"},"flavor_text":"You encounter a group of bandits wearing large red masks. They won't let you pass.","choices":[{"label":"Duel Pointy","outcome":"Gain [treasure]. Lose 3 HP."},{"label":"Bribe Romeo","outcome":"Upgrade a card. Lose all gold."},{"label":"Hug Bear","outcome":"Remove a card. Lose 2 max HP."}],"ambiguities":["The reward in Duel Pointy is a chest glyph with no prose label on the face."]},
  {"title":"The Mausoleum","act":2,"deck":"Act II event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4671","deck_guid":"5168e1","card_guid":"ad1a0d","card_id":467101,"index":1}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity and face"},"flavor_text":"You are faced with a large sarcophagus. You notice black fog seeping out from the sides...","choices":[{"label":"Open Coffin","outcome":"Gain [treasure]. Roll the die. On 1-3: Gain a Curse."},{"label":"Leave","outcome":"Nothing happens."}],"ambiguities":["The gained object is a chest glyph with no prose label on the face."]},
  {"title":"Forgotten Altar","act":2,"deck":"Act II event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4671","deck_guid":"5168e1","card_guid":"8b6c69","card_id":467102,"index":2}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity and face"},"flavor_text":"In front of you sits an altar to a forgotten god. She calls out to you, demanding sacrifice.","setup_text":"Each player randomly selects and reveals one of their [treasure].","choices":[{"label":"Offer","outcome":"Lose your selected [treasure]. Gain [treasure]."},{"label":"Sacrifice","outcome":"Lose 2 HP."},{"label":"Desecrate","outcome":"Gain a Curse."}],"ambiguities":["All three object references are printed as the same chest glyph; the card does not provide a prose noun or visually distinguish the gained chest from the selected chest."]},
  {"title":"The Merchant","act":2,"deck":"Act II event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4671","deck_guid":"5168e1","card_guid":"13f167","card_id":467103,"index":3}],"multiplicity":1,"reused_base_status":{"reused":false,"kind":"Downfall-specific event-deck routing card using the base-game Merchant presentation"},"speech_text":"I like your haircut.","routing_text":"Treat this room as a [merchant].","choices":[],"ambiguities":[]},
  {"title":"Encounter!","act":2,"deck":"Act II event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4671","deck_guid":"5168e1","card_guid":"1a1525","card_id":467104,"index":4},{"sheet_id":"4671","deck_guid":"5168e1","card_guid":"c22a87","card_id":467105,"index":5}],"multiplicity":2,"reused_base_status":{"reused":false,"kind":"Downfall-specific event-deck routing card"},"routing_text":"Fight! Treat this room as a [encounter].","choices":[],"ambiguities":[]},
  {"title":"Mysterious Sphere","act":3,"deck":"Act III event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4673","deck_guid":"cdad92","card_guid":"fd0db6","card_id":467300,"index":0}],"multiplicity":1,"reused_base_status":{"reused":true,"kind":"base-game event identity; face is marked beta art!"},"flavor_text":"A bony sphere surrounds a mysterious glowing object within. You notice some sentries keeping an eye on it.","setup_text":"Fight a [encounter]. After drawing opening hands, one choice for the party:","choices":[{"label":"Open Sphere","outcome":"[vulnerable] to all players. Add [treasure] to all combat rewards."},{"label":"Charge In","outcome":"[mode-shift] to all players."}],"ambiguities":["Both player effects are icon-only; bracketed labels describe the printed glyphs rather than importing PC-mod wording."]},
  {"title":"The Merchant","act":3,"deck":"Act III event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4673","deck_guid":"cdad92","card_guid":"1b5fc0","card_id":467301,"index":1}],"multiplicity":1,"reused_base_status":{"reused":false,"kind":"Downfall-specific event-deck routing card using the base-game Merchant presentation"},"speech_text":"Buy something.","routing_text":"Treat this room as a [merchant].","choices":[],"ambiguities":[]},
  {"title":"Encounter!","act":3,"deck":"Act III event deck","printed_marker":"flame 3","sources":[{"sheet_id":"4673","deck_guid":"cdad92","card_guid":"cf3144","card_id":467302,"index":2},{"sheet_id":"4673","deck_guid":"cdad92","card_guid":"c2526b","card_id":467303,"index":3}],"multiplicity":2,"reused_base_status":{"reused":false,"kind":"Downfall-specific event-deck routing card"},"routing_text":"Fight! Treat this room as a [encounter].","choices":[],"ambiguities":[]},
] as const

export type DownfallEventScope = 'player' | 'party' | 'automatic'
export type DownfallEventRoute = 'merchant' | 'encounter' | null

export type DownfallEventDef = DownfallEventEntry & {
  id: string
  name: string
  scope: DownfallEventScope
  route: DownfallEventRoute
  firstEventRedraw: boolean
  choices: readonly (DownfallEventChoice & { id: string; effects: readonly EventEffect[] })[]
  options: readonly EventOption[]
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function eventRoute(event: DownfallEventEntry): DownfallEventRoute {
  if (event.routing_text?.includes('[merchant]')) return 'merchant'
  if (event.routing_text?.includes('[encounter]')) return 'encounter'
  return null
}

function eventScope(event: DownfallEventEntry): DownfallEventScope {
  if (eventRoute(event) !== null) return 'automatic'
  return event.setup_text?.toLowerCase().includes('one choice for the party') ? 'party' : 'player'
}

const fx = (tag: EventEffect['tag'], fields: Omit<EventEffect, 'tag'> = {}): EventEffect => ({ tag, ...fields })
const roll = (results: NonNullable<EventEffect['results']>): EventEffect => fx('roll-d6', { results })

function eventEffects(id: string, choice: string): readonly EventEffect[] {
  const key = `${id}/${slug(choice)}`
  switch (key) {
    case 'downfall_event_act1_the_sssssrpent/agree': return [fx('gain-gold', { amount: 8 }), fx('gain-curse')]
    case 'downfall_event_act1_the_sssssrpent/stomp': return [fx('card-reward', { source: 'other-character' }), fx('lose-hp', { amount: 2 })]
    case 'downfall_event_act1_the_sssssrpent/debate': return [fx('remove-card'), fx('lose-gold', { amount: 'all' })]
    case 'downfall_event_act1_world_of_goop/gather_gold': return [fx('gain-gold', { amount: 3 }), fx('lose-hp', { amount: 2 })]
    case 'downfall_event_act1_world_of_goop/reach_deeper': return [fx('gain-relic'), fx('gain-curse')]
    case 'downfall_event_act1_world_of_goop/leave_it': return [fx('lose-gold', { amount: 1 })]
    case 'downfall_event_act1_scrap_ooze/reach_inside': return [fx('lose-hp', { amount: 1 }), roll({
      1: [fx('nothing', { filter: 'repeat-or-leave' })], 2: [fx('nothing', { filter: 'repeat-or-leave' })],
      3: [fx('gain-gold', { amount: 2 })], 4: [fx('gain-gold', { amount: 2 })],
      5: [fx('gain-relic')], 6: [fx('gain-relic')],
    })]
    case 'downfall_event_act1_scrap_ooze/leave': return [fx('nothing')]
    case 'downfall_event_act1_dead_adventurer/search': return [roll({
      1: [fx('combat', { room: 'encounter' })], 2: [fx('combat', { room: 'encounter' })],
      3: [fx('gain-gold', { amount: 2, target: 'each-player' })], 4: [fx('gain-gold', { amount: 2, target: 'each-player' })],
      5: [fx('gain-relic', { target: 'one-player' })], 6: [fx('gain-relic', { target: 'one-player' })],
    })]
    case 'downfall_event_act1_dead_adventurer/leave': return [fx('nothing')]
    case 'downfall_event_act2_masked_bandits/duel_pointy': return [fx('gain-relic'), fx('lose-hp', { amount: 3 })]
    case 'downfall_event_act2_masked_bandits/bribe_romeo': return [fx('upgrade-card'), fx('lose-gold', { amount: 'all' })]
    case 'downfall_event_act2_masked_bandits/hug_bear': return [fx('remove-card'), fx('lose-max-hp', { amount: 2 })]
    case 'downfall_event_act2_the_mausoleum/open_coffin': return [fx('gain-relic'), roll({ 1: [fx('gain-curse')], 2: [fx('gain-curse')], 3: [fx('gain-curse')] })]
    case 'downfall_event_act2_the_mausoleum/leave': return [fx('nothing')]
    case 'downfall_event_act2_forgotten_altar/offer': return [fx('lose-relic', { random: true }), fx('gain-relic')]
    case 'downfall_event_act2_forgotten_altar/sacrifice': return [fx('lose-hp', { amount: 2 })]
    case 'downfall_event_act2_forgotten_altar/desecrate': return [fx('gain-curse')]
    case 'downfall_event_act3_mysterious_sphere/open_sphere': return [fx('apply-vulnerable', { amount: 1, target: 'each-player', combatStart: true }), fx('combat', { room: 'encounter', combatReward: 'relic-each-player' })]
    case 'downfall_event_act3_mysterious_sphere/charge_in': return [fx('mode-shift', { target: 'each-player', combatStart: true }), fx('combat', { room: 'encounter' })]
    default: throw new Error(`missing executable Downfall event outcome: ${key}`)
  }
}

export const DOWNFALL_EVENTS: readonly DownfallEventDef[] = DOWNFALL_EVENT_SOURCE_ENTRIES.map((event) => ({
  ...event,
  id: `downfall_event_act${event.act}_${slug(event.title)}`,
  name: event.title,
  scope: eventScope(event),
  route: eventRoute(event),
  firstEventRedraw: [event.setup_text, event.routing_text].some((text) => text?.includes('If this is the first [event]')),
  choices: event.choices.map((choice) => ({ ...choice, id: slug(choice.label), effects: eventEffects(`downfall_event_act${event.act}_${slug(event.title)}`, choice.label) })),
  options: event.choices.length > 0
    ? event.choices.map((choice) => ({ id: slug(choice.label), label: choice.label, description: choice.outcome, effects: eventEffects(`downfall_event_act${event.act}_${slug(event.title)}`, choice.label) }))
    : [{
      id: eventRoute(event) === 'merchant' ? 'shop' : 'fight',
      label: eventRoute(event) === 'merchant' ? 'Shop' : 'Fight!',
      description: event.routing_text ?? '',
      effects: [fx(eventRoute(event) === 'merchant' ? 'merchant' : 'combat', eventRoute(event) === 'encounter' ? { room: 'encounter' } : {})],
    }],
}))

export const DOWNFALL_EVENTS_BY_ID: Readonly<Record<string, DownfallEventDef>> = Object.fromEntries(
  DOWNFALL_EVENTS.map((event) => [event.id, event]),
)

export type DownfallPhysicalEventCard = DownfallEventCardSource & {
  id: string
  eventId: string
  title: string
  act: DownfallEventAct
}

export const DOWNFALL_PHYSICAL_EVENT_CARDS: readonly DownfallPhysicalEventCard[] = DOWNFALL_EVENTS.flatMap((event) =>
  event.sources.map((source, copy) => ({
    ...source,
    id: `${event.id}_${copy + 1}`,
    eventId: event.id,
    title: event.title,
    act: event.act,
  })),
)

/** The physical cards used by the shared run event engine. */
export const DOWNFALL_EVENT_CARDS: readonly EventCard[] = DOWNFALL_PHYSICAL_EVENT_CARDS.map((physical) => {
  const event = DOWNFALL_EVENTS_BY_ID[physical.eventId]!
  return {
    id: event.id, name: event.name, scope: event.scope,
    prompt: event.flavor_text ?? event.setup_text ?? event.routing_text,
    options: event.options, rule: event.setup_text ?? event.routing_text,
    instanceId: physical.id, act: physical.act, minAscension: 3,
    requiresColorlessUnlock: false, firstEventRedraw: event.firstEventRedraw,
  }
})

export const DOWNFALL_EVENT_DECKS: Readonly<Record<DownfallEventAct, readonly string[]>> = {
  1: DOWNFALL_PHYSICAL_EVENT_CARDS.filter((card) => card.act === 1).map((card) => card.id),
  2: DOWNFALL_PHYSICAL_EVENT_CARDS.filter((card) => card.act === 2).map((card) => card.id),
  3: DOWNFALL_PHYSICAL_EVENT_CARDS.filter((card) => card.act === 3).map((card) => card.id),
}

export type DownfallEventResolution =
  | { kind: 'redraw'; discard: true; drawAgain: true }
  | { kind: 'route'; room: Exclude<DownfallEventRoute, null> }
  | { kind: 'choose'; scope: Exclude<DownfallEventScope, 'automatic'>; choices: DownfallEventDef['choices'] }

/** First-Event redraw text resolves before routing or printed choices. */
export function resolveDownfallEventCard(event: DownfallEventDef, isFirstEvent: boolean): DownfallEventResolution {
  if (isFirstEvent && event.firstEventRedraw) return { kind: 'redraw', discard: true, drawAgain: true }
  if (event.route !== null) return { kind: 'route', room: event.route }
  return { kind: 'choose', scope: event.scope === 'automatic' ? 'party' : event.scope, choices: event.choices }
}

export function downfallEventByCardId(cardId: number): DownfallEventDef | undefined {
  const physical = DOWNFALL_PHYSICAL_EVENT_CARDS.find((card) => card.card_id === cardId)
  return physical ? DOWNFALL_EVENTS_BY_ID[physical.eventId] : undefined
}
