# Vercel frontend and Cloudflare R2 data

The selected split is a static Vite frontend on Vercel and versioned city
datasets on a dedicated R2 delivery domain. Heavy OSM extraction/build work runs
on a local machine or batch runner. The current change supplies configuration
and local artifacts; no Vercel project or R2 bucket has been changed or deployed.

## Frontend on Vercel

Import the Git repository into Vercel with the repository root as the project
root. [vercel.json](../vercel.json) selects Vite, `npm ci`, `npm run build`, and
`dist`. `.nvmrc` and `package.json` select Node 24, one of
[Vercel's supported Node releases](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
The same output/configuration applies to the planned Svelte 5 Vite migration;
no framework server adapter is needed for this static frontend.

The config revalidates `/` and `/index.html` and gives hashed `/assets/` files a
one-year immutable browser cache. Existing share URLs use query parameters on
`/`, so no route rewrite is required. Introduce SPA rewrites if path routes are
added later. The artifact contains app code and static UI assets; city datasets
stay in R2. Vercel preview/prod environments should each receive their intended
public data origin when the version-2 loader is implemented. See
[Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite) and
[static project configuration](https://vercel.com/docs/project-configuration/vercel-json).

`VITE_AREA_SERVER` continues to enable an optional version-1 source.
`VITE_CITY_DATA_BASE_URL` is reserved for version 2 and has no current UI effect.
Use a public delivery origin such as `https://data.example.com`; version-2
object keys already include `v2/`. Storage access keys belong in the future
publisher's secret store, never in Vercel frontend `VITE_*` variables. Vite
embeds these public variables at build time, so changes require a rebuild.

## R2 delivery configuration

Choose a dataset-only Standard bucket and attach a custom delivery domain.
Keep extracts, build logs and private inputs outside that public bucket.
Cloudflare's managed `r2.dev` endpoint is intended for development; a
[custom domain supports caching](https://developers.cloudflare.com/r2/buckets/public-buckets/).

[deployment/r2-cors.example.json](../deployment/r2-cors.example.json) is a
dashboard/S3-style read-only CORS template. Replace the example origin with the
actual production app origin and add specific Vercel preview origins used for
testing. The development origin is `http://localhost:8080`. The template uses
GET/HEAD and exposes ETag, encoding and cache-status headers. Wrangler uses a
different CORS JSON shape; convert the template if using its CLI. CORS behavior
and policy application are described in the
[R2 documentation](https://developers.cloudflare.com/r2/buckets/cors/).

The future publisher should apply each local upload plan's object headers:

| Object | Content-Type | Content-Encoding | Cache-Control |
| --- | --- | --- | --- |
| Revisioned `.pbf` | `application/x-protobuf` | `gzip` | `public, max-age=31536000, immutable` |
| Revisioned manifest | `application/json` | None | `public, max-age=31536000, immutable` |
| `latest.json` | `application/json` | None | `public, max-age=60, must-revalidate` |

Upload the stored gzip bytes without decompressing or compressing them again.
Verify uploaded bytes against the stored checksum and CDN/browser-decoded bytes
against the decoded checksum. ETags are revalidation tokens, and may differ from
SHA-256 values. Publish and verify all chunks, then the immutable manifest, then
the latest pointer. Preserve version-1 sources at their existing routes.

Configure explicit Cloudflare Cache Rules for the dataset hostname: allow
caching for `.pbf` and JSON, respect the headers above, and keep pointer/catalog
lifetimes short. These file extensions are not cached by default; a custom
domain alone does not make them cacheable. See
[Cloudflare's default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
Avoid long negative caching for new revision objects. Catalog generation and
publication are a later milestone.

After provisioning, verify delivery using the actual app origin and revision:

```sh
curl -I -H 'Origin: https://citymap.example.com' \
  'https://data.example.com/v2/cities/<key>/<revision>/full/00000.pbf'
curl --compressed -H 'Origin: https://citymap.example.com' \
  'https://data.example.com/v2/cities/<key>/<revision>/full/00000.pbf' \
  --output /tmp/citymap-decoded.pbf
```

Check CORS, Content-Type/Encoding, Cache-Control, and cache-hit behavior on repeat
requests, plus pointer freshness and actual browser reads. Include a valid
`Origin` when checking CORS with curl. Deployment origins, bucket name, delivery
domain, source city list, and refresh schedule remain required provisioning
inputs. The reviewed local artifacts and configuration need no credentials.
