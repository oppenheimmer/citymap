# Road preparation and rendering — October 29, 2026

The changes reuse projected ways across live cells, bound whole-city worker
delivery to two unacknowledged buffers, release consumed R2 download references,
and cull collections outside the rotated map frame. GPU buffers can be released
without deleting their CPU geometry. Live requests wait behind upload queues
above 8 MiB. Cache clearing invalidates deferred saves, and live readiness waits
for drawing.

## Geometry preparation

`npm run benchmark:cells -- --runs 25` uses the pinned real Monaco fixture and
prepares two z14 cells at each of the three road ranks. Independent per-cell
processing and shared batch processing run alternately in the same process,
after five warmups. No network or rendering is involved.

| Preparation | Median | p95 |
| --- | ---: | ---: |
| Independent cells | 36.21 ms | 72.12 ms |
| Shared batch | 12.20 ms | 25.40 ms |

A separate final paired run measured 52.44 ms independent versus 18.34 ms batch
(p95 75.51 / 26.77 ms), about 2.9× faster preparation. Absolute CPU timings vary;
both runs preserve identical coverage. The final raw report is
`.benchmarks/cell-comparison-final.json`.

The six outputs retain exactly **1,886 / 1,803 / 5,800 / 138 / 149 / 561** segments.
All Float32 coordinate hashes match those recorded before implementation; those
hashes are pinned in `tests/live-cell-roads.test.ts`. The benchmark records its
own source hash and compares independent/batch output before timing.

## Browser measurements

Three runs per fixture before and after, using Node 24.20.0, Chromium
153.0.8010.12, Intel i5-1345U, Mesa software Vulkan, a 1000×750 viewport at DPR 1,
and CDP main-thread CPU throttling at 4×. The existing harness samples memory and
WebGL calls. Latency starts at mocked road delivery.

| Fixture | Segments | First draw before / after | Complete before / after |
| --- | ---: | ---: | ---: |
| Small | 512 | 114 / 62 ms | 286 / 215 ms |
| Large | 262,144 | 1,060 / 1,034 ms | 1,953 / 1,941 ms |

Large loads still upload exactly 4 MiB in five bounded uploads. These short runs
show no large-load latency regression; they do not establish a general speedup.
They exclude real provider latency, native GPU completion and physical-device
performance. The default SwiftShader backend lost its context during initial
measurement; both reported measurements use the documented Mesa configuration.

Fixture SHA-256 values:

- Small: `fbe53c926d5154d9d276793adbc691f08b007c7156ad11c88f8dce69a80dd1c9`
- Large: `275bf1cb5e161a3cd42a3d160e11f2473544e653e5158f639c40635865ce57d1`

Local raw reports are retained in ignored `.benchmarks/browser-baseline.json`,
`.benchmarks/browser-rendering.json` and `.benchmarks/cell-comparison.json`.
Commands and harness limitations are in [the benchmark guide](README.md).

## Coverage and resource checks

Unit checks compare 11,532 rotated camera/collection positions with an independent
polygon intersection algorithm, retaining touching edges and stroke padding.
Browser checks prove offscreen geometry skips uploads/draws, a tiny GPU budget
releases buffers while retaining both CPU collections, and revisiting them
uploads again without a road request. Existing seam, rotated PNG/SVG, cache,
cancellation, provider backoff and source-integrity regressions remain required.

Final validation passed 235 unit tests, 89 local browser regressions and 10
built-app browser cases, along with type checks, lint, code generation,
production build and offline deployment preflight. Browser checks used Chromium;
these results do not replace physical-device or live-provider measurements.

Memory budgets estimate road geometry, not total browser or driver memory.
Visible geometry remains protected, so a view that itself exceeds a budget can
exceed that budget. Broad-city overview data needs a later spatial/level-of-detail
format; increasing public Overpass concurrency is not part of these changes.

## Monaco publishing preparation

The existing pipeline was exercised locally from the pinned real-city input:
build, validate, then publisher dry-run including the catalog. It validates
3,486 ways and 15,369 segments and reproduces bundled revision
`a7663752667ecef4455030827e5eaeacc754ec9c5d419c9fe9e0990a0e69d328`.
Artifacts are in ignored `.city-data/optimization-monaco/`. No data was uploaded,
no infrastructure was provisioned, and no additional cities were added.
