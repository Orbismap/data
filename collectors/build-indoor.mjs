#!/usr/bin/env node
/**
 * Build indoor plan JSON files from OSM PBF extracts (Geofabrik regions) using osmium.
 *
 * Usage:
 *   node collectors/build-indoor-osmium.mjs --region europe [--limit N] [--offset N] [--skip-existing] [--icao EDDF]
 *   node collectors/build-indoor-osmium.mjs --pbf /path/to/extract.osm.pbf [--limit N] ...   (local test)
 *
 * Requirements: `osmium` installed and on PATH.
 * Regions (Geofabrik): europe, russia, asia, north-america, central-america, south-america, africa, oceania
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

function indoorPlanFromGeoJson(features) {
  const out = [];
  for (const f of features) {
    const tags = f.properties || {};
    const kind = kindOf(tags);
    if (!kind) continue;
    const hasSemantics = !!(tags.indoor || tags.shop || tags.amenity || tags.tourism || tags.leisure || tags['building:part']);
    if (!hasSemantics) continue;
    const level = levelOf(tags);
    const id = f.id || '';
    const base = {
      id, kind, level,
      name: tags.name ?? tags['name:de'] ?? '',
      ref: tags.ref ?? tags['ref:INDOOR'] ?? '',
      category: tags.shop ?? tags.amenity ?? tags.tourism ?? tags.leisure ?? '',
      osmId: id,
    };
    if (f.geometry.type === 'Point') {
      out.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: f.geometry.coordinates }, properties: { ...base } });
      continue;
    }
    if (f.geometry.type === 'LineString') {
      const coords = f.geometry.coordinates;
      if (coords.length < 2) continue;
      out.push({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { ...base } });
      continue;
    }
    if (f.geometry.type === 'Polygon') {
      const coords = f.geometry.coordinates[0];
      if (!coords || coords.length < 4) continue;
      out.push({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [coords] }, properties: { ...base } });
      continue;
    }
  }
  return out;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = '/tmp/orbis-indoor-osmium';
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
    console.error('Usage: node collectors/build-indoor-osmium.mjs --region <name> | --pbf <file.osm.pbf>');
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(AIRPORTS_PATH, 'utf8'));
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  let airports = rows
    .map((r) => ({ icao: String(r[0]), lon: Number(r[3]), lat: Number(r[4]) }))
    .filter((a) => a.icao && Number.isFinite(a.lon) && Number.isFinite(a.lat));

  if (args.icao) airports = airports.filter((a) => a.icao === args.icao);

  // Filter airports by region bbox (rough) to avoid processing the same airports in every region
  if (regionName && REGIONS[regionName]) {
    const [w, s, e, n] = REGIONS[regionName].bbox;
    airports = airports.filter((a) => a.lon >= w && a.lon <= e && a.lat >= s && a.lat <= n);
  }

  if (Number.isFinite(args.offset) && args.offset > 0) airports = airports.slice(args.offset);
  if (Number.isFinite(args.limit) && args.limit < airports.length) airports = airports.slice(0, args.limit);

  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });

  console.log(`Filtering PBF for indoor/building:part (${airports.length} airports in region) ...`);
  const filteredPbf = `${tmpDir}/filtered-${regionName || 'local'}.osm.pbf`;
  run('osmium', ['tags-filter', pbfPath, '-o', filteredPbf, '--overwrite', 'nwr/indoor', 'nwr/building:part']);

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
      const geojsonStr = execFileSync('osmium', ['export', clipPbf, '-f', 'geojson', '--add-unique-id', 'type_id'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      const geojson = JSON.parse(geojsonStr);
      const features = Array.isArray(geojson.features) ? geojson.features : [];
      const parsed = indoorPlanFromGeoJson(features);
      // Merge into existing airport file (plan data) if present
      let existing = {};
      if (existsSync(outFs)) {
        try { existing = JSON.parse(readFileSync(outFs, 'utf8')); } catch {}
      }
      const merged = { ...existing, icao: a.icao, indoor: parsed };
      writeFileSync(outFs, JSON.stringify(merged));
      console.log(`[${done + skipped + failed + 1}/${airports.length}] ${a.icao}: ${parsed.length} indoor features`);
      done++;
    } catch (e) {
      console.error(`${a.icao}: failed`, e?.message || e);
      failed++;
    }
  }
  console.log(`done=${done} skipped=${skipped} failed=${failed} total=${airports.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
