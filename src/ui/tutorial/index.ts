import type { RunState } from '../../game/run.ts'
import type { CharacterId } from '../../game/types.ts'
import { generalChapters } from './general.ts'
import { onScript } from './helpers.ts'
import { DEFECT } from './heroes/defect.ts'
import { GUARDIAN } from './heroes/guardian.ts'
import { HERMIT } from './heroes/hermit.ts'
import { HEXAGHOST } from './heroes/hexaghost.ts'
import { IRONCLAD } from './heroes/ironclad.ts'
import { SILENT } from './heroes/silent.ts'
import { SLIME_BOSS } from './heroes/slime_boss.ts'
import { WATCHER } from './heroes/watcher.ts'
import type { HeroTutorial, TutorialChapter } from './types.ts'

export const HERO_TUTORIALS: Partial<Record<CharacterId, HeroTutorial>> = Object.fromEntries(
  [IRONCLAD, SILENT, DEFECT, WATCHER, SLIME_BOSS, GUARDIAN, HEXAGHOST, HERMIT]
    .filter((hero): hero is HeroTutorial => hero !== null).map((hero) => [hero.character, hero]),
)

export const tutorialSeed = (character: CharacterId) => HERO_TUTORIALS[character]?.plan.seed ?? `tutorial-${character}`

/**
 * Everything the coach can say in one hero's tutorial: the scripted chapters
 * while the run follows its plan, then general lessons if the player hid the
 * tips and left it.
 */
export function tutorialChapters(character: CharacterId): TutorialChapter[] {
  const hero = HERO_TUTORIALS[character]
  if (!hero) return generalChapters(character, () => true)
  const offScript = (run: RunState) => !onScript(hero.plan, run)
  return [
    ...hero.chapters.map((chapter) => ({ ...chapter, when: (run: RunState) => !offScript(run) && chapter.when(run) })),
    ...generalChapters(character, offScript),
  ]
}
