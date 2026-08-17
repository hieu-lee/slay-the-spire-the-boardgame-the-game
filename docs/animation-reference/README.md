# UI animation reference

These captures are regression references, not source assets. They document the
timing and visual hierarchy used while implementing the web table's motion.

## Official gameplay references

- [Slay the Spire 2 — Early Access Trailer](https://www.youtube.com/watch?v=PW22jwFNxU8), Mega Crit. Combat around 1:04 shows the committed card lifted above the hand before the effect lands; the map around 1:18 keeps the current node and route visually alive.
- [Slay the Spire 2 — Official Gameplay Trailer](https://www.youtube.com/watch?v=ttVtllHkb4E), Mega Crit. The combat cuts use short card commits, impact flashes, and restrained full-screen light rather than long blocking transitions.
- [Slay the Spire — Official Launch Trailer](https://www.youtube.com/watch?v=9SZUtyYSOjQ), Mega Crit. The original establishes the same readable cadence: cards move before numbers settle, reward choices deal into place, and map progress is continuously signalled.

## Local regression captures

- `source-sts1-card-play.png`: official STS1 launch-trailer frame at 0:35, with the committed Power held above the hand.
- `source-sts2-map.png`: official STS2 Early Access trailer frame at 1:15, showing the live route and current-node treatment.
- `source-sts2-reward.png`: official STS2 gameplay-trailer frame at 0:45, showing the three-card reward deal.
- `combat-card-draw.png`: newly visible cards deal from the draw-pile side and settle into the existing fan.
- `combat-card-play.png`: a committed card holds above the battlefield before resolving toward its real discard, exhaust, or draw destination.
- `map-route.png`: reachable routes flow while the current node pulses.
- `reward-deal.png`: revealed reward cards enter in a short stagger.

Regenerate these after intentional motion changes with
`UPDATE_ANIMATION_REFERENCES=1 node scripts/verify-browser.mjs`. Routine browser
verification writes equivalent captures under its artifact output instead of
overwriting these reviewed references. Reduced-motion mode is separately
asserted to collapse every effect.
