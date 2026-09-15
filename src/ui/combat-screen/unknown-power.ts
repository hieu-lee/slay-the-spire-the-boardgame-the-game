export type UnknownPowerRefreshDecision = 'committed' | 'restore' | 'wait' | 'unlock'

// The action callback and the authoritative room refresh race each other. Keep
// that ordering decision independent from React state so every arrival order is
// explicit and can be covered without timing a browser request.
export function unknownPowerRefreshDecision(
  used: boolean,
  refreshAttempt: number | undefined,
  latestRefresh: number | undefined,
): UnknownPowerRefreshDecision {
  if (used) return 'committed'
  if (refreshAttempt === undefined) return 'unlock'
  if (latestRefresh !== undefined && latestRefresh > refreshAttempt) return 'restore'
  return 'wait'
}
