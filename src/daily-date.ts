/** The UTC calendar day of `time` (epoch milliseconds), as `YYYY-MM-DD`: the Daily Climb's day. */
export function dailyDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}
