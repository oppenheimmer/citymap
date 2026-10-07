# Citymap

Visualize city roads using OpenStreetMap data and WebGL.

The current app uses Vue 3 and Vite. The planned rewrite uses Svelte 5, Vite,
and TypeScript; see [the migration plan](MODERNIZATION_PLAN.md). The local
version-2 city-data tools use TypeScript. The frontend is configured for Vercel;
the versioned dataset cache will be delivered from Cloudflare R2.

## Development

```sh
nvm use
npm ci
npm run dev
npm run build
npm run preview
```

Use Node 24 LTS (also selected for CI and Vercel). Development and preview run at
`http://localhost:8080`. Native Node TypeScript support runs the local data tools;
`data:check` performs their separate static type check.

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

The current UI still reads version 1. `VITE_CITY_DATA_BASE_URL` is reserved for
the upcoming version-2 worker loader; setting it does not enable version 2 yet.
The existing lint command still lacks configuration; data checks, tests and the
production build run in CI. UI lint/toolchain replacement remains in the plan.

## License

Code: [MIT](https://opensource.org/license/mit).
Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
