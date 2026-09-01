import type { RewardSource } from '../game/run.ts'

/** Printed label for a Prismatic Shard reward deck. */
export function rewardSourceLabel(source: RewardSource): string {
  return source.split('_').map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(' ')
}
