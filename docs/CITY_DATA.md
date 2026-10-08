# Local version-2 city-data tools

This milestone supplies a reproducible local generator, typed protobuf adapter,
manifest validator, synthetic pilot, and format benchmark. Generated objects go
into `.city-data/`, which is ignored by Git and excluded from the Vercel `dist`
build. Generation and validation run locally; `data:publish` adds explicit R2
publishing after a dry-run. The Svelte worker reads version 2 and preserves
configured `place.proto` version-1 sources.

## Commands

```sh
npm run data:build -- --input tests/fixtures/schema-edges.json
npm run data:pilot
npm run data:benchmark
```

`data:build` prints the manifest object key. Use that key with the same output
root to validate an existing artifact:

```sh
npm run data:validate -- --manifest v2/cities/<city-key>/<revision>/manifest.json
```

All three artifact commands accept `--output <path>`. `build` and `pilot` accept
`--max-points <integer>` between 2 and 1,000,000. `benchmark --output <file>` writes
a JSON measurement report. `--help` describes the generator commands.

## Input contract

`npm run data:extract` produces this input from an offline OSM snapshot and
explicit boundary files. It verifies source/boundary hashes, snapshot time and
typed identity, indexes regional nodes on disk, and selects complete ways
touching covered E7 polygon geometry. Crossing segments with both vertices
outside, holes, neighbors and antimeridian boundaries are tested. It does not
clip or simplify roads. Batches accept 1–16 declared cities. Empty or ambiguous
boundaries fail; failed/cancelled extraction removes its temporary index and
leaves existing city inputs intact.

Only extraction needs the optional, separately installed
[Pyosmium reader](../tools/city-data/requirements.txt); frontend development and
normal tests have no Python dependency. The
[real-city fixture guide](../tests/fixtures/real-city/README.md) supplies a pinned
Monaco config, source checksums and extract/build/benchmark commands.

[The schema edge fixture](../tests/fixtures/schema-edges.json) is a complete input
example. Inputs contain `metadata` and an `elements` array with road ways and
their referenced nodes. **All element IDs, node references, boundary IDs, and
area aliases must be decimal strings.** Converting a number after it has lost
precision cannot recover an OSM ID.

Nodes use degree-valued `lon` and `lat`. Ways have at least two node references
and a nonempty `tags.highway`. Optional `bridge`, `tunnel`, and integer `layer`
tags are retained as flags and a signed layer value. Unrecognized highway values
survive. Duplicate nodes/ways, missing references, invalid coordinates, empty
data, and boundary/key inconsistencies cause a build error.

Metadata records a typed key such as `osm-relation-123`, name, country code,
explicit area-ID aliases, boundary identity/version/hash, source URL/hash,
source snapshot, and a fixed build timestamp. Timestamps are canonical UTC ISO
strings with milliseconds. Source kinds are `osm-extract` or `synthetic`; the
generator records the declared source and boundary hashes, so the extraction
runner must verify those upstream files independently. Synthetic sources use
fictional IDs and `ZZ` and must stay out of public catalogs.

The generator's boundary policy is `preselected-complete-ways`. The extractor
performs selection before generation; neither stage infers a boundary from a
place name. A complete touching way can extend outside a city. Strict clipping
and global catalog expansion remain separate from this complete-way policy.

## Reproducibility and chunking

Coordinates are quantized to E7 integers. Longitudes stay in `[-180, 180]`, and
bounds use ordered min/max values; a crossing of the antimeridian has conservative
wide bounds. The payload preserves the signed delta across that crossing.
The worker uses short-span antimeridian projection; extreme polar rendering is
rejected where Mercator cannot represent a finite road point.

Roads sort deterministically by first longitude, first latitude, and string ID.
Object property and element ordering do not affect bytes. The revision is a full
SHA-256 of encoded chunks with a fixed revision placeholder, source/boundary
metadata, schema/builder and encoder versions, and chunk settings, excluding
`built_at`. The manifest records protobuf/gzip versions and the gzip OS marker;
different compressor environments get distinct revisions. Fix `built_at` for reproducible
manifests. Rebuilding an existing revision with different manifest bytes fails
without overwriting it; reuse the original manifest/build timestamp. Increment
the builder version whenever normalization, encoding or gzip behavior changes,
and use the same Node version when comparing binary artifacts.

The current threshold is a configurable point budget, provisionally 262,144
points per chunk. The synthetic pilot and benchmark use 32,768 to exercise
independent chunks. Ways exceeding the budget split into numbered consecutive
fragments with one shared endpoint. Point counts include those shared endpoints;
segment counts do not duplicate segments. Whole-city unique-way counts avoid
counting fragments as separate roads. These objects contain independent
polylines; their bounds can overlap.

Compressed-size thresholds remain a real-city benchmark decision. The manifest's
`estimated_processing_bytes` is a heuristic (`decoded bytes × 3 + points × 64 +
fragments × 256`), not a measured allocation limit. Decoded and stored chunks are
limited to 64 MiB; reduce the point budget if encoding exceeds that bound.

## Artifacts and integrity

The layout follows the plan:

```text
v2/cities/<typed-key>/<revision>/full/00000.pbf
v2/cities/<typed-key>/<revision>/manifest.json
v2/cities/<typed-key>/<revision>/upload-plan.local.json
v2/cities/<typed-key>/latest.json
```

The `.pbf` files contain gzip bytes. Manifests distinguish stored-byte and
decoded-protobuf sizes and SHA-256 values. The local validator checks both,
bounds, counts, schema, city/revision/chunk identity, full detail, duplicate
fragments, contiguous indices, matching tags and joined endpoints. Gzip
expansion is bounded by the validated decoded size. The browser will normally
receive decoded bytes from objects served with `Content-Encoding: gzip`, and
its worker loader verifies the decoded checksum.

`latest.json` contains a manifest key and checksum. A local upload plan lists
each object, its stored checksum, MIME/encoding/cache headers, and publication
order: chunks, immutable manifest, then the latest pointer. The upload plan is
local tooling metadata and should not itself be uploaded. The local writer
preserves immutable objects and replaces the pointer atomically after writes.
The publisher validates remote reads and protects latest/catalog updates with
conditional writes. No browser S3 SDK or new runtime dependency is introduced.

## Coverage, freshness and retention

Generate an offline report from the complete set of current manifest keys:

```sh
npm run data:report -- --root .city-data/real-pilot/artifacts \
  --manifest v2/cities/<city-key>/<revision>/manifest.json \
  --at 2026-10-09T00:00:00.000Z --output .city-data/coverage.json
```

Repeat `--manifest` for each city. Every local revision is validated before
reporting its source date, complete-way policy, segment/chunk counts and stored/
decoded bytes. The report counts actual supplied cities, without claiming
global coverage. Optional `--gaps gaps.json` records deliberately unbuilt places:

```json
[{"city_key":"osm-relation-42","name":"Example place","country":"FR","reason":"ambiguous-boundary"}]
```

Allowed reasons are `missing-boundary`, `ambiguous-boundary` and `missing-source`.
Never substitute another boundary to remove a gap. Extraction fails with a
specific diagnostic when its declared boundary or source cannot be validated;
record that place in the next report after reviewing the failure. Gaps and built
cities must have distinct typed keys. Synthetic artifacts are refused.

The initial operating policy is a weekly source-snapshot review and a 30-day
freshness budget (`--max-age-days` can change the reporting budget). Refresh
flagged or frequently used cities in bounded batches, reuse downloaded regional
snapshots, preserve the fixed build timestamp for identical revisions, and use
the tested ordered publisher only when publication is authorized. App releases
alone never trigger extraction. The report proposes refresh work; it does not
download, rebuild, publish or contact R2. The real Monaco pilot report is retained
in [the benchmark evidence](benchmarks/20261009-coverage.json).

Keep the current revision plus at least two previous complete revisions for
rollback. Catalogs retained for rollback also protect their referenced city
revisions. Published immutable revisions and exported pinned links are preserved
indefinitely by default: local tooling cannot enumerate another user's saved
links, so age alone cannot establish that a revision is unreferenced. No automatic
garbage collector or remote deletion is enabled. Before any later retention
change, establish a published link-expiry policy, inventory all latest/catalog/
rollback references, and wait at least the one-year immutable HTTP cache lifetime
after the last reference is retired. Remove only confirmed unreferenced objects;
retain source configs/checksums and the coverage report for reproduction.

Local report validation and this retention review finish the preparatory work.
Scheduling refresh jobs, expanding the public catalog and applying remote
retention are operations for the deferred deployment stage.

## Generated code and validation

```sh
npm run data:codegen
npm run data:codegen -- --check
npm run data:check
npm test
npm run build
```

`data:codegen` uses the locked `pbf` compiler and an ESM export conversion to
regenerate `src/proto/city.js` from `src/proto/city.proto` for Node and browser
workers. Review `city.d.ts` alongside schema changes to keep
the handwritten declarations aligned; never edit the generated codec directly.
Version-1 schema/codec field meanings are preserved. CI runs code-generation
verification, TypeScript checking, deterministic tests and the production build
on Node 24.


## Remote publication

`npm run data:publish -- --root <output-path> --manifest <object-key>` is an
offline dry-run. Add `--execute` with batch R2 configuration to upload, verify
immutable objects and update latest conditionally. `--catalog` requires the
complete city set and protects against lost coverage. See the exact ordering,
credentials, concurrency and rollback rules in [DEPLOYMENT.md](DEPLOYMENT.md).
