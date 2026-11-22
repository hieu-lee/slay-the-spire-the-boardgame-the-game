# UI animation reference

These captures are regression references, not source assets. They document the
timing and visual hierarchy used while implementing the web table's motion.

## Official gameplay references

- [Slay the Spire 2 — Early Access Trailer](https://www.youtube.com/watch?v=PW22jwFNxU8), Mega Crit. Combat around 1:04 shows the committed card lifted above the hand before the effect lands; the map around 1:18 keeps the current node and route visually alive.
- [Slay the Spire 2 — Official Gameplay Trailer](https://www.youtube.com/watch?v=ttVtllHkb4E), Mega Crit. The combat cuts use short card commits, impact flashes, and restrained full-screen light rather than long blocking transitions.
- [Slay the Spire — Official Launch Trailer](https://www.youtube.com/watch?v=9SZUtyYSOjQ), Mega Crit. The original establishes the same readable cadence: cards move before numbers settle, reward choices deal into place, and map progress is continuously signalled.

## Local regression captures

`UPDATE_ANIMATION_REFERENCES=1 pnpm verify:browser` writes the card-draw, card-play, map-route and reward-deal captures here for review after intentional motion changes; routine runs write them under the artifact output instead. The captures are not committed. Reduced-motion mode is separately asserted to collapse every effect.
