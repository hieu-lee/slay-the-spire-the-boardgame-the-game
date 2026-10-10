# The Shop: coins, wallet, card packs and skins

The Shop sells the five packs of **The Slayer Pack** (`docs/slayer-pack.md`) and the hero
skins (`src/game/skins.ts`) for coins that boss victories pay. It is reached from **Shop** on the main menu and from the coin purse, the
first item of the menu's top-right corner (purse, Leaderboard, Stats, Mail, Profile, Settings).
It has two sections: **Card Packs** and **Skins**.

| Piece | Where |
|---|---|
| Coin ranges, rolls, pack price | `src/game/coins.ts` (`verify-coins.mjs`) |
| Pack catalogue | `src/game/packs.ts` |
| Skin catalogue and prices | `src/game/skins.ts`, `SKIN_PRICES` in `src/game/coins.ts` |
| Which skin is worn | `src/skin-preference.ts` (`verify-wallet.mjs`, `verify-skin-profile-browser.mjs`) |
| Wallet rules (pure) | `src/wallet.ts` (`verify-wallet.mjs`) |
| Wallet storage | `src/wallet-storage.ts`, hook `src/ui/useWallet.ts` |
| Boss awards in a run | `resolveCombat` in `src/game/run/rooms.ts` (`verify-boss-coins.mjs`) |
| Packs in runs | `createRun` / `beginCatchUp` (`verify-meta-run.mjs`) |
| Online packs and coins | `scripts/lib/rooms.mjs`, `OnlineGame.tsx` (`verify-rooms.mjs`, `verify-room-server.mjs`) |
| Screen | `src/ui/ShopScreen.tsx`, `src/ui/styles/shop.css`, `src/ui/Coins.tsx` (`verify-shop-browser.mjs`, `verify-wallet-sync-browser.mjs`) |

## Earning coins

Every boss defeated (each Act boss, both Ascension 13 Act III bosses, a Mind Bloom boss) appends
one award `{ act, coins }` to `RunState.campaign.bossCoins`. The coins are a uniform whole
number in the range of the **Act of the boss defeated** at the run's Ascension: a room boss is
its Act's boss, while an event boss (Mind Bloom's "War" summons an Act I boss in Act III) pays
as the Act whose base or Downfall boss roster holds it, falling back to the current Act for a
boss in no roster. The roll is seeded from
`(run seed, award number, act, ascension)` with its own RNG, so it never advances the run's
RNG (existing seeds, saves and replays are unchanged) and a resumed or replayed run holds the
same coins. A Daily Climb records no awards. One award is shared by the whole party; every
player is owed it in full.

| Ascension | Act I | Act II | Act III | Act IV | Expected from Acts I-III (sum of averages) |
|---|---|---|---|---|---|
| A0 | 8–12 | 16–24 | 24–36 | 40–60 | 60 |
| A1 | 9–14 | 18–28 | 28–41 | 46–69 | 69 |
| A2 | 10–16 | 21–31 | 31–47 | 52–78 | 78 |
| A3 | 12–18 | 24–36 | 36–54 | 60–90 | 90 |
| A4 | 14–21 | 28–42 | 42–63 | 70–105 | 105 |
| A5 | 16–24 | 32–48 | 48–72 | 80–120 | 120 |
| A6 | 20–30 | 40–60 | 60–90 | 100–150 | 150 |
| A7 | 26–39 | 52–78 | 78–117 | 130–195 | 195 |
| A8 | 32–48 | 64–96 | 96–144 | 160–240 | 240 |
| A9 | 48–72 | 96–144 | 144–216 | 240–360 | 360 |
| A10 | 64–96 | 128–192 | 192–288 | 320–480 | 480 |
| A11 | 64–96 | 128–192 | 192–288 | 360–540 | 480 |
| A12 | 80–120 | 160–240 | 240–360 | 440–660 | 600 |
| A13 | 80–120 | 160–240 | 240–360 | 480–720 | 600 |

Design rules (all asserted by `verify-coins.mjs`): Act I < II < III < IV on average at every
Ascension; on average A5 pays twice A0, A8 twice A5, A10 twice A8; every Ascension pays more
than the one below except A11 and A13 for Acts I-III (those levels add Elite and Act IV
difficulty, so only the Act IV boss pays more; A13 also has a second paid Act III boss).

**Price.** A pack costs `CARD_PACK_PRICE` = 2 × the expected coins of beating the Act I, II and
III bosses at A10 = 2 × (80 + 160 + 240) = **960 coins**. Expectations at a glance: about 16
Act I-III wins at A0, 8 at A5, 4 at A8, or 2 at A10 (fewer with Act IV and A13's second boss).

**Skin price.** Every skin costs `SKIN_PRICE` = **2,500 coins** (`SKIN_PRICES` is the per-skin
catalogue, so a future skin may cost more; `Record<SkinId, number>` makes `tsc -b` fail until a
new skin has a price).

## The wallet

Hosted coin balances, owned packs and owned skins belong to the authenticated account and are saved
on the room server with its persistent profile. Desktop and phone share the same wallet.
`POST /api/profile/wallet` reads it, imports an older browser wallet once, submits pending
recorded-run credits, or buys a pack (`{ pack }`) or a skin (`{ skin }`), one purchase per request. Replies acknowledge mutations only after the server
store is saved; a failed save returns 503 and a retry is safe.

The browser keeps `sts-wallet:<username>` as a local cache (names are NFKC-normalised,
trimmed and case-insensitive). `sts-wallet:<username>:sync` holds a migration id and
pending credits. On load, login, reconnect, focus, and every 15 seconds while visible,
the client refreshes the cache. A reply for an account that signed out is discarded;
a run recorded while a refresh is in flight remains pending and visible until its
next acknowledgement. Offline recorded-run credits survive reloads when storage works.
Account purchases require the server and use its latest balance, so concurrent devices
cannot overspend; retrying a bought pack or skin never charges again. Anonymous and standalone
builds continue using the local wallet and its browser-wide `sts-paid-runs` record.

The wallet stores `skins: SkinId[]` beside `packs` (catalogue order, validated like packs;
a wallet saved before skins parses to none, so `version` stays 1). A skin purchase refuses with
the pack reasons (`unknown`, `owned`, `insufficient`), and the server treats `owned` on a retry
as success. Owning a skin is separate from wearing it: the worn skin is a per-device,
per-account preference (`sts-skins:<username>`, set in the Shop or Profile) that only ever
reads back skins the wallet owns, so a stored choice for an unowned skin reads as Default and
the next write drops it.

Older browser wallets migrate their packs, skins and lifetime earnings (coins plus the price
of owned packs and skins, `spentCoins`). The server unions packs and skins and takes the higher earnings rather than
adding device balances, because old devices can contain the same legacy grant. Each
migration id is remembered, so stale retries never restore spent money. This conservatively
merges pre-sync wallets: separate earnings accumulated on multiple old devices cannot be
summed reliably because those saves contain award counts, not each payment's amount.
New recorded-run payments sync individually and do accumulate across devices. The server
retains their paid-award counts without the browser ledger's 64-run eviction.

### Recorded-run coins and ownership

Boss victories append pending awards to `run.campaign.bossCoins`. Coins pay only when
the result is recorded: **Stop and record result** after victory, or **Record campaign
result** after defeat. Abandoning a run pays nothing; replays, tutorials, and Daily Climbs
pay nothing. Solo keys include the run id, seed, and start nonce; online keys include
room code and run id. Server credits are idempotent by run key and award count.

A run pays the account that started it. Solo saves carry the wallet owner. Online seat
owners are remembered by seat token in sessionStorage; changing accounts never inherits
an old seat's payout. Catch Up skips awards before the hero joined. Disconnected seats
can claim finalized awards after reconnecting, including the room's recent recorded runs.
Browser-wide paid-run records continue preventing an account switch from paying the same
local run to a second wallet.

### Coins for runs recorded before the Shop

The frozen legacy grant (`scripts/lib/coin-grants.mjs`) seeds the server wallet, including
when a browser already claimed it. It is based on non-Daily leaderboard runs recorded
strictly before `coinsLaunchedAt`, and includes named co-op seats. Every defeated Act boss
pays its deterministic Ascension bounty; A13 Act III pays twice. The leaderboard cannot
recover Mind Bloom bosses, a lone first A13 Act III boss, or Catch Up offsets.

The Shop server must deploy before its client to preserve the original cutoff. The old
`/api/profile/coins` claim/confirm protocol remains available for cached clients, but a
grant moved into the account wallet is marked claimed so those clients cannot claim it
again. Avoid rolling back to a pre-Shop server: it does not preserve grant metadata.
The read-only `scripts/coin-grants-report.mjs --store <file>` report prints names and
amounts, never credentials.

## Packs in runs

A bought pack's cards join the reward decks of every new run: an owner pack (Ironclad, Silent,
Defect, Watcher) joins that hero's card and rare reward decks — or that hero's Prismatic supply
when the hero is not in the party — and the Colorless pack joins the Colorless supply, even
before the campaign's Colorless unlock. Without the unlock the pack works at every Colorless
source: the Merchant's Colorless shelf (which offers only pack cards there, never the locked
base cards a modifier such as All Star put in the pile), the Colorless Neow cards and Events
such as Sensory Stone (dealt as if unlocked), and Colorless card rewards. A run without packs
is unchanged. The run records its packs in `run.meta.cardPacks`
(absent when there are none, so a run without packs is byte-identical to one from before the
Shop).

* Solo: every Standard and Custom start (including Quick Start) passes
  `cardPacks: enabledCardPacks(wallet)`; a saved run resumes with the packs it started with;
  run logs record and validate them, and replays rebuild from the log. The **tutorial** and
  the **Daily Climb** never use packs (the engine ignores packs on a Daily Climb).
* Online: the room plays the union of the packs of its seated players, frozen at start. See
  [online-play.md](online-play.md#shop-packs-and-coins-at-the-table).

### The add-packs-to-runs switch

`enabledCardPacks(wallet)` is the owned packs when `addPacksToRuns` is on and none when it is
off; `setAddPacksToRuns(wallet, enabled)` changes it. It defaults to on and is deliberately
**not exposed** in any menu or setting yet — it exists so a later version can let players
choose. Turning it off keeps ownership; the Shop still shows the packs as owned.

## The screen

Desktop and horizontal phones only (phones lay out on a 1280+×720 viewport and scale it, so
the phone rules in `shop.css` enlarge type and tap targets rather than rearranging). The
shelf is set inside the merchant's tent (the in-run Merchant backdrop), with the seated
merchant at the foot of the rail, and leans on icons rather than words: the tabs carry
painted icons, and each pack is a display case lit in its hero's colour, crowned by the
hero's Compendium emblem, with three of its real card scans fanned out, its card count
beside a deck icon (part of the fan's accessible name), and the hero's name. Its one button is the price: **Buy** (coin and
960), disabled with a gauge filling toward the price when the purse is short (its accessible
name says how many coins are missing), or a green **Owned** plate with a wax seal. Pressing
the fan (marked with a magnifying glass) browses every card of the pack, with an Upgrades
toggle, and a click opens both faces side by side at full size (the Compendium's scan
component). Purchases are confirmed in a dialog showing the purse before and after, then
celebrated with the cards fanning open, the seal stamping down and the `magic` sound.
Keyboard: the section tabs use arrow keys; Escape closes the topmost dialog, then leaves the
Shop. Reduced motion (OS or the game's setting) turns the animations off. In the Compendium,
pack cards carry a small "Slayer Pack" badge and name their pack in the card's accessible
name and zoom.

**Skins tab.** One rack per skin in `skins.ts` (so a new skin appears on its own), lit in its
hero's colour: the skin's character-select portrait, its name over the hero it belongs to, and
its one button. Unowned, the button is the price (2,500 with the coin icon), disabled with the
same gauge as a pack when the purse is short, and **Buy** opens the same confirm dialog with the
portrait; owned, the rack carries the wax seal and a **Wear / Worn** toggle (`aria-pressed`)
that sets the preference in one tap. Buying a skin wears it at once unless its hero already
wears another skin. The heroes without a skin keep a locked "Coming soon" rack. Profile's
Skins tab lists Default plus the owned skins; an unowned skin is a locked tile with its price
that opens this tab.

The Shop's painted icons (`public/assets/shop/`) were generated with `gpt-image-2.5-sunburst`
using the menu icons as style references; prompts are in
`scripts/animation/sources/shop-icons/` and hashes in `docs/shop-icons.json`.

WebMCP needs no special tool: the Shop's buttons, tabs and dialogs are ordinary labelled
controls that `inspect_game` lists and `interact_with_game` presses.
