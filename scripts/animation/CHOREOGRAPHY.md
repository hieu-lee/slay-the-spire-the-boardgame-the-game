# Attack choreography

The pre-rig implementation at `0e314e2` is the reference for existing actors.
Joint motion must fit its phase windows, not simply reach an extreme pose at
projectile contact. World travel, SFX, damage and return gates retain their
existing clocks.

| Actor | Preserved phases (milliseconds) |
| --- | --- |
| Ironclad | windup 0–540; dash 540–630; two-handed downward sword swing 630–1170; return dash 1170–1260; recovery 1260–1800 |
| Silent | ready 0–150; throw/outbound daggers 150–1025; hold throw through returning daggers 1025–1900 (including existing per-target stagger) |
| Defect | charge 0–550; release 550–1100; recover 1100–1650; bolt contact remains 1110 |
| Watcher | ready 0–550; staff cast 550–1100; recover 1100–1650; meteor contact remains 1050 |
| Guardian / Hermit | ready 0–550; claw / pistol action 550–1100; recover 1100–1650 |
| Slime hero | prepare / surf outward 0–600; squash against target 600–1100; surf back / settle 1100–1700 |
| Hexaghost hero | channel 0–550; flame flight 550–1450; recover through 2000 |
| Bosses | windup 0–550; travel / transition 550–730; attack 730–1280; recover 1280–1830 |
| Demon boss | preserve separate airborne launch, target slam, second launch and origin landing; never replace the slam with a standing cast |

Reference selectors: `attack-ironclad-motion`, the old `*-ready-pose` and
`*-impact-pose` rules, `boss-melee-dash`, `boss-demon-aerial-slam`; old packaged
boss frame durations are 550 + 180 + 550 + 550 ms.

## New elites

All fit the existing 1830ms enemy presentation and its 730ms gameplay contact.
These are authored from the original silhouettes, weapons and anatomy:

| Design | Choreography |
| --- | --- |
| Gremlin Nob | brace knees, raise heavy skull club with one hand while the other balances, weight-forward smash, heavy follow-through, lift back to guard |
| Lagavulin | lower shell, brace rear legs, extend front claws into a short pounce, retract claws and settle shell |
| Sentry | upper and lower stone shells separate to expose the core; charge, discharge with recoil, close shells |
| Book of Stabbing | curl the arm to draw the blade back, three closely spaced stabs, withdraw blade over the open book |
| Gremlin Leader | quick forward dagger jab; scarf follows the torso with a delayed swish; reset guard |
| Taskmaster | shoulder backswing followed by wrist snap, delayed whip-tip crack and diminishing recoil |
| Giant Head | slow heavy lift / backward tilt, drop forward, ground shock ring, weighted settle |
| Nemesis | pull scythe back, sweep the blade forward and down; cloak and tail follow after the weapon |
| Reptomancer | coil lower body, raise hands, direct a conjured dagger forward, uncoil and lower hands |
| Spire Shield | pull shield close, brace, drive shield face forward, hold the shove, withdraw behind it |
| Spire Spear | draw spear back along its shaft, straight forward thrust, pause at extension, pull back |
| Red Slaver | short spear draw-back and jab, delayed net sway, return to guard |
| Blue Slaver | extend hooked blade, sweep down and pull back as if catching an opponent, recover |

Rigid blades must remain rigid. If a cutout cannot reach its intended poses
without breaking anatomy, use drawn key poses and in-betweens, preserving the
same phase windows and a fixed body scale/ground anchor.
