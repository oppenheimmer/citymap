# Monaco offline fixture

`monaco.json.gz` is the complete-way input selected from real OpenStreetMap data,
not a synthetic city. It contains 3,486 ways, 13,842 referenced nodes and 15,369
segments. Decoded input SHA-256:
`7a1d0b47a24b27eb99eb2b6a0f2cd24cf94ceecbe8d29544230fd84ce04ec4ec`.
The gzip timestamp is zero. The frontend does not ship this test fixture.

Map data: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).
Source snapshot: [Geofabrik Monaco, October 6, 2026](https://download.geofabrik.de/europe/monaco.html).
The config pins the original PBF and full boundary-file SHA-256 values. Raw
source files remain outside Git under ignored `.city-data/`; the compressed
selected input omits contributor account fields and unnecessary source tags.

For extraction, install the small optional reader in a separate environment:

```sh
python3 -m venv .city-data/python
.city-data/python/bin/pip install -r tools/city-data/requirements.txt
```

Download the two source files once into the same working directory as a copy of
`monaco.config.json`, check their SHA-256 values against that config, then run:

```sh
curl -fLO https://download.geofabrik.de/europe/monaco-261006.osm.pbf
curl -fL https://www.openstreetmap.org/api/0.6/relation/1124039/full \
  -o monaco-boundary.osm
sha256sum monaco-261006.osm.pbf monaco-boundary.osm
npm run data:extract -- --input /path/to/monaco-261006.osm.pbf \
  --config /path/to/monaco.config.json --output .city-data/real-pilot/inputs \
  --python .city-data/python/bin/python
npm run data:build -- --input .city-data/real-pilot/inputs/osm-relation-1124039.json \
  --output .city-data/real-pilot/artifacts --max-points 2048
npm run data:benchmark -- --input .city-data/real-pilot/inputs/osm-relation-1124039.json \
  --chunk-points 2048 --output .city-data/real-pilot/format-benchmark.json
```

The original boundary download hash protects its exact snapshot. If a later
download changes, extraction rejects it; deliberately review and update the
source/boundary versions and hashes rather than changing this fixture silently.
Build timestamps are fixed in the config for reproducible manifests.

The normal unit/browser suites read the retained fixture using Node's gzip
support. They require no Python packages, downloads, accounts or source APIs.
