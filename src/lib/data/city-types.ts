// Bounds use canonical longitudes and west <= east. Antimeridian bounds are conservative.
export type Bounds = [west: number, south: number, east: number, north: number];
export type PointE7 = [lon: number, lat: number];

export interface RoadPolyline {
  osm_way_id: string;
  highway: string;
  first_lon_e7: number;
  first_lat_e7: number;
  coordinate_deltas_e7: number[];
  fragment_index: number;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
}

export interface CityRoadChunk {
  schema_version: number;
  city_key: string;
  dataset_revision: string;
  chunk_index: number;
  chunk_count: number;
  detail_level: number;
  roads: RoadPolyline[];
}

export interface CityMetadata {
  city_key: string;
  name: string;
  country: string;
  area_ids: string[];
  source: {
    kind: 'synthetic' | 'osm-extract';
    url: string;
    sha256: string;
    snapshot_at: string;
  };
  boundary: {
    osm_type: 'node' | 'way' | 'relation';
    osm_id: string;
    version: string;
    sha256: string;
    policy: 'preselected-complete-ways';
  };
  built_at: string;
}

export interface GeometryStats {
  bounds: Bounds;
  road_fragment_count: number;
  unique_way_count: number;
  point_count: number;
  segment_count: number;
}

export interface ChunkDescriptor extends GeometryStats {
  index: number;
  key: string;
  content_encoding: 'gzip';
  wire_bytes: number;
  decoded_bytes: number;
  stored_sha256: string;
  decoded_sha256: string;
  estimated_processing_bytes: number;
}

export interface CityManifest extends CityMetadata, GeometryStats {
  manifest_version: 1;
  schema_version: 2;
  dataset_revision: string;
  builder: string;
  encoding: { protobuf: string; gzip_level: 9; zlib: string; gzip_os: number };
  max_points_per_chunk: number;
  coordinate_encoding: 'e7-delta';
  longitude_convention: 'canonical-minus180-to180';
  detail_levels: ['full'];
  retained_tags: ['highway', 'bridge', 'tunnel', 'layer'];
  attribution: { text: string; url: string; license: string };
  chunks: ChunkDescriptor[];
}
