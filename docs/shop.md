# The Shop: coins, wallet and card packs

The Shop sells the five packs of **The Slayer Pack** (`docs/slayer-pack.md`) for coins that
boss victories pay. It is reached from **Shop** on the main menu and from the coin purse, the
first item of the menu's top-right corner (purse, Leaderboard, Stats, Mail, Profile, Settings).
It has two sections: **Card Packs** and **Skins** (a locked "Coming soon" showcase with no
function yet).

| Piece | Where |
|---|---|
| Coin ranges, rolls, pack price | `src/game/coins.ts` (`verify-coins.mjs`) |
| Pack catalogue | `src/game/packs.ts` |
| Wallet rules (pure) | `src/wallet.ts` (`verify-wallet.mjs`) |
| Wallet storage | `src/wallet-storage.ts`, hook `src/ui/useWallet.ts` |
| Boss awards in a run | `resolveCombat` in `src/game/run/rooms.ts` (`verify-boss-coins.mjs`) |
| Packs in runs | `createRun` / `beginCatchUp` (`verify-meta-run.mjs`) |
| Online packs and coins | `scripts/lib/rooms.mjs`, `OnlineGame.tsx` (`verify-rooms.mjs`, `verify-room-server.mjs`) |
| Screen | `src/ui/ShopScreen.tsx`, `src/ui/styles/shop.css`, `src/ui/Coins.tsx` (`verify-shop-browser.mjs`) |

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

## The wallet

The wallet belongs to the signed-in account. It is stored in `localStorage` under
`sts-wallet:<username>` (the name normalised like the server compares names), and under
`sts-wallet` while nobody is signed in. The first time an account has no wallet, it adopts the
anonymous one by moving it (the anonymous key is cleared), so a second account on the same
browser starts empty and never inherits another account's coins or packs. The purse follows
logging in and out in this tab and in other tabs (`onProfileChange`, `storage`).

```json
{ "version": 1, "coins": 1284, "packs": ["slayer_silent"], "addPacksToRuns": true,
  "credited": { "solo:campaign-7:123456:3f0c…": 2, "online:K7QW2D:campaign-3": 1 } }
```

* `coins` — the balance (whole number, 0 to 100,000,000).
* `packs` — owned pack ids, always in catalogue order.
* `addPacksToRuns` — the switch below (default `true`).
* `credited` — the idempotency ledger: run key → how many of that run's awards are paid.

Everything read from storage is validated field by field (`parseWallet`): a wrong version or
unreadable JSON is the empty wallet; otherwise a bad balance becomes 0, unknown or duplicate
pack ids are dropped, a non-boolean switch is `true`, and invalid ledger entries are dropped,
without losing the other fields. Reads and writes never throw: if storage refuses a write the
newer wallet stays in memory for this tab (and the next successful write carries it). Every
change is a read-modify-write of the stored wallet, so a purchase in one tab and a boss credit
in another cannot overwrite each other; open tabs follow changes through the `storage` event.

**Buying** (`buyPack`) refuses unknown ids, owned packs and balances below the price; a refusal
returns the wallet unchanged. The screen asks for confirmation first and re-checks against the
stored wallet when confirmed (another tab may have spent the coins).

### The idempotency ledger

`creditBossCoins(wallet, runKey, awards, joinedAfter)` pays the awards from index
`max(paid, joinedAfter)` on and records `awards.length` as paid. Crediting the same awards again
pays nothing and returns the same wallet object, so nothing is written. This is what keeps
reloads, a resumed solo run, online reconnects, repeated snapshots and React re-renders from
paying a boss twice.

* **Solo key** — `solo:<runId>:<seed>:<nonce>`. App draws the nonce when a run is *started*
  and saves it with the run (`BuiltRun.coinKey`), so resuming the same attempt keeps the key
  while a new attempt on a reused seed is a new run. Saves from before the Shop use
  `solo:<runId>:<seed>`.
* **Online key** — `online:<room code>:<runId>`. Run ids are unique within a room; room codes
  are unique while the room lives.
* The ledger keeps the 64 most recently paid runs. A run that falls out of it has long
  finished (a finished run's awards never grow), so this bounds storage without re-paying.

**Once per browser.** Every payment is also written to a browser-wide record, `sts-paid-runs`
(`PAID_RUNS_KEY`): run key → awards paid, the 256 most recent runs (`MAX_PAID_RUNS`), validated
on read. `creditOncePerBrowser` checks it in the same read-modify-write as the wallet, so a run
paid to one account can never be claimed by another account on this browser — not by switching
account and recording the same run again, nor from a second tab still showing the unrecorded
victory. If storage refuses the write, the tab keeps the record in memory until a write succeeds.
The per-wallet `credited` ledger stays: it travels with the wallet (an account adopting the
anonymous wallet keeps its history) and covers wallets paid before the browser record existed.

**Coins are paid only when the run's result is recorded.** A boss victory rolls and stores its
award in `run.campaign.bossCoins` at once, but no wallet changes then: the award is *pending*.
The coins are credited when the player records the result — **Stop and record result** after a
victory, **Record campaign result** after a defeat (`recordRunResult` in `App.tsx`, the same
action that records the leaderboard result). A run abandoned, discarded, replaced by a new run,
given up and never recorded, or merely resumed or reloaded pays nothing; a recorded run pays
once, also after a reload (the ledger, and the saved `recordRunId`). **Replays and the tutorial
never credit**, and a Daily Climb has no awards. The solo/hot-seat device has one wallet.

**A run pays the account that started it.** A solo run records its owner (`BuiltRun.owner`, the
wallet key signed in at its start). If another account signs in — in this tab or another — the
open run is left, its save is never rewritten for the new account nor offered to it, and a
record of it pays nothing (the player is told why). Online, a seat pays only the account that
took the seat in that tab. That owner is remembered in `sessionStorage` under the seat's token
(`claimSeatOwner`), not its player id: rejoining a room reuses ids (p1..p4), so a different account
taking the same id later is a new seat and pays its own account, while the same seat after a
reload with another account signed in stays foreign. The token never leaves `useRoomSession`,
which exposes only `seatOwnsCoins`.

Online, the party's record button sends `finishRun`, which finalizes the run; every client then
credits its own wallet once from the finalized run in its snapshot, skipping the bosses beaten
before its hero joined (`campaign.joinedAfterBosses`, sent only for the viewer's own hero, mapped
to a position in the awards by `catchUpAwardIndex`). A seat that was away when the run was
recorded is paid on its next snapshot of the finalized run, or — once the party is back in the
lobby — from the room's `recordedRuns` (the last 8 recorded runs' awards and that seat's
offsets, keyed by seat token and sent only to seats that played them).

Feedback: each boss shows a dashed "+N coins pending" toast (with "Boss bounty · claimed when you record the run (X to claim)" under it);
recording shows "+N coins · Run recorded · X in your purse". The victory and defeat summaries
show **Coins to claim** (with "record the run to claim") until the run is recorded; online they show nothing to claim to a seat that will not be paid (another account's seat, or a run this browser already paid). The main-menu
purse and the Shop balance change only when coins are credited.

### Coins for runs recorded before the Shop

Accounts that played before the Shop get coins for the runs they already recorded
(`scripts/lib/coin-grants.mjs`, verified by `verify-coin-grants.mjs`). The room server stores
`coinsLaunchedAt` the first time a server with the Shop starts; only runs recorded **before** it
count (later runs pay in game when recorded, so nothing is paid twice). For each account, every
non-Daily run on the leaderboard that names it — its solo runs (`username`) and its seats in co-op
runs (`winningDecks[].username`; online seats carry the account name) — pays the bosses it beat:
each Act from its starting Act to `highestBossActDefeated`, and at Ascension 13 the Act III boss
twice (a run marks Act III beaten only after both A13 Act III bosses fell). A Mind Bloom boss, and
the first A13 Act III boss of a run that then fell, are not on the leaderboard and are not paid.
Each boss is rolled with `rollBossCoins` at the run's Ascension from a seed made of the
account name and the run id, so the result is the same on every restart and device. Names
compare like the profile registry (NFKC, case-insensitive). Anonymous players and accounts
without such runs get nothing.

**Deploy order.** `coinsLaunchedAt` is set when the first Shop-enabled room server starts
(`createStore`, persisted with the store), so deploy and restart the room server **before**
publishing the Pages client. In the other order, runs recorded in the gap pay twice: the new
client credits them in game, and the legacy grant pays them again because they predate the
cutoff. In a server-first gap, cached old clients record runs that are never paid.

A grant is computed the first time its account asks and then stored and frozen
(`coinGrants` in the room store): later leaderboard edits never change it. Claiming is
two-phase. Builds that talk to a room server (the hosted game, or `VITE_MAIL`/`VITE_COIN_GRANTS`
set locally) ask; others never do, so no request fails. An unknown or stale token gets
`{ coins: 0 }` with a 200, never an error. On load and on every log in/registration the client
(`src/legacy-coins.ts`) stores a
claim id, asks `POST /api/profile/coins {token, claimId}` (which reserves the grant for that
claim id), pays `sts-wallet:<username>` under the ledger key `legacy:<username>`, and then
confirms with `POST /api/profile/coins/confirm {token, claimId, grantId}`. A lost answer is
retried with the same claim id and never pays twice; another browser or device gets 0 while the
grant is reserved, and every claim after the confirmation gets 0. Failures are silent and retried
on the next visit. The credit shows a "+N coins · Your past runs" toast.

The wallet lives in the browser, so the grant lands in the **first browser that claims it** and
nowhere else; a later browser, a private window that is closed, or cleared storage cannot get it
back. To limit that, a browser that cannot keep what it writes (blocked or full storage, tested
with a probe write) never claims, the claim id is stored before asking, and the grant is confirmed
spent only after the wallet write is read back from storage; until then the reservation stays with
that browser and its next visit pays and confirms it. Private windows are not detected.

Known simplification: a co-op seat that joined by Catch Up is paid every boss of the run, because
the leaderboard does not record when a seat joined.

Rolling the room server back to a release from before the Shop drops `coinsLaunchedAt` and
`coinGrants` on its next save (older servers do not write them); a later upgrade would then set a
new cutoff and recompute unclaimed grants, so avoid such a rollback once grants are being claimed.

To inspect the grants before deploying (names and amounts only, no tokens):

```sh
node --experimental-strip-types scripts/coin-grants-report.mjs --store .rooms/rooms.json [--cutoff <ISO date>]
```

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
the phone rules in `shop.css` enlarge type and tap targets rather than rearranging). Each
pack is a display case lit in its hero's colour with three of its real card scans fanned on
top, its card count, tagline (desktop), price and **Buy** / disabled **Not enough coins**
(with "Need N more") / **Owned**, plus **Browse cards**: every card of the pack, with an
Upgrades toggle, and a click opens both faces side by side at full size (the Compendium's scan
component). Purchases are confirmed in a dialog, then celebrated with the cards fanning open
and the `magic` sound. Keyboard: the section tabs use arrow keys; Escape closes the topmost
dialog, then leaves the Shop. Reduced motion (OS or the game's setting) turns the animations
off. In the Compendium, pack cards carry a small "Slayer Pack" badge and name their pack in
the card's accessible name and zoom.

WebMCP needs no special tool: the Shop's buttons, tabs and dialogs are ordinary labelled
controls that `inspect_game` lists and `interact_with_game` presses.
