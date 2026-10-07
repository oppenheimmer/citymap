# Citymap

Create, customize, share and export city road maps from OpenStreetMap.
The app uses Svelte 5, Vite 8 and TypeScript. Vercel serves the frontend and search
function; Cloudflare R2 delivers versioned city datasets.

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
output. Complete IndexedDB geometry has size limits and LRU eviction; saved
local designs are stored separately. Version-1 data sources and older query
links remain supported as data compatibility, without Vue code or dependencies.

## Optional browser checks and performance measurements

The browser suite uses mocked providers and covers rendering, customization,
Unicode labels, PNG/SVG content, cancellation, local caching and R2 integrity.
With a browser already installed:

```sh
npm run build:test
npm run test:browser
npm run build
```

`build:test` generates larger local fixtures and a mock data origin. The final
normal build restores production settings. Select Firefox or WebKit with
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
npm run data:build -- --input /path/to/city.json --output .city-data
npm run data:validate -- --output .city-data --manifest <manifest-object-key>
npm run data:publish -- --root .city-data --manifest <manifest-object-key>
```

The pilot is synthetic and uploads nothing. Publishing defaults to an offline
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
