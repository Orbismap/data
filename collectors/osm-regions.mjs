// Regions of the osm-tiles build: the leaves of the Geofabrik index (https://download.geofabrik.de/index-v1.json), one extract each,
// and the OWNERSHIP rule that keeps features of overlapping extracts from being stored twice.
//
// Geofabrik extracts overlap: a way that crosses a border is in both neighbours (complete ways), and some extracts contain others
// (brandenburg = "mit Berlin"). The regional pieces are merged with tile-join, which does not deduplicate. So each region only keeps
// the features it OWNS: a feature (a point, the first vertex of a line/polygon) belongs to the region whose polygon contains it;
// polygons of smaller regions inside it (Berlin in Brandenburg) are cut out.

/** collective extracts of the index that overlap the real regions (us, us-south, dach, alps …): never built */
export const AGGREGATES = ['us', 'us-midwest', 'us-northeast', 'us-pacific', 'us-south', 'us-west', 'dach', 'alps', 'sea', 'britain-and-ireland', 'great-britain', 'gcc-states'];

/** unique key of a region: its path on Geofabrik without `-latest.osm.pbf`, '/' → '_' (ids alone are not unique: georgia) */
export const regionKey = (pbfUrl) => pbfUrl.replace(/^https?:\/\/download\.geofabrik\.de\//, '').replace(/-latest\.osm\.pbf$/, '').replace(/\//g, '_');

const bboxOf = (geometry) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < b[0]) b[0] = c[0];
      if (c[1] < b[1]) b[1] = c[1];
      if (c[0] > b[2]) b[2] = c[0];
      if (c[1] > b[3]) b[3] = c[1];
    } else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return b;
};
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** the regions to build from the parsed index: leaves (nothing below them) that are no collective extract → [{ key, id, url, geometry, bbox }] */
export function leafRegions(index) {
  const feats = index.features.filter((f) => f.properties?.urls?.pbf && f.geometry);
  const parents = new Set(index.features.map((f) => f.properties?.parent).filter(Boolean));
  return feats
    .filter((f) => !parents.has(f.properties.id) && !AGGREGATES.includes(f.properties.id))
    .map((f) => ({ key: regionKey(f.properties.urls.pbf), id: f.properties.id, url: f.properties.urls.pbf, geometry: f.geometry, bbox: bboxOf(f.geometry) }));
}

const CELL = 0.05; // degrees

/**
 * (lon, lat) => boolean: is the point inside the (Multi)Polygon? Cells of CELL° that no boundary touches are answered once (cache),
 * only points near a boundary run the full ray casting.
 */
export function geometryTester(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const bbox = bboxOf(geometry);
  const border = new Set();
  const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / (CELL / 2)));
        for (let k = 0; k <= n; k++) {
          const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) border.add(cellKey(x + dx * CELL, y + dy * CELL));
        }
      }
    }
  }
  const inRing = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const full = (x, y) => polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h)));
  const cache = new Map();
  return (x, y) => {
    if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return false;
    const k = cellKey(x, y);
    if (border.has(k)) return full(x, y);
    let v = cache.get(k);
    if (v === undefined) {
      v = full((Math.floor(x / CELL) + 0.5) * CELL, (Math.floor(y / CELL) + 0.5) * CELL);
      cache.set(k, v);
    }
    return v;
  };
}

/**
 * (lon, lat) => boolean: does `region` own the point? Inside its polygon and not inside the polygon of a smaller region that overlaps it
 * (neighbours need no cutting: their polygons do not contain points of this one).
 */
export function makeOwner(regions, key) {
  const me = regions.find((r) => r.key === key);
  if (!me) throw new Error(`unknown region ${key}`);
  const inside = geometryTester(me.geometry);
  const cuts = regions.filter((r) => r !== me && intersects(r.bbox, me.bbox) && area(r.bbox) < area(me.bbox)).map((r) => geometryTester(r.geometry));
  return (x, y) => inside(x, y) && !cuts.some((c) => c(x, y));
}

/** owner from a plain box [west, south, east, north] (local tests: a region without the index) */
export const boxOwner = ([w, s, e, n]) => (x, y) => x >= w && x < e && y >= s && y < n;

/** a region's pbf URL and, when it is not the one of the index, a check of its key */
export function findRegion(regions, key) {
  const r = regions.find((x) => x.key === key);
  if (!r) throw new Error(`unknown region ${key}`);
  return r;
}
