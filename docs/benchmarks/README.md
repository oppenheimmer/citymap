# Performance measurements

The dated reports retain the migration's measurements and limitations. Their
Vue comparison is historical; its code remains in Git at `94eba3e`.
The active benchmark measures the current application only.

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

The report records fixture hashes, first draw submission, long tasks, retained
main-thread memory after GC, and browser/device/throttling settings. Worker/peak
memory, native GPU completion and real provider latency are excluded. The root
README's executable/graphics overrides apply when needed. Existing measurements
are not overwritten by the default command.
