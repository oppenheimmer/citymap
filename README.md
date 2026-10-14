# Citymap

Create, customize, share and export city road maps from OpenStreetMap.
The app uses Svelte 5, Vite 8 and TypeScript. Hosting is planned on Vercel for the
frontend/search function and Cloudflare R2 for versioned city datasets. Neither
service is deployed yet; development and local tests work without them.

## Development

Use Node 24 LTS:

```sh
nvm use
npm ci
npm run dev
```

Open `http://localhost:8080`. Copy `.env.example` to `.env.local` for optional
provider settings.
Production search uses public Nominatim with a shared private R2 cache/limiter.
[Set up the R2 buckets `citymap-data` and `citymap-search` and the Vercel project `citymap`](docs/DEPLOYMENT.md).

## Lightweight checks and production build

```sh
npm run check
npm run lint
npm test
npm run data:codegen -- --check
npm run build
npm run deploy:check -- --offline
npm run preview
```

These checks download no browser archives or containers. `npm ci` installs the
locked application/development packages when needed. `build` writes `dist/`.
Static preview does not run `/api/search`; use the dev server
or a Vercel deployment for search.

The renderer and exports load on demand. Workers prepare road geometry and SVG
output. Map and PNG geometry uploads use 1 MiB batches with cancellation between
frames. Complete IndexedDB geometry has size limits and LRU eviction; saved
local designs are stored separately and export as JSON with a restore link.
On phones, controls use a collapsible sheet with accessible cancellation.
Loading shows a progress bar: exact for cached city data, and for any download
that reports its size. Otherwise it shows bytes received, elapsed time and a
warning when the service goes quiet.
Maps default to street-level road detail; footpaths, sidewalks and service ways
are optional, and live loads download only the classes shown. A minimal compass
rose and a railway-style scale bar (whole kilometres or metres above, miles or feet
below, measured at the map centre) can be dragged anywhere on the map; the scale
bar sits below the compass until moved. The map label stays inside the map, moving
in from the edges and, when it is wider than the map, shrinking to fit, on screen and
in exports alike; the design keeps its chosen size for a map with more room. A rotation slider (0–180°, starting at 0°)
turns the map right (clockwise) or left (counter-clockwise) to fill the frame, and
the compass keeps pointing at map north. Links store the turn as one signed angle. Map text (label, compass, scale bar and grid
labels) uses Computer Modern (CMU Serif) by default, Fira Code or sans-serif, and the
label can be bold and italic. Fira Code has no italic design, so its italic is
slanted. The fonts are self-hosted, load only when used, and are embedded in SVG
exports, so the files look the same in any browser. Exports carry both
marks and a 3 px road-colour border, with an optional latitude/longitude grid: ticks
on the border or light grid lines at a chosen opacity, labelled in degrees and
minutes (decimal minutes, never seconds). Labels sit at the tooth tips,
perpendicular to the teeth and upright. Longitudes stay on the top and bottom edges
and latitudes on the sides, swapping past 45° of rotation. Marks and the title that
would cover grid teeth or labels move inward just enough to clear them; a scale bar
that follows the compass moves with it. Exported images
carry no visible OpenStreetMap credit (SVG keeps it in its metadata; the app shows
it in the sidebar footer), so credit OpenStreetMap wherever you share them.
On desktop the options sidebar collapses to a menu button. The map you compose is
the map area with the options (or the phone's sheet) collapsed: opening them shows
that whole map, smaller and centred, with the canvas around it dimmed, and links and
exports keep it, by default at its full size.
Version-1 data sources and older query
links remain supported as data compatibility, without Vue code or dependencies.

## Live roads by map view

With `VITE_LIVE_VIEWPORT=1`, cities without a stored dataset load live roads for
the area on screen instead of one whole-city query, which public Overpass may be
unable to complete for large cities at street detail. A search opens a bounded view
of the city centre; panning and zooming load neighbouring map regions within 50 km
of where the map started, up to four map regions per request, at most one request at a time. Dense regions split; rate limits and a
busy service make loading wait, as long as the service's status page says, with a
countdown; and regions far behind the view are evicted from memory and the GPU.
The centre of the map loads first. Export becomes available once it has loaded and
writes the map available, without waiting for the regions still loading around it.
Only explicitly published favourite cities live in R2.
[How it works, limits, rollout and rollback](docs/LIVE_ROADS.md). The feature is off
by default.

## Local tests without deployed services

With Node 24, installed npm dependencies and an existing browser:

```sh
npm run test:local
```

This runs static checks, lint, focused unit tests and browser workflows against
Vite and a localhost fixture provider. It tests the real local `/api/search`
handler, workers, WebGL, search/loading/cancellation, design controls, sharing,
IndexedDB, and PNG/SVG downloads. Browser requests to outside origins fail the
suite. Provider settings and R2 credentials are overridden for the test servers;
no `.env.local`, deployed services, accounts or browser downloads are required.

Run individual layers or inspect failures:

```sh
npm run test:local:unit
npm run test:local:browser
npm run test:local:browser -- tests/local/exports.spec.ts
npm exec -- playwright show-report playwright-report/local
```

On Linux the local suite detects installed Chromium/Chrome and uses Mesa software
Vulkan when its driver is available. Executable/graphics overrides below also
apply. Tests own ports `8082`, `8091` and proxy `8092`, start and stop both servers, and generate
small/medium/large synthetic fixtures without modifying `dist/`.
[Test design, coverage and troubleshooting](docs/TESTING.md) explains the suite
and separates it from optional data-format and deployment verification.

## Optional production browser checks and performance measurements

The browser suite uses mocked providers and covers rendering, customization,
Unicode labels, PNG/SVG content, cancellation, local caching and R2 integrity.
With a browser already installed:

```sh
npm run build:test
npm run test:browser
npm run build
```

`build:test` generates larger local fixtures and enables the mocked data path.
The final normal build restores production settings. Select Firefox or WebKit with
`PLAYWRIGHT_BROWSER=firefox` or `webkit`. An optional
`PLAYWRIGHT_BROWSER_EXECUTABLE_PATH` selects their installed executable.
For an installed Chromium with the tested Mesa setup:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
PLAYWRIGHT_CHROMIUM_BACKEND=vulkan \
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless npm run test:browser
```

Only install browser archives when bandwidth permits. Normal push/PR CI runs
static/unit/build checks; the browser matrix is requested manually through
**Actions → Checks → Run workflow → browser_checks**.

`npm run benchmark:browser` measures the current build with an installed browser,
defaulting to one small fixture. See [benchmark instructions](docs/benchmarks/README.md).

## City datasets

```sh
npm run data:pilot
npm run data:benchmark
npm run data:extract -- --input /path/to/region.osm.pbf --config /path/to/cities.json
npm run data:build -- --input /path/to/city.json --output .city-data
npm run data:validate -- --output .city-data --manifest <manifest-object-key>
npm run data:publish -- --root .city-data --manifest <manifest-object-key>
npm run data:bundle
```

Monaco ships with the app as a same-origin version-2 dataset in `public/data`, so it
loads in a fraction of a second without R2 or Overpass. Without
`VITE_CITY_DATA_BASE_URL` the app only looks there for bundled cities; every other
city loads live. `npm run data:bundle` regenerates the shipped files.

The default pilot is synthetic; the [real Monaco pilot](docs/benchmarks/20261009-monaco.md)
provides pinned source/selection and format evidence. Extraction is optional
offline tooling with a separate Python reader. Publishing defaults to an offline
plan; actual uploads require real-city input and explicit `--execute`.
[Input/format details](docs/CITY_DATA.md) and
[credentials, publishing and deployment](docs/DEPLOYMENT.md) describe the workflow.

Remaining remote-release work is in [the deployment runbook](docs/DEPLOYMENT.md).
No account resources have been provisioned by the documentation.

## License

Code: [MIT](https://opensource.org/license/mit).
Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
Fonts: CMU Serif (Computer Modern Unicode, Andrey V. Panov et al.) and Fira Code (The
Fira Code Project Authors), each under the [SIL Open Font License 1.1](public/fonts/).
