# Cache management validation — October 29, 2026

The global cache manager lists browser city datasets and live road fragments from
metadata, with names/area IDs, road classes, tile bounds, sizes and dates. It
filters entries and renders 50 rows at a time. Removing a local entry preserves
unrelated records. Clearing both stores preserves designs and provider pacing.

Shared generation numbers and durable IndexedDB markers invalidate pre-clear
deferred and in-flight writes across tabs. Existing live sessions stop saving
after invalidation; new explicit map loads can cache again. Tests cover a writer
whose localStorage access is denied, so the transaction marker remains necessary.

Optional R2 administration uses a dedicated dataset credential and a separate
administrator token. Tokens remain in dialog memory and requests use same-origin
authentication, bounded bodies and no-store responses. City deletion updates the
current catalog with a conditional write before removing that city's objects.
Clear-all is restricted to `v2/`; search data and coordination locks are preserved.
Deletion uses resumable 100-file batches with four concurrent operations. Partial
failures remain visible and can be retried. Concurrent publication is unsupported
during deletion; CDN copies and other devices' browser caches remain separate.

Validation passed **298 unit tests, 127 local Chromium cases (8.8 minutes), and
12 built-app Chromium cases (33.7 seconds)**, including compiled cache clearing
with preserved saved designs. Type checks, Svelte checks, lint, generated-data
consistency, production build and offline deployment validation pass. Focused
unit coverage is 100% lines/branches for cache-generation and 97.60% lines,
86.21% branches, 100% functions for the cache administration server. Browser
cases additionally cover native IndexedDB transactions, cross-tab invalidation,
storage denial, authentication UI, cloud failure/retry and narrow layouts.

Desktop and 320px screenshots were inspected with no horizontal dialog overflow.
The production entry is 51.83 kB gzip (previously 45.93 kB), below the existing
100 kB budget. No runtime dependency was added. R2 credentials are absent in this
checkout; cloud behavior was tested against mocks and no live objects were
deleted. No deployed-cloud latency measurement is claimed.
