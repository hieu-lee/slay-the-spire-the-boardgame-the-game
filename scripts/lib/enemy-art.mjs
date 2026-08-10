// Which rulebook image each enemy's portrait is cropped from.
//
// Data only, in its own module so that reading it does not run the extraction
// pipeline. When this table lived in sync-enemy-art.mjs, importing it from a
// verify script re-ran the whole sync — so the check that every enemy has a
// portrait silently RECREATED any missing portrait and could never fail, and
// the same import aborted the run entirely on a machine without the rulebook.
//
// Keys are enemy ids from src/game/enemies.ts; values are the md5 prefix of the
// card scan embedded in the rulebook PDF. Highest available resolution wins;
// several enemies appear in the book more than once.
//
// Each mapping was checked by cropping the card's TITLE BANNER and reading it,
// not by eyeballing the creature: two were wrong on the first pass, because
// several enemies share a colour scheme and the Cultist card appears twice.
export const ENEMY_ART = {
  small_slime: '8031700b',
  acid_slime: 'f392242c',
  acid_slime_daw: 'prebuilt',
  acid_slime_wda: 'prebuilt',
  acid_slime_wad: 'prebuilt',
  cultist: 'd189fa17',
  jaw_worm: 'd9506603',
  jaw_worm_first: 'prebuilt',
  red_louse: 'c3f81e4f',
  red_louse_first: 'prebuilt',
  red_louse_summon: 'prebuilt',
  green_louse: 'b59e9569',
  green_louse_21w: 'prebuilt',
  gremlin_nob: '9e33a4ee',
  lagavulin: 'a1221753',
  spike_slime: '01e6d175',
  spike_slime_dv2: 'prebuilt',
  spike_slime_v2d: 'prebuilt',
  spike_slime_2dv: 'prebuilt',
  fungi_beast: '2bac4550',
  blue_slaver: '590cdd86',
  jaw_worm_a7: 'prebuilt',
  red_slaver: 'prebuilt',
  looter: 'prebuilt',
  large_slime: 'prebuilt',
  large_slime_summon_w4s: 'prebuilt',
  large_slime_summon_4sw: 'prebuilt',
  large_slime_summon_sw4: 'prebuilt',
  mad_gremlin: 'prebuilt',
  sneaky_gremlin: 'prebuilt',
  gremlin_wizard: 'prebuilt',
  fat_gremlin: 'prebuilt',
  sentry_a: 'prebuilt',
  sentry_b: 'prebuilt',
  sentries: 'prebuilt',
  chosen_14: 'prebuilt',
  chosen_16: 'prebuilt',
  looter_hard: 'prebuilt',
  mugger: 'prebuilt',
  centurion_b3: 'prebuilt',
  centurion_3b: 'prebuilt',
  mystic: 'prebuilt',
  mystic_2sh: 'prebuilt',
  byrd_encounter: 'prebuilt',
  byrd_s13: 'prebuilt',
  byrd_s31: 'prebuilt',
  byrd_31s: 'prebuilt',
  snake_plant: 'prebuilt',
  shelled_parasite: 'prebuilt',
  fungi_beast_a7: 'prebuilt',
  snecko: 'prebuilt',
  spheric_guardian: 'prebuilt',
  blue_slaver_wd3: 'prebuilt',
  blue_slaver_w3d: 'prebuilt',
  blue_slaver_dw3: 'prebuilt',
  blue_slaver_3wd: 'prebuilt',
  red_slaver_dv3: 'prebuilt',
  red_slaver_3dv: 'prebuilt',
  red_slaver_3vd: 'prebuilt',
  red_slaver_v3d: 'prebuilt',
  book_of_stabbing: 'prebuilt',
  gremlin_leader: 'prebuilt',
  taskmaster: 'prebuilt',
}
