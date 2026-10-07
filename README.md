# Citymap

Create, customize, share and export city road maps from OpenStreetMap.
The app uses **Svelte 5, Vite 8 and TypeScript**, with worker-based geometry
preparation and the existing WebGL renderer. Vercel serves the frontend and
search function; versioned city datasets are read directly from Cloudflare R2.
See [the modernization plan and progress log](MODERNIZATION_PLAN.md).

## Development

```sh
nvm use
npm ci
npm run dev
```

Use Node 24 LTS. Open `http://localhost:8080`. Explicit city search uses the local
`/api/search` proxy; a small synthetic sample works without provider requests.
Copy `.env.example` to `.env.local` to configure providers. Development uses an
in-memory search cache/limiter. Production public Nominatim requires shared
private R2 state, or configure a managed Nominatim-compatible search provider.

```sh
npm run check
npm run lint
npm test
npm run data:codegen -- --check
npm run build
npm run deploy:check -- --offline
npm run preview
```

`build` produces `dist/`, including only the small sample. The old Vue app is
preserved in Git history at `10584c3`; it is no longer shipped. Road preparation
and SVG export run in workers, the renderer and export UI load on demand, and
optional IndexedDB geometry caching is bounded independently from saved designs.
Legacy query links and configured version-1 caches remain supported.

## Browser validation

```sh
npm exec -- playwright install chromium
npm run build:test
npm run test:browser
```

The test build includes larger synthetic fixtures and a mocked R2 origin;
**use `npm run build` for deployment**. Tests cover customization, pan/zoom,
Unicode labels, PNG/SVG downloads, search/live fallback, sharing/local caching,
cancellation, scene cleanup, missing WebGL, complete R2 loading and corruption.

Optional overrides for a host whose bundled SwiftShader GPU process crashes:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
PLAYWRIGHT_CHROMIUM_BACKEND=vulkan \
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless npm run test:browser
```

These affect tests only and require the indicated browser/Mesa installation.
Local Chromium functional checks pass with software rendering. Set
`PLAYWRIGHT_BROWSER=firefox` or `webkit` to run the same suite after installing
that browser; their local downloads and native GPU checks remain incomplete.

## City-data tooling

```sh
npm run data:pilot
npm run data:benchmark
npm run data:build -- --input tests/fixtures/schema-edges.json --output .city-data/edges
npm run data:validate -- --output .city-data/edges --manifest <manifest-object-key>
```

The pilot builds three **synthetic** grids with no provider requests or uploads.
See the [input contract](docs/CITY_DATA.md) and
[recorded format benchmark](docs/benchmarks/20261007-city-data.md).
Use `npm run data:publish -- --root .city-data --manifest <object-key>` for an
offline publication plan. Ordered uploads, read-back verification, conditional
pointers and complete catalog coverage are regression-tested; see the deployment
guide before using `--execute`.

## Deployment status

The Svelte root app, build and Vercel search endpoint are implemented. Static
checks, unit tests and Chromium workflow checks pass. R2/Vercel provisioning,
real-city extraction, actual delivery checks and cross-browser validation remain
unverified. Publisher failure paths are tested; a [synthetic browser comparison](docs/benchmarks/20261007-browser.md) records the measured improvements and limits. Nothing has been
deployed to an account. See [deployment setup](docs/DEPLOYMENT.md) and the plan's
`RUNNING CHANGES` for current evidence and remaining work.

## License

Code: [MIT](https://opensource.org/license/mit).
Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
