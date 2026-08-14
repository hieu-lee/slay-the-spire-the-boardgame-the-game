# Item and reward UI reference

The physical board-game rules in `docs/rules.md` remain authoritative. These
screens only guide presentation and interaction; video-game effects and limits
must not be copied into the engine.

## Sources inspected

- [Slay the Spire UI gallery](https://interfaceingame.com/games/slay-the-spire/)
- [Slay the Spire 2 UI gallery](https://interfaceingame.com/games/slay-the-spire-2)
- STS1: Rewards, Choose a Relic, Choose a Card, and Choose Character screens
- STS2: Loot, Relic, Store, Character, Confirmation, Level Selection, and Combat HUD screens

Reference screenshots were captured for local visual comparison outside the
repository; the copyrighted source images are not shipped with the game.

## Presentation contract

- Keep the current run visible but dimmed behind a centered, illustrated reward
  panel. Preserve the compact run HUD so players retain party context.
- Present each reward as a large, controller-friendly row or physical item icon.
  Focus uses a bright cyan/gold outline, slight lift, and an adjacent rules
  tooltip; it must not depend on hover.
- Use short parchment title ribbons, staged reveal motion, sparkle/glow feedback,
  and large edge actions. Accept/confirm is blue or green; skip/back is a distinct
  red ribbon away from the primary choices.
- Keep keyboard focus visible and ordered: reward choices, item actions, then
  confirm/skip. Enter/Space activates and Escape backs out where backing out is
  legal. Touch targets remain at least 44px.
- In co-op, show every seat's progress without exposing another player's hidden
  choices. Reconnect restores the exact revealed offer, focused action, and
  pending replacement/trade state from server-authoritative run data.
- On narrow screens, stack the panel and party status vertically without turning
  reward choices into small website-style buttons. The selected object remains
  the visual center and supporting rules move below it.

## Flow-specific cues

- Card and Golden Ticket rewards use literal card faces. A selected card rises
  and glows; a rare revealed by a Ticket receives a gold source badge.
- Relics and potions use large object art with their rules text beside them.
  Replacement is an explicit second step that keeps the incoming potion visible.
- Potion trading is a two-step give flow outside combat: choose potion, then an
  eligible teammate. No card, relic, gold-token, Shiv, or Miracle transfer action
  is shown.
- Ascension selection is a single prominent level control with the cumulative
  modifier list directly underneath. Locked levels remain visible and explain
  their unlock condition.
