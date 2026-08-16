// Which rulebook images the optional Act I reference crops come from.
//
// Data only, in its own module so that reading it does not run the extraction
// pipeline. When this table lived in sync-enemy-art.mjs, importing it from a
// verify script re-ran the whole sync — so the check that every enemy has a
// portrait silently RECREATED any missing portrait and could never fail, and
// the same import aborted the run entirely on a machine without the rulebook.
//
// Keys are enemy ids from src/game/enemies.ts; values are the md5 prefix of the
// card scan embedded in the rulebook PDF. Runtime enemy art is committed under
// public/assets/combat/enemies and does not depend on these local crops.
//
// Each mapping was checked by cropping the card's TITLE BANNER and reading it,
// not by eyeballing the creature: two were wrong on the first pass, because
// several enemies share a colour scheme and the Cultist card appears twice.
export const ENEMY_ART = {
  small_slime: '8031700b',
  acid_slime: 'f392242c',
  cultist: 'd189fa17',
  jaw_worm: 'd9506603',
  red_louse: 'c3f81e4f',
  green_louse: 'b59e9569',
  gremlin_nob: '9e33a4ee',
  lagavulin: 'a1221753',
  spike_slime: '01e6d175',
  fungi_beast: '2bac4550',
  blue_slaver: '590cdd86',
}
