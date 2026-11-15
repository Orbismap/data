#!/usr/bin/env node
/**
 * Build indoor plan JSON files from a local OSM PBF extract using osmium.
 *
 * Usage:
 *   node collectors/build-indoor-osmium.mjs --pbf /path/to/extract.osm.pbf [--limit N] [--offset N] [--skip-existing] [--icao EDDF]
 *
 * Requirements: `osmium` installed and on PATH.
 * Steps:
 *   1. Filter PBF to indoor/building:part candidates: `osmium tags-filter <pbf> nwr/indoor nwr/building:part -o <tmp>`
 *   2. For each airport bbox, `osmium extract -b ...` then convert to Overpass-like JSON and parse.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AIRPORTS_PATH = new URL('../public/data/airports.json', import.meta.url);
const OUT_DIR = new URL('../public/data/indoor/', import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pbf') args.pbf = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--offset') args.offset = Number(argv[++i]);
    else if (a === '--skip-existing') args.skipExisting = true;
    else if (a === '--icao') args.icao = String(argv[++i]).toUpperCase();
  }
  return args;
}

function indoorOverpassQuery(_bbox) {
  // not used in osmium path, kept for parity
  return '';
}

function levelOf(tags) {
  const raw = tags.level;
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const parts = s.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (nums.length) return nums[0];
  return undefined;
}

function kindOf(tags) {
  const t = tags.indoor ?? tags['building:part'] ?? '';
  if (t === 'room' || tags['building:part'] === 'room') return 'room';
  if (t === 'corridor') return 'corridor';
  if (t === 'wall') return 'wall';
  if (t === 'column') return 'column';
  if (t === 'stairs' || tags.highway === 'steps' || tags.conveying === 'yes') return 'stairs';
  if (t === 'elevator' || tags.highway === 'elevator') return 'elevator';
  if (t === 'area' || tags.shop || tags.amenity || tags.tourism || tags.leisure || tags['building:part'] === 'yes') {
    if (tags.shop || tags.amenity || tags.tourism || tags.leisure) return 'amenity';
    return 'area';
  }
  return undefined;
}

function ptInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function coordsArea(coords) {
  let a = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) a += (coords[j][0] + coords[i][0]) * (coords[j][1] - coords[i][1]);
  return Math.abs(a) / 2;
}

function buildNodeMap(elements) {
  const map = new Map();
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) map.set(el.id, [el.lon, el.lat]);
  }
  return map;
}

function collectWayRings(el, nodeMap) {
  const rings = [];
  if (el.type === 'way' && Array.isArray(el.nodes)) {
    const coords = el.nodes.map((id) => nodeMap.get(id)).filter(Boolean);
    if (coords.length >= 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1]) rings.push(coords);
  } else if (el.type === 'relation' && Array.isArray(el.members)) {
    for (const m of el.members) {
      if ((m.role === 'outer' || m.role === 'inner') && m.geometry && Array.isArray(m.geometry)) {
        const coords = m.geometry.map((p) => [p.lon, p.lat]);
        if (coords.length >= 3) rings.push(coords);
      }
    }
  }
  return rings;
}

function containsAny(ring, points) {
  if (!points.length) return false;
  const sample = points.slice(0, Math.min(8, points.length));
  return sample.some((pt) => ptInRing(pt, ring));
}

function indoorPlanFromOsmJson(data) {
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const nodeMap = buildNodeMap(elements);
  const walls = elements.filter((el) => el.tags?.indoor === 'wall' && el.type === 'way');
  const wallRings = walls.map((w) => (w.nodes || []).map((id) => nodeMap.get(id)).filter(Boolean)).filter((r) => r.length >= 3);
  const wallPoints = wallRings.flat();
  const out = [];
  for (const el of elements) {
    const tags = el.tags;
    if (!tags) continue;
    const kind = kindOf(tags);
    if (!kind) continue;
    const hasSemantics = !!(tags.indoor || tags.shop || tags.amenity || tags.tourism || tags.leisure || tags['building:part']);
    if (!hasSemantics) continue;
    const level = levelOf(tags);
    const id = `${el.type[0]}${el.id}`;
    const base = {
      id, kind, level,
      name: tags.name ?? tags['name:de'] ?? '',
      ref: tags.ref ?? tags['ref:INDOOR'] ?? '',
      category: tags.shop ?? tags.amenity ?? tags.tourism ?? tags.leisure ?? '',
      osmId: `${el.type}/${el.id}`,
    };
    if (el.type === 'node') {
      if (el.lat == null || el.lon == null) continue;
      out.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [el.lon, el.lat] }, properties: { ...base } });
      continue;
    }
    // ways/relations: use geometry if present (from osmium cat -f json with full details)
    let coords = [];
    if (el.type === 'way' && Array.isArray(el.nodes)) {
      coords = el.nodes.map((nid) => nodeMap.get(nid)).filter(Boolean);
    } else if (Array.isArray(el.geometry)) {
      coords = el.geometry.map((p) => [p.lon, p.lat]).filter((p) => p[0] != null && p[1] != null);
    }
    if (el.type !== 'way' || coords.length < 2) continue;
    const isArea = kind !== 'corridor' && kind !== 'wall' && ((tags.indoor && tags.indoor !== 'corridor') || !!tags.shop || !!tags.amenity || !!tags.tourism || !!tags.leisure || tags['building:part'] === 'yes');
    if (isArea) {
      if (coords.length < 4 || coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) continue;
      out.push({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [coords] }, properties: { ...base } });
      continue;
    }
    let enclosed = false;
    if ((kind === 'area' || kind === 'corridor') && wallPoints.length) {
      const mid = coords[Math.floor(coords.length / 2)] || coords[0];
      if (ptInRing(mid, wallRings[0]) || wallRings.some((r) => ptInRing(mid, r))) enclosed = true;
    }
    out.push({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { ...base, enclosed } });
  }
  return out;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pbf || !existsSync(args.pbf)) {
    console.error('Usage: node collectors/build-indoor-osmium.mjs --pbf <file.osm.pbf> [--limit N] [--icao EDDF]');
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(AIRPORTS_PATH, 'utf8'));
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  let airports = rows
    .map((r) => ({ icao: String(r[0]), lon: Number(r[3]), lat: Number(r[4]) }))
    .filter((a) => a.icao && Number.isFinite(a.lon) && Number.isFinite(a.lat));
  if (args.icao) airports = airports.filter((a) => a.icao === args.icao);
  if (Number.isFinite(args.offset) && args.offset > 0) airports = airports.slice(args.offset);
  if (Number.isFinite(args.limit) && args.limit < airports.length) airports = airports.slice(0, args.limit);

  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
  const tmpDir = '/tmp/orbis-indoor-osmium';
  mkdirSync(tmpDir, { recursive: true });

  console.log('Filtering PBF for indoor/building:part ...');
  const filteredPbf = `${tmpDir}/filtered.osm.pbf`;
  run('osmium', ['tags-filter', args.pbf, '-o', filteredPbf, '--overwrite', 'nwr/indoor', 'nwr/building:part']);

  let done = 0, skipped = 0, failed = 0;
  for (const a of airports) {
    const outFs = fileURLToPath(new URL(`${a.icao}.json`, OUT_DIR));
    if (args.skipExisting && existsSync(outFs)) { skipped++; continue; }
    const bbox = [
      (a.lon - 0.035).toFixed(6),
      (a.lat - 0.025).toFixed(6),
      (a.lon + 0.035).toFixed(6),
      (a.lat + 0.025).toFixed(6),
    ].join(',');
    const clipPbf = `${tmpDir}/${a.icao}.osm.pbf`;
    try {
      run('osmium', ['extract', '-b', bbox, filteredPbf, '-o', clipPbf, '--overwrite']);
      const jsonStr = execFileSync('osmium', ['cat', clipPbf, '-f', 'json'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      const data = JSON.parse(jsonStr);
      const parsed = indoorPlanFromOsmJson(data);
      writeFileSync(outFs, JSON.stringify(parsed));
      console.log(`[${done + skipped + failed + 1}/${airports.length}] ${a.icao}: ${parsed.length} features`);
      done++;
    } catch (e) {
      console.error(`${a.icao}: failed`, e?.message || e);
      failed++;
    }
  }
  console.log(`done=${done} skipped=${skipped} failed=${failed} total=${airports.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
