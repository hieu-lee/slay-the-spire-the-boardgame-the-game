# Four-player server latency investigation

On October 7 at 21:54:02 CEST, the server logged a 1,104 ms broadcast in
`ALJ3EU`. The user confirmed this was the room whose players saw delayed
actions. A local save captured at 21:59 contains the four-player Act II
Gremlin Leader fight: nine living enemies, five start-turn abilities, and
442 combat-log entries. This save was inspected offline, never restored to
the production store, and is not included in the repository.

## Cause and repair

Start-turn target equivalence simulated every candidate even after two
targets produced different outcomes. Each simulation cloned the combat and
canonicalized its gameplay state. Room snapshots also repeatedly derived
the same plan through saved-target checks, Noxious Fumes, the coordinator,
and the choice quorum.

- Stop target-equivalence checks at the first different outcome. Keep every
  legal target and continue fully checking candidates when they are equal.
- Reuse source targets until an earlier planned effect changes the simulated
  combat. Continue recalculating targets after damage, row changes, or other
  effects that can invalidate them.
- Cache one derived plan per room in a weak map. The key contains the entire
  combat and committed order/target/choice data, so in-place changes and
  restored rooms invalidate it. Private card data is still redacted for each
  viewer; redacted snapshots are not cached.
- Use the room's existing recorded quorum instead of deriving an unused one
  during snapshot reads.
- Give the game service `CPUWeight=1000`. This increases its relative CPU
  share among sibling services; it does not reserve a core or stop other
  tasks. The setting was verified in the live cgroup without restarting the
  game service. See [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).
- Log broadcasts taking at least 100 ms, previously 1,000 ms, so noticeable
  stalls are visible before they become one-second freezes.

## Measurements

All timings are local to the same WSL host, with another T3 task left running.
They measure server work, not the friend's Internet latency or device FPS.
Profiler instrumentation and host contention affect absolute timings.

| Saved-room workload | Before | After |
| --- | ---: | ---: |
| Four-seat broadcast from a fresh room, median wall time | 2,391 ms (3 samples) | 114 ms (10 samples) |
| Four independent reads of an unchanged room, median wall time | 8,736 ms (3 samples) | 22 ms (10 samples) |

The complete four-seat snapshot output has the same before/after SHA-256:
`09fbabe71981c381cf31e1be3f28b3658bb0e65c826edde5a7ce3a31b6423715`.

A separate in-memory transport check used three four-player rooms, twelve
compressed WebSocket clients, and 25 broadcasts per room. All twelve clients
received each round of updates: median 139 ms, p95 214 ms. Health checks during
the broadcasts had p95 28 ms. These measurements include local compression,
socket delivery, and client JSON parsing, but not public Internet transit.
Only temporary test identities and fresh seat tokens were used.

## Regression check

`node scripts/verify-room-performance.mjs` builds a synthetic version of the
same workload. It checks CPU budgets for fresh four-seat broadcasts and
repeated reads, legal row targets and Shiv overflow, in-place cache
invalidation, committed order changes, and private Exhaust-card redaction.
CPU time and median sampling reduce sensitivity to unrelated host workloads.

Against the original deployed implementation, the check fails at 1,566 ms
CPU against a 500 ms cold-planning budget. The repaired implementation
initially measured 47 ms CPU for cold planning and 14 ms for repeated reads.
Actual network latency still needs measurements from the friend's device;
this repair addresses the reproduced server stall.
