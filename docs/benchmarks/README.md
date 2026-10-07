# Reproducing the browser comparison

Use Node 24 and a working Chromium graphics backend. Build the root app with
`npm run build:test`; this generates all three fixed synthetic fixtures.
Provide a Vue production artifact built from Git commit `10584c3`, for example
from a temporary checkout with its own `npm ci` and `npm run build`. Keep that
artifact outside the current `dist` directory.

```sh
npm run benchmark:browser -- --baseline /path/to/vue-dist --runs 3
```

The tool starts a local server, mocks Overpass with the exact same fixture bytes,
alternates application order, and uses a fresh browser context per measurement.
It records first nonempty line-draw submission, long tasks, retained main-thread
heap after GC, fixture hashes, browser/device/throttling metadata and startup
gzip bytes. See the report's limitations before interpreting results. This is
not a public-provider latency, native GPU, worker-peak-memory or mobile benchmark.
The README's graphics overrides also apply here.
