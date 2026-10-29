# Performance measurements

The [October 29 rendering measurements](20261029-rendering.md) record geometry
parity, batch preparation timing, and browser latency before/after culling and
bounded preparation.

The [October 29 request-protection checks](20261029-api.md) record shared provider
pacing, outage retries and failure-report evidence from local mocks. They do not
measure real Overpass latency or rejection rates.

The [Monaco format comparison](20261009-monaco.md) records real-city stored
size, decode time and memory for the version-1 and version-2 data formats. The
browser benchmark below measures the current application only.

Compare repeated single-cell preparation with shared batch preparation using the
pinned real Monaco fixture, without a browser or network requests:

```sh
npm run benchmark:cells -- --runs 25 --output .benchmarks/cells.json
```

The report checks identical coordinate hashes and segment counts for six
cell/rank combinations before timing them, alternates measurement order, and
records median/p95 times, CPU, Node version and the source hash. It measures
geometry preparation only, not provider or rendering latency.

With Node 24, a production build and an already installed working Chromium:

```sh
npm run build:test
npm run benchmark:browser -- --runs 3
```

The benchmark drives the synthetic sample maps, which exist only in test builds.
It defaults to the small fixture and writes ignored output to
`.benchmarks/browser.json`. It starts a local server and mocks road delivery;
it neither installs browsers nor contacts a map provider. To measure the larger
fixtures, pass `--sizes small,medium,large`. Run `npm run build` again before
deployment.

```sh
npm run benchmark:browser -- --runs 3 --sizes small,medium,large
npm run benchmark:browser -- --runs 1 --sizes large --switches 20 \
  --output .benchmarks/cleanup.json
npm run benchmark:browser -- --runs 1 --sizes small --profile \
  --output .benchmarks/cpu-profile.json
```

The report records fixture hashes, partial first-draw submission, complete
readiness, worker download/decode/index/project timings, context creation and
buffer uploads. Trusted label input records both Node/CDP submission-to-frame
time and renderer event-to-frame time; those are different measurements. WebGL
call spans and optional top CPU-profile frames help attribute long tasks. A
separate trusted Cancel click runs while a large-fixture worker is active and
records its announced feedback at the next animation frame. These describe
browser feedback submission, not physical display/input latency.

Dedicated-worker CDP heap/backing-storage samples and Linux `/proc` RSS/high-water
readings cover the browser's owned processes. Sampling can miss short allocations,
and process memory includes browser/graphics runtime overhead. GPU-process RSS
is not VRAM. Cleanup runs force GC and record workers, live contexts and window/
document listener counts after each switch, clearing the harness history first.
The inspector and memory sampling add overhead; compare only like-for-like runs.
Native GPU completion/VRAM and real provider latency remain outside this harness.
The root README's executable/graphics overrides apply when needed. Existing
measurements are not overwritten by the default command. Do not generate
fixtures or run other browser suites during a benchmark.
