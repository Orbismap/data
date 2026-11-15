// Build static indoor plans from OpenStreetMap (Simple Indoor Tagging) for each airport
// in public/data/airports.json and write them to public/data/indoor/<ICAO>.json.
//
// Usage:
//   node scripts/build-indoor.mjs [--limit N] [--offset N] [--skip-existing]
//
// Rate limit: 1 request/second to Overpass. Retries on HTTP 429.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const AIRPORTS_PATH = new URL('public/data/airports.json', ROOT);
const OUT_DIR = new URL('public/data/indoor/', ROOT);

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = { 'User-Agent': 'Orbis/1.0 (+https://github.com/malte9799/orbis)' };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs(argv) {
  const out = { limit: Infinity, offset: 0, skipExisting: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') { out.limit = Number(argv[++i]); }
    else if (a === '--offset') { out.offset = Number(argv[++i]); }
    else if (a === '--skip-existing') { out.skipExisting = true; }
  }
  return out;
}

// ---- ported from src/data/parsers/indoor.ts ----
function numToken(s) {
  if (!s) return '';
  const m = String(s).match(/-?\d+/);
  return m ? m[0] : String(s).trim();
}
function levelOf(tags) {
  return numToken(tags.level ?? tags['building:level'] ?? tags['level:ref']);
}
const AREA_KINDS = new Set(['room', 'corridor', 'area', 'shop', 'amenity', 'poi', 'stairs', 'elevator']);
function kindOf(tags) {
  const indoor = (tags.indoor ?? '').toLowerCase();
  if (indoor) {
    if (indoor === 'room') return 'room';
    if (indoor === 'corridor' || indoor === 'hallway' || indoor === 'passage' || indoor === 'walkway') return 'corridor';
    if (indoor === 'wall') return 'wall';
    if (indoor === 'door') return 'door';
    if (indoor === 'stairs' || indoor === 'staircase' || indoor === 'step') return 'stairs';
    if (indoor === 'elevator' || indoor === 'lift') return 'elevator';
    if (indoor === 'area' || indoor === 'yes') return 'area';
    return 'area';
  }
  if (tags.shop) return 'shop';
  if (tags.amenity) return 'amenity';
  if (tags.tourism || tags.leisure) return 'poi';
  if (tags['building:part']) return 'area';
  return null;
}
function centroid(coords) {
  const n = coords.length;
  if (!n) return [0, 0];
  let sx = 0, sy = 0;
  for (const c of coords) { sx += c[0]; sy += c[1]; }
  return [sx / n, sy / n];
}
function closed(g) {
  return g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
}
function indoorOverpassQuery(b) {
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:40];(
    way["indoor"](${bbox});
    node["indoor"](${bbox});
    way["level"]["shop"](${bbox});
    node["level"]["shop"](${bbox});
    way["level"]["amenity"](${bbox});
    node["level"]["amenity"](${bbox});
    way["level"]["tourism"](${bbox});
    node["level"]["tourism"](${bbox});
    way["level"]["building:part"](${bbox});
  );out geom qt;`;
}
function indoorPlanFromOverpass(raw) {
  const els = (raw && Array.isArray(raw.elements)) ? raw.elements : [];
  const out = [];
  for (const el of els) {
    const tags = el.tags;
    if (!tags) continue;
    const kind = kindOf(tags);
    if (!kind) continue;
    const hasSemantics = !!(tags.indoor || tags.shop || tags.amenity || tags.tourism || tags.leisure || tags['building:part']);
    if (!hasSemantics) continue;

    const level = levelOf(tags);
    const id = `${el.type[0]}${el.id}`;
    const base = {
      id,
      kind,
      level,
      name: tags.name ?? tags['name:de'] ?? '',
      ref: tags.ref ?? tags['ref:INDOOR'] ?? '',
      category: tags.shop ?? tags.amenity ?? tags.tourism ?? tags.leisure ?? '',
      osmId: `${el.type}/${el.id}`,
    };

    if (el.type === 'node') {
      if (el.lat === undefined || el.lon === undefined) continue;
      out.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [el.lon, el.lat] }, properties: { ...base } });
      continue;
    }
    const g = el.geometry;
    if (el.type !== 'way' || !g || g.length < 2) continue;
    const coords = g.map((p) => [p.lon, p.lat]);

    if (kind === 'wall' || kind === 'door') {
      out.push({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { ...base } });
      continue;
    }

    if (closed(g) && AREA_KINDS.has(kind)) {
      out.push({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [coords] }, properties: { ...base } });
      if (kind === 'shop' || kind === 'amenity' || kind === 'poi' || kind === 'stairs' || kind === 'elevator') {
        const c = centroid(coords.slice(0, -1));
        out.push({ type: 'Feature', id: `${id}-pt`, geometry: { type: 'Point', coordinates: c }, properties: { ...base, kind: (kind === 'shop' ? 'shop' : kind === 'amenity' ? 'amenity' : kind) } });
      }
      continue;
    }

    out.push({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { ...base } });
    if (base.name && (kind === 'stairs' || kind === 'elevator')) {
      const c = centroid(coords);
      out.push({ type: 'Feature', id: `${id}-pt`, geometry: { type: 'Point', coordinates: c }, properties: { ...base } });
    }
  }
  return out;
}

async function fetchOverpass(query) {
  let last;
  for (const host of OVERPASS) {
    const url = `${host}?data=${encodeURIComponent(query)}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
        if (res.status === 429) {
          last = new Error('HTTP 429');
          await sleep(5000 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        last = e;
        if (attempt < 4) await sleep(2000);
      }
    }
  }
  throw last ?? new Error('Overpass failed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(AIRPORTS_PATH, 'utf8'));
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  // rows: [icao, iata, name, lon, lat, elevFt, large, country, city]
  let airports = rows
    .map((r) => ({ icao: String(r[0]), lon: Number(r[3]), lat: Number(r[4]) }))
    .filter((a) => a.icao && Number.isFinite(a.lon) && Number.isFinite(a.lat));

  if (Number.isFinite(args.offset) && args.offset > 0) airports = airports.slice(args.offset);
  if (Number.isFinite(args.limit) && args.limit < airports.length) airports = airports.slice(0, args.limit);

  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });

  let done = 0, skipped = 0, failed = 0;
  for (let i = 0; i < airports.length; i++) {
    const a = airports[i];
    const outPath = new URL(`${a.icao}.json`, OUT_DIR);
    const outFs = fileURLToPath(outPath);
    if (args.skipExisting && existsSync(outFs)) {
      skipped++;
      continue;
    }
    const bbox = {
      west: a.lon - 0.035,
      south: a.lat - 0.025,
      east: a.lon + 0.035,
      north: a.lat + 0.025,
    };
    const q = indoorOverpassQuery(bbox);
    try {
      const data = await fetchOverpass(q);
      const parsed = indoorPlanFromOverpass(data);
      writeFileSync(outFs, JSON.stringify(parsed));
      done++;
      console.log(`[${i + 1}/${airports.length}] ${a.icao}: ${parsed.length} features`);
    } catch (e) {
      failed++;
      console.warn(`[${i + 1}/${airports.length}] ${a.icao}: FAILED ${e?.message ?? e}`);
    }
    // rate limit 1 req/sec
    await sleep(1000);
  }
  console.log(`done=${done} skipped=${skipped} failed=${failed} total=${airports.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
