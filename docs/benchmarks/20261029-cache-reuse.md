# Browser data reuse, 2026-10-29

This milestone preserves useful downloads and avoids repeat work after
interruptions or provider outages. Geometry, query schema, stored-record format
and the 96 MiB total / 16 MiB per-record cache limits remain compatible.

## Behavior and evidence

| Scenario | Expected behavior |
| --- | --- |
| A complete cell waits for an idle save, then its map closes | The registered save drains before the connection closes; a revisit uses the saved geometry. New writes after close are refused. |
| A parent splits and only one quarter finishes | Only the quarter is saved. A revisit requests the parent once, then fetches its three missing quarters after the parent splits again. The completed quarter is reused. |
| Every quarter finishes, including cached quarters | A complete parent can be saved. Its download date is the oldest child's date. Partial geometry is never labelled complete. |
| A fresh-only lookup finds a four-day-old cell | It misses without deleting the older cell. A later write does not evict it solely for being older than 72 hours. |
| An unavailable provider rejects a load and bounded older cells exist | Each eligible cell can recover from cache. Recovered cells send no retry; missing cells keep the original retry allowance and provider cooldown. |
| An explicit refresh fails | It does not serve older geometry. A later successful refresh replaces the record with a fresh download. |
| Cache is cleared while a save or request is pending | The prior epoch travels with its geometry and cannot repopulate the cache after clearing. |

The new cases are in `tests/live-scheduler.test.ts`,
`tests/live-viewport-units.test.ts`, `tests/local/live-viewport.spec.ts` and
`tests/local/storage.spec.ts`. They use real IndexedDB, workers and rendered
exports in the browser, plus controlled promises and clocks in the scheduler.
All road-provider responses are local fixtures.

Milestone validation passed: 256 unit tests, all 98 local browser cases and all
10 built-app cases; Svelte/TypeScript checks, lint, codegen, normal production
build and offline deployment validation. Focused scheduler/viewport unit coverage
is 100% / 97.44% of lines respectively. IndexedDB behavior is exercised by the
browser cases rather than those unit coverage percentages.

## Freshness

The freshness window stays 72 hours. Only outage recovery can use records younger
than 30 days, with an explicit older-data notice and oldest download date. Invalid
queries, resource limits and malformed responses do not trigger this recovery.
The oldest timestamp is retained through reads and aggregation. Dates are not
extended to make old data appear fresh. Disabling the cache or refreshing skips
the fallback. The retention bound is defined by `CELL_CACHE.fallbackAgeMs`.

No real Overpass latency or rejection-rate improvement is claimed. No R2 datasets
or infrastructure were published; the prepared-city scope remains Monaco.
