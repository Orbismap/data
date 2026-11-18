// OpenStreetMap data of Orbis as PMTiles: one file per theme for the whole world in the bucket orbis-osm
// (<theme>-<date>.pmtiles, named in meta.json). The themes are the registry in collectors/osm-themes.mjs (filter, fields, zoom,
// geometry): cctv, blitzer, alpr, webcam, wind, resource (points, zoom 0-14), trees (single trees + the line layer `tree_lines`)
// and roofs (buildings with roof tags as polygons), the last two z15 only.
//
// The build is split by region (the leaves of the Geofabrik index, see osm-regions.mjs), the delivery is not:
//   plan <index.json> <assets.json> [region|all]       prints the JSON list of region keys to refresh: the oldest ones older than
//                                                      MAX_AGE_DAYS (a 30th of all regions per run = rolling); `assets.json` is
//                                                      `gh release view osm-src-points --json assets` (the upload time of a region's
//                                                      state asset says how old it is)
//   extract <outDir> <region> [--index f] [--url pbf] [--own-bbox w,s,e,n]
//                                                      downloads the region's extract and writes the intermediates (GeoJSON lines,
//                                                      one per source of the registry) to <outDir>/src/<region>/ + info.json. Only
//                                                      features the region OWNS are kept (osm-regions.mjs), so overlapping
//                                                      extracts do not produce duplicates
//   regional <outDir> <region>                         tippecanoe: one regional PMTiles per file in <outDir>/regional/<region>/, and
//                                                      the assets for the GitHub releases osm-src-<group> in <outDir>/upload/
//   merge <assetsDir> <distDir> [--prev meta.json] [--delete-list f] [--date YYYY-MM-DD]
//                                                      unpacks the regional assets of ALL regions and joins them per file with
//                                                      tile-join: <distDir>/<file>-<date>.pmtiles, heat/cctv.json, meta.json,
//                                                      LICENSE.txt; the superseded versions go into meta.retired and, once the CDN
//                                                      cache time has passed (24 h), into the delete list
//   local <workDir> <key=pbf[@w,s,e,n]>...             all of the above for local extracts (test; the box = the region's ownership)
// Data © OpenStreetMap contributors (ODbL), extracts by Geofabrik.

import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { THEMES, FILES, GROUPS, sourcesOf, lineFeature, treeLineRecord, parseNode, parseWay, parseEnforcement, metres, simplify, treeRecord, record, speedRecord, alprRecord, webcamRecord, windRecord, resourceRecord, LINE_FIELDS, LINE_TOLERANCE, ROOF_KEEP, ROOF_TAGS, roofFeature } from './osm-themes.mjs';
import { boxOwner, leafRegions, makeOwner, regionKey, findRegion, AGGREGATES } from './osm-regions.mjs';

export { THEMES, FILES, GROUPS, sourcesOf, lineFeature, treeLineRecord, parseNode, parseWay, parseEnforcement, metres, simplify, treeRecord, record, speedRecord, alprRecord, webcamRecord, windRecord, resourceRecord, LINE_FIELDS, LINE_TOLERANCE, ROOF_KEEP, ROOF_TAGS, roofFeature, leafRegions, regionKey, AGGREGATES, makeOwner };

const MAX_AGE_DAYS = 30;
/** a GitHub matrix has at most 256 jobs */
const MAX_JOBS = 250;
/** CDN cache time of the bucket files (Cache-Control max-age=86400): a replaced version stays this long */
export const CDN_TTL_MS = 24 * 3600e3;
const CELL = 100; // heatmap cells per degree (0.01° ≈ 1 km)
/** bump when the layout of the regional pieces or the fields change: older pieces count as stale and are rebuilt */
export const FORMAT = 8;
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

const UA = '-A "Orbis-data/1.0 (+https://github.com/malte9799/orbis)"';
/** shell command that writes the .osm.pbf of `src` (URL or local file) to stdout */
const pbfInput = (src) => (/^https?:/.test(src) ? `curl -sSfL --connect-timeout 30 --speed-limit 200000 --speed-time 180 ${UA} "${src}"` : `cat "${src}"`);

/** runs a shell pipeline, resolves when it exits 0 */
function sh(cmd) {
  return new Promise((res, rej) => {
    const p = spawn('bash', ['-c', `set -o pipefail; ${cmd}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`pipeline failed (exit ${c}): ${cmd.slice(0, 120)}`))));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited with ${c}`))));
  });
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
async function extractLines(dir, pbf, waysFile, id, source, owner) {
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
      if (!owner(rec[0][0][0], rec[0][0][1])) continue;
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
async function extractPolygons(dir, pbf, id, source, owner) {
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
    const [x, y] = feat.geometry.coordinates[0][0][0]; // ownership: the first vertex
    if (!owner(x, y)) continue;
    await out.write(JSON.stringify(feat));
    n++;
  }
  await out.close();
  rmSync(tmp, { recursive: true, force: true });
  return n;
}

const entries = (geometry) => Object.entries(THEMES).filter(([, s]) => s.geometry === geometry);

/** downloads the extract (or takes the local file) and writes the intermediates of all sources of the registry */
async function extract(key, outDir, { url, owner }) {
  const dir = join(outDir, 'src', key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let pbf = url;
  if (/^https?:/.test(url)) {
    pbf = join(dir, 'region.osm.pbf');
    console.log(`${key}: downloading ${url}`);
    await sh(`${pbfInput(url)} > "${pbf}"`);
  }
  const t0 = Date.now();
  const points = entries('point'), lines = entries('line'), polygons = entries('polygon');
  const counts = Object.fromEntries(Object.keys(THEMES).map((id) => [id, 0]));
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
    if (!node || !owner(node.x, node.y)) continue;
    for (const [id, s] of points) {
      if (!s.match(node.tags)) continue;
      const rec = s.record(node);
      if (s.refine) deferred[id].set(node.id, rec);
      else {
        await out[id].write(JSON.stringify(toFeature(id, rec)));
        if (++counts[id] % 100000 === 0) console.log(`${key}: ${counts[id]} ${id} so far (${Math.round((Date.now() - t0) / 1000)} s)`);
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
  for (const [id, s] of lines) {
    counts[id] = await extractLines(dir, pbf, join(dir, `ways-${id}.opl`), id, s, owner);
    rmSync(join(dir, `ways-${id}.opl`), { force: true });
  }
  for (const [id, s] of polygons) counts[id] = await extractPolygons(dir, pbf, id, s, owner);
  if (pbf !== url) rmSync(pbf, { force: true });
  console.log(`${key}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} (${Math.round((Date.now() - t0) / 1000)} s)`);
  return counts;
}

/** a download cannot resume: on any failure (connect error, stall, broken stream) start the region over, up to 3 times */
async function extractWithRetry(key, outDir, opts, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await extract(key, outDir, opts);
    } catch (e) {
      if (i >= attempts) throw e;
      console.error(`${key}: attempt ${i}/${attempts} failed (${e.message}) – starting over in 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

/** name of the state asset of a region: its upload time says when the region was built */
export const stateAsset = (key) => `${key}.f${FORMAT}.points.tar`;
/** name of the release asset of a group's regional piece (several files in the group: a tar, else the PMTiles itself) */
export const assetName = (key, group) => `${key}.f${FORMAT}.${group}.${GROUPS[group].length > 1 ? 'tar' : 'pmtiles'}`;

/** which regions to refresh: `all`, the given one, or the oldest ones that are due (a 30th of all per run: rolling) */
export function planRegions(assets, keys, arg, now = Date.now()) {
  if (arg && arg !== 'all') {
    if (!keys.includes(arg)) throw new Error(`unknown region ${arg}`);
    return [arg];
  }
  const built = new Map(assets.map((a) => [a.name, Date.parse(a.updatedAt ?? a.updated_at)])); // gh api: updated_at, gh release view: updatedAt
  const age = (k) => (built.has(stateAsset(k)) ? now - built.get(stateAsset(k)) : Infinity);
  const byAge = [...keys].sort((a, b) => age(b) - age(a) || (a < b ? -1 : 1));
  if (arg === 'all') return byAge.slice(0, MAX_JOBS);
  const due = byAge.filter((k) => age(k) > MAX_AGE_DAYS * 864e5);
  return due.slice(0, Math.min(MAX_JOBS, Math.ceil(keys.length / MAX_AGE_DAYS)));
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

/** regional PMTiles: one per file of the registry from the intermediates of one region */
async function buildRegional(srcDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const common = ['--force', '--read-parallel', '-q', '-A', ATTRIBUTION];
  for (const file of FILES) {
    const sources = sourcesOf(file);
    const inputs = sources.map((s) => ({ ...s, path: join(srcDir, `${s.id}.geojsonl`) })).filter((s) => nonEmpty(s.path));
    if (!inputs.length) continue;
    const target = join(outDir, `${file}.pmtiles`);
    const [zMin, zMax] = sources[0].zoom;
    const name = ['-n', file, '-N', `OpenStreetMap ${file}`];
    if (sources[0].low) {
      // Camera sets: z0..LOW_ZOOM_END-1 only one bare point per grid cell (layer <set>_lo, lowZoomPoints), nothing dropped;
      // from LOW_ZOOM_END the full records (layer <set>); tile-join puts both zoom ranges into one file
      const lo = join(outDir, `${file}-lo`), hi = join(outDir, `${file}-hi`);
      await lowZoomPoints(inputs.map((s) => s.path), file, `${lo}.geojsonl`);
      await run('tippecanoe', ['-o', `${lo}.pmtiles`, '-l', `${file}_lo`, '-Z', '0', '-z', String(LOW_ZOOM_END - 1), '--no-feature-limit', '--no-tile-size-limit', '-r1', '-b', '0', ...name, ...common, `${lo}.geojsonl`]);
      await run('tippecanoe', ['-o', `${hi}.pmtiles`, '-l', file, '-Z', String(LOW_ZOOM_END), '-z', String(zMax), ...sources[0].tippecanoe, ...name, ...common, ...inputs.map((s) => s.path)]);
      await run('tile-join', ['-o', target, '--force', '-pk', '-q', ...name, '-A', ATTRIBUTION, `${lo}.pmtiles`, `${hi}.pmtiles`]);
      for (const f of [`${lo}.geojsonl`, `${lo}.pmtiles`, `${hi}.pmtiles`]) rmSync(f, { force: true });
    } else {
      // one file, one layer per source (-L name:file), all at the zoom of the file
      await run('tippecanoe', ['-o', target, '-Z', String(zMin), '-z', String(zMax), ...sources[0].tippecanoe, ...name, ...common, ...inputs.flatMap((s) => ['-L', `${s.layer}:${s.path}`])]);
    }
    console.log(`${file}: ${statSync(target).size} bytes`);
  }
  for (const [id, s] of Object.entries(THEMES)) {
    if (!s.heat || !nonEmpty(join(srcDir, `${id}.geojsonl`))) continue;
    writeFileSync(join(outDir, `heat-${id}.json`), JSON.stringify(await heatCells([join(srcDir, `${id}.geojsonl`)])));
  }
  copyFileSync(join(srcDir, 'info.json'), join(outDir, 'info.json'));
}

/** the assets of one region for the GitHub releases: <upload>/<assetName> per group (several files: tar with info.json and heat files, state asset) */
async function packageRegional(key, regionalDir, uploadDir) {
  mkdirSync(uploadDir, { recursive: true });
  const made = [];
  for (const [group, files] of Object.entries(GROUPS)) {
    const present = files.filter((f) => existsSync(join(regionalDir, `${f}.pmtiles`)));
    const target = join(uploadDir, assetName(key, group));
    if (files.length === 1) {
      if (present.length) copyFileSync(join(regionalDir, `${files[0]}.pmtiles`), target);
      else continue;
    } else {
      const members = [...present.map((f) => `${f}.pmtiles`), ...readdirSync(regionalDir).filter((f) => /^heat-.*\.json$/.test(f)), 'info.json'];
      await run('tar', ['-cf', target, '-C', regionalDir, ...members]);
    }
    made.push({ group, asset: assetName(key, group), bytes: statSync(target).size });
  }
  return made;
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

/** unpacks the regional assets in `dir` (current FORMAT only) into <regions>/<key>/<file>.pmtiles, heat-*.json, info.json; returns the keys */
async function unpack(dir, regions) {
  rmSync(regions, { recursive: true, force: true });
  const names = readdirSync(dir);
  const keys = names.filter((n) => n.endsWith(`.f${FORMAT}.points.tar`)).map((n) => n.slice(0, -`.f${FORMAT}.points.tar`.length));
  for (const key of keys) {
    const rd = join(regions, key);
    mkdirSync(rd, { recursive: true });
    for (const [group, files] of Object.entries(GROUPS)) {
      const asset = join(dir, assetName(key, group));
      if (!existsSync(asset)) continue;
      if (files.length > 1) await run('tar', ['-xf', asset, '-C', rd]);
      else copyFileSync(asset, join(rd, `${files[0]}.pmtiles`));
    }
  }
  return keys;
}

async function merge(assetsDir, distDir, { prev, deleteList, date = new Date().toISOString().slice(0, 10) }) {
  const regionsDir = join(assetsDir, 'unpacked');
  const keys = await unpack(assetsDir, regionsDir);
  if (!keys.length) throw new Error(`no regional pieces of format ${FORMAT} in ${assetsDir}`);
  mkdirSync(join(distDir, 'heat'), { recursive: true });
  const infos = keys.map((k) => ({ key: k, ...JSON.parse(readFileSync(join(regionsDir, k, 'info.json'), 'utf8')) }));
  console.log(`merging ${keys.length} regions`);
  const meta = { format: FORMAT, at: Date.now(), version: date, files: {}, sets: {}, regions: keys.length, oldest: Math.min(...infos.map((i) => i.at)), newest: Math.max(...infos.map((i) => i.at)) };
  for (const file of FILES) {
    const inputs = keys.map((k) => join(regionsDir, k, `${file}.pmtiles`)).filter((f) => existsSync(f));
    if (!inputs.length) {
      console.log(`${file}: no data – skipped`);
      continue;
    }
    const name = `${file}-${date}.pmtiles`;
    const target = join(distDir, name);
    // -pk: no tile size limit (the regional pieces were thinned already; the merge only concatenates the tiles of a seam)
    await run('tile-join', ['-o', target, '--force', '-pk', '-q', '-n', file, '-N', `OpenStreetMap ${file}`, '-A', ATTRIBUTION, ...inputs]);
    const sources = sourcesOf(file);
    const sum = (id) => infos.reduce((a, i) => a + (i.counts?.[id] ?? 0), 0);
    meta.files[file] = name;
    meta.sets[file] = { bytes: statSync(target).size, features: sum(sources[0].id), ...(sources.length > 1 ? { layers: Object.fromEntries(sources.map((s) => [s.layer, sum(s.id)])) } : {}) };
    console.log(`${file}: ${meta.sets[file].bytes} bytes from ${inputs.length} regions`);
  }
  // heatmap: cells of all regions (a cell on a seam is split between two regions: sum them)
  const cells = new Map();
  for (const k of keys) {
    const f = join(regionsDir, k, 'heat-cctv.json');
    if (!existsSync(f)) continue;
    for (const [x, y, c] of JSON.parse(readFileSync(f, 'utf8'))) cells.set(`${x},${y}`, (cells.get(`${x},${y}`) ?? 0) + c);
  }
  const heat = [...cells].map(([k, c]) => [...k.split(',').map(Number), c]);
  writeFileSync(join(distDir, 'heat', 'cctv.json'), JSON.stringify(heat));
  meta.heatCells = heat.length;
  const prevMeta = prev && existsSync(prev) ? JSON.parse(readFileSync(prev, 'utf8')) : null;
  const { retired, deletable } = retireVersions(prevMeta, meta.files);
  meta.retired = retired;
  writeFileSync(join(distDir, 'meta.json'), JSON.stringify(meta));
  if (deleteList) writeFileSync(deleteList, deletable.join('\n') + (deletable.length ? '\n' : ''));
  writeFileSync(join(distDir, 'LICENSE.txt'), 'Data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/\nhttps://www.openstreetmap.org/copyright\nDerived from Geofabrik extracts (https://download.geofabrik.de).\n');
  console.log(`heat/cctv.json: ${heat.length} cells; superseded: ${retired.length}, to delete now: ${deletable.length}`);
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

async function extractRegion(key, outDir, { url, owner }) {
  const counts = await extractWithRetry(key, outDir, { url, owner });
  writeFileSync(join(outDir, 'src', key, 'info.json'), JSON.stringify({ at: Date.now(), counts, format: FORMAT }));
  return counts;
}

async function regionalRegion(key, outDir) {
  const dir = join(outDir, 'regional', key);
  await buildRegional(join(outDir, 'src', key), dir);
  const made = await packageRegional(key, dir, join(outDir, 'upload'));
  console.log(`${key}: ${made.map((m) => `${m.asset} (${m.bytes} B)`).join(', ')}`);
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = pos;
  if (cmd === 'plan') {
    const [indexFile, assetsFile, arg] = args;
    if (!indexFile || !assetsFile) throw new Error('usage: osm-tiles plan <index.json> <assets.json> [region|all]');
    const keys = leafRegions(readJson(indexFile)).map((r) => r.key);
    console.log(JSON.stringify(planRegions(readJson(assetsFile).assets ?? [], keys, arg)));
  } else if (cmd === 'extract') {
    const [outDir, key] = args;
    if (!outDir || !key) throw new Error('usage: osm-tiles extract <outDir> <region> [--index f] [--url pbf] [--own-bbox w,s,e,n]');
    const regions = opt.index ? leafRegions(readJson(opt.index)) : null;
    const url = opt.url ?? findRegion(regions ?? [], key).url;
    const owner = opt['own-bbox'] ? boxOwner(opt['own-bbox'].split(',').map(Number)) : regions && regions.some((r) => r.key === key) ? makeOwner(regions, key) : () => true;
    await extractRegion(key, outDir, { url, owner });
  } else if (cmd === 'regional') {
    const [outDir, key] = args;
    if (!outDir || !key) throw new Error('usage: osm-tiles regional <outDir> <region>');
    await regionalRegion(key, outDir);
  } else if (cmd === 'merge') {
    const [assetsDir, distDir] = args;
    if (!assetsDir || !distDir) throw new Error('usage: osm-tiles merge <assetsDir> <distDir> [--prev meta.json] [--delete-list f]');
    await merge(assetsDir, distDir, { prev: opt.prev, deleteList: opt['delete-list'], date: opt.date });
  } else if (cmd === 'local') {
    const [workDir, ...specs] = args;
    if (!workDir || !specs.length) throw new Error('usage: osm-tiles local <workDir> <key=pbf[@w,s,e,n]>...');
    for (const spec of specs) {
      const [key, rest] = spec.split('=');
      const [url, box] = rest.split('@');
      await extractRegion(key, workDir, { url, owner: box ? boxOwner(box.split(',').map(Number)) : () => true });
      await regionalRegion(key, workDir);
    }
    await merge(join(workDir, 'upload'), join(workDir, 'dist'), { prev: opt.prev, deleteList: join(workDir, 'delete.txt'), date: opt.date });
  } else {
    throw new Error('usage: osm-tiles plan <index> <assets> [region|all] | extract <outDir> <region> | regional <outDir> <region> | merge <assetsDir> <distDir> | local <workDir> <key=pbf>...');
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
  main().then(() => { finished = true; }, (e) => { finished = true; console.error(e.message); process.exit(1); });
}
