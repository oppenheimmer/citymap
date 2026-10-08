"""Stream local OSM primitives and assemble a declared boundary with libosmium."""
import argparse
import importlib.metadata
import json
import sys

import osmium

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["header", "elements", "boundary"])
parser.add_argument("input")
parser.add_argument("--type", choices=["way", "relation"])
parser.add_argument("--id")
args = parser.parse_args()


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


if args.mode == "header":
    with osmium.io.Reader(args.input) as reader:
        header = reader.header()
        emit({"snapshot_at": header.get("osmosis_replication_timestamp"),
              "history": header.has_multiple_object_versions,
              "decoder": "pyosmium/" + importlib.metadata.version("osmium")})
elif args.mode == "elements":
    class Elements(osmium.SimpleHandler):
        def node(self, node):
            if node.deleted or not node.location.valid():
                raise ValueError("Deleted or invalid node in snapshot")
            emit({"type": "node", "id": str(node.id),
                  "lon": node.location.lon, "lat": node.location.lat})

        def way(self, way):
            if "highway" not in way.tags:
                return
            if way.deleted:
                raise ValueError("Deleted road way in snapshot")
            if len(way.nodes) > 10000:
                raise ValueError("Road exceeds the bounded primitive reference limit")
            emit({"type": "way", "id": str(way.id),
                  "nodes": [str(node.ref) for node in way.nodes],
                  "tags": {key: way.tags[key] for key in
                           ("highway", "bridge", "tunnel", "layer") if key in way.tags}})

    Elements().apply_file(args.input)
else:
    if not args.type or not args.id or not args.id.isdecimal():
        parser.error("boundary requires --type and --id")

    class Boundary(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.feature = None

        def area(self, area):
            kind = "way" if area.from_way() else "relation"
            if kind != args.type or str(area.orig_id()) != args.id:
                return
            if self.feature is not None:
                raise ValueError("Duplicate boundary identity")
            self.feature = {"type": "Feature", "properties": {
                "osm_type": kind, "osm_id": str(area.orig_id()),
                "version": str(area.version), "name": area.tags.get("name", "")},
                "geometry": json.loads(osmium.geom.GeoJSONFactory().create_multipolygon(area))}

    handler = Boundary()
    handler.apply_file(args.input, locations=True, idx="flex_mem")
    if handler.feature is None:
        raise ValueError("Boundary is absent or cannot be assembled completely")
    emit(handler.feature)
