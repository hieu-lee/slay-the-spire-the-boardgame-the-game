# Downfall public implementation scope

This implementation is pinned to the official public Tabletop Simulator playtest save and its `v1.47` rulebook. The public prototype is the only official source that exposes complete card faces and object metadata; the campaign page describes the planned manufactured box but does not publish every final face.

Primary sources:

- [Contention Games' Downfall campaign](https://gamefound.com/en/projects/contention-games/slay-the-spire-the-board-game---downfall)
- [Official Downfall public-playtest Tabletop Simulator mod](https://steamcommunity.com/sharedfiles/filedetails/?id=3687082014)
- `tmp/downfall-reference/reference-2.pdf` and `tmp/downfall-reference/downfall-workshop.json` during the audit (research inputs are intentionally ignored, not shipped)

## Public-source boundary

The campaign currently advertises 4 minis, 400 sleeves, and 496 cards: 85 cards for each character, 24 Gems, 12 Events, 24 Summons, 29 Bosses, 20 Relics, 12 Potions, 7 Boss Relics, 10 Colorless cards, 20 Heart's Boons, and 12 dividers. Those category numbers total 510 including dividers, or 498 excluding them, so they do not reconcile to the advertised 496-card total.

The `v1.47` prototype rulebook instead inventories 365 player cards, 89 Summons, 17 Events, 12 Boss cards (27 with unlocks), 14 Heart's Boons (20 with unlocks), 24 Gems, 17 Relics, 15 Potions, 8 Boss Relics, and 14 Colorless cards. The decoded TTS object graph also contains Golden Tickets and repeated sheet cells that do not map one-to-one onto either marketing count.

The executable implementation therefore follows the exact public `v1.47` faces, rules, GUIDs, CardIDs, sheet positions, and deck objects. Verification separately records the campaign-page counts and fails if a public prototype object is silently dropped. It does not invent unpublished final card text to force the two inventories to agree.

## Character visuals

The Slime Boss, Guardian, Hexaghost, and Hermit silhouettes were checked against the public PC Downfall mod character art. Image-generation produced higher-resolution idle, ready, impact, rear campfire, and standing merchant poses in the existing game's cutout style. Hexaghost combat now uses seven countable Heat cutouts (0–6 flames), matching attack animations, and a generated green-flame Soulburn button instead of a duplicate text chip. `scripts/prepare-transparent-asset.py` removes baked neutral backgrounds, resizes in premultiplied alpha, and rejects outputs without a real transparent background.

The evil Ironclad, Silent, Defect, Watcher, Neow, Corrupted Heart, Dark Core, Demon, and Spire Shield are not derived from the playable hero cutouts. Their source textures were extracted from the PC Downfall distribution ([Steam app 1865780](https://store.steampowered.com/app/1865780/Downfall__A_Slay_the_Spire_Fan_Expansion/); legacy Workshop item `1610056683`) into the ignored audit directory `tmp/downfall-reference/pc-enemies/`. The four evil-hero raw extracts are `ironclad.png`, `silent.png`, `defect.png`, and `watcher.png`; normalized cutouts and key-frame composites are under `processed/`. The committed `downfall_pc_*` WebPs are optimized runtime derivatives of those extracts. No license grant is asserted: the underlying art remains the property of the PC mod's artists and respective rights holders.

Boss attack frame 2 is composed for a boss standing on the right and striking toward players on the left. Watcher's five key poses were generated from the canonical PC boss reference with `gpt-image-2` and native transparent output, cross-checked for body/staff continuity, then normalized against one shared camera so body scale does not change with staff reach. She raises the complete double-ended staff, swings its orb end down toward the players, and then calls the existing meteor from upper-right to lower-left; the impact layer starts only when the meteor reaches the target. The asset verifier checks direction geometry and perceptual separation from each playable hero, so resizing or re-encoding playable character art cannot satisfy the evil-boss requirement.

Slay the Spire and its characters belong to Mega Crit. The board-game adaptation and Downfall expansion are by Contention Games; the original PC Downfall mod is by Table 9 Studio and its contributors. This repository remains an unofficial fan implementation.
