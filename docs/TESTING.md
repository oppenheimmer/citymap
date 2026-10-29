# Local test design

Citymap's local acceptance suite runs the Svelte application with Vite, the actual
development search handler, road/SVG workers, real WebGL drawing and browser
storage. Search and road providers are deterministic HTTP fixtures on localhost.
Vercel and R2 are not deployed and are not required or contacted by this suite.

The local browser server explicitly selects `VITE_LIVE_VIEWPORT=0` to keep the
whole-area rollback path covered; live-cell cases opt in per page. The built-app
suite uses an empty flag to verify default viewport loading and a cached share-link
revisit with no new road requests. `tests/visibility.test.ts` checks rotated
culling against independent polygon intersection. Browser regressions cover GPU
release/re-upload with retained coordinates and held idle saves around cache
clearing. Exact pre-optimization Monaco coordinate hashes guard road coverage.
Scheduler regressions also check that HTTP 500 failures keep batches together,
all queued cells respect outage waits, and overlapping failures cannot shorten a
cooldown. Load reports retain 20 failures and lifetime request totals across
retries, with URL credentials, queries and provider text omitted. A real browser
downloads a report after HTTP 500 and verifies recovery without request fan-out.
`tests/live-provider-pacer.test.ts` uses a controlled clock and simulated shared
locks/storage to cover success pacing, shared outage waits, cancellation before
and after dispatch, persisted reservations, missing/denied locks, denied storage,
and provider isolation. Browser cases exercise actual Web Locks across tabs,
cache hits during a held network request, cooldown persistence after navigation,
and request spacing when local storage is denied. Only test builds accept
`livePacing=1` to opt the local private mock endpoint into public-style pacing.
Cache-reuse regressions cover an interrupted split with one saved quarter and no
parent record, three missing quarters fetched on return, and an aggregate parent
saved only once complete. Held idle callbacks prove saves finish after a map
switch while cache clearing still invalidates them. Freshness tests preserve
eligible older records, reject future/expired records, show dated older roads
during HTTP 500 without another request, and require network success on refresh.
Scheduler tests cover per-cell outage recovery, misses retaining retry limits,
rate-limit waits remaining intact, and cancellation of pending recovery.

## Run the suite

Use Node 24 (`nvm use`) and the locked dependencies (`npm ci` if needed). The
browser layer requires a working, already installed browser; these scripts never
install browser archives, packages or containers.

```sh
npm run test:local
```

The command runs Svelte/TypeScript checks, ESLint, the selected Node unit files,
then Playwright. It does not run deployment preflight, account checks, publication
or the separate R2 data-contract suites. Lightweight checks can run without any
browser:

```sh
npm run check
npm run lint
npm run test:local:unit
```

For a browser-only run or a focused regression:

```sh
npm run test:local:browser
npm run test:local:browser -- tests/local/search-loading.spec.ts
npm run test:local:browser -- --grep 'export cancellation'
```

Playwright starts the fixture provider on `127.0.0.1:8091`, its browser proxy on
`127.0.0.1:8092`, and Vite on `127.0.0.1:8082`. Keep these ports free. It refuses to reuse an existing server so
an unrelated development process cannot supply different configuration or data.
Both processes stop when the run ends. `npm run dev` can still use port `8080`.
The suite generates ignored small/medium/large fixtures under `public/fixtures/`;
it does not build or replace `dist/`. These synthetic samples exist only in test
builds; a normal `npm run dev` or `npm run build` removes them and shows no
sample controls.

## Coverage and observable results

| Area | Tests | Acceptance evidence |
| --- | --- | --- |
| IDs, boundaries, geometry and links | `tests/app-core.test.ts` | Large IDs remain exact, legacy links restore, invalid ranges are rejected, antimeridian geometry stays connected, missing nodes fail, recorded projection coordinates and complete Unicode designs round-trip. Geographic share views match the projector and restore the same place when the data extent, and so the projection origin, changes, including across the antimeridian. Highway tags map to major/street/other ranks, live queries request only the classes shown, and live geometry is grouped by rank. Export sizes keep the map's shape to the nearest pixel within 256–8192 pixels and 16 megapixels. |
| Bundled cities | `tests/bundled-cities.test.ts`, `tests/roads-worker.test.ts`, `tests/browser/app.spec.ts` | The shipped `public/data` holds exactly the listed cities, each a complete real-city dataset whose pointer, manifest and decoded chunks verify. A bundled-only origin serves its own cities and is never queried for others. The production build loads Monaco from shipped data without the road service. |
| Coordinate grid | `tests/graticule.test.ts` | Whole-degree, whole-minute then decimal-minute intervals; degree/minute labels (never seconds) with hemispheres and antimeridian wrapping; meridians and parallels landing exactly where the rotated map projector draws them; north-up teeth on all four sides; labels at the tooth tips, perpendicular to the teeth and upright at any rotation; one family per edge pair (longitudes top/bottom, latitudes on the sides, swapping past 45°); grid-line opacity; the compass, scale bar and title moving inward clear of teeth and labels, with a following scale bar moving as one group with the compass. |
| Scale bar and marks | `tests/scale-bar.test.ts` | Whole-number 1/2/5 divisions, km to m and mi to ft fallbacks, Mercator ground scale by latitude, end labels inside the mark, marks kept inside the map and the default scale position below the compass, including export scaling. The map label moves in from the edges to stay whole, shrinks to fit a narrower map, scales with exports, and is placed from its measured width. |
| Load progress | `tests/load-status.test.ts` | Known sizes give a determinate bar with bytes, percentage and elapsed time; unknown or exceeded (compressed) sizes stay indeterminate; network stages warn after 15 silent seconds, processing stages never do. |
| Request lifecycle | `tests/request.test.ts`, `tests/response-body.test.ts` | Permanent failures do not retry, transient failures have a bounded retry, rejected response streams are cancelled, long numeric/date cooldowns are respected, cancellation interrupts backoff, deadlines bound response headers but not a body that keeps arriving, stalled bodies fail and cancel, streamed response limits preserve valid bytes. |
| Road worker delivery | `tests/roads-worker.test.ts` | The real worker module runs against a mocked dataset origin. Network/CORS, server and invalid pointer failures fall back to live roads before a revision is selected; a selected revision that fails does not. At most three chunk downloads overlap, chunks arrive in manifest order and each arrives as one buffer per road rank, major roads first. Antimeridian datasets project with their wrapped extent and one origin. |
| Worker ownership and races | `tests/load-city.test.ts` | Completion waits for drawing; cancellation rejects queued and late messages; failed uploads and worker errors terminate processing once; malformed, empty, incomplete or count-mismatched geometry cannot complete a city. |
| Renderer compatibility | `tests/renderer-compat.test.ts` | Installed source/build scheduling cancels pending draws before immediate exports, including Vite query-string URLs; uniform and per-vertex color modes touch only allocated thick-line attributes. Thin/thick uploads use the exact typed-array view and upload unchanged geometry only once. |
| Progressive uploads and cancellation | `tests/local/rendering.spec.ts` | A large map uploads bounded views of at most 1 MiB, major roads first, and draws all 262,144 segments progressively. Hidden road classes upload nothing until shown, then upload once. Held frame callbacks prove map and PNG cancellation stop further batches and release graphics contexts; PNG retry uploads each batch once, including thick-line output. |
| Regional extraction | `tests/extract.test.ts` | Exact E7 selection covers outside-endpoint crossings, holes, coastlines, neighbors, islands and antimeridian geometry. A disk-backed index preserves decimal IDs, complete references and tags, rejects duplicate/missing primitives, and cleans failed/cancelled staging without replacing old city inputs. |
| Real-city delivery and recovery | `tests/local/city-data.spec.ts` | Monaco data arrives as actual HTTP gzip objects, validates ten chunks, all 15,369 SVG segments and actual PNG road pixels, and reopens a pinned revision from the copy saved by the unpinned load without downloads. Corrupt decoded bytes fail without fallback/export; explicit retry reloads immutable HTTP bytes. A 503 or CORS-less pointer falls back to live roads. Switching road detail needs no downloads, and exports contain exactly the shown classes (Monaco: 2,741 major, 5,383 streets, 15,369 all segments). A quarter-turn rotation swaps the exported road drawing's proportions. |
| Mobile sheet and portable settings | `tests/local/mobile-settings.spec.ts`, `tests/design-file.test.ts` | The sheet scrolls independently, opens over the map and collapses to uncover it without resizing it, and keeps Cancel available; failures reopen controls. The map fills the screen above the collapsed sheet's strip, and links and the default export size keep the map shown. Saved-settings JSON preserves Unicode, view, palette and pinned identity with a working restore link. |
| Search and loading | `tests/local/search-loading.spec.ts` | Real `/api/search` validates methods/queries/headers and identifies the provider request; explicit search, normalized caching, ambiguous typed results, stale searches, empty/malformed/busy responses, node/custom/antimeridian bounds and retry/cancellation recover correctly. All three sample sizes report complete segment counts without providers. Automatic live links ask before downloading. A download that reports its size shows a determinate bar with bytes and percentage; a silent wait shows an indeterminate bar, a running timer and Cancel. |
| Design, scene and accessibility | `tests/local/design-scene.spec.ts` | Presets/colors/opacity with visible slider percentages and label size, Unicode labels, pointer and keyboard placement, clamps, zoom in/out, pan/fit/resize, view sharing (including after the road extent changes) and saved designs restore; no recent-city list is shown. Live loads download only the shown road detail and fetch again only for more detail. The compass rose and scale bar drag and move with arrow keys, the scale bar follows the compass until moved, positions restore from links, the scale bar shows whole-number km/m and mi/ft teeth that change with zoom, and both appear in exports and can be hidden. The rotation slider starts at 0° and, with a Right/Left choice, turns the map and the compass together either way (stored as −180° to 180°), keeps the view, survives links and exports, and resets to 0° turning right for a new city. A label pushed to the edge stays whole, and one wider than the map shrinks to fit, on screen and in the SVG, while links keep its chosen size. The options sidebar opens over the full-width map and collapses to a menu button with focus handed between the toggles; the map, its label and its view never change with it, links and the default export size keep the map shown, and a window resized to the phone layout and back restores the same map. Map attribution is only in the sidebar and exports. No-WebGL, worker denial and context loss report usable errors. Repeated switching leaves one live graphics context and no live load workers. Narrow touch emulation covers DPR scaling, overflow, dialog focus/Escape and browser zoom shortcuts. |
| Persistence failures and bounds | `tests/local/storage.spec.ts` | Storage denial/quota/malformed histories do not block rendering/sharing; corrupt geometry downloads again; typed-array subviews persist exactly; incomplete/oversized cities are refused; LRU eviction and the saved-design limit hold. Cache clearing preserves designs and refresh/cache opt-out download again. |
| Live cells | `tests/live-grid.test.ts`, `tests/live-overpass.test.ts`, `tests/live-cell-roads.test.ts` | Cell rectangles match the scene projector; neighbours share exact edges; levels keep similar ground size by latitude; covers are centre-first, stable under small pans, exact for rotated frames and bounded; antimeridian cells wrap to valid columns and draw beside the origin; polar views clamp. Each rank's Overpass filter selects exactly the classes `roadRank` assigns; queries are bounded bbox queries with outward-rounded edges, and combined queries union each cell's own statement with 10 s more per added cell. HTTP statuses (502–504 as a busy provider), 200 `remark` timeouts, oversized bodies, invalid JSON, cancellation and deadlines become typed failures with sanitized remarks. A 429 reads the wait from the provider's status page (free slots or the soonest slot), and an unreadable page leaves the wait to backoff. Clipping is half-open: crossing roads meet exactly without gaps or duplicates and a road on a shared edge is drawn once; other ranks are dropped; empty cells are valid; corrupt data fails. |
| Live scheduling and handover | `tests/live-scheduler.test.ts`, `tests/live-viewport-units.test.ts`, `tests/roads-worker.test.ts`, `tests/renderer-compat.test.ts` | A fake clock proves priority order with one request at a time, no duplicate requests, dropped and aborted work for cells leaving the view, bounded quartering of dense cells, rate limits that wait (Retry-After, the status page or backoff) without splitting, a busy provider waiting 10, 20, 40 then 60 s before pausing, waits of up to five minutes run without pausing, one retry for an unavailable provider, a pause after repeated failures, an explicit retry that still waits out a running cooldown, a session request budget, cache lookups before requests and silence after disposal. With a fake scene and worker, the centre of a view (major roads, then streets) is requested before the rest, which follows by distance whatever its class; the map becomes exportable once the centre has loaded, and an export then selects at once, requesting nothing, the regions of its frame at every class shown, including classes too dense to load after zooming out; a region still being drawn makes it incomplete. Zoomed out too far for any class to load, the map is exportable at once unless its centre is beyond 50 km. When memory runs short, regions out of view are evicted before those in view, including streets too dense to load after zooming out. Requests combine the next cells in priority order with one result per cell; a combined request that runs out of time, or is invalid, retries its cells alone (then splits), and later requests combine fewer; a rate limit on one counts once and repeats it; it runs on while any of its cells is wanted or retained. The real cells worker returns clipped segments and typed failures, and one request for several cells keeps each cell's own rank, clipped so that roads meet exactly at shared edges. Searched places start at a bounded view of their centre; cached cells translate between origins. The roads worker hands over to viewport loading only after stored datasets are tried, and classifies remarks with a development diagnostic. Each renderer program can release only its own buffers, keeping the shared shader program. |
| Live roads in the browser | `tests/local/live-viewport.spec.ts` | Opted in per page with `?liveMode=viewport` (test builds only; `liveBudget` shrinks the memory budget). The fixture provider answers cell queries with synthetic meridians and parallels per rank, including streets along cell edges. A search loads a bounded set of cells, never an area query, with up to four cells per request and no cell requested twice. The fixture provider answers combined queries with each road once across the boxes it crosses. Panning loads only new cells; panning back, zoom oscillation and restyling request nothing. A zoomed-out view keeps major roads and asks to zoom in. Detail upgrades fetch only new classes. A fully loaded view exports every road, and in the SVG every road runs edge to edge in pieces that join exactly. Dense cells split into quarters, after the combined request holding them retries its cells alone; rate limits repeat the request unsplit. A rate limit waits as long as the fixture status page says, with a countdown, and a busy (504) provider makes every request wait with a countdown instead of failing regions. Failed regions in the centre keep loaded roads and keep Export unavailable until retry recovers. Export waits only for the centre of the map, then exports the map available around it and says *Exported available map.* After zooming out past the street and footpath limits, an export keeps the streets and footpaths already loaded, its PNG matches the screen's roads, and nothing more is requested. Zoomed out too far for even major roads to load, Export writes the roads drawn, until the centre of the map is beyond 50 km. With a tiny budget, distant regions are evicted, GPU buffers are deleted and plateau, and evicted cells reload. Share links restore the view; the browser cache serves revisits, refresh refetches and clearing empties it; switching cities aborts live requests. Panning past 50 km from the start requests nothing beyond the radius, says why, and keeps Export unavailable there. |
| Downloaded content and failures | `tests/local/exports.spec.ts` | The chosen typeface (Computer Modern by default, Fira Code or sans-serif) loads from the app itself, styles the on-screen label and marks and every SVG text, travels inside SVGs as embedded font faces (none for sans-serif; Fira Code's italic slants its upright faces), and changes the PNG; bold and italic labels reach the screen, links, SVG attributes and PNG; PNG signatures, dimensions and actual road pixels; opaque/transparent interiors inside a 3 px road-colour border; none/border-tick/grid-line coordinate grids with labels and opacity, and no on-image map credit (SVG metadata keeps it); valid SVG with all 512 small-fixture segments, escaped Unicode, palette/opacity and map-data attribution; safe filenames; width and height that keep the map's shape as either is typed, move out-of-range or emptied sizes to the nearest that fits and follow a window that changes shape; cancellation of an active SVG worker; canvas/encoding/font failures without empty downloads or loss of the map. |

Each browser test gets a fresh context with empty storage. A single worker owns
the mutable fixture provider, reset before each case; do not override `--workers`
to run these scenarios concurrently. Provider controls support failed statuses,
malformed bodies, delays, a bounded number of transient failures, timeouts for
cells wider than a `dense` span, and `match` to apply a scenario only to queries
containing given text. Request
logs prove caching, queries and retry counts rather than assuming they occurred.
Race tests use held promises/messages or wait for provider requests before
cancelling. Assertions wait for observable state rather than arbitrary sleeps.

The browser uses an allowlist HTTP proxy in `tests/support/provider-proxy.ts`.
It forwards only the two fixture destinations, rejects outside HTTP/CONNECT
targets before opening upstream connections, and records violations for
`tests/support/local.ts`. Each context proves the proxy blocks another loopback
port; unhandled page exceptions also fail the case. Page/worker request events
identify application attempts outside those origins and fail the case. The proxy
also blocks browser-owned background probes, which Chromium performs before app
navigation; those do not count as application traffic. Service workers are blocked.
This preserves native cancellation: Playwright's Firefox request interception
was observed to keep an upstream request alive after abort. Held responses prove
Cancel, Escape and switching each abort an active request; a worker
acknowledgement precedes bounded termination.
The test server configuration overrides public provider URLs, private
R2 settings and keys from the shell or local env files. The search handler uses
its in-memory development cache and a fixture search endpoint; road workers use
the fixture Overpass endpoint. The dataset origin serves real-city fixture
objects with gzip/cache headers. No production search/provider traffic is needed.

## Browsers and troubleshooting

The local configuration detects common Linux Chromium/Chrome paths. When an
installed Chromium and `/usr/share/vulkan/icd.d/lvp_icd.x86_64.json` are available,
it selects Mesa software Vulkan, used to avoid the documented SwiftShader crash
on this host. Override explicitly when needed:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
PLAYWRIGHT_CHROMIUM_BACKEND=vulkan \
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless npm run test:local:browser
```

For other already installed Playwright-compatible runtimes:

```sh
PLAYWRIGHT_BROWSER=firefox \
PLAYWRIGHT_BROWSER_EXECUTABLE_PATH=/path/to/firefox npm run test:local:browser
PLAYWRIGHT_BROWSER=webkit \
PLAYWRIGHT_BROWSER_EXECUTABLE_PATH=/path/to/webkit-launcher npm run test:local:browser
```

If no supported system browser is detected, Playwright uses its existing browser
cache. Missing executables/libraries, unsupported WebKit host libraries or
incompatible graphics backends fail visibly; tests do not skip WebGL checks to
turn an environment failure into a pass. Install browsers only when desired and
bandwidth permits. Restricted execution environments must allow launching the
browser and binding the two loopback servers.

The HTML report, failed-run traces, and downloaded PNG/SVG attachments help
inspect output and failures:

```sh
npm exec -- playwright show-report playwright-report/local
npm exec -- playwright show-trace test-results/local/<failed-test>/trace.zip
```

These output directories are ignored by Git. PNG/SVG content tests attach the
actual downloaded files to the report.

## Other verification layers

`npm test` retains all offline unit/data/publisher contract tests. Those use
local files and fake storage/fetches, not deployed accounts. `npm run build:test`
followed by `npm run test:browser` exercises the separate production-preview
suite, including mocked versioned R2 data integrity. Neither command establishes
real CDN delivery. Rebuild with `npm run build` before deployment.

Normal push/PR CI runs static, unit, codegen, build and offline artifact checks
without downloading browsers. Explicit workflow dispatch with `browser_checks`
installs the Chromium/Firefox/WebKit matrix and runs both local and
production-preview browser suites, retaining failure artifacts.

The agreed local touch-device verification uses tested browser touch emulation.
Functional software rendering and touch emulation do not establish native GPU
performance, physical-device accessibility or deployed Vercel/R2
behavior. Deployed search, real provider availability, dataset uploads, CORS and
CDN headers remain separate release work in [the deployment runbook](DEPLOYMENT.md).
Performance measurements have their own [benchmark workflow](benchmarks/README.md).
