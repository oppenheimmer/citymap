# Vercel frontend/search and Cloudflare R2 datasets

The production split is a Svelte/Vite static frontend plus `/api/search` on
Vercel, with city data fetched directly from R2. Extraction and publishing run
on a local machine or batch runner. No account resources have been provisioned
or deployed by this migration.

## Build and preview

Use Node 24 and the repository root as the Vercel project root.
[vercel.json](../vercel.json) selects `npm ci`, `npm run build` and `dist`.
Node 24 is selected by the repository and should also be selected in Vercel's
project settings. [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
and [Vite deployment](https://vercel.com/docs/frameworks/frontend/vite) describe
these settings. The API function has a 30-second limit.

```sh
npm ci
npm run check
npm run lint
npm test
npm run data:codegen -- --check
npm run build:test
npm run test:browser
npm run build
npm run deploy:check -- --offline
```

The last build removes test-only fixtures/provider settings. CI uploads this
production artifact. The artifact check verifies root entry/assets, the startup
budget, lazy renderer/workers/exports, fixture exclusion and Vercel settings.
`npm run deploy:check` additionally checks local production environment inputs;
it does not create a deployment or contact a provider. For this local check,
provide settings through the environment or `.env.production.local`. Vercel
preview/production settings must be entered separately in Vercel.

HTML revalidates and hashed `/assets/` files receive a one-year immutable cache.
Share links use root query parameters, so no SPA path rewrite is required.
`vite preview` serves static assets; it does not run `/api/search`. Use `npm run
dev` for the local API or a Vercel preview for the deployed API.

## Environment inputs

[.env.example](../.env.example) lists all settings. `VITE_*` values are public
build-time configuration and require rebuilding when changed.

| Setting | Runtime/purpose |
| --- | --- |
| `VITE_CITY_DATA_BASE_URL` | Public R2 custom-domain origin, e.g. `https://data.example.com`. Keys already include `v2/`. Blank enables live fallback. |
| `VITE_AREA_SERVER` | Optional version-1 cache base; retained for compatibility. |
| `VITE_SEARCH_URL` | Optional Nominatim-compatible endpoint; default `/api/search`. |
| `VITE_OVERPASS_URL` | Optional Overpass endpoint; default public Overpass interpreter. |
| `APP_ORIGIN` | Server-only production app URL for identifying the search application. |
| `SEARCH_PROVIDER_URL` | Server-only Nominatim-compatible search URL; default public Nominatim. |
| `SEARCH_PROVIDER_API_KEY` | Optional server-only provider bearer token. |
| `R2_SEARCH_BUCKET` | Private shared search cache/rate-state bucket for public Nominatim. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Server/batch secrets; never expose through `VITE_*`. |
| `R2_DATA_BUCKET` | Batch publisher's public dataset bucket. |

Public [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
requires explicit search submission, identification, caching and an aggregate
one-request-per-second limit. Production public search fails closed without
private shared R2 storage. A conditional lease serializes requests across Vercel
instances and imposes a cooldown after completion; concurrent callers receive
429/Retry-After. Development memory state is not the production limiter.
A managed/self-hosted provider can use its own service limits without the public
limiter. New queries can wait or fail during provider/storage outages; cached
successful results remain usable where available.

Keep the search bucket **private and separate from public datasets**. Scope its
server token to that bucket. Apply an approximately eight-day lifecycle to the
`search/v1/` prefix if desired; leave the single `locks/` object outside that
rule. Public catalog/extract objects never belong in the private search bucket.
A separate publisher credential should have object read/write permission only
for the selected dataset bucket. The app's R2 reads require no storage secret.

## R2 delivery

Use a dataset-only Standard bucket with a custom delivery domain.
Cloudflare's [public-bucket documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/)
explains custom-domain caching; `r2.dev` is intended for development.
Keep raw extracts, logs and private inputs outside this bucket.

Apply [deployment/r2-cors.example.json](../deployment/r2-cors.example.json),
replacing the example origin and adding specific preview origins. It permits
GET/HEAD and exposes relevant delivery headers. Wrangler has a different JSON
shape; convert the template if using that CLI. See
[R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

| Object | Content-Type | Content-Encoding | Cache-Control |
| --- | --- | --- | --- |
| Revisioned `.pbf` | `application/x-protobuf` | `gzip` | `public, max-age=31536000, immutable` |
| Revisioned manifest/country index | `application/json` | None | `public, max-age=31536000, immutable` |
| `latest.json` / `v2/catalog.json` | `application/json` | None | `public, max-age=60, must-revalidate` |

Add Cloudflare Cache Rules for `.pbf` and JSON on the data hostname; these
extensions are not cached by default. Respect object cache headers and avoid
long negative caching for new revisions. See
[default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
The browser verifies decoded hashes, identity, counts and fragment continuity.
Only a missing latest pointer permits fallback; a declared missing/corrupt
revision fails and cannot be exported. IndexedDB stores complete geometry with
32 MiB per-city/128 MiB total limits and LRU eviction. Clearing geometry preserves
saved designs. Explicit refresh selects the latest revision; sharing pins a
validated immutable revision.

## Publishing

Build and validate offline inputs using [CITY_DATA.md](CITY_DATA.md). The
boundary policy is preselected complete ways; this tool does not extract/clip a
regional file or infer cities. Synthetic fixtures cannot be published.

```sh
npm run data:publish -- --root .city-data \
  --manifest v2/cities/<key>/<revision>/manifest.json
```

Default is an offline dry-run with object keys, bytes, checksums and headers.
To publish, configure the batch R2 secrets/bucket and add `--execute`.
The publisher uploads unchanged stored gzip bytes with fixed Content-Length;
it uses `If-None-Match: *` for immutable objects and verifies bytes/headers on
read-back. All chunks precede the manifest; latest updates use an ETag captured
before upload. A competing publication causes failure instead of overwrite.
These conditions are supported by [R2's S3 API](https://developers.cloudflare.com/r2/api/s3/api/).

`--catalog` publishes country shards and the root discovery catalog after all
supplied cities. Supply **the complete catalog city set**, repeating `--manifest`
for each city. Existing country shards are checksum-validated and accidental
coverage removal is rejected before writes. Root catalog updates also use
compare-and-swap. Publication is atomic per pointer, not across all city
pointers: a failed batch can leave some city latest pointers updated while the
old catalog remains valid because it references immutable manifests. Retry
with the intended complete set; immutable uploads are idempotent.

Keep previous revision objects for pinned links and rollback. Roll back the app
by redeploying the previous known-good Vercel build. To roll a city back, publish
its retained manifest again; no immutable bytes are replaced. Retain the prior
catalog's manifests when reconstructing a full catalog rollback.

## Verify actual delivery before production

On the Vercel preview, verify explicit search, cached/live loading, sharing,
refresh, cancellation, customization and PNG/SVG downloads. Confirm storage
credentials do not appear in the frontend artifact. Verify actual R2 headers:

```sh
curl -I -H 'Origin: https://citymap.example.com' \
  'https://data.example.com/v2/cities/<key>/<revision>/full/00000.pbf'
curl --compressed -H 'Origin: https://citymap.example.com' \
  'https://data.example.com/v2/cities/<key>/<revision>/full/00000.pbf' \
  --output /tmp/citymap-decoded.pbf
```

Check CORS, MIME/encoding, immutable caching, repeat-request cache hits, decoded
SHA-256, and short pointer freshness with the actual app origin. Use a real small
city input before expanding the catalog. The [browser comparison](benchmarks/20261007-browser.md)
uses synthetic fixtures and software graphics; it is not a delivery or native
GPU benchmark. Local Chromium checks pass; Firefox/WebKit/physical-device and
remote preview verification remain required release evidence.
