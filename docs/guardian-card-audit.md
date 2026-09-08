# Guardian printed-card audit — 2026-09-08

Audited all 83 definitions and 150 distinct faces (base cards, upgrades, Golden Ticket and all 15 Gems) against `public/assets/cards/guardian__*.webp`, the shipped official public-v1.47 TTS crops. Reviewed costs, types, numbers, icons, mode conditions, triggers, targeting, Socket interactions and lifecycle flags against the source registry, combat resolver, shared queries, play and turn paths. All printed costs match. The user-provided Charge Core and Poly Beam images confirm that orange flame means Vigor and blue pip means Energy. Both already worked correctly.

The local optional `tmp/downfall-reference/manifests/guardian.json` is an older transcription, not the authority for corrected rule text. Physical identity checks still use it when available.

| Card | Audit result (base and upgrade where present) |
| --- | --- |
| Curl Up | No mismatch found. |
| Defend | No mismatch found. |
| Strike | No mismatch found. |
| Twin Slam | No mismatch found. |
| Orb Support | No mismatch found. |
| Resilient Plate | Resolve the unconditional and Defense Mode Block icons separately, including per-icon bonuses. |
| Overload | Restore mandatory Mode Shift after drawing. |
| Prismatic Barrier | Block targets one player; only damage, Weak and Vulnerable gain area effect. Sapphire/Bismuth remain self Block. |
| Prismatic Spray | Correct the area-effect symbol list to damage, Weak and Vulnerable; attached Block stays self-only. |
| Tune Up | No mismatch found. |
| Stasis Field | Four separately assigned Block icons; five upgraded. |
| Strike for Strike | No mismatch found. |
| Sentry Beam | No mismatch found. |
| Disrupt | No mismatch found. |
| Charge Core | No mismatch found. |
| Crystal Edge | No mismatch found. |
| Fierce Bash | No mismatch found. |
| Orb Slam | No mismatch found. |
| Hack | No mismatch found. |
| Poly Beam | No mismatch found. |
| Priming Shot | No mismatch found. |
| Gear Up | No mismatch found. |
| Spheric Shield | No mismatch found. |
| Suspension | No mismatch found. |
| Fortify | No mismatch found. |
| Walker Claw | No mismatch found. |
| Roll Attack | No mismatch found. |
| Golden Ticket | No mismatch found. |
| Orbwalk | No mismatch found. |
| Guardian Whirl | No mismatch found. |
| Vent Steam | No mismatch found. |
| Turbocharge | No mismatch found. |
| Speed Boost | No mismatch found. |
| Charge Up | No mismatch found. |
| Incinerate | No mismatch found. |
| Crystallize | No mismatch found. |
| Focus Beam | No mismatch found. |
| Gem Cannon | No mismatch found. |
| Harden | No mismatch found. |
| Multi Beam | No mismatch found. |
| Stasis Beam | No mismatch found. |
| Power Beam | No mismatch found. |
| Laser Turret | No mismatch found. |
| Future Plans | No mismatch found. |
| Preprogram | No mismatch found. |
| Brilliant Scales | No mismatch found. |
| Repulsor | No mismatch found. |
| Ancient Construct | No mismatch found. |
| Shield Charger | No mismatch found. |
| Time Sifter | No mismatch found. |
| Scale Slash | No mismatch found. |
| Blitz | No mismatch found. |
| Bauble Burst | No mismatch found. |
| Body Crash | Two X-damage hits after paying X Block, not one X-squared hit. |
| Spiker Protocol | No mismatch found. |
| Evade | Double the resulting Block exactly, without applying the per-icon bonus a second time. |
| Giga Beam | No mismatch found. |
| Revenge Protocol | No mismatch found. |
| Armored Protocol | No mismatch found. |
| Gem Finder | No mismatch found. |
| Exploit Gems | No mismatch found. |
| Stasis Engine | No mismatch found. |
| Construction Form | No mismatch found. |
| Floating Orbs | No mismatch found. |
| Time Capacitor | No mismatch found. |
| DESTROY | No mismatch found. |
| Refracted Beam | Single-enemy attacks or self Block; neither face has an area-effect icon. |
| Forecasting | No mismatch found. |
| Amethyst | No mismatch found. |
| Emerald | No mismatch found. |
| Garnet | No mismatch found. |
| Opal | No mismatch found. |
| Ruby | No mismatch found. |
| Sapphire | No mismatch found. |
| Tourmaline | Gain one Vigor, then immediately spend that new token; repeated effects each gain/spend independently. |
| Amber | No mismatch found. |
| Aquamarine | Gain one Vigor before preventing additional card plays. |
| Bismuth | No mismatch found. |
| Morganite | No mismatch found. |
| Jasper | No mismatch found. |
| Onyx | No mismatch found. |
| Pearl | No mismatch found. |
| Peridot | No mismatch found. |

Validation: `node scripts/verify-guardian-card-audit.mjs` exercises the corrected behavior and Energy/Vigor distinction, both upgrades and modes, capped Vigor, repeated Gems and Power activation. Its 24 checks pass; 18 fail on original commit `9f8ffee`. `node scripts/verify-downfall-guardian.mjs` covers all definitions and the existing Guardian integration cases. `node scripts/verify-guardian-card-browser.mjs` checks actual targeting prompts and card play on desktop (1440×900) and horizontal phone (844×390). Screenshots are written to `artifacts/guardian-card-audit/`.
