# Live roads by map view

Citymap can load live OpenStreetMap roads for the area on screen instead of one
query for a whole administrative area. A search opens a bounded view of the place's
centre; panning and zooming load the neighbouring area. The centre of the map loads
first, and an export needs only that: it contains whatever else of its area has loaded. Nothing is stored on a server: only an explicit handful of
favourite cities are published to R2, as before.

The feature is off by default. Set `VITE_LIVE_VIEWPORT=1` at build time to enable
it. Without it, live cities load with one area query as before.

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
| Geometry | `src/lib/live/cell-roads.ts`, `src/workers/cells.worker.ts` | A worker decodes, projects with the session's fixed origin and clips each road to every requested cell of its rank, exactly as if each cell had been fetched alone. Clipping is half-open: a road on a shared edge is drawn by exactly one cell, and roads crossing edges meet exactly. Cells without roads are valid. |
| Scheduler | `src/lib/live/scheduler.ts` | Wanted cells load in priority order: first the centre of the map (cells touching the middle half of the composed map's width and height), major roads before streets; then the rest by distance from the centre, whatever their class. Requests combine the next four queued cells in that order. Queued work for cells that left the view is dropped; a request is aborted only when none of its cells is within two views. A combined request that times out, is too large or fails otherwise retries its cells one by one, and after running out of time or memory later requests combine half as many. Timeouts and oversized responses split only that cell, at most twice. A 429 makes every request wait until the status page says a slot frees (a jittered 5 s backoff when it cannot be read) and never splits. A busy provider (HTTP 502–504) makes every request wait 10, 20, 40 then 60 s, jittered, rather than failing regions. Waits of up to five minutes run by themselves, with a countdown under the map status; a longer one pauses loading. Other unavailable responses get one retry. Five consecutive provider failures, or 600 requests in a session, pause loading until the user retries; a retry still waits out a cooldown that is running. |
| Viewport | `src/lib/live/viewport.ts` | Turns the rotated, padded camera frame into wanted cells (debounced 250 ms, at most once a second while panning). Each loaded cell owns its GPU collections; regions not seen recently are evicted beyond 160 MiB (64 MiB on small devices). Eviction deletes their buffers but keeps the shared shader program (see `tools/renderer-compat.ts`). |
| Browser cache | `src/lib/live/cell-cache.ts` | Optional IndexedDB copies of complete cells: 96 MiB, 72 hours, least recently used first. Keys include the grid version, query schema, provider URL and cell. Stored geometry is translated to the session origin. *Use cached city data* turns it off; *Refresh city data* bypasses it and *Clear city cache* empties it. |
| Start | `src/lib/live/start.ts` | Starts at the search result's centre: 5 km wide for Streets, 2.5 km for All, 30 km for Major, or less for a small place. *Fit map* frames the searched bounds and still loads by view. A drawn bounding box is shown whole. |

Live roads load only within **50 km** of where the map started: the search result's
centre, or the centre of a shared view. A cell whose nearest edge is within the radius
loads whole, so the boundary is approximate. Panning further shows no new roads and
says so, and nothing more is requested. Searching again starts a new 50 km area. This
bounds how much a single session can ever request.

Road detail is cumulative and per rank. Switching from Streets to All requests
only the new classes; switching back requests nothing. Recolouring never
refetches. A view needing more than 36 cells of a rank, such as streets across a
whole metropolis, keeps the coarser ranks and asks the user to zoom in. Nothing
requests hundreds of cells.

**Export** stays unavailable until every cell in the centre of the map has
loaded: the cells touching the middle half of the composed map's width and
height, for every road class shown (`LIVE_LIMITS.core`). The composed map is the
map area with the options collapsed. With them open, roads still load for the
composed map only, not for the dimmed area around it. The map's status says so while it waits.
An export then computes its exact rotated frame and writes whatever of it has
loaded, at once, without waiting for the regions still loading around the
centre. The dialog says **Exported available map.** when any region was
missing. Only an export shaped unlike the view can need more of its centre;
that part loads first (up to 120 cells, with progress and Cancel). If it fails,
or lies beyond the 50 km radius, nothing is exported and the dialog says why.
Road classes too dense to load at the current zoom are left out of the export
rather than drawn in patches. Exports never restart loading or skip a cooldown.

Favourite cities keep the existing path. The roads worker first tries the
bundled or R2 dataset. Only when none applies does it hand over to viewport
loading, so stored and live sources never mix. Links without a location (only
an `areaId`) still use the whole-area query.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_LIVE_VIEWPORT` | unset (off) | `1` loads live roads by map view. |
| `VITE_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass-compatible endpoint; must allow browser CORS. |
| `VITE_OVERPASS_CONCURRENCY` | `1` | Requests in flight per browser session, 1–4, for a private provider. Known public instances (overpass-api.de, kumi.systems, private.coffee, maps.mail.ru) always get 1. |

Limits live in `LIVE_LIMITS` (`viewport.ts`, including the 50 km `radiusMetres`), `CELL_LIMITS` (`overpass.ts`),
`START_METRES` (`start.ts`), `CELL_CACHE` (`cell-cache.ts`) and the cell levels
(`grid.ts`). They are initial values to tune with measurements, not provider
or hardware guarantees. Bump `GRID_VERSION` or `QUERY_SCHEMA` when you change
levels or queries, so stale cached cells are ignored.

## Provider etiquette and capacity

Public Overpass is a shared, rate-limited service, not unlimited production
capacity. The defaults use one request at a time per session, no prefetch beyond
a 15% margin, cancellation, and backoff that honours rate limits. Never
rotate between public endpoints to get around limits. Concurrency is per
browser, not a global limit across users. If real traffic outgrows public
capacity, point `VITE_OVERPASS_URL` at a supported, paid or self-hosted
Overpass-compatible service, or add a rate-limited server proxy. A proxy must
not become an open relay. Keep OpenStreetMap attribution as the app does today.

Development builds log sanitized provider remarks, HTTP status and the
split/retry decision for each failed cell to the browser console as warnings. Raw provider
text never reaches the page. *Load timings* shows regions, segments, first
road time, requests, cache hits, bytes and the median request time.

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

1. With `VITE_LIVE_VIEWPORT=1` in `.env.local`, run `npm run dev`. Then check
   Bhubaneswar by hand against the public provider, using a few requests:
   - Streets: the first view loads, panning fills in neighbours, and Fit map
     asks to zoom in rather than requesting the whole city.
   - The *Load timings* panel shows per-request times.
   - All on a small area: it works, or fails with a retryable message.
   - An export of a few square kilometres succeeds.

   Watch the console for classified remarks.
2. Enable it in a Preview deployment, then Production. Set
   `VITE_LIVE_VIEWPORT=1` and redeploy; `VITE_*` values are compiled into the
   build.
3. Smoke-test a dense megacity, a sparse village, a coast, a city near ±180°,
   a slow mobile connection and a provider 429. Measure requests and errors per
   view before considering a private provider.

**Rollback:** remove `VITE_LIVE_VIEWPORT` (or set `0`) and redeploy. Every city
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
