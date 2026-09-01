// Exact public-v1.47 Downfall item inventory, transcribed from the official TTS sheets.
// The literal manifest is authoritative; executable helpers follow the inventory.
import type { CardDef, Effect, TargetScope } from '../cards.ts'
import type { PotionDef, RelicDef } from '../relics.ts'
import type { Trigger } from '../triggers.ts'

export const DOWNFALL_ITEMS_MANIFEST = {
  "schemaVersion": 1,
  "source": {
    "label": "Downfall board-game expansion public TTS v1.47",
    "save": "/tmp/downfall-research.LNtS6K/WorkshopUpload",
    "method": "DeckIDs/CustomDeck mappings decoded from the official save; every occupied front was checked against a per-cell crop of the downloaded full-resolution sheet.",
    "iconNotation": {
      "[damage]": "red sword damage icon",
      "[block]": "blue shield block icon",
      "[energy]": "orange energy icon",
      "[strength]": "yellow flexed-arm Strength icon",
      "[weak]": "crossed-swords Weak icon",
      "[vulnerable]": "broken-heart Vulnerable icon",
      "[potion]": "potion icon",
      "[relic]": "treasure-chest relic icon",
      "[dazed]": "purple spiral Dazed icon",
      "[slimed]": "green spiral Slimed icon",
      "[burn]": "flame Burn icon",
      "[card-reward]": "gray card-reward icon",
      "[yellow-card-reward]": "yellow card-reward icon; the sheet does not print a glossary label",
      "[up-arrow-card-reward]": "gray card with upward arrow icon; the sheet does not print a glossary label"
    },
    "ambiguities": [
      "The source prints several mechanics solely as icons. Bracketed tokens preserve the visible icon's established board-game meaning; where the sheet itself does not spell out a reward-deck icon, its literal visual identity is retained rather than replaced with a PC-mod term.",
      "The relic sheet's '?' room on Ssserpent Head and the Heart's Boon reward-card icons are intentionally preserved literally.",
      "No rarity label is printed on colorless fronts. Their pool is therefore recorded as colorless, not an inferred common/uncommon/rare tier."
    ]
  },
  "sheets": [
    {
      "pool": "relic",
      "guid": "0f8234",
      "deckPrefix": 4663,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/11200880463290873692/FF636525E0EE46603F0F5019CB16F5AF15CC9F99/",
      "occupiedIndices": "0-57",
      "physicalCards": 58
    },
    {
      "pool": "potion",
      "guid": "72a869",
      "deckPrefix": 4664,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/14440857101538639601/87FA2E3ED550CF0953A6DC70C16FEC01A1EE7DB9/",
      "occupiedIndices": "0-43",
      "physicalCards": 44
    },
    {
      "pool": "colorless",
      "guid": "7f7cc9",
      "deckPrefix": 4670,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/10226011417834792627/60EC6C4398619AC8590F8D66C09434B5D0E5CB36/",
      "occupiedIndices": "0-37",
      "physicalCards": 38
    },
    {
      "pool": "boss-relic",
      "guid": "d6b384",
      "deckPrefix": 4674,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/14409824376083182334/2F46408573FC3F5A4E86903AA88EC34B3C8C9665/",
      "occupiedIndices": "0-26",
      "physicalCards": 27
    },
    {
      "pool": "colorless-upgrade",
      "guid": "80fcb6",
      "deckPrefix": 4684,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/16161141889428139353/D8E55B09C27F408C23A94804C9FE6339A3C85463/",
      "occupiedIndices": "0-37",
      "physicalCards": 38
    },
    {
      "pool": "heart-boon",
      "guid": "938861",
      "deckPrefix": 4384,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/15019999112916723016/2D61D4FAAD6C8EC543DDAF4753E4CE2D58D00526/",
      "occupiedIndices": "0-19",
      "physicalCards": 20
    },
    {
      "pool": "relic-supplement",
      "guid": "5b1766",
      "deckPrefix": 4710,
      "faceUrl": "https://steamusercontent-a.akamaihd.net/ugc/18172033859850535393/1D8E275D73DEA166A034784F017D2F01A45FE612/",
      "occupiedIndices": "0-16",
      "physicalCards": 17
    }
  ],
  "relics": [
    {
      "guid": "0f8234",
      "index": 0,
      "cardId": 466300,
      "name": "Blood Vial",
      "type": "relic",
      "pool": "relic",
      "text": "Start of combat: Heal 1 HP.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 1,
      "cardId": 466301,
      "name": "Lantern",
      "type": "relic",
      "pool": "relic",
      "text": "Start of combat: Gain [energy].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 2,
      "cardId": 466302,
      "name": "Bag of Preparation",
      "type": "relic",
      "pool": "relic",
      "text": "Start of combat: Draw 2 cards.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 3,
      "cardId": 466303,
      "name": "Anchor",
      "type": "relic",
      "pool": "relic",
      "text": "Start of combat: 2 [block].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 4,
      "cardId": 466304,
      "name": "Ninja Scroll",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: 1 [damage], 1 [damage], 1 [damage]. Treat each [damage] as a separate 0 cost Attack.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 5,
      "cardId": 466305,
      "name": "Mummified Hand",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Gain [energy] [energy] if you played a Power this turn.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 6,
      "cardId": 466306,
      "name": "Red Skull",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Gain [strength] if you shuffled your draw pile this combat.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 7,
      "cardId": 466307,
      "name": "Gambling Chip",
      "type": "relic",
      "pool": "relic",
      "text": "Once per room: Reroll the die.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 8,
      "cardId": 466308,
      "name": "Regal Pillow",
      "type": "relic",
      "pool": "relic",
      "text": "When you Rest: Heal +3 HP.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 9,
      "cardId": 466309,
      "name": "Mutagen",
      "type": "relic",
      "pool": "relic",
      "text": "Start of combat: Gain [strength]. Lose [strength] at end of turn.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 10,
      "cardId": 466310,
      "name": "Necronomicon",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1]: The next Attack you play this turn is played twice.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 11,
      "cardId": 466311,
      "name": "Dolly's Mirror",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1]: Trigger a die relic ability. Its owner gains the effect.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 12,
      "cardId": 466312,
      "name": "Horn Cleat",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1-2]: 1 [block].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 13,
      "cardId": 466313,
      "name": "Mercury Hourglass",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1-2]: Deal 1 damage to any row.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 14,
      "cardId": 466314,
      "name": "Charon's Ashes",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1-2]: You may Exhaust a card in your hand to deal 2 damage.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 15,
      "cardId": 466315,
      "name": "Vajra",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1]: Gain [strength]. Lose that [strength] at end of turn.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 16,
      "cardId": 466316,
      "name": "Sundial",
      "type": "relic",
      "pool": "relic",
      "text": "[die 2]: Gain [energy] [energy].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 17,
      "cardId": 466317,
      "name": "Pocketwatch",
      "type": "relic",
      "pool": "relic",
      "text": "[die 3]: Draw 3 cards.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 18,
      "cardId": 466318,
      "name": "Captain's Wheel",
      "type": "relic",
      "pool": "relic",
      "text": "[die 3]: 3 [block].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 19,
      "cardId": 466319,
      "name": "Nilry's Codex",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1]: Draw 1 card. [die 2]: Trigger a die relic ability. Its owner gains the effect.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 20,
      "cardId": 466320,
      "name": "Duality",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1]: 2 [block]. [die 2]: Deal 2 damage.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 21,
      "cardId": 466321,
      "name": "Happy Flower",
      "type": "relic",
      "pool": "relic",
      "text": "[die 2-3]: Gain [energy].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 22,
      "cardId": 466322,
      "name": "Stone Calendar",
      "type": "relic",
      "pool": "relic",
      "text": "[die 4]: Deal 4 damage.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 23,
      "cardId": 466323,
      "name": "Oddly Smooth Stone",
      "type": "relic",
      "pool": "relic",
      "text": "[die 4]: 2 [block] to any player.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 24,
      "cardId": 466324,
      "name": "Gremlin Horn",
      "type": "relic",
      "pool": "relic",
      "text": "[die 4]: Draw 1 card. [die 5]: Gain [energy].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 25,
      "cardId": 466325,
      "name": "Tungsten Rod",
      "type": "relic",
      "pool": "relic",
      "text": "[die 5]: 1 [block] to all players, 3 [block] instead if solo.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 26,
      "cardId": 466326,
      "name": "Pen Nib",
      "type": "relic",
      "pool": "relic",
      "text": "[die 5]: [vulnerable].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 27,
      "cardId": 466327,
      "name": "Ink Bottle",
      "type": "relic",
      "pool": "relic",
      "text": "[die 6]: Draw 1 card.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 28,
      "cardId": 466328,
      "name": "Red Mask",
      "type": "relic",
      "pool": "relic",
      "text": "[die 5-6]: [weak].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 29,
      "cardId": 466329,
      "name": "The Boot",
      "type": "relic",
      "pool": "relic",
      "text": "[die 1-3]: Deal 1 damage.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 30,
      "cardId": 466330,
      "name": "Incense Burner",
      "type": "relic",
      "pool": "relic",
      "text": "[die 6]: You can't lose more than 1 HP this round.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 31,
      "cardId": 466331,
      "name": "Peace Pipe",
      "type": "relic",
      "pool": "relic",
      "text": "When you Rest: You may also remove a card.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 32,
      "cardId": 466332,
      "name": "Strike Dummy",
      "type": "relic",
      "pool": "relic",
      "text": "Your starter Strikes deal +1 damage.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 33,
      "cardId": 466333,
      "name": "Bird-Faced Urn",
      "type": "relic",
      "pool": "relic",
      "text": "When you play a Power: 1 [block].",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 34,
      "cardId": 466334,
      "name": "Meat on the Bone",
      "type": "relic",
      "pool": "relic",
      "text": "End of combat: If you have less than 4 HP, your HP becomes 4.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 35,
      "cardId": 466335,
      "name": "The Abacus",
      "type": "relic",
      "pool": "relic",
      "text": "Once per room: +1 to the die result. (1 becomes 2.)",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 36,
      "cardId": 466336,
      "name": "Toolbox",
      "type": "relic",
      "pool": "relic",
      "text": "Once per room: -1 to the die result. (1 becomes 6.)",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 37,
      "cardId": 466337,
      "name": "Whetstone",
      "type": "relic",
      "pool": "relic",
      "text": "Upgrade a starter Strike and another Attack, then discard this item. Can't be used in combat.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 38,
      "cardId": 466338,
      "name": "War Paint",
      "type": "relic",
      "pool": "relic",
      "text": "Upgrade a starter Defend and another Skill, then discard this item. Can't be used in combat.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 39,
      "cardId": 466339,
      "name": "Old Coin",
      "type": "relic",
      "pool": "relic",
      "text": "Gain 10 gold, then discard this item. If this appears at The Merchant or The Courier, discard it and draw again.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 40,
      "cardId": 466340,
      "name": "Akabeko",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Gain [strength] for one Attack.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 41,
      "cardId": 466341,
      "name": "Centennial Puzzle",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Draw 3 cards if you lost HP this combat.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 42,
      "cardId": 466342,
      "name": "Blue Candle",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Exhaust up to 2 cards in your hand.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 43,
      "cardId": 466343,
      "name": "The Courier",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Look at the top card of the relic or potion deck. Buy it or discard it.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 44,
      "cardId": 466344,
      "name": "Orichalcum",
      "type": "relic",
      "pool": "relic",
      "text": "End of turn: 1 [block] if you don't have any Block.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 45,
      "cardId": 466345,
      "name": "Golden Eye",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Scry 3.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 46,
      "cardId": 466346,
      "name": "Ice Cream",
      "type": "relic",
      "pool": "relic",
      "text": "Start of turn: Gain your leftover Energy from last turn. (Max Energy is 6.)",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 47,
      "cardId": 466347,
      "name": "Ssserpent Head",
      "type": "relic",
      "pool": "relic",
      "text": "At ?: Gain 2 gold when you enter the room.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 48,
      "cardId": 466348,
      "name": "Golden Idol",
      "type": "relic",
      "pool": "relic",
      "text": "End of combat: Gain 1 gold.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 49,
      "cardId": 466349,
      "name": "Calipers",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Keep your leftover Block from last turn.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 50,
      "cardId": 466350,
      "name": "Dead Branch",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Draw 1 card for each card in your Exhaust pile.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 51,
      "cardId": 466351,
      "name": "Du-Vu Doll",
      "type": "relic",
      "pool": "relic",
      "text": "Gain [strength] when you draw a Curse. Lose that [strength] at end of turn.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 52,
      "cardId": 466352,
      "name": "Self-Forming Clay",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: 3 [block] if you lost HP this combat.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 53,
      "cardId": 466353,
      "name": "Runic Pyramid",
      "type": "relic",
      "pool": "relic",
      "text": "Once per combat: Retain any number of cards this turn.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 54,
      "cardId": 466354,
      "name": "Omamori",
      "type": "relic",
      "pool": "relic",
      "text": "You can't gain Curses.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 55,
      "cardId": 466355,
      "name": "Wing Boots",
      "type": "relic",
      "pool": "relic",
      "text": "You may ignore paths when moving up to the next room. Use this 3x, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 56,
      "cardId": 466356,
      "name": "Molten Egg",
      "type": "relic",
      "pool": "relic",
      "text": "When you add an Attack to your deck, upgrade it. Use this 3x, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "0f8234",
      "index": 57,
      "cardId": 466357,
      "name": "Toxic Egg",
      "type": "relic",
      "pool": "relic",
      "text": "When you add a Skill to your deck, upgrade it. Use this 3x, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 0,
      "cardId": 471000,
      "name": "Teleportation Stone",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 2]: Draw 1 card. [die 3]: 2 [block].",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 1,
      "cardId": 471001,
      "name": "Thimble Helm",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "Once per combat: Spend [energy] to gain 2 [block].",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 2,
      "cardId": 471002,
      "name": "Dueling Glove",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 1]: Gain [energy]. [die 2]: Deal 2 damage.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 3,
      "cardId": 471003,
      "name": "Sack of Gems",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 1]: 1 [block]. [die 2]: Draw 1 card. [die 3]: Deal 1 damage.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 4,
      "cardId": 471004,
      "name": "Black Powder",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 2]: Your next Attack this turn costs 0 Energy.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 5,
      "cardId": 471005,
      "name": "Kunai",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 4]: Gain 1 [block] for each Attack in your hand.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 6,
      "cardId": 471006,
      "name": "Clasped Locket",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 5-6]: Deal 2 damage.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 7,
      "cardId": 471007,
      "name": "Fuel Canister",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 1-2]: You may Exhaust a card in your hand to gain [energy].",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 8,
      "cardId": 471008,
      "name": "Snecko Egg",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 1 or 6]: The next card you play this turn costs 1. (Includes 0 cost cards.)",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 9,
      "cardId": 471009,
      "name": "Greed Ooze",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "[die 1]: Deal 2 damage, +5 if you have 7 or more gold.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 10,
      "cardId": 471010,
      "name": "Potion Belt",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "You may hold 2 additional potions. When obtained: Gain 2 potions.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 11,
      "cardId": 471011,
      "name": "Shot Glass",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "Once per combat: Discard a potion to gain [strength].",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 12,
      "cardId": 471012,
      "name": "Makeshift Battery",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "Once per combat: Gain [energy] [energy] if you have any [dazed], [burn], [slimed], or Curses in your hand.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 13,
      "cardId": 471013,
      "name": "Straight Razor",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "When you Rest: You may also Transform a card.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 14,
      "cardId": 471014,
      "name": "Unceasing Top",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "Once per combat: If you have 1 or fewer cards in hand, draw 3 cards.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 15,
      "cardId": 471015,
      "name": "Pantograph",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "Start of Boss combat: Heal 4 HP.",
      "multiplicity": 1
    },
    {
      "guid": "5b1766",
      "index": 16,
      "cardId": 471016,
      "name": "The Broken Seal",
      "type": "relic",
      "pool": "relic-supplement",
      "text": "Once per combat: If you have 2 or more cards in your Exhaust pile, gain [energy].",
      "multiplicity": 1
    }
  ],
  "potions": [
    {
      "guid": "72a869",
      "indices": [
        0
      ],
      "cardIds": [
        466400
      ],
      "name": "Transforming Brew",
      "type": "potion",
      "pool": "potion",
      "text": "Transform a card in your hand. Add the gained card to your hand.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        1,
        2
      ],
      "cardIds": [
        466401,
        466402
      ],
      "name": "Energy Drink",
      "type": "potion",
      "pool": "potion",
      "text": "The next card you play this turn costs 0 Energy.",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        3,
        4
      ],
      "cardIds": [
        466403,
        466404
      ],
      "name": "Mystery Potion",
      "type": "potion",
      "pool": "potion",
      "text": "[die 1-2]: Deal 4 damage. [die 3-4]: Draw 3 cards. [die 5-6]: Gain [energy] [energy].",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        5
      ],
      "cardIds": [
        466405
      ],
      "name": "Pizzaz Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Gain [strength] [strength] for one Attack.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        6
      ],
      "cardIds": [
        466406
      ],
      "name": "Greed Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Deal damage equal to your gold.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        7
      ],
      "cardIds": [
        466407
      ],
      "name": "Liquid Void",
      "type": "potion",
      "pool": "potion",
      "text": "Put a card from your Exhaust pile into your hand. It costs 0 Energy this turn.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        8
      ],
      "cardIds": [
        466408
      ],
      "name": "Fruit Juice",
      "type": "potion",
      "pool": "potion",
      "text": "Restore 1 lost max HP. Heal 1 HP.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        9
      ],
      "cardIds": [
        466409
      ],
      "name": "Clever Concoction",
      "type": "potion",
      "pool": "potion",
      "text": "Draw until you have 7 cards in your hand.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        10
      ],
      "cardIds": [
        466410
      ],
      "name": "Destiny Draught",
      "type": "potion",
      "pool": "potion",
      "text": "Trigger any die relic ability. Its owner gains the effect.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        11
      ],
      "cardIds": [
        466411
      ],
      "name": "Cultist Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Lose 1 HP. Gain [strength].",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        12
      ],
      "cardIds": [
        466412
      ],
      "name": "Bottle of Nails",
      "type": "potion",
      "pool": "potion",
      "text": "Lose 1 HP. Gain [energy] [energy]. Draw 3 cards.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        13
      ],
      "cardIds": [
        466413
      ],
      "name": "Cactus Juice",
      "type": "potion",
      "pool": "potion",
      "text": "Exhaust all [dazed], [slimed], and [burn] in your hand. Draw 1 card for each card Exhausted.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        14
      ],
      "cardIds": [
        466414
      ],
      "name": "Whale Ale",
      "type": "potion",
      "pool": "potion",
      "text": "ALL players draw 2 cards. If playing solo, draw 4 cards instead.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        15,
        16
      ],
      "cardIds": [
        466415,
        466416
      ],
      "name": "Block Potion",
      "type": "potion",
      "pool": "potion",
      "text": "2 [block] to any player.",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        17,
        18
      ],
      "cardIds": [
        466417,
        466418
      ],
      "name": "Energy Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Gain [energy] [energy].",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        19,
        20
      ],
      "cardIds": [
        466419,
        466420
      ],
      "name": "Explosive Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Deal 2 damage to any row.",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        21,
        22
      ],
      "cardIds": [
        466421,
        466422
      ],
      "name": "Fire Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Deal 4 damage.",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        23,
        24
      ],
      "cardIds": [
        466423,
        466424
      ],
      "name": "Swift Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Draw 3 cards.",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        25,
        26
      ],
      "cardIds": [
        466425,
        466426
      ],
      "name": "Weak Potion",
      "type": "potion",
      "pool": "potion",
      "text": "[weak] [weak].",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        27,
        28
      ],
      "cardIds": [
        466427,
        466428
      ],
      "name": "Vulnerable Potion",
      "type": "potion",
      "pool": "potion",
      "text": "[vulnerable].",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        29,
        30
      ],
      "cardIds": [
        466429,
        466430
      ],
      "name": "Flex Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Gain [strength]. Lose that [strength] at end of turn.",
      "multiplicity": 2
    },
    {
      "guid": "72a869",
      "indices": [
        31
      ],
      "cardIds": [
        466431
      ],
      "name": "Gambler's Brew",
      "type": "potion",
      "pool": "potion",
      "text": "Change the die to any number (before accepting the roll).",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        32
      ],
      "cardIds": [
        466432
      ],
      "name": "Ghost in a Jar",
      "type": "potion",
      "pool": "potion",
      "text": "You can't lose more than 1 HP this round.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        33
      ],
      "cardIds": [
        466433
      ],
      "name": "Distilled Chaos",
      "type": "potion",
      "pool": "potion",
      "text": "Draw 3 cards. Immediately play them in any order for 0 Energy.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        34
      ],
      "cardIds": [
        466434
      ],
      "name": "Entropic Brew",
      "type": "potion",
      "pool": "potion",
      "text": "Gain [potion] [potion].",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        35
      ],
      "cardIds": [
        466435
      ],
      "name": "Fairy in a Bottle",
      "type": "potion",
      "pool": "potion",
      "text": "When your HP becomes 0, instead set your HP to 2 and discard this item.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        36
      ],
      "cardIds": [
        466436
      ],
      "name": "Attack Potion",
      "type": "potion",
      "pool": "potion",
      "text": "The next Attack you play this turn is played twice.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        37
      ],
      "cardIds": [
        466437
      ],
      "name": "Skill Potion",
      "type": "potion",
      "pool": "potion",
      "text": "The next Skill you play this turn is played twice.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        38
      ],
      "cardIds": [
        466438
      ],
      "name": "Ancient Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Remove all Weak and Vulnerable from your character.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        39
      ],
      "cardIds": [
        466439
      ],
      "name": "Blood Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Heal 2 HP.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        40
      ],
      "cardIds": [
        466440
      ],
      "name": "Cunning Potion",
      "type": "potion",
      "pool": "potion",
      "text": "1 [damage], 1 [damage], 1 [damage]. Treat each [damage] as a separate 0 cost Attack.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        41
      ],
      "cardIds": [
        466441
      ],
      "name": "Purity Potion",
      "type": "potion",
      "pool": "potion",
      "text": "Exhaust up to 3 cards in your hand.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        42
      ],
      "cardIds": [
        466442
      ],
      "name": "Liquid Memories",
      "type": "potion",
      "pool": "potion",
      "text": "Put a card from your discard pile into your hand. It costs 0 Energy this turn.",
      "multiplicity": 1
    },
    {
      "guid": "72a869",
      "indices": [
        43
      ],
      "cardIds": [
        466443
      ],
      "name": "Snecko Oil",
      "type": "potion",
      "pool": "potion",
      "text": "Draw 5 cards. Gain [dazed] [dazed].",
      "multiplicity": 1
    }
  ],
  "bossRelics": [
    {
      "guid": "d6b384",
      "index": 0,
      "cardId": 467400,
      "name": "Dented Plate",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: If you have 5 HP or more, gain [energy].",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 1,
      "cardId": 467401,
      "name": "Wheel of Change",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "[die 1]: Discard 2 cards. [die 2]: Draw 2 cards. [die 3]: Deal 2 damage. [die 4]: Gain [energy]. [die 5]: Gain [strength]. [die 6]: 1 [block].",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 2,
      "cardId": 467402,
      "name": "Knowing Skull",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Once per combat: Draw 3 cards.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 3,
      "cardId": 467403,
      "name": "Battle Buddies",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. Start of combat: Discard 2 cards.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 4,
      "cardId": 467404,
      "name": "Forbidden Fruit",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Gain [up-arrow-card-reward], [yellow-card-reward], [relic], and a Curse. Use this immediately, then discard it.",
      "multiplicity": 1,
      "uncertainty": "The source prints the first two rewards only as gray-up-arrow and yellow card icons; their glossary labels are not printed on this sheet."
    },
    {
      "guid": "d6b384",
      "index": 5,
      "cardId": 467405,
      "name": "Chronometer",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: The next card you play this turn costs 1. (Includes 0 cost cards.)",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 6,
      "cardId": 467406,
      "name": "Mark of Pain",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. When obtained: Lose 2 max HP.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 7,
      "cardId": 467407,
      "name": "Shuriken",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Once per combat: Gain [strength] if you played 3 Attacks this turn.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 8,
      "cardId": 467408,
      "name": "Ectoplasm",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. You can't gain gold.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 9,
      "cardId": 467409,
      "name": "Cursed Key",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. When obtained, gain 2 Curses.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 10,
      "cardId": 467410,
      "name": "Wrist Blade",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Your 0 cost Attacks deal +1 damage on each [damage]. (Include X.)",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 11,
      "cardId": 467411,
      "name": "Holy Water",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of combat: Place 2 cubes. Remove a cube: Gain [energy].",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 12,
      "cardId": 467412,
      "name": "Snecko Eye",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "[die 1-2]: Draw 2 cards. [die 3-4]: Gain [energy]. [die 5-6]: Gain [dazed].",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 13,
      "cardId": 467413,
      "name": "Pandora's Box",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Transform 3 cards. Use this immediately, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 14,
      "cardId": 467414,
      "name": "Coffee Dripper",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. At campfire rooms: You can't Rest.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 15,
      "cardId": 467415,
      "name": "Fusion Hammer",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. At campfire rooms: You can't Smith.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 16,
      "cardId": 467416,
      "name": "Orrery",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Gain 4 [card-reward]. Use this immediately, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 17,
      "cardId": 467417,
      "name": "Sozu",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Gain [energy]. You can't gain potions.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 18,
      "cardId": 467418,
      "name": "Frozen Core",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "End of turn: 1 [block].",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 19,
      "cardId": 467419,
      "name": "Empty Cage",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Remove 2 cards. Use this immediately, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 20,
      "cardId": 467420,
      "name": "Black Blood",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "End of combat: Heal 2 HP.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 21,
      "cardId": 467421,
      "name": "Ring of the Serpent",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Start of turn: Draw 1 card.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 22,
      "cardId": 467422,
      "name": "White Beast Statue",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "End of combat: Gain [potion].",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 23,
      "cardId": 467423,
      "name": "Tiny House",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Gain [card-reward], [potion], 3 gold. Upgrade a card. Use this immediately, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 24,
      "cardId": 467424,
      "name": "Astrolabe",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Upgrade 3 cards. Use this immediately, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 25,
      "cardId": 467425,
      "name": "Calling Bell",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Gain [relic] [relic] [relic]. Gain a Curse. Use this immediately, then discard it.",
      "multiplicity": 1
    },
    {
      "guid": "d6b384",
      "index": 26,
      "cardId": 467426,
      "name": "Enchiridion",
      "type": "boss relic",
      "pool": "boss-relic",
      "text": "Gain [card-reward]. Look at 5 cards instead of 3. Use this immediately, then discard it.",
      "multiplicity": 1
    }
  ],
  "colorlessCards": [
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 0,
      "baseCardId": 467000,
      "upgradeCardId": 468400,
      "name": "Bite",
      "type": "Attack",
      "pool": "colorless",
      "cost": 1,
      "baseText": "2 [damage]. If you have 4 HP or less, 2 [block].",
      "upgradedText": "3 [damage]. If you have 4 HP or less, 3 [block].",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 1,
      "baseCardId": 467001,
      "upgradeCardId": 468401,
      "name": "Deep Breath",
      "type": "Skill",
      "pool": "colorless",
      "cost": 1,
      "baseText": "2 [block]. Put 1 card from your Exhaust pile on top of your discard pile. Exhaust.",
      "upgradedText": "3 [block]. Put 2 cards from your Exhaust pile on top of your discard pile. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 2,
      "baseCardId": 467002,
      "upgradeCardId": 468402,
      "name": "Forethought",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Retain. When played, if you Retained this last turn, draw 2 cards.",
      "upgradedText": "Retain. When played, if you Retained this last turn, draw 3 cards.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 3,
      "baseCardId": 467003,
      "upgradeCardId": 468403,
      "name": "Jack of All Trades",
      "type": "Attack",
      "pool": "colorless",
      "cost": 2,
      "baseText": "1 [damage] for each Skill in your hand. 1 [block] for each other Attack in your hand.",
      "upgradedText": "2 [damage] for each Skill in your hand. 1 [block] for each other Attack in your hand.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 4,
      "baseCardId": 467004,
      "upgradeCardId": 468404,
      "name": "Last Stand",
      "type": "Power",
      "pool": "colorless",
      "cost": 2,
      "baseText": "You can't gain [weak] [vulnerable]. When played, 4 [block] and remove all of your [weak] [vulnerable].",
      "upgradedText": "You can't gain [weak] [vulnerable]. When played, 6 [block] and remove all of your [weak] [vulnerable].",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 5,
      "baseCardId": 467005,
      "upgradeCardId": 468405,
      "name": "Secret Technique",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Scry 3. You may put 1 Skill revealed this way into your hand. Exhaust.",
      "upgradedText": "Scry 3. You may put 1 Skill revealed this way into your hand.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 6,
      "baseCardId": 467006,
      "upgradeCardId": 468406,
      "name": "Secret Weapon",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Scry 3. You may put 1 Attack revealed this way into your hand. Exhaust.",
      "upgradedText": "Scry 3. You may put 1 Attack revealed this way into your hand.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 7,
      "baseCardId": 467007,
      "upgradeCardId": 468407,
      "name": "Panic Button",
      "type": "Power",
      "pool": "colorless",
      "cost": 0,
      "baseText": "When played, 5 [block]. You can't gain [block]. Start of turn: Place a cube. Then Exhaust if there are 2 cubes.",
      "upgradedText": "When played, 7 [block]. You can't gain [block]. Start of turn: Place a cube. Then Exhaust if there are 2 cubes.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 8,
      "baseCardId": 467008,
      "upgradeCardId": 468408,
      "name": "Ritual Dagger",
      "type": "Attack",
      "pool": "colorless",
      "cost": 0,
      "baseText": "3 [damage]. If this kills the enemy, gain [energy] [energy]. Exhaust.",
      "upgradedText": "4 [damage]. If this kills the enemy, gain [energy] [energy] [energy]. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 9,
      "baseCardId": 467009,
      "upgradeCardId": 468409,
      "name": "Shaper's Blessing",
      "type": "Power",
      "pool": "colorless",
      "cost": 2,
      "baseText": "End of turn: Place a cube and gain 2 [block]. Then Exhaust if there are 2 cubes.",
      "upgradedText": "End of turn: Place a cube and gain 2 [block]. Then Exhaust if there are 3 cubes.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 10,
      "baseCardId": 467010,
      "upgradeCardId": 468410,
      "name": "Blood Shots",
      "type": "Attack",
      "pool": "colorless",
      "cost": 3,
      "baseText": "2 [damage], 2 [damage], 2 [damage].",
      "upgradedText": "2 [damage], 2 [damage], 2 [damage], 2 [damage].",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 11,
      "baseCardId": 467011,
      "upgradeCardId": 468411,
      "name": "Chronoboost",
      "type": "Power",
      "pool": "colorless",
      "cost": 2,
      "upgradedCost": 1,
      "baseText": "Whenever you shuffle your draw pile, [strength].",
      "upgradedText": "Whenever you shuffle your draw pile, [strength].",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 12,
      "baseCardId": 467012,
      "upgradeCardId": 468412,
      "name": "Curiosity",
      "type": "Power",
      "pool": "colorless",
      "cost": 3,
      "upgradedCost": 2,
      "baseText": "Whenever you play another Power, [strength].",
      "upgradedText": "Whenever you play another Power, [strength].",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 13,
      "baseCardId": 467013,
      "upgradeCardId": 468413,
      "name": "Invincible",
      "type": "Power",
      "pool": "colorless",
      "cost": 3,
      "upgradedCost": 2,
      "baseText": "End of turn: You may Exhaust this to prevent all HP loss you would take this round.",
      "upgradedText": "End of turn: You may Exhaust this to prevent all HP loss you would take this round.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 14,
      "baseCardId": 467014,
      "upgradeCardId": 468414,
      "name": "Virus",
      "type": "Attack",
      "pool": "colorless",
      "cost": 1,
      "baseText": "Exhaust the top 2 cards of your deck. X [damage]. X is the number of cards in your Exhaust pile.",
      "upgradedText": "Exhaust the top 3 cards of your deck. X [damage]. X is the number of cards in your Exhaust pile.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 15,
      "baseCardId": 467015,
      "upgradeCardId": 468415,
      "name": "YOU ARE MINE!",
      "type": "Skill",
      "pool": "colorless",
      "cost": 3,
      "baseText": "2 [block]. [vulnerable] [vulnerable] [weak] [weak]. Exhaust.",
      "upgradedText": "2 [block]. [vulnerable] [vulnerable] [vulnerable] [weak] [weak] [weak]. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 16,
      "baseCardId": 467016,
      "upgradeCardId": 468416,
      "name": "Dramatic Entrance",
      "type": "Attack",
      "pool": "colorless",
      "cost": 0,
      "baseText": "2 [damage]. +1 damage if it's the first turn of combat. Exhaust.",
      "upgradedText": "2 [damage]. +3 damage if it's the first turn of combat. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 17,
      "baseCardId": 467017,
      "upgradeCardId": 468417,
      "name": "Good Instincts",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "1 [block] to any player.",
      "upgradedText": "2 [block] to any player.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 18,
      "baseCardId": 467018,
      "upgradeCardId": 468418,
      "name": "Mind Blast",
      "type": "Attack",
      "pool": "colorless",
      "cost": 2,
      "baseText": "X [damage]. X is the number of other cards in your hand.",
      "upgradedText": "X+1 [damage]. X is the number of other cards in your hand.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 19,
      "baseCardId": 467019,
      "upgradeCardId": 468419,
      "name": "Finesse",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "1 [block]. Draw 1 card. Exhaust.",
      "upgradedText": "1 [block]. Draw 1 card.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 20,
      "baseCardId": 467020,
      "upgradeCardId": 468420,
      "name": "Flash of Steel",
      "type": "Attack",
      "pool": "colorless",
      "cost": 0,
      "baseText": "1 [damage]. Draw 1 card. Exhaust.",
      "upgradedText": "1 [damage]. Draw 1 card.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 21,
      "baseCardId": 467021,
      "upgradeCardId": 468421,
      "name": "Swift Strike",
      "type": "Attack",
      "pool": "colorless",
      "cost": 0,
      "baseText": "1 [damage]. You may switch rows with another player.",
      "upgradedText": "2 [damage]. You may switch rows with another player.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 22,
      "baseCardId": 467022,
      "upgradeCardId": 468422,
      "name": "Panacea",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Retain. Remove all [weak] [vulnerable] from any player. Exhaust.",
      "upgradedText": "Retain. Remove all [weak] [vulnerable] from all players. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 23,
      "baseCardId": 467023,
      "upgradeCardId": 468423,
      "name": "Purity",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Exhaust up to 3 cards in your hand. Exhaust.",
      "upgradedText": "Exhaust up to 5 cards in your hand. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 24,
      "baseCardId": 467024,
      "upgradeCardId": 468424,
      "name": "Blind",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "[weak]. Exhaust.",
      "upgradedText": "[weak] [weak]. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 25,
      "baseCardId": 467025,
      "upgradeCardId": 468425,
      "name": "Trip",
      "type": "Skill",
      "pool": "colorless",
      "cost": 2,
      "baseText": "[vulnerable] [vulnerable]. Exhaust.",
      "upgradedText": "[vulnerable] [vulnerable] [vulnerable]. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 26,
      "baseCardId": 467026,
      "upgradeCardId": 468426,
      "name": "Sadistic Nature",
      "type": "Power",
      "pool": "colorless",
      "cost": 1,
      "baseText": "Whenever you put a token on an enemy, deal 1 damage to that enemy.",
      "upgradedText": "Whenever you put a token on an enemy, deal 2 damage to that enemy.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 27,
      "baseCardId": 467027,
      "upgradeCardId": 468427,
      "name": "Panache",
      "type": "Power",
      "pool": "colorless",
      "cost": 0,
      "baseText": "End of turn: If your hand is empty, deal 3 damage to any row.",
      "upgradedText": "End of turn: If your hand is empty, deal 5 damage to any row.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 28,
      "baseCardId": 467028,
      "upgradeCardId": 468428,
      "name": "Thinking Ahead",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Draw 2 cards. Then put a card from your hand on top of your draw pile. Exhaust.",
      "upgradedText": "Draw 3 cards. Then put a card from your hand on top of your draw pile. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 29,
      "baseCardId": 467029,
      "upgradeCardId": 468429,
      "name": "Madness",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "The next card you play this turn costs 0. Exhaust.",
      "upgradedText": "Retain. The next card you play this turn costs 0. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 30,
      "baseCardId": 467030,
      "upgradeCardId": 468430,
      "name": "Impatience",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "If you have no Attacks in your hand, draw 2 cards.",
      "upgradedText": "If you have no Attacks in your hand, draw 3 cards.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 31,
      "baseCardId": 467031,
      "upgradeCardId": 468431,
      "name": "Dark Shackles",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "2 [block] for each enemy that intends to attack you. Exhaust.",
      "upgradedText": "3 [block] for each enemy that intends to attack you. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 32,
      "baseCardId": 467032,
      "upgradeCardId": 468432,
      "name": "Apparition",
      "type": "Skill",
      "pool": "colorless",
      "cost": 1,
      "baseText": "Ethereal. You can't lose more than 1 HP this round. Exhaust.",
      "upgradedText": "You can't lose more than 1 HP this round. Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 33,
      "baseCardId": 467033,
      "upgradeCardId": 468433,
      "name": "The Bomb",
      "type": "Power",
      "pool": "colorless",
      "cost": 2,
      "baseText": "End of turn: Place a cube. Then if there are 3 cubes, deal 10 damage to ALL enemies, then Exhaust.",
      "upgradedText": "End of turn: Place a cube. Then if there are 3 cubes, deal 12 damage to ALL enemies, then Exhaust.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 34,
      "baseCardId": 467034,
      "upgradeCardId": 468434,
      "name": "Mayhem",
      "type": "Power",
      "pool": "colorless",
      "cost": 2,
      "upgradedCost": 1,
      "baseText": "Once per turn: Draw 1 card. Immediately play it for 0 Energy.",
      "upgradedText": "Once per turn: Draw 1 card. Immediately play it for 0 Energy.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 35,
      "baseCardId": 467035,
      "upgradeCardId": 468435,
      "name": "Hand of Greed",
      "type": "Attack",
      "pool": "colorless",
      "cost": 2,
      "baseText": "4 [damage]. +3 damage if you have 10 or more gold.",
      "upgradedText": "4 [damage]. +5 damage if you have 10 or more gold.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 36,
      "baseCardId": 467036,
      "upgradeCardId": 468436,
      "name": "Apotheosis",
      "type": "Power",
      "pool": "colorless",
      "cost": 2,
      "upgradedCost": 1,
      "baseText": "Your starter Strikes deal +1 damage. Your starter Defends gain +1 block.",
      "upgradedText": "Your starter Strikes deal +1 damage. Your starter Defends gain +1 block.",
      "multiplicity": 1
    },
    {
      "baseGuid": "7f7cc9",
      "upgradeGuid": "80fcb6",
      "index": 37,
      "baseCardId": 467037,
      "upgradeCardId": 468437,
      "name": "Master of Strategy",
      "type": "Skill",
      "pool": "colorless",
      "cost": 0,
      "baseText": "Draw 3 cards. Exhaust.",
      "upgradedText": "Draw 4 cards. Exhaust.",
      "multiplicity": 1
    }
  ],
  "heartsBoons": [
    {
      "guid": "938861",
      "index": 0,
      "cardId": 438400,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "PROVE your worth...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain [card-reward] from the colorless rewards.",
        "Gain 2 [potion].",
        "Upgrade a starter Strike and Defend. Lose 1 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 1,
      "cardId": 438401,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Arise... Servant...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain [card-reward].",
        "Gain 8 gold. Lose 1 max HP.",
        "Upgrade a starter Strike and Defend. Lose 3 gold."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 2,
      "cardId": 438402,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Arise... Servant...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Remove a card.",
        "Gain 8 gold. Lose 1 max HP.",
        "Transform a card, then upgrade it. Lose 2 HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 3,
      "cardId": 438403,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Sacrifice... For power...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Upgrade 2 starter Strikes. Lose 1 HP.",
        "Gain 2 [potion].",
        "Gain [up-arrow-card-reward] from the colorless rewards. Lose 3 HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 4,
      "cardId": 438404,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "I brought you back...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Transform a card.",
        "Add a random rare card to your deck.",
        "Gain [up-arrow-card-reward]. Lose 2 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 5,
      "cardId": 438405,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "I brought you back...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain [card-reward].",
        "Gain [relic]. Lose 1 max HP.",
        "Remove 2 cards. Lose 3 gold."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 6,
      "cardId": 438406,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Slay... Intruders...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain 2 [potion].",
        "Upgrade 2 starter Strikes. Lose 1 HP.",
        "Remove 2 cards. Lose 2 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 7,
      "cardId": 438407,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Slay... Intruders...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Transform a card.",
        "Upgrade 2 starter Strikes. Lose 1 HP.",
        "Gain [yellow-card-reward]. Gain a Curse."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 8,
      "cardId": 438408,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Slay... Intruders...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Upgrade a card.",
        "Transform a card.",
        "Gain [yellow-card-reward]. Lose 2 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 9,
      "cardId": 438409,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Slay... Intruders...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Upgrade a card.",
        "Gain [relic]. Lose 1 max HP.",
        "Gain 11 gold. Lose 2 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 10,
      "cardId": 438410,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Descend... Into madness...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Remove 2 starter Defends.",
        "Upgrade a card.",
        "Transform a card, then upgrade it. Lose 1 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 11,
      "cardId": 438411,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Descend... Into madness...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain 8 gold. Lose 1 max HP.",
        "Remove a card.",
        "Transform a card, then upgrade it. Lose 3 gold."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 12,
      "cardId": 438412,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Sacrifice... For power...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Upgrade a card.",
        "Add a random rare card to your deck.",
        "Look at 3 [relic] and gain 1 of your choice. Gain a Curse."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 13,
      "cardId": 438413,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "PROVE your worth...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain 3 [potion].",
        "Gain 11 gold. Lose 2 max HP.",
        "Gain [up-arrow-card-reward]. Gain a Curse."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 14,
      "cardId": 438414,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Sacrifice... For power...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Remove a card.",
        "Add 2 random colorless cards to your deck.",
        "Look at 3 [relic] and gain 1 of your choice. Lose 2 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 15,
      "cardId": 438415,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Sacrifice... For power...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain [card-reward] from the colorless rewards.",
        "Gain 8 gold. Lose 1 max HP.",
        "Add 2 random cards from your card rewards to your deck."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 16,
      "cardId": 438416,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "Sacrifice... For power...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Add a random rare card to your deck.",
        "Gain [relic]. Lose 3 gold.",
        "Add a random colorless card to your deck and upgrade it. Lose 1 HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 17,
      "cardId": 438417,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "I brought you back...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain 5 gold.",
        "Gain [card-reward] from the colorless rewards.",
        "Gain 3 [card-reward]. Lose 1 max HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 18,
      "cardId": 438418,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "I brought you back...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain 3 [potion].",
        "Upgrade a card.",
        "Gain [up-arrow-card-reward]. Lose 3 HP."
      ],
      "multiplicity": 1
    },
    {
      "guid": "938861",
      "index": 19,
      "cardId": 438419,
      "name": "The Heart's Boon",
      "type": "boon",
      "pool": "heart-boon",
      "speech": "I brought you back...",
      "commonText": "Gain 3 [card-reward]. Then choose an option below...",
      "options": [
        "Gain 3 [potion].",
        "Remove 2 starter Defends.",
        "Gain [card-reward]. Look at 5 cards instead of 3. Lose 1 gold and 1 HP."
      ],
      "multiplicity": 1
    }
  ],
  "completenessAudit": {
    "status": "complete-by-public-sheet-index",
    "sheetChecks": [
      {
        "guid": "0f8234",
        "expectedIndices": "0-57",
        "representedIndices": "0-57",
        "missing": [],
        "extra": [],
        "physicalCards": 58,
        "records": 58
      },
      {
        "guid": "5b1766",
        "expectedIndices": "0-16",
        "representedIndices": "0-16",
        "missing": [],
        "extra": [],
        "physicalCards": 17,
        "records": 17
      },
      {
        "guid": "72a869",
        "expectedIndices": "0-43",
        "representedIndices": "0-43",
        "missing": [],
        "extra": [],
        "physicalCards": 44,
        "records": 34,
        "note": "Ten duplicated potion names are grouped with both physical indices and multiplicity 2."
      },
      {
        "guid": "d6b384",
        "expectedIndices": "0-26",
        "representedIndices": "0-26",
        "missing": [],
        "extra": [],
        "physicalCards": 27,
        "records": 27
      },
      {
        "guid": "7f7cc9",
        "expectedIndices": "0-37",
        "representedIndices": "0-37",
        "missing": [],
        "extra": [],
        "physicalCards": 38,
        "records": 38
      },
      {
        "guid": "80fcb6",
        "expectedIndices": "0-37",
        "representedIndices": "0-37",
        "missing": [],
        "extra": [],
        "physicalCards": 38,
        "records": 38,
        "note": "Paired one-to-one with base colorless records by identical sheet index."
      },
      {
        "guid": "938861",
        "expectedIndices": "0-19",
        "representedIndices": "0-19",
        "missing": [],
        "extra": [],
        "physicalCards": 20,
        "records": 20
      }
    ],
    "totals": {
      "physicalFronts": 242,
      "manifestRecords": 194,
      "unrepresentedPhysicalIndices": 0
    },
    "scopeNote": "All occupied cells of the official v1.47 expansion item sheets are included. Familiar PC-game names are not filtered out because the public TTS sheets, not PC-mod provenance, define this physical expansion inventory."
  }
} as const

export type DownfallSheet = (typeof DOWNFALL_ITEMS_MANIFEST.sheets)[number]
export type DownfallRelic = (typeof DOWNFALL_ITEMS_MANIFEST.relics)[number]
export type DownfallPotion = (typeof DOWNFALL_ITEMS_MANIFEST.potions)[number]
export type DownfallBossRelic = (typeof DOWNFALL_ITEMS_MANIFEST.bossRelics)[number]
export type DownfallColorlessCard = (typeof DOWNFALL_ITEMS_MANIFEST.colorlessCards)[number]
export type HeartsBoon = (typeof DOWNFALL_ITEMS_MANIFEST.heartsBoons)[number]
export type DownfallItem = DownfallRelic | DownfallPotion | DownfallBossRelic | DownfallColorlessCard | HeartsBoon

export const DOWNFALL_RELICS = DOWNFALL_ITEMS_MANIFEST.relics
export const DOWNFALL_POTIONS = DOWNFALL_ITEMS_MANIFEST.potions
export const DOWNFALL_BOSS_RELICS = DOWNFALL_ITEMS_MANIFEST.bossRelics
export const DOWNFALL_COLORLESS_CARDS = DOWNFALL_ITEMS_MANIFEST.colorlessCards
export const HEARTS_BOONS = DOWNFALL_ITEMS_MANIFEST.heartsBoons

const DOWNFALL_RELIC_VARIANTS = new Set([
  'ninja_scroll', 'vajra', 'nilrys_codex', 'duality', 'happy_flower', 'ink_bottle', 'the_boot',
  'enchiridion', 'snecko_eye', 'wrist_blade',
])

/** Keep expansion printings separate when their rules differ from the base-game component. */
export function downfallRelicId(name: string): string {
  const id = itemId(name)
  return DOWNFALL_RELIC_VARIANTS.has(id) ? `downfall_${id}` : id
}

/** Shared special-case dispatch uses the printed component's base identity. */
export function downfallRelicBaseId(id: string): string {
  const base = id.startsWith('downfall_') ? id.slice('downfall_'.length) : id
  return DOWNFALL_RELIC_VARIANTS.has(base) ? base : id
}

/** Exact physical supplies. Repeated ids are distinct cardboard copies. */
export const DOWNFALL_RELIC_DECK = DOWNFALL_RELICS.flatMap((item) => Array(item.multiplicity).fill(downfallRelicId(item.name)))
export const DOWNFALL_POTION_DECK = DOWNFALL_POTIONS.flatMap((item) => Array(item.multiplicity).fill(itemId(item.name)))
export const DOWNFALL_BOSS_RELIC_DECK = DOWNFALL_BOSS_RELICS.flatMap((item) => Array(item.multiplicity).fill(downfallRelicId(item.name)))
export const DOWNFALL_COLORLESS_DECK = DOWNFALL_COLORLESS_CARDS.flatMap((item) => Array(item.multiplicity).fill(itemId(item.name)))
export const CORRUPTED_SHARD_SUPPLY = 4

export type DownfallCondition =
  | { kind: 'hpAtLeast'; amount: number }
  | { kind: 'attacksPlayedAtLeast'; amount: number }
  | { kind: 'cardsInExhaustAtLeast'; amount: number }
  | { kind: 'cardsInHandAtMost'; amount: number }
  | { kind: 'handHasStatusOrCurse' }

export type DownfallPassiveRule =
  | { kind: 'nextCardCosts'; amount: number; includesZero: boolean }
  | { kind: 'potionCapacity'; amount: number; gainOnAcquire: number }
  | { kind: 'startBossCombat' }

export type DownfallExecutableRule =
  | {
      kind: 'abilities'
      abilities: readonly {
        trigger: Trigger
        effects: readonly Effect[]
        optional?: boolean
        condition?: DownfallCondition
        target?: TargetScope
        supportTarget?: TargetScope
      }[]
    }
  | {
      kind: 'activation'
      timing: 'combat' | 'room' | 'acquire' | 'rest'
      once: boolean
      optional?: boolean
      condition?: DownfallCondition
      effects: readonly Effect[]
    }
  | { kind: 'effects'; effects: readonly Effect[]; target?: TargetScope; supportTarget?: TargetScope }
  | { kind: 'passive'; rule: DownfallPassiveRule; trigger?: Trigger; effects?: readonly Effect[] }
  | { kind: 'restTransform'; optional: true; count: 1 }
  | { kind: 'discardPotionForStrength'; oncePerCombat: true; amount: 1 }
  | { kind: 'transformHandCard'; addReplacementToHand: true }
  | { kind: 'rollForEffects'; effectsByFace: Readonly<Record<number, readonly Effect[]>> }
  | { kind: 'temporaryStrength'; amount: number; attacks: 1 }
  | { kind: 'damageEqualToGold' }
  | { kind: 'recoverExhaustToHand'; amount: 1; freeThisTurn: true }
  | { kind: 'restoreMaxHp'; amount: 1; heal: 1 }
  | { kind: 'triggerChosenDieRelic' }
  | { kind: 'exhaustStatusesInHand'; statuses: readonly ['daze', 'slimed', 'burn']; drawPerCard: 1 }
  | { kind: 'forbiddenFruit' }
  | { kind: 'heartsBoon'; cardId: string }
  | { kind: 'roomEntryGold'; room: 'event'; amount: 2 }

export type ExistingItemRegistry = {
  relics: Readonly<Record<string, RelicDef>>
  potions: Readonly<Record<string, PotionDef>>
  cards: Readonly<Record<string, CardDef>>
}

export type ResolvedDownfallItem =
  | { kind: 'existing-relic'; definition: RelicDef }
  | { kind: 'existing-potion'; definition: PotionDef }
  | { kind: 'existing-card'; definition: CardDef }
  | { kind: 'downfall'; rule: DownfallExecutableRule }

export function itemId(name: string): string {
  const id = name.toLowerCase()
    .replaceAll('&', 'and')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return id === 'ring_of_the_serpent' ? 'ring_of_serpent' : id
}

const colorless = (name: string, def: Omit<CardDef, 'id' | 'name' | 'owner' | 'rarity'>): CardDef => {
  const source = DOWNFALL_COLORLESS_CARDS.find((item) => item.name === name)!
  return {
    id: itemId(name), name, owner: 'colorless', rarity: 'uncommon', multiplicity: source.multiplicity,
    printedText: source.baseText, ...def,
  }
}

/** The 16 public-v1.47 Colorless faces that are not present in the base game. */
export const DOWNFALL_COLORLESS_CARD_DEFS: Readonly<Record<string, CardDef>> = Object.fromEntries([
  colorless('Bite', { type: 'attack', cost: 1, effects: [
    { kind: 'hit', amount: 2 }, { kind: 'block', amount: 2, when: { kind: 'hpAtMost', amount: 4 } },
  ], upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[0]!.upgradedText, effects: [
    { kind: 'hit', amount: 3 }, { kind: 'block', amount: 3, when: { kind: 'hpAtMost', amount: 4 } },
  ] } }),
  colorless('Deep Breath', { type: 'skill', cost: 1, exhaust: true, effects: [
    { kind: 'block', amount: 2 }, { kind: 'recoverExhaustToDiscard', amount: 1 },
  ], upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[1]!.upgradedText, effects: [
    { kind: 'block', amount: 3 }, { kind: 'recoverExhaustToDiscard', amount: 2 },
  ] } }),
  colorless('Forethought', { type: 'skill', cost: 0, retain: true,
    effects: [{ kind: 'draw', amount: 2, when: { kind: 'retainedLastTurn' } }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[2]!.upgradedText, effects: [{ kind: 'draw', amount: 3, when: { kind: 'retainedLastTurn' } }] } }),
  colorless('Jack of All Trades', { type: 'attack', cost: 2, effects: [
    { kind: 'hit', amount: { base: 0, per: 'skillsInHand' } }, { kind: 'block', amount: { base: 0, per: 'otherAttacksInHand' } },
  ], upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[3]!.upgradedText, effects: [
    { kind: 'hit', amount: { base: 0, per: 'skillsInHand', scale: 2 } }, { kind: 'block', amount: { base: 0, per: 'otherAttacksInHand' } },
  ] } }),
  colorless('Last Stand', { type: 'power', cost: 2, resolvesOnPlay: true,
    effects: [{ kind: 'block', amount: 4 }, { kind: 'clearDebuffs' }], persistentEffects: [{ kind: 'preventDebuffs' }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[4]!.upgradedText, effects: [{ kind: 'block', amount: 6 }, { kind: 'clearDebuffs' }] } }),
  colorless('Secret Technique', { type: 'skill', cost: 0, exhaust: true,
    effects: [{ kind: 'scryToHand', amount: 3, cardType: 'skill', optional: true }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[5]!.upgradedText, exhaust: false } }),
  colorless('Secret Weapon', { type: 'skill', cost: 0, exhaust: true,
    effects: [{ kind: 'scryToHand', amount: 3, cardType: 'attack', optional: true }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[6]!.upgradedText, exhaust: false } }),
  colorless('Panic Button', { type: 'power', cost: 0, resolvesOnPlay: true,
    effects: [{ kind: 'block', amount: 5 }], persistentEffects: [{ kind: 'preventBlock' }],
    additionalTriggers: [{ trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'countdownExhaust', cubes: 2 }] }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[7]!.upgradedText, effects: [{ kind: 'block', amount: 7 }] } }),
  colorless('Ritual Dagger', { type: 'attack', cost: 0, exhaust: true,
    effects: [{ kind: 'hit', amount: 3 }, { kind: 'gainEnergyIfTargetDead', amount: 2 }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[8]!.upgradedText, effects: [{ kind: 'hit', amount: 4 }, { kind: 'gainEnergyIfTargetDead', amount: 3 }] } }),
  colorless("Shaper's Blessing", { type: 'power', cost: 2, trigger: { kind: 'endOfTurn' },
    effects: [{ kind: 'block', amount: 2 }, { kind: 'countdownExhaust', cubes: 2 }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[9]!.upgradedText, effects: [{ kind: 'block', amount: 2 }, { kind: 'countdownExhaust', cubes: 3 }] } }),
  colorless('Blood Shots', { type: 'attack', cost: 3, effects: [{ kind: 'hit', amount: 2, times: 3 }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[10]!.upgradedText, effects: [{ kind: 'hit', amount: 2, times: 4 }] } }),
  colorless('Chronoboost', { type: 'power', cost: 2, trigger: { kind: 'onShuffle' }, effects: [{ kind: 'gainStrength', amount: 1 }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[11]!.upgradedText } }),
  colorless('Curiosity', { type: 'power', cost: 3, trigger: { kind: 'onPlayCard', cardType: 'power' }, effects: [{ kind: 'gainStrength', amount: 1 }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[12]!.upgradedText } }),
  colorless('Invincible', { type: 'power', cost: 3, trigger: { kind: 'endOfTurn' }, effects: [{ kind: 'optionalPreventRoundHpLoss' }],
    upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[13]!.upgradedText } }),
  colorless('Virus', { type: 'attack', cost: 1, effects: [
    { kind: 'exhaustDrawTop', amount: 2 }, { kind: 'damage', amount: { base: 0, per: 'cardsInExhaust' } },
  ], upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[14]!.upgradedText, effects: [
    { kind: 'exhaustDrawTop', amount: 3 }, { kind: 'damage', amount: { base: 0, per: 'cardsInExhaust' } },
  ] } }),
  colorless('YOU ARE MINE!', { type: 'skill', cost: 3, exhaust: true, effects: [
    { kind: 'block', amount: 2 }, { kind: 'applyVulnerable', amount: 2 }, { kind: 'applyWeak', amount: 2 },
  ], upgrade: { printedText: DOWNFALL_COLORLESS_CARDS[15]!.upgradedText, effects: [
    { kind: 'block', amount: 2 }, { kind: 'applyVulnerable', amount: 3 }, { kind: 'applyWeak', amount: 3 },
  ] } }),
].map((def) => [def.id, def]))

function exactText(item: DownfallItem): string {
  if ('text' in item) return item.text
  if ('baseText' in item) return item.baseText
  return [item.commonText, ...item.options].join(' ')
}

const ability = (
  trigger: Trigger,
  effects: readonly Effect[],
  target?: TargetScope,
  supportTarget?: TargetScope,
): DownfallExecutableRule => ({
  kind: 'abilities',
  abilities: [{ trigger, effects, ...(target ? { target } : {}), ...(supportTarget ? { supportTarget } : {}) }],
})

const CUSTOM_RULES: Readonly<Record<string, DownfallExecutableRule>> = {
  ninja_scroll: { kind: 'activation', timing: 'combat', once: true, effects: [] },
  vajra: ability({ kind: 'dieRelic', faces: [1] }, [{ kind: 'gainTemporaryStrength', amount: 1 }]),
  nilrys_codex: ability({ kind: 'dieRelic', faces: [1] }, [{ kind: 'draw', amount: 1 }]),
  duality: {
    kind: 'abilities', abilities: [
      { trigger: { kind: 'dieRelic', faces: [1] }, effects: [{ kind: 'block', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'damage', amount: 2 }] },
    ],
  },
  happy_flower: ability({ kind: 'dieRelic', faces: [2, 3] }, [{ kind: 'gainEnergy', amount: 1 }]),
  ink_bottle: ability({ kind: 'dieRelic', faces: [6] }, [{ kind: 'draw', amount: 1 }]),
  the_boot: ability({ kind: 'dieRelic', faces: [1, 2, 3] }, [{ kind: 'damage', amount: 1 }]),
  enchiridion: { kind: 'effects', effects: [] },
  snecko_eye: {
    kind: 'abilities', abilities: [
      { trigger: { kind: 'dieRelic', faces: [1, 2] }, effects: [{ kind: 'draw', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [3, 4] }, effects: [{ kind: 'gainEnergy', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [5, 6] }, effects: [{ kind: 'addDaze', amount: 1, pile: 'discard' }] },
    ],
  },
  wrist_blade: { kind: 'effects', effects: [] },
  ssserpent_head: { kind: 'roomEntryGold', room: 'event', amount: 2 },
  teleportation_stone: {
    kind: 'abilities',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'draw', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [3] }, effects: [{ kind: 'block', amount: 2 }] },
    ],
  },
  thimble_helm: {
    kind: 'activation', timing: 'combat', once: true,
    effects: [{ kind: 'spendEnergy', amount: 1 }, { kind: 'block', amount: 2 }],
  },
  dueling_glove: {
    kind: 'abilities',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [1] }, effects: [{ kind: 'gainEnergy', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'damage', amount: 2 }] },
    ],
  },
  sack_of_gems: {
    kind: 'abilities',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [1] }, effects: [{ kind: 'block', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'draw', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [3] }, effects: [{ kind: 'damage', amount: 1 }] },
    ],
  },
  black_powder: ability({ kind: 'dieRelic', faces: [2] }, [{ kind: 'discountNextAttack' }]),
  kunai: ability({ kind: 'dieRelic', faces: [4] }, [{
    kind: 'block', amount: { base: 0, per: 'attacksInHand' },
  }]),
  clasped_locket: ability({ kind: 'dieRelic', faces: [5, 6] }, [{ kind: 'damage', amount: 2 }]),
  fuel_canister: {
    kind: 'abilities',
    abilities: [{
      trigger: { kind: 'dieRelic', faces: [1, 2] },
      optional: true,
      effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'gainEnergy', amount: 1 }],
    }],
  },
  snecko_egg: {
    kind: 'passive', trigger: { kind: 'dieRelic', faces: [1, 6] },
    rule: { kind: 'nextCardCosts', amount: 1, includesZero: true },
  },
  greed_ooze: ability({ kind: 'dieRelic', faces: [1] }, [{
    kind: 'damage', amount: { base: 2, bonus: { plus: 5, when: { kind: 'goldAtLeast', amount: 7 } } },
  }]),
  potion_belt: { kind: 'passive', rule: { kind: 'potionCapacity', amount: 2, gainOnAcquire: 2 } },
  makeshift_battery: {
    kind: 'activation', timing: 'combat', once: true,
    condition: { kind: 'handHasStatusOrCurse' }, effects: [{ kind: 'gainEnergy', amount: 2 }],
  },
  unceasing_top: {
    kind: 'activation', timing: 'combat', once: true,
    condition: { kind: 'cardsInHandAtMost', amount: 1 }, effects: [{ kind: 'draw', amount: 3 }],
  },
  pantograph: {
    kind: 'passive', rule: { kind: 'startBossCombat' }, effects: [{ kind: 'heal', amount: 4 }],
  },
  the_broken_seal: {
    kind: 'activation', timing: 'combat', once: true,
    condition: { kind: 'cardsInExhaustAtLeast', amount: 2 }, effects: [{ kind: 'gainEnergy', amount: 1 }],
  },
  shot_glass: { kind: 'discardPotionForStrength', oncePerCombat: true, amount: 1 },
  straight_razor: { kind: 'restTransform', optional: true, count: 1 },
  transforming_brew: { kind: 'transformHandCard', addReplacementToHand: true },
  mystery_potion: {
    kind: 'rollForEffects',
    effectsByFace: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1, mysteryPotionEffects(index + 1)])),
  },
  pizzaz_potion: { kind: 'temporaryStrength', amount: 2, attacks: 1 },
  greed_potion: { kind: 'damageEqualToGold' },
  liquid_void: { kind: 'recoverExhaustToHand', amount: 1, freeThisTurn: true },
  fruit_juice: { kind: 'restoreMaxHp', amount: 1, heal: 1 },
  destiny_draught: { kind: 'triggerChosenDieRelic' },
  cactus_juice: { kind: 'exhaustStatusesInHand', statuses: ['daze', 'slimed', 'burn'], drawPerCard: 1 },
  energy_drink: { kind: 'effects', effects: [{ kind: 'discountNextCard' }] },
  clever_concoction: { kind: 'effects', effects: [{ kind: 'drawToHandSize', size: 7 }] },
  cultist_potion: {
    kind: 'effects', effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
  },
  bottle_of_nails: {
    kind: 'effects',
    effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'gainEnergy', amount: 2 }, { kind: 'draw', amount: 3 }],
  },
  whale_ale: { kind: 'effects', effects: [{ kind: 'draw', amount: 2 }], supportTarget: 'allPlayers' },
  dented_plate: {
    kind: 'abilities',
    abilities: [{
      trigger: { kind: 'startOfTurn' },
      condition: { kind: 'hpAtLeast', amount: 5 },
      effects: [{ kind: 'gainEnergy', amount: 1 }],
    }],
  },
  wheel_of_change: {
    kind: 'abilities',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [1] }, effects: [{ kind: 'discard', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'draw', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [3] }, effects: [{ kind: 'damage', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'gainEnergy', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [5] }, effects: [{ kind: 'gainStrength', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [6] }, effects: [{ kind: 'block', amount: 1 }] },
    ],
  },
  knowing_skull: {
    kind: 'activation', timing: 'combat', once: true, effects: [{ kind: 'draw', amount: 3 }],
  },
  battle_buddies: {
    kind: 'abilities',
    abilities: [
      { trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }] },
      { trigger: { kind: 'startOfCombat' }, effects: [{ kind: 'discard', amount: 2 }] },
    ],
  },
  chronometer: {
    kind: 'passive', trigger: { kind: 'startOfTurn' },
    rule: { kind: 'nextCardCosts', amount: 1, includesZero: true },
  },
  shuriken: {
    kind: 'activation', timing: 'combat', once: true,
    condition: { kind: 'attacksPlayedAtLeast', amount: 3 }, effects: [{ kind: 'gainStrength', amount: 1 }],
  },
  forbidden_fruit: { kind: 'forbiddenFruit' },
}

function registryMatch<T extends { id: string; name: string }>(
  defs: Readonly<Record<string, T>>,
  name: string,
): T | undefined {
  const id = itemId(name)
  const withoutArticle = id.replace(/(^|_)the_/, '$1')
  return defs[id] ?? defs[withoutArticle] ?? Object.values(defs).find((def) => def.name === name)
}

export function resolveDownfallItem(
  item: DownfallItem,
  registry?: ExistingItemRegistry,
): ResolvedDownfallItem {
  const id = itemId(item.name)
  const compiled = CUSTOM_RULES[id]
  if ((item.type === 'relic' || item.type === 'boss relic') && DOWNFALL_RELIC_VARIANTS.has(id) && compiled) {
    return { kind: 'downfall', rule: compiled }
  }
  if (registry && (item.type === 'relic' || item.type === 'boss relic')) {
    const definition = registryMatch(registry.relics, item.name)
    if (definition) return { kind: 'existing-relic', definition }
  }
  if (registry && item.type === 'potion') {
    const definition = registryMatch(registry.potions, item.name)
    if (definition) return { kind: 'existing-potion', definition }
  }
  if (registry && item.type !== 'boon' && 'baseText' in item) {
    const definition = registryMatch(registry.cards, item.name)
    if (definition) return { kind: 'existing-card', definition }
  }
  if (compiled) return { kind: 'downfall', rule: compiled }
  if (item.type === 'boon') return { kind: 'downfall', rule: { kind: 'heartsBoon', cardId: itemId(`heart_boon_${item.index}`) } }
  throw new Error(`Downfall item has no executable definition: ${item.name} (${exactText(item)})`)
}

export function mysteryPotionEffects(die: number): readonly Effect[] {
  if (!Number.isInteger(die) || die < 1 || die > 6) return []
  if (die <= 2) return [{ kind: 'damage', amount: 4 }]
  if (die <= 4) return [{ kind: 'draw', amount: 3 }]
  return [{ kind: 'gainEnergy', amount: 2 }]
}

export const whaleAleDrawCount = (livingPlayers: number): number => livingPlayers <= 0 ? 0 : livingPlayers === 1 ? 4 : 2

export function conditionMet(
  condition: DownfallCondition,
  state: {
    hp: number
    attacksPlayedThisTurn: number
    exhaustCount: number
    handSize: number
    handHasStatusOrCurse: boolean
  },
): boolean {
  switch (condition.kind) {
    case 'hpAtLeast': return state.hp >= condition.amount
    case 'attacksPlayedAtLeast': return state.attacksPlayedThisTurn >= condition.amount
    case 'cardsInExhaustAtLeast': return state.exhaustCount >= condition.amount
    case 'cardsInHandAtMost': return state.handSize <= condition.amount
    case 'handHasStatusOrCurse': return state.handHasStatusOrCurse
  }
}

export function heartBoon(index: number): HeartsBoon | undefined {
  return HEARTS_BOONS.find((boon) => boon.index === index)
}

const DOWNFALL_MECHANIC_OWNERS = new Set(['slime_boss', 'guardian', 'hexaghost', 'hermit'])

/** Rulebook p.7: a foreign card that references a character board grants one of four Shards. */
export function cardNeedsCorruptedShard(
  recipient: string,
  card: Pick<CardDef, 'owner' | 'effects' | 'printedText' | 'guardian' | 'cardKind'>,
): boolean {
  if (card.owner === recipient || !DOWNFALL_MECHANIC_OWNERS.has(card.owner)) return false
  if (card.guardian || card.cardKind === 'slime') return true
  const text = card.printedText ?? ''
  if (/\b(?:Load|Chamber|Advance|Retract|Heat|Soulburn|Attack Mode|Defense Mode|Vigor|Slime)\b/i.test(text)) return true
  return card.effects.some((effect) => [
    'advance', 'retract', 'gainSoulburn', 'useAllSoulburn', 'guardianCard', 'guardianGem',
    'growSlime', 'commandSlime', 'gainSlime', 'load',
  ].includes(effect.kind))
}

export function heartBoonOptionCosts(option: string): {
  hp: number
  maxHp: number
  gold: number
  curse: boolean
} {
  const amount = (pattern: RegExp): number => Number(option.match(pattern)?.[1] ?? 0)
  return {
    hp: amount(/(?:Lose \d+ gold and |Lose )(\d+) HP/),
    maxHp: amount(/Lose (\d+) max HP/),
    gold: amount(/Lose (\d+) gold/),
    curse: /Gain a Curse/.test(option),
  }
}

export function physicalCardIds(): number[] {
  return [
    ...DOWNFALL_RELICS.map((item) => item.cardId),
    ...DOWNFALL_POTIONS.flatMap((item) => [...item.cardIds]),
    ...DOWNFALL_BOSS_RELICS.map((item) => item.cardId),
    ...DOWNFALL_COLORLESS_CARDS.flatMap((item) => [item.baseCardId, item.upgradeCardId]),
    ...HEARTS_BOONS.map((item) => item.cardId),
  ]
}
