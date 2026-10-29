# Reuse road cells after waiting — October 29, 2026

The provider queue now checks completed browser cell records after acquiring its
lock and again after a persisted cooldown. Another tab may have downloaded those
roads since the first cache lookup. Only missing leaves are dispatched; cached
leaves keep their provenance and survive a failure of the remaining request.

Cache-only work creates no provider reservation or cooldown, does not reset
provider failure state, and spends no network request budget. Queued Refresh and
disabled-cache loads still download fresh roads. Cancelled and no-longer-wanted
work cannot dispatch. The scheduler counts requests at dispatch, with a second
budget check so concurrent private-provider queues cannot overspend it.

A real local Chromium test reproduced two identical cold tabs sending **two**
road requests before the change and **one** afterward. The second tab reports
zero road requests and one cached region. An overlapping view requests its
missing cells without repeating a completed cell. This measures request reuse
against deterministic local fixtures, not public Overpass latency or rejection
rates. Cells not yet saved by another tab can still be cache misses.

Validation passed **272 unit tests, 109 local browser cases and 11 built-app
browser cases**, plus Svelte/TypeScript checks, lint, generated-code consistency,
the normal production build and offline deployment validation. Focused scheduler
coverage is 100% lines / 94.84% branches. Browser cases exercise native Web Locks,
workers, IndexedDB, cancellation, storage denial, provider waits and backup
retries. The original Monaco geometry/seam and rendering/export checks still pass.

No runtime dependency, provider setting, road query schema or cache record format
changed. The 30-day outage fallback limit remains in effect.
