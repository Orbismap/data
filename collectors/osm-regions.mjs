// Units of the osm-tiles build: Geofabrik extracts (https://download.geofabrik.de/index-v1.json), one job each, and the OWNERSHIP rule that keeps features of overlapping extracts from being stored twice.
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

/** all leaves of the index (nothing below them) that are no collective extract → [{ key, id, url, geometry, bbox }] (the finest split; the build uses unitRegions) */
export function leafRegions(index) {
  const feats = index.features.filter((f) => f.properties?.urls?.pbf && f.geometry);
  const parents = new Set(index.features.map((f) => f.properties?.parent).filter(Boolean));
  return feats
    .filter((f) => !parents.has(f.properties.id) && !AGGREGATES.includes(f.properties.id))
    .map((f) => ({ key: regionKey(f.properties.urls.pbf), id: f.properties.id, url: f.properties.urls.pbf, geometry: f.geometry, bbox: bboxOf(f.geometry) }));
}

/**
 * An extract is built as ONE unit while its pbf is at most this big. Limits: the 2 GB of a release asset, the 6 h of a job and the RAM (16 GB)
 * of osmium and tippecanoe; NOT the disk (~100 GB free) and not the run time otherwise. Measured on Berlin (the densest case: 100 MB pbf, 15 s
 * for everything): the assets are 0.059 x the pbf in all (roofs 0.036, trees 0.016, points 0.006), the run time 0.15 s per MB; Hessen's roofs
 * are 0.014 x. So even Europe (35.5 GB) would be at worst ~1.3 GB roofs (Berlin ratio, likely 0.5 GB), ~0.6 GB trees, ~90 min: the 2 GB and the 6 h
 * would allow one unit of up to ~40 GB (9 units in all). 20 GB (57 units: North America 19.6, Asia 16.5, Africa 8.0 as one, Europe in countries,
 * the biggest France 5.1 and Germany 4.9) keeps a margin for what is not measured: the RAM of osmium/tippecanoe above Germany (16 GB runner).
 * If a unit runs out of RAM or time, lower this constant (merge ignores pieces of units that no longer exist).
 */
export const UNIT_MAX_BYTES = 20e9;

/** path of a region on Geofabrik without `-latest.osm.pbf` (europe/germany/hessen) */
const pathOf = (pbfUrl) => pbfUrl.replace(/^https?:\/\/download\.geofabrik\.de\//, '').replace(/-latest\.osm\.pbf$/, '');

/**
 * The tree of the index by path (europe/germany/hessen is below europe/germany; the `parent` field of the index is not used: it
 * puts the US states below north-america). Collective extracts are no nodes, what lies below one hangs on the next ancestor (or is a root).
 * → { roots, nodes: Map<key, node> }, node = { key, id, url, geometry, bbox, children }, everything sorted by key
 */
export function regionTree(index) {
  const feats = index.features.filter((f) => f.properties?.urls?.pbf && f.geometry && !AGGREGATES.includes(f.properties.id));
  const nodes = new Map(feats.map((f) => [regionKey(f.properties.urls.pbf), { key: regionKey(f.properties.urls.pbf), id: f.properties.id, url: f.properties.urls.pbf, geometry: f.geometry, bbox: bboxOf(f.geometry), children: [] }]));
  const byPath = new Map([...nodes.values()].map((n) => [pathOf(n.url), n]));
  const roots = [];
  for (const n of nodes.values()) {
    // the nearest ancestor by path that is a node: below a collective extract (north-america/us/ohio, us is none) that is the one above it,
    // so a unit north-america also covers the states
    let p = pathOf(n.url), parent = null;
    while (!parent && p.includes('/')) parent = byPath.get((p = p.slice(0, p.lastIndexOf('/'))));
    (parent ?? { children: roots }).children.push(n);
  }
  const sort = (list) => list.sort((a, b) => (a.key < b.key ? -1 : 1)).forEach((n) => sort(n.children));
  sort(roots);
  return { roots, nodes };
}

/**
 * The units to build: from the top down the biggest region whose pbf is at most `max` bytes (`sizes` = { key: bytes } of the committed table
 * osm-sizes.json), a bigger one is split into its children. A region of unknown size that has children is split too (safe), a leaf is
 * always a unit. A unit covers everything below it, so there are no gaps and no doublings (except what the index overlaps, see makeOwner).
 * → [{ key, id, url, geometry, bbox }]
 */
export function unitRegions(index, sizes = {}, max = UNIT_MAX_BYTES) {
  const out = [];
  const walk = (n) => {
    const size = sizes[n.key];
    if (!n.children.length || (size !== undefined && size <= max)) out.push({ key: n.key, id: n.id, url: n.url, geometry: n.geometry, bbox: n.bbox });
    else n.children.forEach(walk);
  };
  regionTree(index).roots.forEach(walk);
  return out;
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
