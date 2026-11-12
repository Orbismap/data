// OpenStreetMap point data for Orbis as PMTiles: one file per data set for the whole world in the bucket orbis-osm
// (<set>.pmtiles, layer name = set). Sets: cctv (surveillance cameras without ALPR/webcams), blitzer (speed and
// red-light cameras), alpr (licence plate readers), webcam (webcams with a link), wind (single wind turbines),
// resource (mine shafts, adits, wells, quarry/mine/oil/gas/refinery points).
// Only nodes are available when streaming (-R): ways and areas with these tags are not included.
//
// Three steps (run by .github/workflows/osm-tiles.yml, bucket orbis-osm):
//   node collectors/osm-tiles.mjs plan <dir> [region|all]      prints the JSON list of regions to refresh: <dir>/src/<region>/info.json
//                                                              says when each was built; without argument the stalest one that is
//                                                              older than MAX_AGE_DAYS (or missing), `all` = every region
//   node collectors/osm-tiles.mjs extract <outDir> <region> [--url <pbf-url>]
//                                                              streams the Geofabrik extract through `osmium tags-filter -R` (nothing
//                                                              big is stored) and writes intermediates, one per set:
//                                                              <outDir>/src/<region>/<set>.geojsonl (newline-delimited GeoJSON points)
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
export const FORMAT = 5;
/** point data sets – the client reads them in src/api/osmtiles.ts */
export const SETS = ['cctv', 'blitzer', 'alpr', 'webcam', 'wind', 'resource'];
/** pmtiles zoom range: single points down to z14 (no points dropped at max zoom unless a tile is huge), thinned out below */
const MIN_ZOOM = 0;
const MAX_ZOOM = 14;
/**
 * Sets the viewer draws from zoom 0 (cameras): below LOW_ZOOM_END their tiles carry a second, attribute-free layer
 * `<set>_lo` instead of the full records. Every point stays visible: points that fall into the same cell of a
 * LOW_GRID × LOW_GRID grid per tile (≈ half a screen pixel at 512 px tiles) are drawn on top of each other anyway, so
 * one stands for them. The full layer `<set>` starts at LOW_ZOOM_END (the viewer reads `<set>_lo` below it).
 */
export const LOW_SETS = ['cctv', 'blitzer', 'alpr', 'webcam'];
export const LOW_ZOOM_END = 6; // first zoom of the full layer; the `_lo` layer covers 0 .. LOW_ZOOM_END - 1
export const LOW_GRID = 1024;

/** record fields after [lon, lat] per set (= property names of the GeoJSON features) */
export const FIELDS = {
  cctv: ['dir', 'surveillance', 'ctype', 'mount', 'guard', 'operator', 'id'],
  blitzer: ['dir', 'kind', 'speed', 'operator', 'ref', 'id'],
  alpr: ['dir', 'brand', 'flock', 'mount', 'operator', 'zone', 'since', 'ref', 'id'],
  webcam: ['dir', 'name', 'operator', 'panning', 'link', 'id'],
  wind: ['name', 'operator', 'manufacturer', 'model', 'output', 'id'],
  resource: ['name', 'kind', 'words', 'resource', 'operator', 'id'],
};
/** default of a field (left out of the file): direction -1, flags 0, everything else '' (id is always present) */
export const fieldDefault = (f) => (f === 'dir' ? -1 : f === 'guard' || f === 'flock' || f === 'panning' ? 0 : '');

/** a record [lon, lat, …FIELDS[set]] as GeoJSON point feature */
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
  return out;
}


/** appends lines to a file with backpressure */
function lineWriter(path) {
  const ws = createWriteStream(path);
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
      await once(ws, 'finish');
    },
  };
}

async function extract(region, outDir, url) {
  const dir = join(outDir, 'src', region);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = url ?? `https://download.geofabrik.de/${REGIONS[region]}-latest.osm.pbf`;
  const filter = `n/man_made=surveillance n/highway=speed_camera n/surveillance:type=ALPR n/webcam n/contact:webcam n/generator:source=wind n/man_made=${RESOURCE_MAN_MADE.join(',')} n/industrial=${RESOURCE_INDUSTRIAL.join(',')} n/landuse=quarry r/type=enforcement`;
  const input = /^https?:/.test(src) ? `curl -sSfL -A "Orbis-data/1.0 (+https://github.com/malte9799/orbis)" "${src}"` : `cat "${src}"`;
  const proc = spawn('bash', ['-c', `set -o pipefail; ${input} | osmium tags-filter -R --input-format=pbf --output-format=opl --overwrite -o - - ${filter}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`${region}: streaming ${src}`);
  const t0 = Date.now();
  const out = Object.fromEntries(SETS.filter((s) => s !== 'blitzer').map((s) => [s, lineWriter(join(dir, `${s}.geojsonl`))]));
  const counts = Object.fromEntries(SETS.map((s) => [s, 0]));
  /** speed cameras by node id; enforcement relations (they come after all nodes) refine their kind */
  const speed = new Map();
  for await (const line of createInterface({ input: proc.stdout })) {
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
  console.log(`${region}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} (${Math.round((Date.now() - t0) / 1000)} s)`);
  return counts;
}

/** which regions to refresh: `all`, the given one, or the stalest one that is due */
export function planRegions(infos, arg, now = Date.now()) {
  if (arg === 'all') return Object.keys(REGIONS);
  if (arg) {
    if (!REGIONS[arg]) throw new Error(`unknown region ${arg}`);
    return [arg];
  }
  const age = (r) => (infos[r]?.format === FORMAT ? now - infos[r].at : Infinity);
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
    const files = used.map((r) => join(srcDir, r, `${set}.geojsonl`)).filter((f) => existsSync(f) && statSync(f).size > 0);
    const target = join(distDir, `${set}.pmtiles`);
    if (!files.length) {
      console.log(`${set}: no data – skipped`);
      continue;
    }
    // -r1: no thinning by rate; -b 0: no buffer (points would be duplicated into the neighbour tiles); --drop-densest-as-needed only where a tile gets too big (dense low zooms), -M/-O keep z14 complete
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
      await run('tippecanoe', ['-o', target, '-l', set, '-Z', String(MIN_ZOOM), '-z', String(MAX_ZOOM), '--drop-densest-as-needed', '-M', '1000000', '-O', '250000', ...common, ...files]);
    }
    meta.sets[set] = { ...meta.sets[set], bytes: statSync(target).size, features: used.reduce((a, r) => a + (meta.regions[r]?.counts?.[set] ?? 0), 0) };
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
    const counts = await extract(region, outDir, flag === '--url' ? url : undefined);
    if (!url && counts.cctv < 50) throw new Error(`${region}: only ${counts.cctv} cameras – keeping previous data`);
    writeFileSync(join(outDir, 'src', region, 'info.json'), JSON.stringify({ at: Date.now(), counts, format: FORMAT }));
  } else if (cmd === 'build') {
    const [srcDir, distDir] = args;
    if (!srcDir || !distDir) throw new Error('usage: osm-tiles build <srcDir> <distDir>');
    await build(srcDir, distDir);
  } else {
    throw new Error('usage: osm-tiles plan <dir> [region|all] | extract <outDir> <region> | build <srcDir> <distDir>');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
