# Performance measurements

The dated reports retain the migration's measurements and limitations. Their
Vue comparison is historical; its code remains in Git at `94eba3e`.
The active benchmark measures the current application only.

The [October 8 upload investigation](20261008-uploads.md) records bounded
geometry uploads, cancellation evidence and the remaining responsiveness limits.
The [October 9 phase and cleanup audit](20261009-local.md) adds worker/process
memory, trusted input and cancellation feedback, plus twenty repeated switches.

With Node 24, a production build and an already installed working Chromium:

```sh
npm run build
npm run benchmark:browser -- --runs 3
```

This defaults to the small fixture and writes ignored output to
`.benchmarks/browser.json`. It starts a local server and mocks road delivery;
it neither installs browsers nor contacts a map provider. To measure the larger
locally generated fixtures, run `npm run build:test`, then pass
`--sizes small,medium,large`. Rebuild normally before deployment.

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
