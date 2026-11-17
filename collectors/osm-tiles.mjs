// OpenStreetMap point data for Orbis as PMTiles: one file per data set for the whole world in the bucket orbis-osm
// (<set>.pmtiles, layer name = set). Sets: cctv (surveillance cameras without ALPR/webcams), blitzer (speed and
// red-light cameras), alpr (licence plate readers), webcam (webcams with a link), wind (single wind turbines),
// resource (mine shafts, adits, wells, quarry/mine/oil/gas/refinery points), trees (natural=tree nodes for the 3D view,
// zoom 15 only, see SET_ZOOM; the same file carries a second layer `tree_lines` with the ways natural=tree_row and
// barrier=hedge as lines, see treeLineRecord).
// Only nodes are available when streaming (-R): ways and areas with the other tags are not included. The tree lines
// need geometry and therefore a second streamed pass over the extract (extractLines): the first pass keeps the ways
// (their node refs), the second one fetches just those nodes (`osmium getid`), osmium builds the lines (`export`).
//
// Three steps (run by .github/workflows/osm-tiles.yml, bucket orbis-osm):
//   node collectors/osm-tiles.mjs plan <dir> [region|all]      prints the JSON list of regions to refresh: <dir>/src/<region>/info.json
//                                                              says when each was built; without argument the stalest one that is
//                                                              older than MAX_AGE_DAYS (or missing), `all` = every region
//   node collectors/osm-tiles.mjs extract <outDir> <region> [--url <pbf-url>]
//                                                              streams the Geofabrik extract through `osmium tags-filter -R` (nothing
//                                                              big is stored) and writes intermediates, one per set:
//                                                              <outDir>/src/<region>/<set>.geojsonl (newline-delimited GeoJSON points; GZ_SETS: <set>.geojsonl.gz)
//                                                              <outDir>/src/<region>/tree_lines.geojsonl.gz (GeoJSON lines of the `tree_lines` layer)
//                                                              <outDir>/src/<region>/info.json  (build date, counts, format)
//                                                              --url builds from another .osm.pbf (local test with a tiny extract)
//   node collectors/osm-tiles.mjs build <srcDir> <distDir>     builds <distDir>/<set>.pmtiles with tippecanoe from the intermediates
//                                                              of ALL regions in <srcDir>/<region>/, the cctv heatmap
//                                                              <distDir>/heat/cctv.json, meta.json and LICENSE.txt
// The properties of the GeoJSON features are the fields of the former tile records (see FIELDS; fields that
// have their default value are left out) – src/api/osmtiles.ts of the app turns them back into the records.
// Data © OpenStreetMap contributors (ODbL), extracts by Geofabrik.

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';

export const REGIONS = {
  europe: 'europe',
  russia: 'russia',
  asia: 'asia',
  'north-america': 'north-america',
  'central-america': 'central-america',
  'south-america': 'south-america',
  africa: 'africa',
  oceania: 'australia-oceania',
};
const MAX_AGE_DAYS = 30;
const CELL = 100; // heatmap cells per degree (0.01° ≈ 1 km)
/** bump when the file layout changes: older regions count as stale and are rebuilt */
export const FORMAT = 7;
/** point data sets – the client reads them in src/api/osmtiles.ts */
export const SETS = ['cctv', 'blitzer', 'alpr', 'webcam', 'wind', 'resource', 'trees'];
/** pmtiles zoom range: single points down to z14 (no points dropped at max zoom unless a tile is huge), thinned out below */
const MIN_ZOOM = 0;
const MAX_ZOOM = 14;
/** sets with their own zoom range [min, max] (trees: single trees for the 3D view, z15 only: the map overzooms it, z16 would store every tree twice) */
export const SET_ZOOM = { trees: [15, 15] };
/** second layer of trees.pmtiles: tree rows and hedges as lines; its intermediate is <region>/tree_lines.geojsonl.gz (not a set of its own: it goes into the build of `trees`) */
export const LINES = { set: 'trees', layer: 'tree_lines', file: 'tree_lines.geojsonl.gz' };
/** Douglas-Peucker tolerance of the lines (m) */
export const LINE_TOLERANCE = 1;
/**
 * Sets the viewer draws from zoom 0 (cameras): below LOW_ZOOM_END their tiles carry a second, attribute-free layer
 * `<set>_lo` instead of the full records. Every point stays visible: points that fall into the same cell of a
 * LOW_GRID × LOW_GRID grid per tile (≈ half a screen pixel at 512 px tiles) are drawn on top of each other anyway, so
 * one stands for them. The full layer `<set>` starts at LOW_ZOOM_END (the viewer reads `<set>_lo` below it).
 */
export const LOW_SETS = ['cctv', 'blitzer', 'alpr', 'webcam'];
export const LOW_ZOOM_END = 6; // first zoom of the full layer; the `_lo` layer covers 0 .. LOW_ZOOM_END - 1
export const LOW_GRID = 1024;

/** sets whose intermediates are gzipped (<set>.geojsonl.gz; trees is ~18x bigger than all other sets together, R2 free tier is 10 GB) */
export const GZ_SETS = ['trees'];
/** sets whose build may fail without stopping the rest (the other sets and meta.json are still published) */
export const OPTIONAL_SETS = ['trees'];
/** file name of a set's intermediate in <src>/<region>/ */
export const srcFile = (set) => `${set}.geojsonl${GZ_SETS.includes(set) ? '.gz' : ''}`;

/** record fields after [lon, lat] per set (= property names of the GeoJSON features) */
export const FIELDS = {
  cctv: ['dir', 'surveillance', 'ctype', 'mount', 'guard', 'operator', 'id'],
  blitzer: ['dir', 'kind', 'speed', 'operator', 'ref', 'id'],
  alpr: ['dir', 'brand', 'flock', 'mount', 'operator', 'zone', 'since', 'ref', 'id'],
  webcam: ['dir', 'name', 'operator', 'panning', 'link', 'id'],
  wind: ['name', 'operator', 'manufacturer', 'model', 'output', 'id'],
  resource: ['name', 'kind', 'words', 'resource', 'operator', 'id'],
  trees: ['species', 'height', 'circumference', 'leaf_type', 'leaf_cycle'], // no id (position is enough to find a tree in OSM), no genus (the app derives it from species)
};
/** property names of a tree_lines feature (after the geometry) */
export const LINE_FIELDS = ['kind', 'species', 'height', 'leaf_type', 'leaf_cycle'];
/** default of a field (left out of the file): direction -1, flags 0, everything else '' (id, where a set has one, is always present) */
export const fieldDefault = (f) => (f === 'dir' ? -1 : f === 'guard' || f === 'flock' || f === 'panning' ? 0 : '');

/** a record [lon, lat, …FIELDS[set]] as GeoJSON point feature (numbers stay numbers; '' = not tagged = left out) */
export function toFeature(set, rec) {
  const props = {};
  FIELDS[set].forEach((f, i) => {
    const v = rec[i + 2];
    if (f === 'id' || v !== fieldDefault(f)) props[f] = v;
  });
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [rec[0], rec[1]] }, properties: props };
}

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
  if (!p) return null;
  const t = p.tags;
  if (t.man_made !== 'surveillance' || t['surveillance:type'] === 'ALPR' || t.webcam || t['contact:webcam']) return null;
  return p;
}

/** One OPL line of an enforcement relation → { tags, members: [{ ref, role }] } or null. Only node members are kept. */
export function parseEnforcement(line) {
  if (line.charCodeAt(0) !== 114 /* r */) return null;
  let raw = '', mem = '';
  for (const f of line.split(' ')) {
    if (f[0] === 'T') raw = f.slice(1);
    else if (f[0] === 'M') mem = f.slice(1);
  }
  const tags = parseTags(raw);
  if (tags.type !== 'enforcement') return null;
  const members = [];
  for (const m of mem.split(',')) {
    const at = m.indexOf('@');
    if (m[0] === 'n' && at > 1) members.push({ ref: m.slice(1, at), role: unescapeOpl(m.slice(at + 1)) });
  }
  return { tags, members };
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

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

const RESOURCE_MAN_MADE = ['petroleum_well', 'pumpjack', 'mineshaft', 'adit'];
const RESOURCE_INDUSTRIAL = ['mine', 'oil', 'gas', 'refinery'];

/** which point data sets a node belongs to, with its records */
function classify(p) {
  const t = p.tags;
  const out = [];
  if (t['surveillance:type'] === 'ALPR') out.push(['alpr', alprRecord(p)]);
  const link = webcamLink(t);
  if (link) out.push(['webcam', webcamRecord(p, link)]);
  if (t.power === 'generator' && t['generator:source'] === 'wind') out.push(['wind', windRecord(p)]);
  if (RESOURCE_MAN_MADE.includes(t.man_made) || RESOURCE_INDUSTRIAL.includes(t.industrial) || t.landuse === 'quarry') out.push(['resource', resourceRecord(p)]);
  if (t.natural === 'tree') out.push(['trees', treeRecord(p)]);
  return out;
}


/** appends lines to a file with backpressure */
function lineWriter(path) {
  const file = createWriteStream(path);
  const gz = path.endsWith('.gz') ? createGzip({ level: 6 }) : null;
  if (gz) gz.pipe(file);
  const ws = gz ?? file;
  let buf = [];
  let size = 0;
  const flush = async () => {
    if (!buf.length) return;
    const chunk = buf.join('');
    buf = [];
    size = 0;
    if (!ws.write(chunk)) await once(ws, 'drain');
  };
  return {
    async write(line) {
      buf.push(line, '\n');
      size += line.length;
      if (size > 1 << 20) await flush();
    },
    async close() {
      await flush();
      ws.end();
      await once(file, 'finish');
    },
  };
}

/** shell command that writes the .osm.pbf of `src` (URL or local file) to stdout */
const pbfInput = (src) => (/^https?:/.test(src) ? `curl -sSfL --connect-timeout 30 --speed-limit 200000 --speed-time 180 -A "Orbis-data/1.0 (+https://github.com/malte9799/orbis)" "${src}"` : `cat "${src}"`);

/** runs a shell pipeline, resolves when it exits 0 */
function sh(cmd) {
  return new Promise((res, rej) => {
    const p = spawn('bash', ['-c', `set -o pipefail; ${cmd}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`pipeline failed (exit ${c}): ${cmd.slice(0, 120)}`))));
  });
}

/**
 * Tree lines (natural=tree_row, barrier=hedge) as <dir>/tree_lines.geojsonl.gz. Input: `waysFile`, the OPL lines of the
 * ways from the first pass (tags + node refs). Second streamed pass over the extract: only the nodes those ways use
 * (`osmium getid`, ids from the ways), then osmium merges nodes + ways in a temp dir and exports them as linestrings
 * (closed ways stay lines). Returns the number of lines written.
 */
async function extractLines(dir, src, waysFile) {
  const tmp = join(dir, 'lines-tmp');
  mkdirSync(tmp, { recursive: true });
  const idsFile = join(tmp, 'node-ids.txt');
  const ids = lineWriter(idsFile);
  let ways = 0;
  for await (const line of createInterface({ input: createReadStream(waysFile) })) {
    const w = parseWay(line);
    if (!w) continue;
    ways++;
    for (const r of w.refs) await ids.write(`n${r}`);
  }
  await ids.close();
  if (!ways) {
    rmSync(tmp, { recursive: true, force: true });
    await new Promise((res) => createWriteStream(join(dir, LINES.file)).end(res)); // empty gz-less placeholder is skipped by build (size 0)
    return 0;
  }
  const nodes = join(tmp, 'nodes.osm.pbf'), waysPbf = join(tmp, 'ways.osm.pbf'), merged = join(tmp, 'merged.osm.pbf'), located = join(tmp, 'lines.geojsonseq');
  // pass 2 over the extract: only the used nodes (getid without -r reads the stream once; ids in a bitmap)
  await sh(`${pbfInput(src)} | osmium getid --overwrite -F pbf -f pbf -o "${nodes}" -i "${idsFile}" -`);
  await sh(`osmium cat --overwrite --input-format=opl -f pbf -o "${waysPbf}" "${waysFile}" && osmium merge --overwrite -o "${merged}" "${nodes}" "${waysPbf}"`);
  rmSync(nodes, { force: true });
  rmSync(waysPbf, { force: true });
  await sh(`osmium export --overwrite -i sparse_file_array,"${join(tmp, 'locations.idx')}" --geometry-types=linestring -f geojsonseq -x print_record_separator=false -o "${located}" "${merged}"`);
  rmSync(merged, { force: true });
  const out = lineWriter(join(dir, LINES.file));
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(located), crlfDelay: Infinity })) {
    if (!line) continue;
    const f = JSON.parse(line);
    if (f.geometry?.type !== 'LineString') continue;
    const rec = treeLineRecord(f.properties ?? {}, f.geometry.coordinates);
    if (!rec) continue;
    await out.write(JSON.stringify(lineFeature(rec)));
    n++;
  }
  await out.close();
  rmSync(tmp, { recursive: true, force: true });
  return n;
}

async function extract(region, outDir, url) {
  const dir = join(outDir, 'src', region);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = url ?? `https://download.geofabrik.de/${REGIONS[region]}-latest.osm.pbf`;
  const filter = `n/man_made=surveillance n/highway=speed_camera n/surveillance:type=ALPR n/webcam n/contact:webcam n/generator:source=wind n/man_made=${RESOURCE_MAN_MADE.join(',')} n/industrial=${RESOURCE_INDUSTRIAL.join(',')} n/landuse=quarry n/natural=tree w/natural=tree_row w/barrier=hedge r/type=enforcement`;
  const input = pbfInput(src);
  const proc = spawn('bash', ['-c', `set -o pipefail; ${input} | osmium tags-filter -R --input-format=pbf --output-format=opl --overwrite -o - - ${filter}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`${region}: streaming ${src}`);
  const t0 = Date.now();
  const out = Object.fromEntries(SETS.filter((s) => s !== 'blitzer').map((s) => [s, lineWriter(join(dir, srcFile(s)))]));
  const counts = Object.fromEntries([...SETS, LINES.layer].map((s) => [s, 0]));
  const waysFile = join(dir, 'ways.opl'); // tree rows and hedges (OPL), input of extractLines
  const ways = createWriteStream(waysFile);
  /** speed cameras by node id; enforcement relations (they come after all nodes) refine their kind */
  const speed = new Map();
  for await (const line of createInterface({ input: proc.stdout })) {
    if (line.charCodeAt(0) === 119 /* w */) {
      if (!ways.write(`${line}\n`)) await once(ways, 'drain');
      continue;
    }
    const rel = line.charCodeAt(0) === 114 ? parseEnforcement(line) : null;
    if (rel) {
      // positions of relations are not available when streaming (-R), so use their device nodes:
      // red-light relation → its devices are red-light cameras; several devices of a speed relation → monitored stretch
      const devices = rel.members.map((m) => speed.get(m.ref)).filter(Boolean);
      if (rel.tags.enforcement === 'traffic_signals') for (const d of devices) d[3] = 'signals';
      else if (rel.tags.enforcement === 'maxspeed' && devices.length > 1) for (const d of devices) if (d[3] === 'cam') d[3] = 'section';
      continue;
    }
    const node = parseNode(line);
    if (!node) continue;
    if (node.tags.highway === 'speed_camera') {
      speed.set(node.id, speedRecord(node));
      continue;
    }
    const hits = classify(node);
    const cam = parseOpl(line);
    if (cam) hits.push(['cctv', record(cam)]);
    for (const [set, rec] of hits) {
      await out[set].write(JSON.stringify(toFeature(set, rec)));
      if (++counts[set] % 100000 === 0) console.log(`${region}: ${counts[set]} ${set} so far (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  const code = await new Promise((res) => proc.on('close', res));
  if (code !== 0) throw new Error(`${region}: download/filter failed (exit ${code})`);
  const bl = lineWriter(join(dir, 'blitzer.geojsonl'));
  for (const rec of speed.values()) await bl.write(JSON.stringify(toFeature('blitzer', rec)));
  counts.blitzer = speed.size;
  await bl.close();
  for (const w of Object.values(out)) await w.close();
  ways.end();
  await once(ways, 'finish');
  // lines: second pass, may fail without losing the points (info.linesOk = false makes `plan` pick the region again at once)
  let linesOk = true;
  try {
    counts[LINES.layer] = await extractLines(dir, src, waysFile);
  } catch (e) {
    linesOk = false;
    console.error(`${region}: tree lines failed (${e.message}) – points are kept, the lines of this region are missing until the next run`);
    rmSync(join(dir, LINES.file), { force: true });
    rmSync(join(dir, 'lines-tmp'), { recursive: true, force: true });
  }
  rmSync(waysFile, { force: true });
  console.log(`${region}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} (${Math.round((Date.now() - t0) / 1000)} s)`);
  return { counts, linesOk };
}

/** a streamed download cannot resume: on any failure (connect error, stall, broken stream) start the region over, up to 3 times */
async function extractWithRetry(region, outDir, url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await extract(region, outDir, url);
    } catch (e) {
      if (i >= attempts) throw e;
      console.error(`${region}: attempt ${i}/${attempts} failed (${e.message}) – starting over in 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

/** which regions to refresh: `all`, the given one, or the stalest one that is due */
export function planRegions(infos, arg, now = Date.now()) {
  if (arg === 'all') return Object.keys(REGIONS);
  if (arg) {
    if (!REGIONS[arg]) throw new Error(`unknown region ${arg}`);
    return [arg];
  }
  const age = (r) => (infos[r]?.format === FORMAT && infos[r].linesOk !== false ? now - infos[r].at : Infinity);
  const due = Object.keys(REGIONS).filter((r) => age(r) > MAX_AGE_DAYS * 864e5).sort((a, b) => age(b) - age(a));
  return due.slice(0, 1);
}

const readInfo = (srcDir, region) => {
  try {
    return JSON.parse(readFileSync(join(srcDir, region, 'info.json'), 'utf8'));
  } catch {
    return null;
  }
};

/** streams the cctv intermediates of all regions into world heatmap cells [lon, lat, count] */
async function heatCells(files) {
  const cells = new Map();
  for (const f of files) {
    for await (const line of createInterface({ input: createReadStream(f) })) {
      if (!line) continue;
      const [x, y] = JSON.parse(line).geometry.coordinates;
      const key = Math.round(x * CELL) * 1e6 + Math.round(y * CELL);
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
  }
  return [...cells].map(([k, c]) => {
    // key = X·1e6 + Y with |Y| ≤ 9000 < 5e5
    const x = Math.round(k / 1e6);
    return [x / CELL, (k - x * 1e6) / CELL, c];
  });
}

/**
 * Attribute-free copy of the points for the low zooms: for each zoom z < LOW_ZOOM_END one point per LOW_GRID cell of a
 * tile (Web-Mercator), written as newline-delimited GeoJSON with `tippecanoe: {layer, minzoom: z, maxzoom: z}`.
 * Returns the number of points per zoom.
 */
export async function lowZoomPoints(files, set, outFile) {
  const out = createWriteStream(outFile);
  const seen = Array.from({ length: LOW_ZOOM_END }, () => new Set());
  const counts = new Array(LOW_ZOOM_END).fill(0);
  for (const file of files) {
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (!line) continue;
      const c = JSON.parse(line).geometry?.coordinates;
      if (!c) continue;
      const [lon, lat] = c;
      const wx = (lon + 180) / 360;
      const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
      const wy = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
      for (let z = 0; z < LOW_ZOOM_END; z++) {
        const n = 2 ** z * LOW_GRID;
        const key = Math.min(n - 1, Math.floor(wx * n)) * n + Math.min(n - 1, Math.floor(wy * n));
        if (seen[z].has(key)) continue;
        seen[z].add(key);
        counts[z]++;
        if (!out.write(`{"type":"Feature","tippecanoe":{"layer":"${set}_lo","minzoom":${z},"maxzoom":${z}},"geometry":{"type":"Point","coordinates":[${lon},${lat}]},"properties":{}}\n`)) await once(out, 'drain');
      }
    }
  }
  out.end();
  await once(out, 'finish');
  return counts;
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited with ${c}`))));
  });
}

async function build(srcDir, distDir) {
  const regions = Object.keys(REGIONS).filter((r) => existsSync(join(srcDir, r, 'info.json')) || existsSync(join(srcDir, r, 'cctv.geojsonl')));
  const extra = readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !REGIONS[d.name]).map((d) => d.name); // test regions
  const used = [...regions, ...extra];
  if (!used.length) throw new Error(`no intermediates in ${srcDir}`);
  mkdirSync(join(distDir, 'heat'), { recursive: true });
  const meta = { format: FORMAT, at: Date.now(), regions: {}, sets: {} };
  for (const r of used) {
    const info = readInfo(srcDir, r);
    if (info) meta.regions[r] = info;
  }
  console.log(`building from ${used.join(', ')}`);
  for (const set of SETS) {
    const files = used.map((r) => join(srcDir, r, srcFile(set))).filter((f) => existsSync(f) && statSync(f).size > 0);
    const lineFiles = set === LINES.set ? used.map((r) => join(srcDir, r, LINES.file)).filter((f) => existsSync(f) && statSync(f).size > 0) : [];
    const target = join(distDir, `${set}.pmtiles`);
    if (!files.length) {
      console.log(`${set}: no data – skipped`);
      continue;
    }
    // -r1: no thinning by rate; -b 0: no buffer (points would be duplicated into the neighbour tiles); --drop-densest-as-needed only where a tile gets too big (dense low zooms), -M/-O keep z14 complete
    const [zMin, zMax] = SET_ZOOM[set] ?? [MIN_ZOOM, MAX_ZOOM];
    const common = ['--force', '-n', set, '-N', `OpenStreetMap ${set} points`, '-r1', '-b', '0', '--read-parallel', '-q', '-A', '© OpenStreetMap contributors (ODbL)'];
    if (LOW_SETS.includes(set)) {
      // Camera sets: z0..LOW_ZOOM_END-1 only one bare point per grid cell (layer <set>_lo, lowZoomPoints), nothing dropped;
      // from LOW_ZOOM_END the full records (layer <set>); tile-join puts both zoom ranges into one file
      const lo = join(distDir, `${set}-lo`);
      meta.sets[set] = { lowZoomPoints: await lowZoomPoints(files, set, `${lo}.geojsonl`) };
      await run('tippecanoe', ['-o', `${lo}.pmtiles`, '-l', `${set}_lo`, '-Z', '0', '-z', String(LOW_ZOOM_END - 1), '--no-feature-limit', '--no-tile-size-limit', ...common, `${lo}.geojsonl`]);
      await run('tippecanoe', ['-o', `${join(distDir, `${set}-hi`)}.pmtiles`, '-l', set, '-Z', String(LOW_ZOOM_END), '-z', String(MAX_ZOOM), '--drop-densest-as-needed', '-M', '1000000', '-O', '250000', ...common, ...files]);
      await run('tile-join', ['-o', target, '--force', '-pk', '-q', '-n', set, '-N', `OpenStreetMap ${set} points`, '-A', '© OpenStreetMap contributors (ODbL)', `${lo}.pmtiles`, `${join(distDir, `${set}-hi`)}.pmtiles`]);
      for (const f of [`${lo}.geojsonl`, `${lo}.pmtiles`, `${join(distDir, `${set}-hi`)}.pmtiles`]) rmSync(f, { force: true });
    } else {
      try {
        // trees: two layers in one file, -L name:file per input (points `trees`, lines `tree_lines`, both only at the set's zoom)
        const inputs = lineFiles.length ? [...files.map((f) => ['-L', `${set}:${f}`]), ...lineFiles.map((f) => ['-L', `${LINES.layer}:${f}`])].flat() : ['-l', set, ...files];
        await run('tippecanoe', ['-o', target, '-Z', String(zMin), '-z', String(zMax), '--drop-densest-as-needed', '-M', '1000000', '-O', '250000', ...common, ...inputs]);
      } catch (e) {
        if (!OPTIONAL_SETS.includes(set)) throw e;
        console.error(`${set}: build failed (${e.message}) – skipped, the previous file stays in the bucket`);
        rmSync(target, { force: true });
        continue;
      }
    }
    meta.sets[set] = { ...meta.sets[set], bytes: statSync(target).size, features: used.reduce((a, r) => a + (meta.regions[r]?.counts?.[set] ?? 0), 0), ...(set === LINES.set ? { lines: used.reduce((a, r) => a + (meta.regions[r]?.counts?.[LINES.layer] ?? 0), 0) } : {}) };
    console.log(`${set}: ${meta.sets[set].bytes} bytes`);
  }
  const cctv = used.map((r) => join(srcDir, r, 'cctv.geojsonl')).filter((f) => existsSync(f));
  const cells = await heatCells(cctv);
  writeFileSync(join(distDir, 'heat', 'cctv.json'), JSON.stringify(cells));
  meta.heatCells = cells.length;
  console.log(`heat/cctv.json: ${cells.length} cells`);
  writeFileSync(join(distDir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(distDir, 'LICENSE.txt'), 'Data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/\nhttps://www.openstreetmap.org/copyright\nDerived from Geofabrik extracts (https://download.geofabrik.de).\n');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'plan') {
    const [dir, arg] = args;
    const infos = Object.fromEntries(Object.keys(REGIONS).map((r) => [r, readInfo(join(dir ?? '.', 'src'), r)]));
    console.log(JSON.stringify(planRegions(infos, arg)));
  } else if (cmd === 'extract') {
    const [outDir, region, flag, url] = args;
    if (!outDir || !region) throw new Error('usage: osm-tiles extract <outDir> <region> [--url <pbf>]');
    if (!REGIONS[region] && flag !== '--url') throw new Error(`unknown region ${region}`);
    const { counts, linesOk } = await extractWithRetry(region, outDir, flag === '--url' ? url : undefined);
    if (!url && counts.cctv < 50) throw new Error(`${region}: only ${counts.cctv} cameras – keeping previous data`);
    writeFileSync(join(outDir, 'src', region, 'info.json'), JSON.stringify({ at: Date.now(), counts, format: FORMAT, ...(linesOk ? {} : { linesOk: false }) }));
  } else if (cmd === 'build') {
    const [srcDir, distDir] = args;
    if (!srcDir || !distDir) throw new Error('usage: osm-tiles build <srcDir> <distDir>');
    await build(srcDir, distDir);
  } else {
    throw new Error('usage: osm-tiles plan <dir> [region|all] | extract <outDir> <region> | build <srcDir> <distDir>');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
