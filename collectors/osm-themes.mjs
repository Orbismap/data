// Registry of the OSM themes of the osm-planet pipeline (collectors/osm-tiles.mjs). A new theme is ONE entry in THEMES below:
// no new workflow, no new build code.
//
// An entry (a "source") says what is taken from OSM and how it is stored:
//   file      name of the world PMTiles it goes into (<file>-<date>.pmtiles in the bucket); several sources may share a file
//             (trees: layers `trees` and `tree_lines`)
//   layer     layer name inside the file
//   group     which job builds it (osm-planet.yml): points + trees + netz = the node job, roofs = the roofs job (its filter takes so
//             much disk that it has a runner of its own)
//   geometry  'point' (OSM nodes, streamed once), 'line' (ways: node refs from the stream, positions fetched in a second pass)
//             or 'polygon' (buildings etc.: osmium export builds the areas)
//   filter    osmium tags-filter expressions of the first pass (OR); polygons optionally `require` (AND, second filter)
//   match     (tags) => boolean, which of the filtered objects belong to the theme (points, lines)
//   record / lineRecord / polygonFeature   tags (+ geometry) -> record / GeoJSON feature (polygonFeature: one or an array;
//             `attributes`: object attributes osmium export adds to the properties, e.g. 'type,id')
//   fields    property names of a point record after [lon, lat] (FIELDS)
//   zoom      [min, max] of the pmtiles; low: below LOW_ZOOM_END only an attribute-free layer `<layer>_lo` (see lowZoomPoints)
//   tippecanoe  extra tippecanoe arguments of the source's layer
// Data © OpenStreetMap contributors (ODbL).

import { NET_LAYERS, NET_VARIANTS } from './netzplan.mjs';

/** OPL escapes unsafe characters as %hex% */
const unescapeOpl = (v) => v.replace(/%([0-9a-f]+)%/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

function parseTags(raw) {
  const tags = {};
  for (const kv of raw.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) tags[unescapeOpl(kv.slice(0, i))] = unescapeOpl(kv.slice(i + 1));
  }
  return tags;
}

/** One OPL line of a node → { id, x, y, tags } or null (not a node, no position). */
export function parseNode(line) {
  if (line.charCodeAt(0) !== 110 /* n */) return null;
  let id, x, y, raw = '';
  for (const f of line.split(' ')) {
    if (f[0] === 'n' && id === undefined) id = f.slice(1);
    else if (f[0] === 'x') x = parseFloat(f.slice(1));
    else if (f[0] === 'y') y = parseFloat(f.slice(1));
    else if (f[0] === 'T') raw = f.slice(1);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { id, x, y, tags: parseTags(raw) };
}

/** Like parseNode, but only for CCTV cameras: man_made=surveillance without ALPR and webcams with a link. */
export function parseOpl(line) {
  const p = parseNode(line);
  return p && isCctv(p.tags) ? p : null;
}

export const isCctv = (t) => t.man_made === 'surveillance' && t['surveillance:type'] !== 'ALPR' && !t.webcam && !t['contact:webcam'];

/** One OPL line of a relation → { id, tags, members: [{ type: 'n'|'w'|'r', ref, role }] } or null */
export function parseRelation(line) {
  if (line.charCodeAt(0) !== 114 /* r */) return null;
  let id, raw = '', mem = '';
  for (const f of line.split(' ')) {
    if (f[0] === 'r' && id === undefined) id = f.slice(1);
    else if (f[0] === 'T') raw = f.slice(1);
    else if (f[0] === 'M') mem = f.slice(1);
  }
  const members = [];
  for (const m of mem.split(',')) {
    const at = m.indexOf('@');
    if (at > 1) members.push({ type: m[0], ref: m.slice(1, at), role: unescapeOpl(m.slice(at + 1)) });
  }
  return { id, tags: parseTags(raw), members };
}

/** One OPL line of an enforcement relation → { tags, members: [{ ref, role }] } or null. Only node members are kept. */
export function parseEnforcement(line) {
  const rel = parseRelation(line);
  if (rel?.tags.type !== 'enforcement') return null;
  return { tags: rel.tags, members: rel.members.filter((m) => m.type === 'n').map(({ ref, role }) => ({ ref, role })) };
}

/** One OPL line of a way → { id, tags, refs: node id strings } or null */
export function parseWay(line) {
  if (line.charCodeAt(0) !== 119 /* w */) return null;
  let id, raw = '', nds = '';
  for (const f of line.split(' ')) {
    if (f[0] === 'w' && id === undefined) id = f.slice(1);
    else if (f[0] === 'T') raw = f.slice(1);
    else if (f[0] === 'N') nds = f.slice(1);
  }
  return { id, tags: parseTags(raw), refs: nds ? nds.split(',').map((n) => n.slice(1)) : [] };
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** default of a field (left out of the file): direction -1, flags 0, everything else '' (id, where a set has one, is always present) */
export const fieldDefault = (f) => (f === 'dir' ? -1 : f === 'guard' || f === 'flock' || f === 'panning' || f === 'cargo' ? 0 : '');

/** a record [lon, lat, …fields] as GeoJSON point feature (numbers stay numbers; '' = not tagged = left out) */
export function recordFeature(fields, rec) {
  const props = {};
  fields.forEach((f, i) => {
    const v = rec[i + 2];
    if (f === 'id' || v !== fieldDefault(f)) props[f] = v;
  });
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [rec[0], rec[1]] }, properties: props };
}

/** Blitzer tile record: [lon, lat, direction°|-1, kind 'cam'|'section'|'signals', maxspeed, operator, ref, OSM node id] */
export function speedRecord({ id, x, y, tags }) {
  const dir = parseFloat((tags.direction ?? tags['camera:direction'] ?? '').split(';')[0]);
  const kind = tags.enforcement === 'traffic_signals' ? 'signals' : 'cam';
  return [r5(x), r5(y), Number.isFinite(dir) ? Math.round(dir) : -1, kind, tags.maxspeed ?? '', tags.operator ?? '', tags.ref ?? '', Number(id)];
}

/** Tile record: [lon, lat, direction°|-1, surveillance, camera:type, camera:mount, guard 0|1, operator, OSM node id] */
export function record({ id, x, y, tags }) {
  const dir = parseFloat((tags['camera:direction'] ?? tags.direction ?? '').split(';')[0]);
  return [r5(x), r5(y), Number.isFinite(dir) ? Math.round(dir) : -1, tags.surveillance ?? '', tags['camera:type'] ?? '', tags['camera:mount'] ?? '', tags['surveillance:type'] === 'guard' ? 1 : 0, tags.operator ?? '', Number(id)];
}

const dirOf = (t) => {
  const d = parseFloat((t['camera:direction'] ?? t.direction ?? '').split(';')[0]);
  return Number.isFinite(d) ? Math.round(d) : -1;
};

/** ALPR record: [lon, lat, direction°|-1, brand, flock 0|1, mount, operator, zone, since, ref, OSM node id] */
export function alprRecord({ id, x, y, tags: t }) {
  const brand = t.manufacturer ?? t.brand ?? t['manufacturer:wikidata'] ?? '';
  const flock = /flock/i.test(brand) || t['manufacturer:wikidata'] === 'Q108485435' ? 1 : 0;
  return [r5(x), r5(y), dirOf(t), brand, flock, t['camera:mount'] ?? '', t.operator ?? '', t['surveillance:zone'] ?? '', t.start_date ?? '', t.ref ?? '', Number(id)];
}

/** the link of an OSM webcam, or '' (the layer shows webcams that have one) */
const webcamLink = (t) => {
  if (!(t.webcam || t['contact:webcam'] || t.surveillance === 'webcam')) return '';
  const link = t.webcam ?? t['contact:webcam'] ?? t.url ?? t.website ?? t['contact:website'];
  return link && /^https?:\/\//.test(link) ? link : '';
};

/** webcam record: [lon, lat, direction°|-1, name, operator, panning 0|1, link, OSM node id] */
export function webcamRecord({ id, x, y, tags: t }, link) {
  return [r5(x), r5(y), dirOf(t), t.name ?? t.description ?? '', t.operator ?? '', t['camera:type'] === 'panning' ? 1 : 0, link, Number(id)];
}

/** wind turbine record: [lon, lat, name, operator, manufacturer, model, output, OSM node id] */
export function windRecord({ id, x, y, tags: t }) {
  return [r5(x), r5(y), t.name ?? '', t.operator ?? '', t.manufacturer ?? '', t['generator:model'] ?? t.model ?? '', t['generator:output:electricity'] ?? '', Number(id)];
}

/** resource record: [lon, lat, name, kind label, resource words, resource tag, operator, OSM node id] – kind/words as the layer expects them */
export function resourceRecord({ id, x, y, tags: t }) {
  const kind =
    t.man_made === 'petroleum_well' || t.man_made === 'pumpjack' ? 'Bohrloch' : t.landuse === 'quarry' ? 'Steinbruch/Tagebau' : t.man_made === 'mineshaft' ? 'Schacht' : t.man_made === 'adit' ? 'Stollen' : t.industrial === 'refinery' ? 'Raffinerie' : 'Bergwerk';
  const words = [t.resource, t['resource:type'], t.product, t.substance, t.industrial === 'oil' ? 'oil' : '', t.industrial === 'gas' ? 'gas' : '', t.man_made === 'petroleum_well' ? 'oil' : ''].filter(Boolean).join(' ');
  return [r5(x), r5(y), t.name ?? '', kind, words, t.resource ?? '', t.operator ?? '', Number(id)];
}

/** OSM number in metres ("12", "12.5", "12 m", "12,5") → rounded number, or '' when missing/unusable (0 < v <= max) */
export function metres(raw, max, digits) {
  if (raw === undefined) return '';
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:m)?\s*$/i.exec(raw);
  if (!m) return '';
  const v = parseFloat(m[1].replace(',', '.'));
  if (!(v > 0 && v <= max)) return '';
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

const LEAF_TYPES = ['broadleaved', 'needleleaved', 'mixed', 'leafless'];
const LEAF_CYCLES = ['deciduous', 'evergreen', 'semi_deciduous', 'semi_evergreen'];
/** a value of a fixed vocabulary, else '' (junk values would only bloat the tiles) */
const oneOf = (v, list) => (v !== undefined && list.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : '');

/** tree record: [lon, lat, species, height m, circumference m, leaf_type, leaf_cycle]; missing values stay '' (left out, the renderer picks defaults) */
export function treeRecord({ x, y, tags: t }) {
  return [r5(x), r5(y), t.species ?? '', metres(t.height, 150, 1), metres(t.circumference, 30, 2), oneOf(t.leaf_type, LEAF_TYPES), oneOf(t.leaf_cycle, LEAF_CYCLES)];
}

/** Douglas-Peucker tolerance of the lines (m) */
export const LINE_TOLERANCE = 1;

/** metres between two lon/lat points, planar approximation around latitude `lat0` (good enough for 1 m tolerances) */
const planar = (c, lat0) => [c[0] * 111320 * Math.cos((lat0 * Math.PI) / 180), c[1] * 110574];

/** Douglas-Peucker: the points of `coords` ([lon, lat][]) that remain with tolerance `tol` metres; first and last always stay (so closed rings stay closed) */
export function simplify(coords, tol = LINE_TOLERANCE) {
  if (coords.length < 3) return coords;
  const lat0 = coords[0][1];
  const pts = coords.map((c) => planar(c, lat0));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** property names of a tree_lines feature (after the geometry) */
export const LINE_FIELDS = ['kind', 'species', 'height', 'leaf_type', 'leaf_cycle'];

/**
 * Line record of a way: [coords [lon, lat][], kind 'row'|'hedge', species (rows only), height m, leaf_type, leaf_cycle], or null
 * (neither tree_row nor hedge, or fewer than 2 distinct points left). Coordinates: ≤ 5 decimals, simplified to ~1 m.
 */
export function treeLineRecord(tags, coords) {
  const kind = tags.natural === 'tree_row' ? 'row' : tags.barrier === 'hedge' ? 'hedge' : null;
  if (!kind) return null;
  const pts = [];
  for (const [x, y] of coords) {
    const p = [r5(x), r5(y)];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  const line = simplify(pts);
  if (line.length < 2) return null;
  return [line, kind, kind === 'row' ? tags.species ?? '' : '', metres(tags.height, kind === 'row' ? 150 : 30, 1), oneOf(tags.leaf_type, LEAF_TYPES), oneOf(tags.leaf_cycle, LEAF_CYCLES)];
}

/** a line record as GeoJSON LineString feature (empty values left out; `kind` is always there) */
export function lineFeature(rec) {
  const props = {};
  LINE_FIELDS.forEach((f, i) => {
    const v = rec[i + 1];
    if (f === 'kind' || v !== '') props[f] = v;
  });
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: rec[0] }, properties: props };
}

// --- roofs ---------------------------------------------------------------------------------------------------------------

/** A building or building part is a roof record when it carries one of these (a part without them stays with the base map's buildings). */
export const ROOF_TAGS = ['roof:shape', 'roof:height', 'roof:levels', 'roof:colour', 'roof:material', 'roof:angle'];
/**
 * Tags of the roofs layer = what the app's 3D model reads (src/pro/gebaeude/roofs.ts, data/parsers/gebaeude.ts): walls from the
 * heights/levels, roof from roof:*, colours/materials for the look. Property names ARE the OSM keys, values stay strings
 * (the app passes them on as `tags`).
 */
export const ROOF_KEEP = [
  'building', 'building:part', 'height', 'building:height', 'min_height', 'building:levels', 'building:min_level', 'roof:levels',
  'roof:shape', 'roof:height', 'roof:direction', 'roof:orientation', 'roof:angle', 'roof:colour', 'roof:material',
  'building:colour', 'colour', 'building:material', 'material',
];
const ROOF_MAX_VALUE = 40;

/** GeoJSON feature (MultiPolygon, ≤ 6 decimals) of a roof from an `osmium export` polygon, or null (no roof tag, no area, not a building) */
export function roofFeature(f) {
  const t = f.properties ?? {};
  if (!ROOF_TAGS.some((k) => t[k] !== undefined && t[k] !== '')) return null;
  if (t.building === 'no' || t['building:part'] === 'no' || (t.building === undefined && t['building:part'] === undefined)) return null;
  const props = {};
  for (const k of ROOF_KEEP) {
    const v = t[k];
    if (typeof v !== 'string') continue;
    const s = (k === 'roof:shape' ? v.trim().toLowerCase() : v.trim());
    if (s && s.length <= ROOF_MAX_VALUE) props[k] = s;
  }
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return null;
  const ring = (r) => {
    const out = [];
    for (const [x, y] of r) {
      const p = [r6(x), r6(y)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return out.length >= 4 ? out : null;
  };
  const polys = [];
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
    const outer = ring(poly[0]);
    if (!outer) continue;
    polys.push([outer, ...poly.slice(1).map(ring).filter(Boolean)]);
  }
  if (!polys.length) return null;
  return { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: polys }, properties: props };
}

// --- bicycle parking -----------------------------------------------------------------------------------------------------

export const PARKING_FIELDS = ['type', 'capacity', 'covered', 'access', 'fee', 'lit', 'cargo', 'operator', 'name', 'osm', 'id'];
/** layer of the outlines in fahrradparken.pmtiles (the points are in the layer `fahrradparken`) */
export const PARKING_AREA_LAYER = 'fahrradparken_flaechen';

/** free text of a tag, '' when missing or longer than `max` */
const short = (v, max = 40) => (v !== undefined && v.trim().length <= max ? v.trim() : '');

/**
 * bicycle parking record: [lon, lat, type (bicycle_parking=*), capacity, covered, access, fee, lit, cargo 0|1, operator, name,
 * osm ''|'w'|'r' ('' = node), OSM id]
 */
export function parkingRecord({ id, x, y, tags: t }, osm = '') {
  const capacity = /^\d{1,5}$/.test(t.capacity ?? '') ? Number(t.capacity) : 0;
  const cargo = Number(t['capacity:cargo_bike']) > 0 || t['capacity:cargo_bike'] === 'yes' || ['yes', 'designated'].includes(t.cargo_bike) ? 1 : 0;
  return [r5(x), r5(y), short(t.bicycle_parking), capacity || '', oneOf(t.covered, ['yes', 'no', 'partial']), short(t.access),
    oneOf(t.fee, ['yes', 'no']), oneOf(t.lit, ['yes', 'no']), cargo, short(t.operator, 80), short(t.name, 80), osm, Number(id)];
}

/** area-weighted centre of a closed ring [lon, lat][]; the mean of its corners when it has no area */
export function ringCentre(ring) {
  const [x0, y0] = ring[0];
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const ax = ring[i][0] - x0, ay = ring[i][1] - y0, bx = ring[i + 1][0] - x0, by = ring[i + 1][1] - y0;
    const k = ax * by - bx * ay;
    area += k;
    cx += (ax + bx) * k;
    cy += (ay + by) * k;
  }
  if (Math.abs(area) > 1e-14) return [x0 + cx / (3 * area), y0 + cy / (3 * area)];
  const corners = ring.slice(0, -1);
  return [0, 1].map((d) => corners.reduce((sum, c) => sum + c[d], 0) / corners.length);
}

/**
 * A bicycle parking mapped as an area (`osmium export -a type,id`): [point, outline], both with the same properties, or null. The
 * point goes into the same layer as the parkings mapped as nodes (so the app reads one layer for all), the outline (zoom 14 only)
 * into PARKING_AREA_LAYER. A multipolygon with several parts gets its point in the first one.
 */
export function parkingArea(f) {
  const t = f.properties ?? {}, g = f.geometry;
  if (t.amenity !== 'bicycle_parking' || (g?.type !== 'Polygon' && g?.type !== 'MultiPolygon')) return null;
  const [x, y] = ringCentre((g.type === 'Polygon' ? g.coordinates : g.coordinates[0])[0]);
  const point = recordFeature(PARKING_FIELDS, parkingRecord({ id: t['@id'], x, y, tags: t }, t['@type'] === 'relation' ? 'r' : 'w'));
  const round = (c) => (typeof c[0] === 'number' ? [r6(c[0]), r6(c[1])] : c.map(round));
  const outline = { type: 'Feature', tippecanoe: { layer: PARKING_AREA_LAYER, minzoom: 14 }, geometry: { type: g.type, coordinates: round(g.coordinates) }, properties: point.properties };
  return [point, outline];
}

// --- the registry --------------------------------------------------------------------------------------------------------

/** refines the kind of speed cameras by their enforcement relations (relations come after all nodes in the stream) */
export function refineEnforcement(rel, byId) {
  // positions of relations are not available when streaming (-R), so use their device nodes:
  // red-light relation → its devices are red-light cameras; several devices of a speed relation → monitored stretch
  const devices = rel.members.map((m) => byId.get(m.ref)).filter(Boolean);
  if (rel.tags.enforcement === 'traffic_signals') for (const d of devices) d[3] = 'signals';
  else if (rel.tags.enforcement === 'maxspeed' && devices.length > 1) for (const d of devices) if (d[3] === 'cam') d[3] = 'section';
}

const POINT_RES = { geometry: 'point', zoom: [0, 14], tippecanoe: ['--drop-densest-as-needed', '-M', '1000000', '-O', '250000', '-r1', '-b', '0'] };
const RESOURCE_MAN_MADE = ['petroleum_well', 'pumpjack', 'mineshaft', 'adit'];
const RESOURCE_INDUSTRIAL = ['mine', 'oil', 'gas', 'refinery'];

/** bicycle parking from zoom 10 (a world view of a million racks says nothing and would double the file); outlines are neither clipped nor reduced */
const PARKING_RES = { zoom: [10, 14], tippecanoe: [...POINT_RES.tippecanoe, '--no-clipping', '--no-tiny-polygon-reduction'] };

/** the themes (see the head of the file); the key is the source id = name of its intermediate <id>.geojsonl */
export const THEMES = {
  cctv: { ...POINT_RES, file: 'cctv', layer: 'cctv', group: 'points', low: true, heat: true, filter: ['n/man_made=surveillance'], match: isCctv, record, fields: ['dir', 'surveillance', 'ctype', 'mount', 'guard', 'operator', 'id'] },
  blitzer: { ...POINT_RES, file: 'blitzer', layer: 'blitzer', group: 'points', low: true, filter: ['n/highway=speed_camera', 'r/type=enforcement'], match: (t) => t.highway === 'speed_camera', record: speedRecord, refine: refineEnforcement, fields: ['dir', 'kind', 'speed', 'operator', 'ref', 'id'] },
  alpr: { ...POINT_RES, file: 'alpr', layer: 'alpr', group: 'points', low: true, filter: ['n/surveillance:type=ALPR'], match: (t) => t['surveillance:type'] === 'ALPR', record: alprRecord, fields: ['dir', 'brand', 'flock', 'mount', 'operator', 'zone', 'since', 'ref', 'id'] },
  webcam: { ...POINT_RES, file: 'webcam', layer: 'webcam', group: 'points', low: true, filter: ['n/webcam', 'n/contact:webcam'], match: (t) => !!webcamLink(t), record: (p) => webcamRecord(p, webcamLink(p.tags)), fields: ['dir', 'name', 'operator', 'panning', 'link', 'id'] },
  wind: { ...POINT_RES, file: 'wind', layer: 'wind', group: 'points', filter: ['n/generator:source=wind'], match: (t) => t.power === 'generator' && t['generator:source'] === 'wind', record: windRecord, fields: ['name', 'operator', 'manufacturer', 'model', 'output', 'id'] },
  resource: {
    ...POINT_RES, file: 'resource', layer: 'resource', group: 'points',
    filter: [`n/man_made=${RESOURCE_MAN_MADE.join(',')}`, `n/industrial=${RESOURCE_INDUSTRIAL.join(',')}`, 'n/landuse=quarry'],
    match: (t) => RESOURCE_MAN_MADE.includes(t.man_made) || RESOURCE_INDUSTRIAL.includes(t.industrial) || t.landuse === 'quarry',
    record: resourceRecord, fields: ['name', 'kind', 'words', 'resource', 'operator', 'id'],
  },
  // bicycle parking: nodes from the stream, areas (ways and multipolygons) through osmium export; both in the layer `fahrradparken`
  fahrradparken: { ...POINT_RES, ...PARKING_RES, file: 'fahrradparken', layer: 'fahrradparken', group: 'points', filter: ['n/amenity=bicycle_parking'], match: (t) => t.amenity === 'bicycle_parking', record: parkingRecord, fields: PARKING_FIELDS },
  fahrradparken_areas: { ...PARKING_RES, geometry: 'polygon', file: 'fahrradparken', layer: 'fahrradparken', group: 'points', filter: ['w/amenity=bicycle_parking', 'r/amenity=bicycle_parking'], attributes: 'type,id', polygonFeature: parkingArea },
  // single trees for the 3D view, z15 only (the map overzooms it; z16 would store every tree twice); no id (the position is enough), no genus (the app derives it from species)
  trees: { ...POINT_RES, zoom: [15, 15], file: 'trees', layer: 'trees', group: 'trees', filter: ['n/natural=tree'], match: (t) => t.natural === 'tree', record: treeRecord, fields: ['species', 'height', 'circumference', 'leaf_type', 'leaf_cycle'] },
  // second layer of trees.pmtiles: rows of trees and hedges as lines
  tree_lines: { geometry: 'line', zoom: [15, 15], file: 'trees', layer: 'tree_lines', group: 'trees', filter: ['w/natural=tree_row', 'w/barrier=hedge'], match: (t) => t.natural === 'tree_row' || t.barrier === 'hedge', lineRecord: treeLineRecord, lineFeature, tippecanoe: ['--drop-densest-as-needed', '-M', '1000000', '-O', '250000', '-r1', '-b', '0'] },
  // roof shapes (buildings and building parts with a roof tag), z15 only; whole buildings, each in exactly ONE tile (no clipping: the app lays the roof planes over the bounding rectangle of the outline)
  roofs: {
    geometry: 'polygon', zoom: [15, 15], file: 'roofs', layer: 'roofs', group: 'roofs',
    filter: ROOF_TAGS.flatMap((k) => [`w/${k}`, `r/${k}`]), require: ['w/building', 'w/building:part', 'r/building', 'r/building:part'],
    polygonFeature: roofFeature, tippecanoe: ['--no-clipping', '--no-duplication', '--no-tile-size-limit', '--no-feature-limit'],
  },
};

// Network plans (collectors/netzplan.mjs): one file per variant (netz-<variant>) with the layers lines, labels and stations. All nine
// sources are computed together from the rail route relations of the first pass and the stop nodes of a second pass.
for (const variant of Object.keys(NET_VARIANTS)) {
  for (const layer of NET_LAYERS) {
    THEMES[`netz_${variant}_${layer}`] = {
      file: `netz-${variant}`, layer, variant, group: 'netz', geometry: 'netz', zoom: [6, 12],
      filter: ['r/route=train,subway,light_rail,tram,monorail'],
      // nothing is dropped: a missing line or station would tear a plan apart, and the rail network is thin enough
      tippecanoe: ['-r1', '--no-feature-limit', '--no-tile-size-limit'],
    };
  }
}

/** the sources of one world file */
export const sourcesOf = (file) => Object.entries(THEMES).filter(([, s]) => s.file === file).map(([id, s]) => ({ id, ...s }));
/** the world files (= data sets the client reads), in registry order */
export const FILES = [...new Set(Object.values(THEMES).map((s) => s.file))];
/** release groups: group → files */
export const GROUPS = Object.fromEntries([...new Set(Object.values(THEMES).map((s) => s.group))].map((g) => [g, [...new Set(Object.values(THEMES).filter((s) => s.group === g).map((s) => s.file))]]));
