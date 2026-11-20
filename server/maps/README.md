# Regional OpenStreetMap data

`nyc-midtown.json` contains named Midtown streets and landmarks downloaded from
OpenStreetMap on 20 November 2026. It covers 34th Street, 35th Street, 42nd Street,
Herald Square, the Empire State Building, and Times Square. Street geometries are
clipped to the preset boundary. Feature IDs retain the original OSM node or way ID,
and merged streets retain their source way IDs.

The source extracts came from the OSM map endpoint with these bounding boxes,
in west, south, east, north order.

- `-73.995,40.744,-73.978,40.754`
- `-73.995,40.754,-73.978,40.764`

The application uses a matching disk cache first, then this bundled snapshot.
Custom areas continue to use Overpass with Nominatim fallback. `GAZETTEER_FILE`
is a test override whose features must lie in the selected area. A Paris fixture
cannot replace the New York dataset. Snapshot data can be older than the live map.

© OpenStreetMap contributors. The database is distributed under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
[OpenStreetMap attribution and copyright](https://www.openstreetmap.org/copyright).
