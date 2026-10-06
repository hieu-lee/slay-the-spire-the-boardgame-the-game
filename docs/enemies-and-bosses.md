# Enemy and boss completion ledger

The authoritative values are transcribed from the physical enemy, elite,
summon, boss, and Ascension cards. The local reviewer pack in
`docs/reference/` contains the official publisher rulebook and the downloaded
enemy/elite/summon scans used for the August 2026 audit. Video-game values are
not used.

## Opening Red Louse reward source

The opening Red Louse (3 HP, summoning one Green Louse) awards **1 Gold and
one normal Card Reward**, not Gold alone. The summon adds no rewards.

Source: the [official base-game Tabletop Simulator mod](https://steamcommunity.com/sharedfiles/filedetails/?id=2884027954),
opening deck GUID `e21cbf`, card ID `313500` (sheet `3135`, zero-based cell `0`).
The [original Act I card sheet](https://steamusercontent-a.akamaihd.net/ugc/2098170267433236144/539C190A8A6F688B51F13DA9B181E65D09A193D2/)
is a 10-column, 3-row grid; its top-left card shows both the `1` Gold icon and
the Card Reward scroll icon. The mod's `starter_enemy_reward_list` independently
lists Red Louse as `{"Gold_1", "Card"}`. Audited 2026-10-05.

Regression: `node --experimental-strip-types scripts/verify-opening-louse-browser.mjs`
plays the dealt opening fight, claims Gold, reloads, and adds the card on desktop
and horizontal phone. Screenshots and state evidence are saved under
`artifacts/opening-louse-browser/`.

## Completed physical sets

- Act I: all encounter variants; Gremlin Nob, Lagavulin, and Sentries; Slime
  Boss, The Guardian's two modes, and Hexaghost.
- Act II: all encounter variants; Book of Stabbing, Gremlin Leader, and
  Taskmaster; The Collector and eight Torch Heads, The Champ and Fury Mode,
  Bronze Automaton and all four Bronze Orb die rows.
- Act III: all encounter variants; Reptomancer and Daggers, Nemesis, and Giant
  Head; Awakened One's two phases and eight Cultists, Time Eater, Donu and Deca.
- Act IV: Corrupt Heart with Invincible and Beat of Death; Ascension 11 first
  adds Spire Shield and Spire Spear with per-player Facing.

## Campaign and Ascension integration

- Boss decks are selected per act; Ascension 10 uses the harder printed boss
  rows, Ascension 11 uses the harder Heart and Act IV elite, and Ascension 13
  fights a second distinct Act III boss after defeating the first. Both must be
  defeated for Act III win credit; losing to the second retains marks for the
  first defeated boss but does not count as a leaderboard win.
- Summons come from finite shuffled physical supplies and keep authoritative
  left-to-right acting order. Split and Awakened One use their printed delayed
  arrival timing.
- Act I-II bosses give every player 3 Gold (2 at Ascension 10+) and a Rare
  Reward, then reveal player count plus one Boss Relics (three solo) from
  the complete 20-card physical deck as one shared face-up draft. Act III boss
  cards print no rewards.
- The Ascension 11 Spire Shield/Spear elite gives every player an upgraded Card
  Reward plus the shared Elite Relic before the Heart.
- Defeating the Corrupt Heart is terminal: it grants no Boss Relic draft and
  cannot advance to a synthetic Act V.

## Spawn-count audit (1–4 players)

- Encounters draw one main card per player; every printed summon stays in that
  main enemy's row. The complete encounter deck matches its printed summon bars.
- Sentries total `3n` enemies. Gremlin Leader, Taskmaster, and Reptomancer total
  `1 + 2n`. Other elites total one, except Act IV's fixed Shield + Spear pair.
- Bronze Automaton starts with `n` Orbs; Awakened One with `2n` Cultists; Slime
  Boss Split creates `3n` Slimes; Collector fills toward `2n` Torch Heads; Donu
  always adds one Deca. Other bosses add no start-of-combat enemies.
