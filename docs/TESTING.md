# Local test design

Citymap's local acceptance suite runs the Svelte application with Vite, the actual
development search handler, road/SVG workers, real WebGL drawing and browser
storage. Search and road providers are deterministic HTTP fixtures on localhost.
Vercel and R2 are not deployed and are not required or contacted by this suite.

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

Playwright starts the fixture provider on `127.0.0.1:8091` and Vite on
`127.0.0.1:8082`. Keep these ports free. It refuses to reuse an existing server so
an unrelated development process cannot supply different configuration or data.
Both processes stop when the run ends. `npm run dev` can still use port `8080`.
The suite generates ignored small/medium/large fixtures under `public/fixtures/`;
it does not build or replace `dist/`. A normal `npm run dev` or `npm run build`
regenerates only the production small sample.

## Coverage and observable results

| Area | Tests | Acceptance evidence |
| --- | --- | --- |
| IDs, boundaries, geometry and links | `tests/app-core.test.ts` | Large IDs remain exact, legacy links restore, invalid ranges are rejected, antimeridian geometry stays connected, missing nodes fail, recorded projection coordinates and complete Unicode designs round-trip. |
| Request lifecycle | `tests/request.test.ts`, `tests/response-body.test.ts` | Permanent failures do not retry, transient failures have a bounded retry, rejected response streams are cancelled, long numeric/date cooldowns are respected, cancellation interrupts backoff, deadlines abort fetches, streamed response limits preserve valid bytes. |
| Worker ownership and races | `tests/load-city.test.ts` | Completion waits for drawing; cancellation rejects queued and late messages; failed uploads and worker errors terminate processing once; malformed, empty, incomplete or count-mismatched geometry cannot complete a city. |
| Renderer compatibility | `tests/renderer-compat.test.ts` | Installed source/build scheduling cancels pending draws before immediate exports, including Vite query-string URLs; uniform and per-vertex color modes touch only allocated thick-line attributes. Thin/thick uploads use the exact typed-array view and upload unchanged geometry only once. |
| Progressive uploads and cancellation | `tests/local/rendering.spec.ts` | A large map uploads four exact 1 MiB views and draws all 262,144 segments progressively. Held frame callbacks prove map and PNG cancellation stop further batches and release graphics contexts; PNG retry uploads each batch once, including thick-line output. |
| Search and loading | `tests/local/search-loading.spec.ts` | Real `/api/search` validates methods/queries/headers and identifies the provider request; explicit search, normalized caching, ambiguous typed results, stale searches, empty/malformed/busy responses, node/custom/antimeridian bounds and retry/cancellation recover correctly. All three sample sizes report complete segment counts without providers. Automatic live links ask before downloading. |
| Design, scene and accessibility | `tests/local/design-scene.spec.ts` | Presets/colors/opacity, Unicode labels, pointer and keyboard placement, clamps, zoom in/out, pan/fit/resize, camera sharing, saved designs and recents restore. No-WebGL, worker denial and context loss report usable errors. Repeated switching leaves one live graphics context and no live load workers. Narrow touch emulation covers DPR scaling, overflow, dialog focus/Escape and browser zoom shortcuts. |
| Persistence failures and bounds | `tests/local/storage.spec.ts` | Storage denial/quota/malformed histories do not block rendering/sharing; corrupt geometry downloads again; typed-array subviews persist exactly; incomplete/oversized cities are refused; LRU eviction and history limits hold. Cache clearing preserves designs and refresh/cache opt-out download again. |
| Downloaded content and failures | `tests/local/exports.spec.ts` | PNG signatures, dimensions and actual road pixels; opaque/transparent corners; valid SVG with all 512 small-fixture segments, escaped Unicode, palette/opacity and map-data attribution; safe filenames; dimension/pixel budgets; cancellation of an active SVG worker; canvas/encoding/font failures without empty downloads or loss of the map. |

Each browser test gets a fresh context with empty storage. A single worker owns
the mutable fixture provider, reset before each case; do not override `--workers`
to run these scenarios concurrently. Provider controls support failed statuses,
malformed bodies, delays and a bounded number of transient failures. Request
logs prove caching, queries and retry counts rather than assuming they occurred.
Race tests use held promises/messages or wait for provider requests before
cancelling. Assertions wait for observable state rather than arbitrary sleeps.

`tests/support/local.ts` blocks and records browser HTTP requests outside the two
localhost origins and fails on unhandled page exceptions. Service workers are
blocked. The test server configuration overrides public provider URLs, private
R2 settings and keys from the shell or local env files. The search handler uses
its in-memory development cache and a fixture search endpoint; road workers use
the fixture Overpass endpoint. No production search/provider traffic is needed.

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
PLAYWRIGHT_BROWSER=webkit npm run test:local:browser
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

Functional software rendering and touch emulation do not establish native GPU
performance, peak memory, physical-device accessibility or deployed Vercel/R2
behavior. Deployed search, real provider availability, dataset uploads, CORS and
CDN headers remain separate release work in [the deployment runbook](DEPLOYMENT.md).
Performance measurements have their own [benchmark workflow](benchmarks/README.md).
