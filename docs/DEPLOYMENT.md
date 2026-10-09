# Set up Citymap on Cloudflare R2 and Vercel

This guide connects the R2 dataset bucket **`citymap`** to the Vercel project
**`citymap`**. It uses the selected public Nominatim search service, backed by a
second, private R2 bucket named **`citymap-search`**.

| Resource | Purpose | Access |
| --- | --- | --- |
| R2 `citymap` | Versioned road chunks, manifests and discovery catalogs | Public reads through a delivery domain; publisher-only writes |
| R2 `citymap-search` | Shared search results and application-wide rate limiter | Private; Vercel search function reads/writes |
| Vercel `citymap` | Svelte frontend and `/api/search` | App users |

Use your actual assigned app hostname throughout. A Vercel project named
`citymap` does not guarantee that `citymap.vercel.app` is available. In the
examples, `https://citymap.vercel.app` is an app-URL placeholder and
`https://data.example.com` is a delivery-domain placeholder.

## 1. Create the R2 buckets

1. Open the Cloudflare dashboard and select the account that will own the data.
2. Open **R2 Object Storage → Overview**. Complete R2 activation if prompted.
3. Select **Create bucket**, enter **`citymap`**, and use the **Standard** storage
   class for these frequently read datasets. Select a suitable location or use
   automatic placement, then create the bucket. If `citymap` already exists,
   use it without deleting or replacing its contents.
4. Create **`citymap-search`** in the same account. Keep both its public development
   URL and custom-domain access disabled.
5. Record the **Account ID** from R2's account details. The S3 endpoint is
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; this is used for signed server
   requests, not as the browser's public data URL.

The private search bucket is needed because enabling public delivery on
`citymap` exposes its objects. A `search/` prefix in that public bucket would
not make search state private. Bucket creation and default private access are
covered by [Cloudflare's bucket documentation](https://developers.cloudflare.com/r2/buckets/create-buckets/).

## 2. Create two scoped R2 credentials

From **R2 → Overview → Account Details → API Tokens → Manage**, create these
credentials with **Object Read & Write** permissions limited to the indicated
bucket:

| Suggested token name | Bucket scope | Where to store it |
| --- | --- | --- |
| `citymap-search-vercel` | `citymap-search` only | Vercel server environment; optional local development environment |
| `citymap-data-publisher` | `citymap` only | Local/batch publisher environment |

Record each token's **Access Key ID** and **Secret Access Key** when it is created.
The code uses this S3 credential pair, not the dashboard API-token string.
The R2 client selects region `auto` automatically. See
[R2 authentication and bucket-scoped permissions](https://developers.cloudflare.com/r2/api/tokens/).

The Vercel search function needs only the `citymap-search` credential. It does
not upload city datasets. Keep publisher credentials out of Vercel and all
credentials out of `VITE_*` variables. Only public delivery URLs belong there.

## 3. Give `citymap` a public delivery domain

For production, use a domain managed in the same Cloudflare account:

1. Open **R2 → citymap → Settings → Custom Domains → Add**.
2. Enter a subdomain such as `data.example.com`, review the DNS record, and select
   **Connect Domain**. Wait for the status to become **Active**.
3. The browser data base URL is now `https://data.example.com`, without the bucket
   name or `/v2` appended. The loader appends versioned object keys itself.

If you do not yet have a domain, `citymap`'s public `r2.dev` URL can be enabled
for development. Replace it with a custom domain before production; `r2.dev`
is rate-limited and does not provide the custom-domain caching features.
[Cloudflare public delivery and domain setup](https://developers.cloudflare.com/r2/buckets/public-buckets/)
describes both options. Leave `citymap-search` private.

An empty dataset bucket is valid during setup. Until a city has been published,
the frontend can fall back to live Overpass roads.

## 4. Import the Vercel project `citymap`

In Vercel, select **Add New → Project**, import this Git repository, and use:

| Project setting | Value |
| --- | --- |
| Project name | `citymap` |
| Root directory | Repository root (`./`) |
| Framework preset | **Vite** |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js version | **24.x** |
| Production branch | `main` |

The committed [vercel.json](../vercel.json) already specifies the build commands,
output, static cache headers, and a 30-second search-function limit. The frontend
is plain Svelte/Vite; a SvelteKit adapter is not needed. Vercel also builds
[api/search.ts](../api/search.ts) as the `/api/search` function. See the [Node function runtime](https://vercel.com/docs/functions/runtimes/node-js),
[Vite deployment](https://vercel.com/docs/frameworks/frontend/vite) and
[supported Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

Before deploying, add these project environment variables. Use the
**`citymap-search-vercel`** credential pair from step 2:

| Variable | Value | Used by |
| --- | --- | --- |
| `VITE_CITY_DATA_BASE_URL` | `https://data.example.com` or your temporary development delivery URL | Browser, embedded during build |
| `SEARCH_PROVIDER_URL` | `https://nominatim.openstreetmap.org/search` | Search function |
| `APP_ORIGIN` | Actual production app URL | Search application identification |
| `R2_ACCOUNT_ID` | Your Cloudflare Account ID | Search function |
| `R2_SEARCH_BUCKET` | `citymap-search` | Search function |
| `R2_ACCESS_KEY_ID` | Search credential's Access Key ID | Search function |
| `R2_SECRET_ACCESS_KEY` | Search credential's Secret Access Key | Search function |

Leave `VITE_SEARCH_URL` blank to use same-origin `/api/search`. Leave
`VITE_OVERPASS_URL`, `VITE_AREA_SERVER` and `SEARCH_PROVIDER_API_KEY` blank for
this setup. Do not set `VITE_TEST_FIXTURES`: the normal build ships one small
sample rather than the larger test maps. `R2_DATA_BUCKET` is a local publisher
setting and is not required by Vercel.

Apply the search settings to **Production and Preview**, using the same private
bucket so both environments share the Nominatim limit. Set each environment's
public delivery URL as appropriate. If the app hostname is not known before the
first deployment, use `https://github.com/oppenheimmer/citymap` as the initial
`APP_ORIGIN` identifier, then replace it with the assigned production app URL
and redeploy before release. Copy the actual app URL from the project's
**Settings → Domains** after deployment.

Changing Vercel environment variables affects subsequent deployments; redeploy
after changes. Public `VITE_*` settings also require rebuilding because they are
compiled into the app. See [Vercel environment variables](https://vercel.com/docs/environment-variables).

## 5. Allow the app to read the dataset bucket

Once the app URL is known, open **R2 → citymap → Settings → CORS Policy → Add CORS
policy → JSON**. Paste [r2-cors.example.json](../deployment/r2-cors.example.json),
replacing `https://citymap.vercel.app` with the actual app origin:

```json
[
  {
    "AllowedOrigins": ["https://citymap.vercel.app", "http://localhost:8080"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["If-None-Match", "If-Modified-Since"],
    "ExposeHeaders": ["ETag", "Content-Encoding", "CF-Cache-Status"],
    "MaxAgeSeconds": 3600
  }
]
```

Add the exact preview origins you use for testing and any later custom app
origin. Save the policy. CORS governs browser reads; it neither enables public
access nor grants upload access. `citymap-search` needs no browser CORS policy.
If the delivery domain already has cached objects, purge them after changing
CORS so new headers are returned. Check that a missing pointer's 404 also carries
the CORS header (`curl -I -H 'Origin: <app origin>' https://data.example.com/v2/cities/osm-relation-1/latest.json`).
Without it browsers report a network error; the app still falls back to live roads,
but each uncached city then costs one extra retry. This is the dashboard/S3 JSON shape, not
Wrangler's CLI shape. See [R2 CORS setup](https://developers.cloudflare.com/r2/buckets/cors/).

## 6. Configure delivery caching

For the Cloudflare zone containing `data.example.com`, create a **Cache Rule**
matching this hostname and paths ending in `.pbf` or `.json`:

```text
(http.host eq "data.example.com" and
 (ends_with(http.request.uri.path, ".pbf") or
  ends_with(http.request.uri.path, ".json")))
```

Set cache eligibility to **Eligible for cache** and choose an edge TTL option
that uses the origin's Cache-Control header. Keep browser TTL respectful of
origin headers. Avoid caching missing objects for long periods; a just-published
revision should become available promptly. This makes protobuf/JSON caching
explicit while preserving the publisher's different lifetimes:

| Published object | Content-Type | Content-Encoding | Cache-Control |
| --- | --- | --- | --- |
| Revisioned road `.pbf` | `application/x-protobuf` | `gzip` | `public, max-age=31536000, immutable` |
| Revisioned manifest/country index | `application/json` | None | `public, max-age=31536000, immutable` |
| City `latest.json`, `v2/catalog.json` | `application/json` | None | `public, max-age=60, must-revalidate` |

[Cloudflare Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)
describe the origin-header options. A blanket long TTL would make latest/catalog
updates stale. Retain immutable revisions so pinned design links keep working.

## 7. Publish a real city to `citymap`

The public bucket stores generated city objects, not raw OSM extracts.
[The city-data guide](CITY_DATA.md) defines the complete-way input contract.
Selection/extraction happens before generation; the tool does not clip or infer
city boundaries. Synthetic pilot/example fixtures cannot be published.

With Node 24, build and validate your real-city input:

```sh
npm run data:build -- --input /path/to/real-city.json --output .city-data
npm run data:validate -- --output .city-data \
  --manifest v2/cities/<city-key>/<revision>/manifest.json
```

Use the manifest key printed by the build command. Create an ignored local file
**`.env.publisher.local`** containing the separate `citymap-data-publisher`
credential pair:

```dotenv
R2_ACCOUNT_ID=<your-account-id>
R2_ACCESS_KEY_ID=<publisher-access-key-id>
R2_SECRET_ACCESS_KEY=<publisher-secret-access-key>
R2_DATA_BUCKET=citymap
```

First review the offline upload plan:

```sh
node --env-file=.env.publisher.local tools/city-data/publish.ts \
  --root .city-data \
  --manifest v2/cities/<city-key>/<revision>/manifest.json
```

Then run the same command with **`--execute`** to upload. Using `--env-file` is
necessary here: the publisher does not automatically load Vite `.env` files.
Existing shell variables take precedence over Node's env file; use a terminal
without conflicting search credentials. The publisher verifies stored bytes and
headers, uploads all chunks before the manifest, then conditionally updates
latest. Competing updates fail rather than replacing another publisher's pointer.

Optional **`--catalog`** also publishes discovery indexes after all supplied
cities. Repeat `--manifest` for every city in the complete intended catalog;
partial replacement that would remove existing cities is rejected. A batch is
atomic per pointer, not across all cities. Retrying verified immutable objects
is idempotent.

Do not use a generic directory sync: it can expose local upload plans or replace
pointers before their chunks exist. No frontend deployment is needed when a new
city revision is published to the existing delivery domain.

## 8. Check the installation with small requests

The lightweight local checks use installed dependencies and download no browser
archives or containers:

```sh
nvm use
npm run check
npm run lint
npm test
npm run data:codegen -- --check
npm run build
npm run deploy:check -- --offline
```

To check environment inputs locally, put the Vercel/search values into ignored
`.env.production.local`, then run `npm run deploy:check`. This checks local
configuration and artifacts; it does not contact or provision either service.

After deployment, test search with one request using the actual app URL:

```sh
curl --get --data-urlencode 'q=Tokyo, Japan' \
  'https://citymap.vercel.app/api/search'
```

Expect a JSON array. A 503 suggests missing/invalid private R2 credentials or a
provider/storage outage. Concurrent searches queue for up to 8 seconds behind the
shared limiter; 429 with `Retry-After: 2` means it stayed busy for that long. Public
[Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
requires cached, identified requests and at most one provider request per second
across the app. Submit searches explicitly; keep Preview and Production sharing
the private limiter. There is a 22-second search budget plus three seconds for
lease cleanup. If developing against public Nominatim while production is active,
configure the same private R2 search credentials in `.env.local` so development
also uses that shared limiter.

Check a published road object without downloading the whole city:

```sh
curl -I -H 'Origin: https://citymap.vercel.app' \
  'https://data.example.com/v2/cities/<city-key>/<revision>/full/00000.pbf'
```

Expect the configured CORS origin, protobuf content type, gzip encoding and
immutable cache header. Repeated requests should demonstrate cache hits when
eligible. The app validates decoded hashes, fragment continuity and complete
counts. Before a revision is selected, an absent, unreachable, slow (8 s) or
invalid latest pointer falls back to live roads; a selected or pinned revision that
fails delivery or validation fails visibly instead of mixing sources. Reopen a shared design and download a small PNG/SVG to
confirm the deployed API, data and export paths.

`api/search.ts` imports server modules with `.ts` extensions, which local Node 24
and the type checks accept but no Vercel build has exercised yet. After linking the
project, run `vercel pull` and `vercel build` once locally, or inspect the first
preview's function logs, before relying on search.

Browser suites are optional downloads: use **GitHub Actions → Checks → Run
workflow → browser_checks** when a full browser run is wanted. They are not
installed during normal local builds or ordinary push/PR checks. Actual remote
delivery remains unverified until the deployed checks above run successfully.

## Updates and rollback

Pushes to `main` deploy through the connected Vercel project. Redeploy after
changing build/server environment settings. The checked production `dist` is
also retained by CI as `citymap-vercel`; it contains frontend assets, while a
complete Vercel deployment must include the source API function as well.

Roll back the app to a previous Vercel deployment. Roll back a city by publishing
its retained manifest again; immutable chunk bytes are never replaced. For a
catalog rollback, supply the complete retained city set. Keep raw extracts,
build logs, local plans and private search state outside the public bucket.

No bucket, token, project or deployment is created merely by adding this guide
or the example files; perform the dashboard steps with your own account.
