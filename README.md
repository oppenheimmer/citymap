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
provider settings. A small synthetic sample needs no provider connection.
Production search uses public Nominatim with a shared private R2 cache/limiter.
[Set up the R2 bucket and Vercel project, both named `citymap`](docs/DEPLOYMENT.md).

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
locked application/development packages when needed. `build` writes `dist/` with
one small sample. Static preview does not run `/api/search`; use the dev server
or a Vercel deployment for search.

The renderer and exports load on demand. Workers prepare road geometry and SVG
output. Map and PNG geometry uploads use 1 MiB batches with cancellation between
frames. Complete IndexedDB geometry has size limits and LRU eviction; saved
local designs are stored separately and export as JSON with a restore link.
On phones, controls use a collapsible sheet with accessible cancellation.
Version-1 data sources and older query
links remain supported as data compatibility, without Vue code or dependencies.

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
defaulting to one small fixture. See [benchmark instructions](docs/benchmarks/README.md)
and the [historical migration comparison](docs/benchmarks/20261007-browser.md).

## City datasets

```sh
npm run data:pilot
npm run data:benchmark
npm run data:extract -- --input /path/to/region.osm.pbf --config /path/to/cities.json
npm run data:build -- --input /path/to/city.json --output .city-data
npm run data:validate -- --output .city-data --manifest <manifest-object-key>
npm run data:publish -- --root .city-data --manifest <manifest-object-key>
```

The default pilot is synthetic; the [real Monaco pilot](docs/benchmarks/20261009-monaco.md)
provides pinned source/selection and format evidence. Extraction is optional
offline tooling with a separate Python reader. Publishing defaults to an offline
plan; actual uploads require real-city input and explicit `--execute`.
[Input/format details](docs/CITY_DATA.md) and
[credentials, publishing and deployment](docs/DEPLOYMENT.md) describe the workflow.

Implementation, validation evidence and remaining remote-release work are
recorded in [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md). No account resources
have been provisioned by the documentation. Historical source is retained in Git
rather than an extra framework checkout.

## License

Code: [MIT](https://opensource.org/license/mit).
Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
