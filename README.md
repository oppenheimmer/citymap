# Citymap

Visualize city roads using OpenStreetMap data and WebGL.

The root app still uses Vue 3 and Vite 2. An in-progress Svelte 5, Vite 8,
and TypeScript replacement lives in `prototype/`; see
[the migration plan and status log](MODERNIZATION_PLAN.md). Hosting targets are
Vercel for the frontend/search function and Cloudflare R2 for versioned datasets.
This is a development checkpoint, **not a deployment-ready release**.

## Development

```sh
nvm use
npm ci
npm run prototype:install
npm run dev
npm run build
npm run preview
```

Use Node 24 LTS (also selected for CI and Vercel). Development and preview run at
`http://localhost:8080`. The combined build serves Vue at `/` and the Svelte
prototype at `/prototype/`. Both dependency installs above are required to build.
For Svelte development, use `npm run prototype:dev` and open
`http://localhost:8081/prototype/`. Native Node TypeScript support runs the data
tools; `data:check` performs their separate static type check.

Road data loads through Overpass. An optional protobuf cache can be configured
with `VITE_AREA_SERVER`; no cache endpoint is configured by default.

## City-data tooling and checks

```sh
npm run data:codegen -- --check
npm run data:check
npm test
npm run data:pilot
npm run data:benchmark
```

The pilot generates and validates three **synthetic** road grids in `.city-data/`.
It makes no provider requests or uploads. The benchmark compares version 1,
version-2 single files, and independent chunks. See the
[input contract and local commands](docs/CITY_DATA.md),
[recorded benchmark](docs/benchmarks/20261007-city-data.md), and
[R2/Vercel deployment setup](docs/DEPLOYMENT.md).

The root Vue UI reads version 1. The prototype implements worker loading for
`VITE_CITY_DATA_BASE_URL` version-2 manifests/chunks, the optional version-1
`VITE_AREA_SERVER`, and live Overpass. It also contains local geometry caching,
complete design links, saved designs, customization, and PNG/SVG export.
Browser parity is not yet established.

## Migration checkpoint: October 7, 2026

- Local generator/codegen checks, TypeScript checks, 43 unit cases, Svelte checking,
  and both production builds pass on Node 24.21.0.
- Browser validation remains blocked by WebGL context loss during map loading;
  three browser cases fail and the no-WebGL case passes. Exports and repeated-switch
  cleanup have not passed. Temporary renderer
  diagnostics and a disabled explicit context-release hook remain in the prototype.
- `api/search.ts` implements the Vercel search proxy. Public Nominatim in production
  requires shared private R2 state (`R2_SEARCH_BUCKET`, `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`); an alternative provider can use
  `SEARCH_PROVIDER_URL` and optional `SEARCH_PROVIDER_API_KEY`. Set `APP_ORIGIN`
  to identify the application. Local prototype development uses an in-memory store.
- `tools/city-data/publish.ts` contains an initial ordered publisher and catalog
  writer. Remote publishing, failure-path tests, and catalog replacement safeguards
  are pending. No datasets or infrastructure have been deployed.
- CI still installs only root dependencies and must be updated for the combined
  build. `npm test` runs only the 30 data cases. Lint remains unconfigured,
  `prototype:benchmark` points to a missing script, and synthetic benchmark
  fixtures currently enter the prototype build. These are release blockers.

Additional checkpoint checks (after installing both dependency trees):

```sh
npm run prototype:check
npx tsc --project tsconfig.server.json
node --test tests/*.test.ts
npm exec --prefix prototype -- playwright install chromium
npm run prototype:test
```

The browser suite currently has known failures. The next implementation step is
to resolve renderer context loss and verify loading, exports, and cleanup before
promoting Svelte to the root app. Toolchain/CI cleanup, a reproducible browser
comparison, publisher verification, and deployment validation follow. The
[deployment guide](docs/DEPLOYMENT.md) describes the earlier data-tool milestone;
it is not yet a complete release runbook for this prototype.

## License

Code: [MIT](https://opensource.org/license/mit).
Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
