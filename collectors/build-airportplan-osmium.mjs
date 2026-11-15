#!/usr/bin/env node
/**
 * Build airport ground plan JSON files from OSM PBF extracts using osmium.
 * Uses osmium export -f geojson (not osmium cat -f json, which isn't supported).
 *
 * Output: public/data/airports/<ICAO>.json
 *
 * Usage:
 *   node collectors/build-airportplan-osmium.mjs --region europe [--limit N] [--icao EDDF]
 *   node collectors/build-airportplan-osmium.mjs --pbf /path/to/extract.osm.pbf --icao EDDF
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AIRPORTS_PATH = new URL('../public/data/airports.json', import.meta.url);
const OUT_DIR = new URL('../public/data/airports/', import.meta.url);

const REGIONS = {
  europe: { url: 'https://download.geofabrik.de/europe-latest.osm.pbf', bbox: [-10, 34, 40, 71] },
  russia: { url: 'https://download.geofabrik.de/russia-latest.osm.pbf', bbox: [20, 41, 180, 82] },
  asia: { url: 'https://download.geofabrik.de/asia-latest.osm.pbf', bbox: [25, -10, 180, 55] },
  'north-america': { url: 'https://download.geofabrik.de/north-america-latest.osm.pbf', bbox: [-170, 15, -50, 75] },
  'central-america': { url: 'https://download.geofabrik.de/central-america-latest.osm.pbf', bbox: [-120, 5, -60, 35] },
  'south-america': { url: 'https://download.geofabrik.de/south-america-latest.osm.pbf', bbox: [-85, -60, -30, 15] },
  africa: { url: 'https://download.geofabrik.de/africa-latest.osm.pbf', bbox: [-20, -35, 55, 40] },
  oceania: { url: 'https://download.geofabrik.de/australia-oceania-latest.osm.pbf', bbox: [110, -50, 180, -10] },
};

const LIGHT_TYPES = ['txe', 'txc', 'rwe', 'rwc', 'tdz', 'als', 'rwt', 'sbl', 'cbl', 'rgl', 'txw', 'papi', 'other'];
const LIGHT_COLOURS = ['white', 'green', 'blue', 'red', 'yellow'];
const LIGHT_DEFAULT_COLOUR = { txe: 'blue', txc: 'green', papi: 'red' };
const DEFAULT_WIDTH = { runway: 45, taxiway: 23, taxilane: 15 };
const DEFAULT_HEIGHT = { terminal: 18, hangar: 14, building: 9 };
const KINDS = new Set(['runway', 'taxiway', 'taxilane', 'apron', 'terminal', 'hangar', 'building', 'helipad', 'gate', 'parking', 'light']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pbf') args.pbf = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--offset') args.offset = Number(argv[++i]);
    else if (a === '--skip-existing') args.skipExisting = true;
    else if (a === '--icao') args.icao = String(argv[++i]).toUpperCase();
  }
  return args;
}

const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

function lightKind(tags) {
  const nav = tags.navigationaid ?? '';
  const lt = LIGHT_TYPES.includes(nav) ? nav : 'other';
  const colour = tags['light:colour'] ?? '';
  const col = LIGHT_COLOURS.includes(colour) ? colour : (LIGHT_DEFAULT_COLOUR[lt] ?? 'white');
  return { lt, col };
}

function kindOf(tags) {
  switch (tags.aeroway) {
    case 'runway': case 'taxiway': case 'taxilane': case 'apron':
    case 'terminal': case 'hangar': case 'helipad': return tags.aeroway;
    case 'gate': return 'gate';
    case 'parking_position': return 'parking';
    case 'navigationaid': return 'light';
  }
  return tags.building ? 'building' : null;
}

function heightOf(tags, kind) {
  let h = num(tags.height);
  if (!Number.isFinite(h)) {
    const levels = num(tags['building:levels']);
    h = Number.isFinite(levels) ? levels * 3.5 : (DEFAULT_HEIGHT[kind] ?? 0);
  }
  let minh = num(tags.min_height);
  if (!Number.isFinite(minh)) {
    const minLevels = num(tags['building:min_level']);
    minh = Number.isFinite(minLevels) ? minLevels * 3.5 : 0;
  }
  return { h, minh };
}

function parseOsmId(feature) {
  const id = feature.id || '';
  const m = String(id).match(/^([nwr])(\d+)$/);
  if (m) return `${m[1]}${m[2]}`;
  return id;
}

function planFromGeoJson(features, icao) {
  const polygons = [];
  const lines = [];
  const points = [];

  for (const f of features) {
    const tags = f.properties || {};
    const kind = kindOf(tags);
    if (!kind || !KINDS.has(kind)) continue;
    const id = parseOsmId(f);
    const base = { id, kind, ref: tags.ref ?? '', name: tags.name ?? '' };

    if (f.geometry.type === 'Point') {
      if (kind === 'gate' || kind === 'parking' || kind === 'helipad' || kind === 'light') {
        const props = kind === 'light' ? { ...base, ...lightKind(tags) } : base;
        points.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: f.geometry.coordinates }, properties: props });
      }
      continue;
    }

    if (f.geometry.type === 'LineString') {
      const coords = f.geometry.coordinates;
      if (coords.length < 2) continue;
      if (kind === 'runway' || kind === 'taxiway' || kind === 'taxilane') {
        const w = num(tags.width);
        lines.push({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { ...base, w: Number.isFinite(w) ? w : (DEFAULT_WIDTH[kind] ?? 20), surface: tags.surface ?? '' } });
      } else if (kind === 'gate' || kind === 'parking' || kind === 'helipad') {
        const c = coords.reduce((a, p) => [a[0] + p[0] / coords.length, a[1] + p[1] / coords.length], [0, 0]);
        points.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: c }, properties: base });
      }
      continue;
    }

    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
      const rings = f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates.map((poly) => poly[0])
        : [f.geometry.coordinates[0]];
      for (const coords of rings) {
        if (!coords || coords.length < 4) continue;
        const closed = coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
        if (!closed) continue;
        if (kind === 'apron' || kind === 'terminal' || kind === 'hangar' || kind === 'building' || kind === 'helipad' || tags.area === 'yes') {
          const { h, minh } = heightOf(tags, kind);
          polygons.push({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [coords] }, properties: { ...base, h, minh } });
        }
      }
      continue;
    }
  }

  return { icao, polygons, lines, points };
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = '/tmp/orbis-airportplan-osmium';
  mkdirSync(tmpDir, { recursive: true });

  let pbfPath = args.pbf;
  let regionName = args.region;
  if (!pbfPath && regionName) {
    const info = REGIONS[regionName];
    if (!info) {
      console.error(`Unknown region: ${regionName}. Valid: ${Object.keys(REGIONS).join(', ')}`);
      process.exit(2);
    }
    pbfPath = `${tmpDir}/${regionName}-latest.osm.pbf`;
    if (!existsSync(pbfPath)) {
      console.log(`Downloading ${info.url} ...`);
      spawnSync('curl', ['-L', '-o', pbfPath, info.url], { stdio: 'inherit' });
      if (!existsSync(pbfPath)) {
        console.error('Download failed');
        process.exit(1);
      }
    }
  }
  if (!pbfPath || !existsSync(pbfPath)) {
    console.error('Usage: node collectors/build-airportplan-osmium.mjs --region <name> | --pbf <file.osm.pbf>');
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(AIRPORTS_PATH, 'utf8'));
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  let airports = rows
    .map((r) => ({ icao: String(r[0]), lon: Number(r[3]), lat: Number(r[4]) }))
    .filter((a) => a.icao && Number.isFinite(a.lon) && Number.isFinite(a.lat));

  if (args.icao) airports = airports.filter((a) => a.icao === args.icao);

  if (regionName && REGIONS[regionName]) {
    const [w, s, e, n] = REGIONS[regionName].bbox;
    airports = airports.filter((a) => a.lon >= w && a.lon <= e && a.lat >= s && a.lat <= n);
  }

  if (Number.isFinite(args.offset) && args.offset > 0) airports = airports.slice(args.offset);
  if (Number.isFinite(args.limit) && args.limit < airports.length) airports = airports.slice(0, args.limit);

  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });

  console.log(`Filtering PBF for aeroway (${airports.length} airports in region) ...`);
  const filteredPbf = `${tmpDir}/filtered-aeroway-${regionName || 'local'}.osm.pbf`;
  run('osmium', ['tags-filter', pbfPath, '-o', filteredPbf, '--overwrite', 'nwr/aeroway']);

  let done = 0, skipped = 0, failed = 0;
  for (const a of airports) {
    const outFs = fileURLToPath(new URL(`${a.icao}.json`, OUT_DIR));
    if (args.skipExisting && existsSync(outFs)) { skipped++; continue; }
    const bbox = `${a.lon - 0.035},${a.lat - 0.025},${a.lon + 0.035},${a.lat + 0.025}`;
    const clipPbf = `${tmpDir}/${a.icao}-ap.osm.pbf`;
    try {
      run('osmium', ['extract', '-b', bbox, filteredPbf, '-o', clipPbf, '--overwrite']);
      // osmium export to GeoJSON (not osmium cat -f json, which isn't supported)
      const geojsonStr = execFileSync('osmium', ['export', clipPbf, '-f', 'geojson', '--add-unique-id', 'type_id'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      const geojson = JSON.parse(geojsonStr);
      const features = Array.isArray(geojson.features) ? geojson.features : [];
      const plan = planFromGeoJson(features, a.icao);

      const out = { icao: a.icao, polygons: plan.polygons, lines: plan.lines, points: plan.points };
      writeFileSync(outFs, JSON.stringify(out));
      console.log(`[${done + skipped + failed + 1}/${airports.length}] ${a.icao}: ${plan.polygons.length} polygons, ${plan.lines.length} lines, ${plan.points.length} points`);
      done++;
    } catch (e) {
      console.error(`${a.icao}: failed`, e?.message || e);
      failed++;
    }
  }
  console.log(`done=${done} skipped=${skipped} failed=${failed} total=${airports.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
