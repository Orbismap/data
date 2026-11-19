// OpenStreetMap data of Orbis as PMTiles: one file per theme for the whole world in the bucket orbis-osm
// (<theme>-<date>.pmtiles, named in meta.json). The themes are the registry in collectors/osm-themes.mjs (filter, fields, zoom,
// geometry): cctv, blitzer, alpr, webcam, wind, resource (points, zoom 0-14), trees (single trees + the line layer `tree_lines`)
// and roofs (buildings with roof tags as polygons), the last two z15 only.
//
// The build reads the PLANET (planet-latest.osm.pbf, ~90 GB, from a mirror) once per job; the themes are sparse, so what is kept is small:
//   build [--groups points,trees] [--out dir] [--pbf file] [--part file] [--date YYYY-MM-DD]
//                                          downloads the planet (mirrors in order, first that works; or takes --pbf), writes the intermediates
//                                          (GeoJSON lines per source of the groups) to <out>/src/, deletes the planet after its last pass,
//                                          builds the world PMTiles of the groups with tippecanoe into <out>/dist/ (+ heat/cctv.json), and
//                                          writes <part> (JSON: file names, sizes, feature counts) for `publish`
//   publish <partsDir> <distDir> [--prev meta.json] [--delete-list f] [--manifest manifest.json] [--date YYYY-MM-DD]
//                                          joins the part files of all jobs to <distDir>/meta.json (+ LICENSE.txt); the superseded versions
//                                          go into meta.retired and, once the CDN cache time has passed (24 h), into the delete list;
//                                          --manifest: the bucket's manifest.json is updated in place (new files in, deleted ones out)
// Groups (GROUPS in the registry) are the units of work of the two jobs: `points` + `trees` read nodes (one streamed pass) and ways (second
// pass), `roofs` reads ways and relations (osmium needs the file on disk for that, two passes). Data © OpenStreetMap contributors (ODbL).

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { RULES } from './manifest.mjs';
import { THEMES, FILES, GROUPS, sourcesOf, lineFeature, treeLineRecord, parseNode, parseWay, parseEnforcement, metres, simplify, treeRecord, record, speedRecord, alprRecord, webcamRecord, windRecord, resourceRecord, LINE_FIELDS, LINE_TOLERANCE, ROOF_KEEP, ROOF_TAGS, roofFeature } from './osm-themes.mjs';

export { THEMES, FILES, GROUPS, sourcesOf, lineFeature, treeLineRecord, parseNode, parseWay, parseEnforcement, metres, simplify, treeRecord, record, speedRecord, alprRecord, webcamRecord, windRecord, resourceRecord, LINE_FIELDS, LINE_TOLERANCE, ROOF_KEEP, ROOF_TAGS, roofFeature };

/** the planet from these mirrors, in this order (measured 2026-11: gwdg ~145 MB/s, planet.openstreetmap.org ~45, fau ~27, bbbike ~10) */
export const PLANET_MIRRORS = [
  'https://ftp5.gwdg.de/pub/misc/openstreetmap/planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
  'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
  'https://ftp.fau.de/osm-planet/pbf/planet-latest.osm.pbf',
];
/** CDN cache time of the bucket files (Cache-Control max-age=86400): a replaced version stays this long */
export const CDN_TTL_MS = 24 * 3600e3;
const CELL = 100; // heatmap cells per degree (0.01° ≈ 1 km)
/** version of meta.json and the file layout the app reads */
export const FORMAT = 9;
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** the point data sets the client reads (= world files with points) */
export const SETS = FILES.filter((f) => sourcesOf(f).some((s) => s.geometry === 'point'));
/** zoom range [min, max] of the sets that differ from 0-14 (trees: z15 only, the map overzooms it; z16 would store every tree twice) */
export const SET_ZOOM = Object.fromEntries(FILES.map((f) => [f, sourcesOf(f)[0].zoom]).filter(([, z]) => z[0] !== 0 || z[1] !== 14));
/** record fields after [lon, lat] per source (= property names of the GeoJSON features) */
export const FIELDS = Object.fromEntries(Object.entries(THEMES).filter(([, s]) => s.fields).map(([id, s]) => [id, s.fields]));
/** second layer of trees.pmtiles: tree rows and hedges as lines; its intermediate is <region>/tree_lines.geojsonl */
export const LINES = { set: 'trees', layer: 'tree_lines', file: 'tree_lines.geojsonl' };

/**
 * Sets the viewer draws from zoom 0 (cameras): below LOW_ZOOM_END their tiles carry a second, attribute-free layer
 * `<set>_lo` instead of the full records. Every point stays visible: points that fall into the same cell of a
 * LOW_GRID × LOW_GRID grid per tile (≈ half a screen pixel at 512 px tiles) are drawn on top of each other anyway, so
 * one stands for them. The full layer `<set>` starts at LOW_ZOOM_END (the viewer reads `<set>_lo` below it).
 */
export const LOW_SETS = FILES.filter((f) => sourcesOf(f).some((s) => s.low));
export const LOW_ZOOM_END = 6; // first zoom of the full layer; the `_lo` layer covers 0 .. LOW_ZOOM_END - 1
export const LOW_GRID = 1024;

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

/** appends lines to a file with backpressure */
function lineWriter(path) {
  const file = createWriteStream(path);
  let buf = [];
  let size = 0;
  const flush = async () => {
    if (!buf.length) return;
    const chunk = buf.join('');
    buf = [];
    size = 0;
    if (!file.write(chunk)) await once(file, 'drain');
  };
  return {
    async write(line) {
      buf.push(line, '\n');
      size += line.length;
      if (size > 1 << 20) await flush();
    },
    async close() {
      await flush();
      file.end();
      await once(file, 'finish');
    },
  };
}

/** User-Agent with a contact (the mirrors ask for one) */
const USER_AGENT = `Orbis-data/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY ?? 'Orbismap/data'})`;
/** shell command that writes the .osm.pbf of `src` (a local file) to stdout */
const pbfInput = (src) => `cat "${src}"`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** seconds from a Retry-After value (seconds or an HTTP date), else null */
export function retryAfterSeconds(v, now = Date.now()) {
  if (v == null || v === '') return null;
  if (/^\d+$/.test(String(v).trim())) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - now) / 1000));
}

/** pause before retry number `attempt` (1, 2, …): the server's Retry-After if it gave one, else 30 s doubling up to 10 min, plus up to 25 % jitter */
export function backoffMs(attempt, retryAfter = null) {
  const base = retryAfter != null ? retryAfter * 1000 : Math.min(600_000, 30_000 * 2 ** (attempt - 1));
  return Math.round(base * (1 + Math.random() * 0.25));
}


/** no TCP connection to a mirror from this runner (curl exit 6/7): the next mirror is tried */
export class MirrorUnreachable extends Error {
  constructor(url, attempts) {
    super(`mirror-unreachable: no connection to ${url} (${attempts} attempts)`);
    this.name = 'MirrorUnreachable';
  }
}
/** curl exit codes for "no connection": 6 (cannot resolve host), 7 (cannot connect) */
const NO_CONNECTION = [6, 7];


/**
 * Downloads `url` to `file`, one request at a time, resuming a partial file (-C -). On a failure (429/503/5xx, connect error, stall) it waits
 * (Retry-After if the server sent one, else growing pauses) and continues, up to `attempts` times. A refusal that is no overload (404 …) fails at once.
 * No connection at all (no HTTP answer, curl exit 6/7) will not get better on this runner (an address that is blocked stays blocked): after
 * `connectAttempts` tries with short pauses it throws MirrorUnreachable.
 */
export async function download(url, file, attempts = 8, { connectAttempts = 3, connectPauseMs = [5000, 30_000] } = {}) {
  const hdr = `${file}.headers`;
  let noConnection = 0;
  for (let i = 1; ; i++) {
    let failed = false;
    let exitCode = 0;
    try {
      await sh(`curl -sSL --fail --connect-timeout 30 --speed-limit 200000 --speed-time 180 -A "${USER_AGENT}" -C - -D "${hdr}" -o "${file}" "${url}"`);
    } catch (e) {
      failed = true; // connect error, stall, HTTP error (--fail): the headers tell which
      exitCode = e.exitCode ?? 0;
    }
    const code = Number((existsSync(hdr) ? [...readFileSync(hdr, 'utf8').matchAll(/^HTTP\/\S+ (\d+)/gm)].pop()?.[1] : null) ?? 0);
    if (code === 416 || (!failed && (code === 0 || (code >= 200 && code < 300)))) {
      rmSync(hdr, { force: true }); // 416: the file was complete already
      return;
    }
    if (failed && code === 0 && NO_CONNECTION.includes(exitCode)) {
      rmSync(hdr, { force: true });
      if (++noConnection >= connectAttempts) throw new MirrorUnreachable(url, noConnection);
      const ms = connectPauseMs[noConnection - 1] ?? connectPauseMs.at(-1) ?? 0;
      console.error(`download ${url}: no connection (curl ${exitCode}, ${noConnection}/${connectAttempts}) – retrying in ${Math.round(ms / 1000)} s`);
      await sleep(ms);
      continue;
    }
    const retryAfter = existsSync(hdr) ? retryAfterSeconds(readFileSync(hdr, 'utf8').match(/^retry-after:\s*(.+?)\s*$/im)?.[1]) : null;
    rmSync(hdr, { force: true });
    if ((code >= 400 && code < 500 && code !== 429 && code !== 408) || i >= attempts) throw new Error(`download of ${url} failed (HTTP ${code || '-'}, ${i}/${attempts})`);
    const ms = backoffMs(i, retryAfter);
    console.error(`download ${url}: HTTP ${code || '-'} (attempt ${i}/${attempts}) – retrying in ${Math.round(ms / 1000)} s${retryAfter != null ? ' (Retry-After)' : ''}`);
    await sleep(ms);
  }
}

/** runs a shell pipeline, resolves when it exits 0 */
function sh(cmd) {
  return new Promise((res, rej) => {
    const p = spawn('bash', ['-c', `set -o pipefail; ${cmd}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(Object.assign(new Error(`pipeline failed (exit ${c}): ${cmd.slice(0, 120)}`), { exitCode: c }))));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited with ${c}`))));
  });
}

const stamp = () => new Date().toISOString().slice(11, 19);
/** free disk space of the working directory, for the log */
const freeSpace = () => {
  try {
    const s = statfsSync('.');
    return `${Math.round((s.bavail * s.bsize) / 1e9)} GB free`;
  } catch {
    return '';
  }
};
/** runs `fn` and logs its start, end (duration, free disk) and, for long silent steps (osmium prints nothing), a line every `heartbeatMs` */
export async function timed(label, fn, heartbeatMs = 300_000) {
  const t0 = Date.now();
  console.log(`[${stamp()}] ${label} ...`);
  const beat = setInterval(() => console.log(`[${stamp()}] ${label}: still running (${Math.round((Date.now() - t0) / 60000)} min, ${freeSpace()})`), heartbeatMs);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    console.log(`[${stamp()}] ${label}: done in ${Math.round((Date.now() - t0) / 1000)} s (${freeSpace()})`);
  }
}

/**
 * Downloads the planet from the first mirror that works (`urls` in order). A partial file of a failed mirror is removed: another mirror may
 * serve another planet version, so resuming across mirrors would corrupt the file. Returns the URL used.
 */
export async function downloadFirst(urls, file, dl = (u, f) => download(u, f, 4)) {
  let last;
  for (const url of urls) {
    try {
      await dl(url, file);
      return url;
    } catch (e) {
      last = e;
      console.error(`mirror ${url} failed: ${e.message}`);
      rmSync(file, { force: true });
    }
  }
  throw last ?? new Error('no mirror given');
}

/** the `-x print_record_separator=false` GeoJSON lines of an osmium export, parsed */
async function* geojsonLines(file) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line) yield JSON.parse(line);
}


/**
 * Lines (the sources with geometry 'line', e.g. tree rows and hedges) as <dir>/<id>.geojsonl. Input: `waysFile`, the OPL lines of the
 * ways from the first pass (tags + node refs). Second pass over the extract: only the nodes those ways use (`osmium getid`, ids from
 * the ways), then osmium merges nodes + ways in a temp dir and exports them as linestrings (closed ways stay lines).
 * Returns the number of lines written.
 */
async function extractLines(dir, pbf, waysFile, id, source) {
  const tmp = join(dir, `lines-tmp-${id}`);
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
  const out = lineWriter(join(dir, `${id}.geojsonl`));
  let n = 0;
  if (ways) {
    const nodes = join(tmp, 'nodes.osm.pbf'), waysPbf = join(tmp, 'ways.osm.pbf'), merged = join(tmp, 'merged.osm.pbf'), located = join(tmp, 'lines.geojsonseq');
    // pass 2 over the extract: only the used nodes (getid without -r reads the stream once; ids in a bitmap)
    await sh(`${pbfInput(pbf)} | osmium getid --overwrite -F pbf -f pbf -o "${nodes}" -i "${idsFile}" -`);
    await sh(`osmium cat --overwrite --input-format=opl -f pbf -o "${waysPbf}" "${waysFile}" && osmium merge --overwrite -o "${merged}" "${nodes}" "${waysPbf}"`);
    rmSync(nodes, { force: true });
    rmSync(waysPbf, { force: true });
    await sh(`osmium export --overwrite -i sparse_file_array,"${join(tmp, 'locations.idx')}" --geometry-types=linestring -f geojsonseq -x print_record_separator=false -o "${located}" "${merged}"`);
    rmSync(merged, { force: true });
    for await (const f of geojsonLines(located)) {
      if (f.geometry?.type !== 'LineString') continue;
      const rec = source.lineRecord(f.properties ?? {}, f.geometry.coordinates);
      if (!rec) continue;
      await out.write(JSON.stringify(source.lineFeature(rec)));
      n++;
    }
  }
  await out.close();
  rmSync(tmp, { recursive: true, force: true });
  return n;
}


/**
 * Polygons (buildings with a roof tag …) as <dir>/<id>.geojsonl: osmium tags-filter keeps the objects with the source's tags (first
 * `filter`, OR) that also have one of `require` (second filter, AND) plus what they refer to; osmium export assembles the areas
 * (closed ways and multipolygon relations). Offline per file, one pass each. Returns the number of features written.
 */
async function extractPolygons(dir, pbf, id, source) {
  const tmp = join(dir, `polygons-tmp-${id}`);
  mkdirSync(tmp, { recursive: true });
  const [s1, s2, raw] = ['s1.osm.pbf', 's2.osm.pbf', 'areas.geojsonseq'].map((f) => join(tmp, f));
  await sh(`osmium tags-filter --overwrite -o "${s1}" "${pbf}" ${source.filter.join(' ')}`);
  await sh(`osmium tags-filter --overwrite -o "${s2}" "${s1}" ${source.require.join(' ')}`);
  rmSync(s1, { force: true });
  await sh(`osmium export --overwrite -i sparse_file_array,"${join(tmp, 'locations.idx')}" --geometry-types=polygon -f geojsonseq -x print_record_separator=false -o "${raw}" "${s2}"`);
  rmSync(s2, { force: true });
  const out = lineWriter(join(dir, `${id}.geojsonl`));
  let n = 0;
  for await (const f of geojsonLines(raw)) {
    const feat = source.polygonFeature(f);
    if (!feat) continue;
    await out.write(JSON.stringify(feat));
    n++;
  }
  await out.close();
  rmSync(tmp, { recursive: true, force: true });
  return n;
}


const entries = (geometry, groups) => Object.entries(THEMES).filter(([, s]) => s.geometry === geometry && groups.includes(s.group));

/** writes the intermediates (GeoJSON lines per source) of the given groups to <outDir>/src/; `consume`: delete the planet after the last pass */

async function extract(pbf, outDir, { groups, consume = false }) {
  const key = 'osm';
  const dir = join(outDir, 'src');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const points = entries('point', groups), lines = entries('line', groups), polygons = entries('polygon', groups);
  const counts = Object.fromEntries(Object.keys(THEMES).map((id) => [id, 0]));
  const pass1 = async () => {
  // pass 1: nodes (points) and ways (their lines are built in pass 2), one streamed osmium run for all sources
  const filter = [...new Set([...points, ...lines].flatMap(([, s]) => s.filter))].join(' ');
  const proc = spawn('bash', ['-c', `set -o pipefail; osmium tags-filter -R --input-format=pbf --output-format=opl --overwrite -o - "${pbf}" ${filter}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`${key}: filtering ${pbf}`);
  // listen before reading: a small extract can exit before the stream is drained, and a 'close' that was missed never resolves (Node then ends silently with exit 0)
  const closed = new Promise((res) => proc.on('close', res));
  const out = Object.fromEntries(points.filter(([, s]) => !s.refine).map(([id]) => [id, lineWriter(join(dir, `${id}.geojsonl`))]));
  const ways = Object.fromEntries(lines.map(([id]) => [id, createWriteStream(join(dir, `ways-${id}.opl`))]));
  /** records of sources that are refined later (speed cameras by node id; enforcement relations come after all nodes) */
  const deferred = Object.fromEntries(points.filter(([, s]) => s.refine).map(([id]) => [id, new Map()]));
  for await (const line of createInterface({ input: proc.stdout })) {
    const c = line.charCodeAt(0);
    if (c === 119 /* w */) {
      const w = parseWay(line);
      for (const [id, s] of lines) if (w && s.match(w.tags)) if (!ways[id].write(`${line}\n`)) await once(ways[id], 'drain');
      continue;
    }
    if (c === 114 /* r */) {
      const rel = parseEnforcement(line);
      if (rel) for (const [id, s] of points) if (s.refine) s.refine(rel, deferred[id]);
      continue;
    }
    const node = parseNode(line);
    if (!node) continue;
    for (const [id, s] of points) {
      if (!s.match(node.tags)) continue;
      const rec = s.record(node);
      if (s.refine) deferred[id].set(node.id, rec);
      else {
        await out[id].write(JSON.stringify(toFeature(id, rec)));
        if (++counts[id] % 5_000_000 === 0) console.log(`${key}: ${counts[id]} ${id} so far (${Math.round((Date.now() - t0) / 1000)} s)`);
      }
    }
  }
  const code = await closed;
  if (code !== 0) throw new Error(`${key}: download/filter failed (exit ${code})`);
  for (const [id, m] of Object.entries(deferred)) {
    const w = lineWriter(join(dir, `${id}.geojsonl`));
    for (const rec of m.values()) await w.write(JSON.stringify(toFeature(id, rec)));
    await w.close();
    counts[id] = m.size;
  }
  for (const w of Object.values(out)) await w.close();
  for (const w of Object.values(ways)) {
    w.end();
    await once(w, 'finish');
  }
  };
  if (points.length || lines.length) await timed('pass 1: nodes and ways of the themes (stream through the filter)', pass1);
  for (const [id, s] of lines) {
    counts[id] = await timed(`lines ${id}: second pass over the planet`, () => extractLines(dir, pbf, join(dir, `ways-${id}.opl`), id, s));
    rmSync(join(dir, `ways-${id}.opl`), { force: true });
  }
  for (const [id, s] of polygons) counts[id] = await timed(`polygons ${id}: filter and export`, () => extractPolygons(dir, pbf, id, s));
  if (consume) rmSync(pbf, { force: true }); // the last pass over the planet is done: the disk is needed for the rest
  console.log(`${key}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} (${Math.round((Date.now() - t0) / 1000)} s)`);
  return counts;
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

/** streams point intermediates into heatmap cells [lon, lat, count] */
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

const nonEmpty = (f) => existsSync(f) && statSync(f).size > 0;

/** the group of a world file (all its sources share one) */
const groupOf = (file) => sourcesOf(file)[0].group;

/**
 * World PMTiles of the groups from the intermediates in `srcDir`: <outDir>/<file>-<date>.pmtiles per file (+ heat/cctv.json). Returns the
 * part of meta.json these files make: { files, sets, heatCells }.
 */
async function buildWorld(srcDir, outDir, groups, counts, date) {
  mkdirSync(join(outDir, 'heat'), { recursive: true });
  const common = ['--force', '--read-parallel', '-q', '-A', ATTRIBUTION];
  const part = { files: {}, sets: {} };
  for (const file of FILES.filter((f) => groups.includes(groupOf(f)))) {
    const sources = sourcesOf(file);
    const inputs = sources.map((s) => ({ ...s, path: join(srcDir, `${s.id}.geojsonl`) })).filter((s) => nonEmpty(s.path));
    if (!inputs.length) {
      console.log(`${file}: no data - skipped`);
      continue;
    }
    const name = `${file}-${date}.pmtiles`;
    const target = join(outDir, name);
    const [zMin, zMax] = sources[0].zoom;
    const label = ['-n', file, '-N', `OpenStreetMap ${file}`];
    await timed(`tippecanoe ${file}`, async () => {
      if (sources[0].low) {
        // Camera sets: z0..LOW_ZOOM_END-1 only one bare point per grid cell (layer <set>_lo, lowZoomPoints), nothing dropped;
        // from LOW_ZOOM_END the full records (layer <set>); tile-join puts both zoom ranges into one file
        const lo = join(srcDir, `${file}-lo`), hi = join(srcDir, `${file}-hi`);
        await lowZoomPoints(inputs.map((s) => s.path), file, `${lo}.geojsonl`);
        await run('tippecanoe', ['-o', `${lo}.pmtiles`, '-l', `${file}_lo`, '-Z', '0', '-z', String(LOW_ZOOM_END - 1), '--no-feature-limit', '--no-tile-size-limit', '-r1', '-b', '0', ...label, ...common, `${lo}.geojsonl`]);
        await run('tippecanoe', ['-o', `${hi}.pmtiles`, '-l', file, '-Z', String(LOW_ZOOM_END), '-z', String(zMax), ...sources[0].tippecanoe, ...label, ...common, ...inputs.map((s) => s.path)]);
        await run('tile-join', ['-o', target, '--force', '-pk', '-q', ...label, '-A', ATTRIBUTION, `${lo}.pmtiles`, `${hi}.pmtiles`]);
        for (const f of [`${lo}.geojsonl`, `${lo}.pmtiles`, `${hi}.pmtiles`]) rmSync(f, { force: true });
      } else {
        // one file, one layer per source (-L name:file), all at the zoom of the file
        await run('tippecanoe', ['-o', target, '-Z', String(zMin), '-z', String(zMax), ...sources[0].tippecanoe, ...label, ...common, ...inputs.flatMap((s) => ['-L', `${s.layer}:${s.path}`])]);
      }
    });
    const features = counts[sources[0].id] ?? 0;
    part.files[file] = name;
    part.sets[file] = { bytes: statSync(target).size, features, ...(sources.length > 1 ? { layers: Object.fromEntries(sources.map((s) => [s.layer, counts[s.id] ?? 0])) } : {}) };
    console.log(`${file}: ${part.sets[file].bytes} bytes, ${features} features`);
  }
  for (const [id, s] of Object.entries(THEMES)) {
    if (!s.heat || !groups.includes(s.group) || !nonEmpty(join(srcDir, `${id}.geojsonl`))) continue;
    const cells = await timed(`heat cells ${id}`, () => heatCells([join(srcDir, `${id}.geojsonl`)]));
    writeFileSync(join(outDir, 'heat', `${id}.json`), JSON.stringify(cells));
    part.heatCells = { ...part.heatCells, [id]: cells.length };
    part.extra = { ...part.extra, [`heat/${id}.json`]: statSync(join(outDir, 'heat', `${id}.json`)).size };
  }
  return part;
}

/**
 * Which versions of the files are superseded and which may be deleted now. `prev` = the meta.json that is live (null: none),
 * `files` = { file: name } of the new build. A replaced version stays until the CDN cache time has passed; a bucket that still has the
 * unversioned names (meta without `files`) counts as replaced as of now.
 */
export function retireVersions(prev, files, now = Date.now(), ttl = CDN_TTL_MS) {
  const current = new Set(Object.values(files));
  const replaced = prev ? (prev.files ? Object.values(prev.files) : Object.keys(prev.sets ?? {}).map((s) => `${s}.pmtiles`)) : [];
  const retired = new Map();
  for (const r of prev?.retired ?? []) if (!current.has(r.file)) retired.set(r.file, r.at);
  for (const f of replaced) if (!current.has(f) && !retired.has(f)) retired.set(f, now);
  const all = [...retired].map(([file, at]) => ({ file, at }));
  return { retired: all.filter((r) => now - r.at < ttl), deletable: all.filter((r) => now - r.at >= ttl).map((r) => r.file) };
}

/** joins the part files of the jobs to meta.json (+ LICENSE.txt); the superseded versions go into meta.retired / the delete list */
export function publish(partsDir, distDir, { prev, deleteList, manifest: manifestPath, date = new Date().toISOString().slice(0, 10), now = Date.now() } = {}) {
  const parts = readdirSync(partsDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(partsDir, f)));
  if (!parts.length) throw new Error(`no part files in ${partsDir}`);
  const built = new Set(parts.flatMap((p) => p.groups ?? []));
  const absent = Object.keys(GROUPS).filter((g) => !built.has(g));
  if (absent.length) throw new Error(`no part for the groups ${absent.join(', ')}: publishing would drop their files from meta.json`);
  const files = {}, sets = {};
  let heatCells = 0;
  for (const p of parts) {
    Object.assign(files, p.files);
    Object.assign(sets, p.sets);
    heatCells += Object.values(p.heatCells ?? {}).reduce((a, b) => a + b, 0);
  }
  const dataAt = parts.map((p) => p.dataAt ?? now);
  const meta = { format: FORMAT, at: now, version: date, files, sets, regions: 1, oldest: Math.min(...dataAt), newest: Math.max(...dataAt), heatCells };
  const prevMeta = prev && existsSync(prev) ? readJson(prev) : null;
  const { retired, deletable } = retireVersions(prevMeta, files, now);
  meta.retired = retired;
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'meta.json'), JSON.stringify(meta));
  if (deleteList) writeFileSync(deleteList, deletable.join('\n') + (deletable.length ? '\n' : ''));
  writeFileSync(join(distDir, 'LICENSE.txt'), 'Data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/\nhttps://www.openstreetmap.org/copyright\nDerived from the OpenStreetMap planet file (https://planet.openstreetmap.org).\n');
  if (manifestPath) {
    // manifest.json of the bucket: entries of the new files (the build jobs upload without touching it: two jobs would overwrite each other), without the deleted ones
    const m = existsSync(manifestPath) ? readJson(manifestPath) : {};
    const add = (key, bytes) => {
      const [, source = '', license = ''] = RULES.find(([re]) => re.test(key)) ?? [];
      m[key] = { updated: new Date(now).toISOString(), bytes, source, license };
    };
    for (const [f, name] of Object.entries(files)) add(name, sets[f].bytes);
    for (const p of parts) for (const [key, bytes] of Object.entries(p.extra ?? {})) add(key, bytes);
    add('meta.json', statSync(join(distDir, 'meta.json')).size);
    add('LICENSE.txt', statSync(join(distDir, 'LICENSE.txt')).size);
    for (const f of deletable) delete m[f];
    writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)))));
  }
  console.log(`meta.json: ${Object.keys(files).length} files, ${heatCells} heat cells; superseded: ${retired.length}, to delete now: ${deletable.length}`);
  return meta;
}

/** `--name value` pairs after the positional arguments */
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

/** time stamp of the planet's data (osmosis_replication_timestamp of the header) in ms, else now */
function dataTimestamp(pbf) {
  try {
    const t = Date.parse(execFileSync('osmium', ['fileinfo', '-g', 'header.option.osmosis_replication_timestamp', pbf], { encoding: 'utf8' }).trim());
    return Number.isNaN(t) ? Date.now() : t;
  } catch {
    return Date.now();
  }
}

async function build(opt) {
  const groups = (opt.groups ?? Object.keys(GROUPS).join(',')).split(',');
  for (const g of groups) if (!GROUPS[g]) throw new Error(`unknown group ${g} (${Object.keys(GROUPS).join(', ')})`);
  const out = opt.out ?? 'work';
  const date = opt.date ?? new Date().toISOString().slice(0, 10);
  mkdirSync(out, { recursive: true });
  let pbf = opt.pbf, consume = false;
  if (!pbf) {
    pbf = join(out, 'planet.osm.pbf');
    consume = true;
    const urls = process.env.PLANET_URL ? [process.env.PLANET_URL, ...PLANET_MIRRORS] : PLANET_MIRRORS;
    const used = await timed('download of the planet', () => downloadFirst(urls, pbf));
    console.log(`planet from ${used}: ${(statSync(pbf).size / 1e9).toFixed(1)} GB`);
  }
  const dataAt = dataTimestamp(pbf);
  console.log(`planet data of ${new Date(dataAt).toISOString()}`);
  const counts = await extract(pbf, out, { groups, consume });
  const part = await buildWorld(join(out, 'src'), join(out, 'dist'), groups, counts, date);
  writeFileSync(opt.part ?? join(out, 'part.json'), JSON.stringify({ ...part, groups, dataAt, counts }));
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = pos;
  if (cmd === 'build') {
    await build(opt);
  } else if (cmd === 'publish') {
    const [partsDir, distDir] = args;
    if (!partsDir || !distDir) throw new Error('usage: osm-tiles publish <partsDir> <distDir> [--prev meta.json] [--delete-list f] [--manifest manifest.json] [--date YYYY-MM-DD]');
    publish(partsDir, distDir, { prev: opt.prev, deleteList: opt['delete-list'], manifest: opt.manifest, date: opt.date });
  } else {
    throw new Error('usage: osm-tiles build [--groups points,trees] [--out dir] [--pbf file] [--part file] [--date d] | publish <partsDir> <distDir> [--prev meta.json] [--delete-list f]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // a promise that never settles ends Node silently with exit 0: that must not count as success
  let finished = false;
  process.on('exit', (c) => {
    if (!finished && c === 0) {
      console.error('osm-tiles: stopped before it finished (a promise never settled)');
      process.exitCode = 1;
    }
  });
  main().then(
    () => { finished = true; },
    (e) => {
      finished = true;
      console.error(e.message);
      process.exit(1);
    },
  );
}
