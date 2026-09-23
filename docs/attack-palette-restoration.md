# Attack palette restoration

Idle artwork is the palette reference. Separately generated attack drawings had
stronger saturation and sometimes different hues, making characters change color
when attacking. The corrected source artwork bakes one fixed, hue-local grade
across each complete sheet or sequence. No browser filters or per-frame color
normalization are used. Ironclad and Watcher also use separate static poses in
CombatScreen; their ready/impact and ready/thrust assets are corrected alongside
the rigged exports. Do not apply the grade again to these corrected sources.

| Rigs | Restored colors |
| --- | --- |
| Ironclad | Dark red trousers, muted gold armor |
| Silent | Muted green cloak |
| Defect | Pale gold body, light blue cloak |
| Watcher | Violet clothing, muted sash, gold staff tip in live static poses |
| Guardian hero and attacking boss | Muted gold plates and blue body |
| Hermit | Dusty red hat/leather and grey-blue coat |
| Awakened One, both phases | Muted cyan feathers |
| Bronze Automaton | Pale bronze armor |
| Guardian defensive boss | Gold plates and blue core |
| Collector | Dark teal cloak |
| Time Eater | Violet robes and pale green skin |
| Downfall Trickster | Green cloak |
| Downfall Wrathful | Violet clothing |
| Champ | Blue armor and dark red cape |

All 98 idle/attack rig pairs were visually audited. The remaining rigs retain
matching palettes or intentional attack effects. Hermit's yellow muzzle flashes,
Collector's green flame, Trickster's separately composited purple double, and
Hexaghost's heat variants keep their distinct colors.

Before editing, validation covered color jumps, temporal flicker, unintended effect
recoloring, alpha/geometry changes, encoding quality, and stale Safari companions.
Source dimensions, alpha bytes, frame counts and durations were checked against
`28058eb`; grading does not resize or reposition the subject. Runtime exports use
the existing renderers, choreography and quality settings.

## Rebuild and inspect

Requires the Python animation dependencies and RIFE model documented in
`scripts/animation/README.md`, plus ffmpeg with Apple's HEVC-alpha encoder.

```sh
python3 scripts/animation/render-rig.py scripts/animation/rigs.json --only=hero-ironclad,hero-silent,hero-defect,hero-watcher,hero-guardian,hero-hermit,awakened_one_phase_1,awakened_one_phase_2,bronze_automaton,guardian_attack,guardian_defensive,the_collector,time_eater,downfall_trickster,downfall_wrathful,the_champ
python3 scripts/animation/review-rigs.py --only=hero-ironclad,hero-silent,hero-defect,hero-watcher,hero-guardian,hero-hermit,awakened_one_phase_1,awakened_one_phase_2,bronze_automaton,guardian_attack,guardian_defensive,the_collector,time_eater,downfall_trickster,downfall_wrathful,the_champ
node scripts/verify-rig-animation-browser.mjs --only=none
node scripts/verify-rig-animation-browser.mjs --boss-only
node scripts/verify-safari-combat-animation-browser.mjs
```

The review command writes repeating idle/attack/recovery videos and frame galleries
under `artifacts/rig-animation/review`. The browser checks write desktop and
horizontal-phone screenshots and recordings under `artifacts/rig-animation/browser`.

On macOS, the light lane's Linux deployment fixtures need GNU coreutils, modern
Bash and a Node installation under `/opt` or `/usr` on `PATH`, with `TMPDIR=/tmp`.
The fixtures compare resolved release paths and select Bash through `PATH`.
