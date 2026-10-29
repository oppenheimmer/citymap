# Live roads by map view

Citymap can load live OpenStreetMap roads for the area on screen instead of one
query for a whole administrative area. A search opens a bounded view of the place's
centre; panning and zooming load the neighbouring area. The centre of the map loads
first, and an export waits only for that: it contains exactly the roads drawn on screen. Nothing is stored on a server: only an explicit handful of
favourite cities are published to R2, as before.

Viewport loading is the default. Set `VITE_LIVE_VIEWPORT=0` at build time to
restore whole-area loading. Stored datasets remain preferred in either mode.

## Why

A whole-city query is one large request. Bhubaneswar loads at **Major roads** but
fails at **Streets** after about 20 MB with the provider's generic error, while
a smaller bounding box at Streets works. Larger server limits or another endpoint
would not change the shape of the problem: per-request cost grows with the city,
and an append-only scene grows for as long as someone keeps panning. Viewport
loading bounds both.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Cell grid | `src/lib/live/grid.ts` | Web Mercator tiles as query units. Each road rank has its own level: about 20 km for major roads, 5 km for streets, 2.4 km for every way, coarser towards the poles so ground size stays similar. Tile columns end at ±180°, so no cell crosses the antimeridian. |
| Queries | `src/lib/live/overpass.ts` | One rank per cell, `way[filter](s,w,n,e)`. A request combines up to four cells in one union, `(…;…;);out geom qt;`, so a road several of them share downloads once; it allows `[timeout:30]` plus 10 s per added cell, and `[maxsize:64 MiB]`. The filters match `roadRank()` exactly, so ranks never overlap. Responses are capped at 32 MiB. Every failure is typed, including timeouts reported as a `remark` inside HTTP 200, and HTTP 502–504, Overpass's "too busy". After a 429 the worker reads the provider's status page (`…/api/status`, beside the interpreter), which browsers can read although they cannot read `Retry-After`, for when a slot frees. Only its slot lines are parsed; nothing else in it is kept. |
| Geometry | `src/lib/live/cell-roads.ts`, `src/workers/cells.worker.ts` | A worker scans and projects each selected way once, then clips it to the requested cells of its rank. Whole-way bounds skip irrelevant clipping. The session uses one fixed origin. Clipping is half-open: a shared-edge road is drawn by exactly one cell and crossing roads meet exactly. Empty cells are valid. |
| Shared provider queue | `src/lib/live/provider-pacer.ts` | Public-provider viewport requests use one queue per provider origin across map sessions and same-origin tabs. Web Locks serialize requests; a stored reservation protects reloads. A response can be drawn before the following pause finishes. Cached cells bypass the queue. |
| Scheduler | `src/lib/live/scheduler.ts` | Wanted cells load in priority order: first the centre of the map (cells touching the middle half of its width and height), major roads before streets; then the rest by distance from the centre, whatever their class. Requests combine the next four queued cells in that order. Queued work for cells that left the view is dropped; a request is aborted only when none of its cells is within two views. A combined request that times out, is too large or has invalid query/data retries its cells one by one, and after running out of time or memory later requests combine half as many. Timeouts and oversized responses split only that cell, at most twice. A 429 makes every request wait until the status page says a slot frees (a jittered 5 s backoff when it cannot be read) and never splits. A busy provider (HTTP 502–504) makes every request wait 10, 20, 40 then 60 s, jittered, rather than failing regions. Waits of up to five minutes run by themselves, with a countdown under the map status; a longer one pauses loading. Unavailable or unreachable providers keep batches together and delay all queued cells, with one retry per cell. Five consecutive provider failures, or 600 requests in a session, pause loading until the user retries; a retry still waits out a cooldown that is running. |
| Viewport | `src/lib/live/viewport.ts` | Turns the rotated, padded camera frame into wanted cells (debounced 250 ms, at most once a second while panning). Each loaded cell owns its GPU collections. Beyond 160 MiB (64 MiB on small devices) regions are evicted, least recently seen first: those out of view go first, regions in view of classes too dense to load at this zoom only when nothing else is left, and regions loading in view never. Eviction deletes their buffers but keeps the shared shader program (see `tools/renderer-compat.ts`). |
| Browser cache | `src/lib/live/cell-cache.ts` | Optional IndexedDB copies of complete cells: 96 MiB, 72 hours, least recently used first. Keys include the grid version, query schema, provider URL and cell. Stored geometry is translated to the session origin. *Use cached city data* turns it off; *Refresh city data* bypasses it and *Clear city cache* empties it. |
| Start | `src/lib/live/start.ts` | Starts at the search result's centre: 5 km wide for Streets, 2.5 km for All, 30 km for Major, or less for a small place. *Fit map* frames the searched bounds and still loads by view. A drawn bounding box is shown whole. |

The renderer skips collections outside the rotated frame, including stroke
padding. It budgets estimated GPU road buffers separately: 80 MiB for desktop
live scenes and 32 MiB on small devices, half the raw-geometry budget above.
Offscreen GPU buffers are released least recently drawn first while their CPU
coordinates remain available. Revisiting those coordinates re-uploads them
without a request. Visible geometry stays protected, so these are soft budgets,
not limits on total browser/driver memory. Other scenes default to 64 MiB for GPU
road buffers. Pending live uploads above 8 MiB delay further requests until
drawing catches up. Complete-city worker delivery is limited to two prepared
buffers awaiting drawing. Clearing either browser cache invalidates old delayed
saves within the page, so they cannot put cleared records back.

Live roads load only within **50 km** of where the map started: the search result's
centre, or the centre of a shared view. A cell whose nearest edge is within the radius
loads whole, so the boundary is approximate. Panning further shows no new roads and
says so, and nothing more is requested. Searching again starts a new 50 km area. This
bounds how much a single session can ever request.

Road detail is cumulative and per rank. Switching from Streets to All requests
only the new classes; switching back requests nothing. Recolouring never
refetches. A view needing more than 36 cells of a rank, such as streets across a
whole metropolis, stops requesting that rank and asks the user to zoom in. Roads
already loaded stay visible, and exports include them; when memory runs short, regions
out of view are evicted before them. Nothing requests hundreds of cells.

**Export** stays unavailable until every cell in the centre of the map has
loaded and been drawn: the cells touching the middle half of the map's width and height, for
every road class shown that loads at this zoom (`LIVE_LIMITS.core`). The options
open over the map without resizing it, so roads load for the whole map, including
the part they cover. The map's status says so while it waits. Zoomed out too far
for any road class shown to load, the map has no centre to wait for: Export is
available at once, unless the centre of the map lies beyond the 50 km radius.
An export has the map's shape and contains exactly the roads drawn on screen when
the download starts, in its exact rotated frame: every road class shown, including
detail loaded during earlier pans or closer views and classes too dense to load at
this zoom. Roads not loaded by then, such as regions waiting on a busy road service,
are left out, and the dialog says **Exported available map.** Exports never request
roads, restart loading or skip a cooldown.

Favourite cities keep the existing path. The roads worker first tries the
bundled or R2 dataset. Only when none applies does it hand over to viewport
loading, so stored and live sources never mix. Links without a location (only
an `areaId`) still use the whole-area query.

## Keeping useful browser data

Completed quarters of a split cell are saved independently. When an interrupted
view is reopened, the parent may need another resource-limit response before it
splits, but completed quarters then load from the browser instead of downloading
again. A parent record is saved only when every quarter is ready. Deferred saves
registered before a map closes can finish afterward; new saves on a closed
session are rejected. Clearing the cache invalidates registered saves and replies
from requests dispatched before the clear.

Cells are fresh for 72 hours. Older valid records stay within the same 96 MiB LRU
budget for at most 30 days. They are used only after a rate limit, busy/unavailable
provider or connection failure, or while that outage's cooldown is already known.
They never hide invalid queries, malformed data or resource failures. The map
marks older roads, shows their oldest download date and records them in the load
report. Reading a record does not change its download date. A mixed-age parent
keeps its oldest child's date. **Refresh city data** and disabling the cache skip
this fallback and require a fresh response.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_LIVE_VIEWPORT` | unset (on) | Unset or `1` loads live roads by map view; `0` restores whole-area loading. |
| `VITE_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass-compatible endpoint; must allow browser CORS. |
| `VITE_OVERPASS_FALLBACK_URL` | unset (off) | One optional independent backup for connection failures or HTTP 500/501; uses the existing delayed retry. Absolute HTTPS URL (localhost HTTP allowed for tests). |
| `VITE_OVERPASS_CONCURRENCY` | `1` | Requests in flight per browser session, 1–4, for a private provider. Known public instances (overpass-api.de, kumi.systems, private.coffee, maps.mail.ru) always get 1. |

Limits live in `LIVE_LIMITS` (`viewport.ts`, including the 50 km `radiusMetres`), `CELL_LIMITS` (`overpass.ts`),
`START_METRES` (`start.ts`), `CELL_CACHE` (`cell-cache.ts`) and the cell levels
(`grid.ts`). They are initial values to tune with measurements, not provider
or hardware guarantees. Bump `GRID_VERSION` or `QUERY_SCHEMA` when you change
levels or queries, so stale cached cells are ignored.

## Provider etiquette and capacity

Public Overpass is a shared, rate-limited service, not unlimited production
capacity. Viewport requests use one request at a time per public provider across
map sessions and same-origin tabs, no prefetch beyond a 15% margin, cancellation,
and backoff that honours rate limits. Never rotate between public endpoints to
get around limits. This is not a global limit across users, browsers or devices.
If real traffic outgrows public
capacity, point `VITE_OVERPASS_URL` at a supported, paid or self-hosted
Overpass-compatible service, or add a rate-limited server proxy. A proxy must
not become an open relay. Keep OpenStreetMap attribution as the app does today.

After a successful request the queue pauses for roughly its elapsed time, with
jitter and a 1–60 second bound. This reduces bursts; elapsed time includes
transport and background processing and is not a measurement of provider CPU.
Provider failures share backoff and readable Retry-After, including across new
maps. Drawing a completed response never waits for this pause. Browser-cache
lookups happen first and are not held behind the network queue.

Before dispatch, the queue stores a reservation for the query timeout plus
50 seconds (header/body allowance). An aborted request keeps that reservation:
switching cities or reloading cannot immediately assume the upstream query has
stopped. This can delay the next uncached view by up to 110 seconds for a
four-cell request. Cached views remain available. The failure report records
time spent waiting for the queue separately from successful fetch times.

Web Locks and local storage provide coordination across same-origin tabs and
reloads. With storage denied the lock stays held through the pause; reload
protection then cannot persist. Without usable Web Locks, maps within one page
still share pacing, but simultaneous tabs cannot be serialized. Clearing road
geometry does not clear provider cooldowns. These changes apply to viewport
loading; the explicit whole-area rollback and old area-only links retain their
existing request path. Private endpoints retain configured concurrency.

Development builds log sanitized provider remarks, HTTP status and the
split/retry decision for each failed cell to the browser console as warnings. Raw provider
text never reaches the page. *Load timings* shows regions, segments, first
road time, requests, cache hits, bytes and the median request time. Its last
failure includes a plain-language reason and HTTP status when available.
*Download load report* saves these counters and the most recent 20 failures as
JSON. Request totals include attempts before an explicit retry. Reports omit
queries, map coordinates, provider URL paths/credentials and response text.

HTTP 500 responses and connection failures keep combined cells together and make
all queued requests wait, including cells not yet attempted. They back off from
2 seconds, doubling to 60 seconds with jitter, or honour a readable Retry-After.
An individual cell still gets only one extra attempt. This prevents one outage
from immediately expanding into separate requests for every cell.

## Optional backup provider

Set `VITE_OVERPASS_FALLBACK_URL` to an independent Overpass-compatible endpoint
that permits your app's use. It is empty by default. After a connection failure
or HTTP 500/501, the scheduler's existing delayed retry may use this backup.
Successful browser-cache recovery sends no backup request. A session switches at
most once and stays on the backup, including explicit retries; it never races
providers or adds retry attempts. Enabling a backup limits that session to one
request at a time. Known public endpoints retain shared pacing.

Rate limits, HTTP 502–504 busy responses, readable Retry-After, resource/query/data
errors, background-processing failures and cancellations do not trigger a switch.
The original cooldown still applies. Fresh cache lookups try both configured
providers; outage recovery prefers fresh data over older data. Each cell keeps
its actual provider URL in its cache key. Split parents containing multiple
providers are not saved as if all their data came from one provider. Reports show
sanitized source origins, request totals per origin and actual switch counts.

[Private.coffee](https://overpass.private.coffee/) publishes the interpreter
`https://overpass.private.coffee/api/interpreter` and asks for efficient POST
queries and limited concurrency. Its old `overpass.kumi.systems` name is the same
service, not an independent backup. The
[OpenStreetMap instance list](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)
also lists `https://maps.mail.ru/osm/tools/overpass/api/interpreter` from VK Maps.
Check an operator's current terms and reachability before configuring it. Direct
status probes from this workspace timed out on 2026-10-29 (20 s Private.coffee,
15 s VK Maps); no real road queries were sent, and live browser CORS/availability
was not verified. Local tests verify failover mechanics, not public reliability.
The main service's individual nodes and aliases of Private.coffee are rejected
as duplicate backup choices. The main operator's
[guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)
does not recommend cycling its nodes to spread load.

## When loading pauses

After five consecutive provider failures, loading pauses until the user selects
*Retry loading roads*. The status names the reason:

- **Cannot be reached:** the connection was refused or blocked, or the browser
  withheld the response (CORS). Check that this machine can reach the provider,
  for example with
  `curl -A 'citymap check' https://overpass-api.de/api/status` (the public
  instance refuses clients that do not identify themselves). Overpass instances can refuse
  addresses after heavy use; such a block usually lifts after a while. Moving
  the same traffic to another public instance only to get around a block is
  against their usage policies. A firewall on your own network is a different
  case: use a reachable instance, or your own, in `VITE_OVERPASS_URL`.
- **Busy:** rate limited (HTTP 429) beyond a five-minute wait. Wait, then retry.
- **Too busy right now:** HTTP 502–504 five times in a row, across waits of 10
  to 60 s. Retry later.
- **Overloaded or too dense:** cells kept timing out even after splitting. Zoom
  in, or retry later.
- **Not responding:** server errors or no response before the deadline.

## Rollout

1. With the default configuration, run `npm run dev`. Then check
   Bhubaneswar by hand against the public provider, using a few requests:
   - Streets: the first view loads, panning fills in neighbours, and Fit map
     asks to zoom in rather than requesting the whole city.
   - The *Load timings* panel shows per-request times.
   - All on a small area: it works, or fails with a retryable message.
   - An export of a few square kilometres succeeds.

   Watch the console for classified remarks.
2. Verify a Preview deployment before Production. Leave
   `VITE_LIVE_VIEWPORT` unset or set `1`; `VITE_*` values are compiled into the
   build.
3. Smoke-test a dense megacity, a sparse village, a coast, a city near ±180°,
   a slow mobile connection and a provider 429. Measure requests and errors per
   view before considering a private provider.

**Rollback:** set `VITE_LIVE_VIEWPORT=0` and redeploy. Every uncached city
then loads with one area query again; links, designs and R2 datasets are
unaffected. Keep the whole-area path for at least one release after enabling.

## Not yet done

- No measured Bhubaneswar baseline: the automated suite never calls public
  Overpass. Record request counts and times during the rollout smoke test above.
- Limits are untuned initial values.
- One-ring prefetch is not implemented. Enable it only for a private provider,
  after measurement.
- Combining cells cuts requests (a first Streets view of the fixture city: 4
  requests for 13 cells), but whether it also means fewer 429s on the public
  instance, which may charge an address by server time, is unmeasured. Watch the
  status page during the rollout smoke test.
