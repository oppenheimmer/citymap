# Citymap

Visualize city roads using OpenStreetMap data and WebGL.

The current app uses Vue 3 and Vite. The planned rewrite uses Svelte 5, Vite,
and TypeScript; see [the migration plan](MODERNIZATION_PLAN.md).

## Development

```sh
npm ci
npm run dev
npm run build
```

The development server runs at `http://localhost:8080`.

Road data loads through Overpass. An optional protobuf cache can be configured
with `VITE_AREA_SERVER`; no cache endpoint is configured by default.

## License

Code: [MIT](https://opensource.org/license/mit).
Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
