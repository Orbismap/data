import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { FIELDS, LINES, lineFeature, metres, parseNode, parseWay, simplify, toFeature, treeLineRecord, treeRecord, SET_ZOOM, SETS, FILES, GROUPS, THEMES, FORMAT, assetName, stateAsset, planRegions, retireVersions, roofFeature, leafRegions, unitRegions, regionTree, UNIT_MAX_BYTES, regionKey, makeOwner, dailyCount, retryAfterSeconds, backoffMs, probeSizes, download, GeofabrikUnreachable, UNREACHABLE_EXIT } from './osm-tiles.mjs';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sizesTable from './osm-sizes.json';

describe('trees set', () => {
  it('parses metre values and drops junk', () => {
    expect(metres('12', 150, 1)).toBe(12);
    expect(metres('12,55 m', 150, 1)).toBe(12.6);
    expect(metres('1.234', 30, 2)).toBe(1.23);
    expect(metres('0', 150, 1)).toBe('');
    expect(metres('tall', 150, 1)).toBe('');
    expect(metres('5000', 150, 1)).toBe('');
    expect(metres(undefined, 150, 1)).toBe('');
  });

  it('keeps only tagged values in the feature', () => {
    const node = parseNode('n42 v1 x8.68123456 y50.11 Tnatural=tree,species=Quercus%20%robur,height=18,leaf_type=broadleaved,leaf_cycle=bogus');
    const f = toFeature('trees', treeRecord(node));
    expect(f.geometry.coordinates).toEqual([8.68123, 50.11]);
    expect(f.properties).toEqual({ species: 'Quercus robur', height: 18, leaf_type: 'broadleaved' });
  });

  it('a bare tree has no properties at all (no id, no genus)', () => {
    const f = toFeature('trees', treeRecord(parseNode('n7 x1 y2 Tnatural=tree,genus=Quercus')));
    expect(f.properties).toEqual({});
    expect(FIELDS.trees).not.toContain('id');
    expect(FIELDS.trees).not.toContain('genus');
  });

  it('is built for zoom 15', () => {
    expect(SET_ZOOM.trees).toEqual([15, 15]);
  });
});

describe('tree_lines layer', () => {
  it('parses a way line of OPL', () => {
    const w = parseWay('w9 v1 dV c1 t2020 i1 uu Tnatural=tree_row,species=Tilia Nn1,n2,n3');
    expect(w).toEqual({ id: '9', tags: { natural: 'tree_row', species: 'Tilia' }, refs: ['1', '2', '3'] });
    expect(parseWay('n1 x1 y2')).toBeNull();
  });

  it('tree row: kind, species and height, no ids', () => {
    const rec = treeLineRecord({ natural: 'tree_row', species: 'Tilia cordata', height: '12,5 m', leaf_type: 'broadleaved', leaf_cycle: 'x' }, [[8.1234567, 50.1], [8.2, 50.1]]);
    expect(lineFeature(rec!)).toEqual({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[8.12346, 50.1], [8.2, 50.1]] },
      properties: { kind: 'row', species: 'Tilia cordata', height: 12.5, leaf_type: 'broadleaved' },
    });
  });

  it('hedge: no species, only kind when nothing else is tagged', () => {
    const rec = treeLineRecord({ barrier: 'hedge', species: 'Carpinus' }, [[1, 2], [1.001, 2]]);
    expect(lineFeature(rec!).properties).toEqual({ kind: 'hedge' });
  });

  it('other ways and degenerate lines are dropped', () => {
    expect(treeLineRecord({ highway: 'path' }, [[1, 2], [3, 4]])).toBeNull();
    expect(treeLineRecord({ barrier: 'hedge' }, [[1, 2], [1.000001, 2.000001]])).toBeNull();
  });

  it('simplifies to ~1 m and keeps the ends (also of closed rings)', () => {
    const dLat = (m: number) => m / 110574;
    expect(simplify([[8, 50], [8.0005, 50 + dLat(0.5)], [8.001, 50]])).toEqual([[8, 50], [8.001, 50]]);
    const bent = [[8, 50], [8.0005, 50 + dLat(5)], [8.001, 50]];
    expect(simplify(bent)).toEqual(bent);
    const ring = [[8, 50], [8.001, 50], [8.001, 50.001], [8, 50]];
    expect(simplify(ring)).toEqual(ring);
  });

  it('has its own layer and intermediate in the trees file', () => {
    expect(LINES).toMatchObject({ set: 'trees', layer: 'tree_lines' });
  });
});

describe('registry', () => {
  it('keeps the files, layers and fields the client reads', () => {
    expect(SETS).toEqual(['cctv', 'blitzer', 'alpr', 'webcam', 'wind', 'resource', 'trees']);
    expect(FILES).toEqual([...SETS, 'roofs']);
    expect(FIELDS.cctv).toEqual(['dir', 'surveillance', 'ctype', 'mount', 'guard', 'operator', 'id']);
    expect(FIELDS.blitzer).toEqual(['dir', 'kind', 'speed', 'operator', 'ref', 'id']);
    expect(FIELDS.resource).toEqual(['name', 'kind', 'words', 'resource', 'operator', 'id']);
    expect(THEMES.trees.layer).toBe('trees');
    expect(THEMES.tree_lines).toMatchObject({ file: 'trees', layer: 'tree_lines' });
  });

  it('every source has what its geometry needs', () => {
    for (const [id, s] of Object.entries(THEMES)) {
      expect(s.file && s.layer && s.group && s.filter?.length && s.zoom, id).toBeTruthy();
      if (s.geometry === 'point') expect(typeof s.match === 'function' && typeof s.record === 'function' && s.fields?.length, id).toBeTruthy();
      if (s.geometry === 'line') expect(typeof s.lineRecord === 'function' && typeof s.match === 'function', id).toBeTruthy();
      if (s.geometry === 'polygon') expect(typeof s.polygonFeature === 'function' && s.require?.length, id).toBeTruthy();
    }
  });

  it('roofs and trees are z15 only, each group is one release', () => {
    expect(THEMES.roofs.zoom).toEqual([15, 15]);
    expect(GROUPS).toEqual({ points: ['cctv', 'blitzer', 'alpr', 'webcam', 'wind', 'resource'], trees: ['trees'], roofs: ['roofs'] });
    expect(assetName('europe_germany_hessen', 'points')).toBe(`europe_germany_hessen.f${FORMAT}.points.tar`);
    expect(assetName('europe_germany_hessen', 'roofs')).toBe(`europe_germany_hessen.f${FORMAT}.roofs.pmtiles`);
  });
});

describe('roofs theme', () => {
  const poly = [[[8, 50], [8.0001, 50], [8.0001, 50.0001], [8, 50]]];
  it('keeps the tags the 3D model reads, under the OSM keys, and nothing else', () => {
    const f = roofFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { building: 'house', 'roof:shape': ' Gabled ', 'roof:height': '3.5', 'addr:city': 'X', name: 'Y', height: '9' } });
    expect(f!.properties).toEqual({ building: 'house', 'roof:shape': 'gabled', 'roof:height': '3.5', height: '9' });
    expect(f!.geometry.type).toBe('MultiPolygon');
  });

  it('drops buildings and parts without a roof tag, and roof tags without a building', () => {
    expect(roofFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { building: 'house', height: '9' } })).toBeNull();
    expect(roofFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { 'building:part': 'yes', 'building:levels': '3' } })).toBeNull();
    expect(roofFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { amenity: 'shelter', 'roof:shape': 'flat' } })).toBeNull();
    expect(roofFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { 'building:part': 'yes', 'roof:levels': '1' } })).not.toBeNull();
  });
});

describe('plan', () => {
  const keys = Array.from({ length: 60 }, (_, i) => `r${String(i).padStart(2, '0')}`);
  const now = Date.parse('2026-12-01T00:00:00Z');
  const asset = (k: string, daysAgo: number) => ({ name: stateAsset(k), updatedAt: new Date(now - daysAgo * 864e5).toISOString() });

  it('rolling: the oldest due regions, a 30th of all per run', () => {
    const assets = keys.map((k, i) => asset(k, 10 + i)); // r59 oldest (69 d)
    expect(planRegions(assets, keys, undefined, now)).toEqual(['r59', 'r58']);
  });

  it('never built counts as oldest, regions younger than 30 days are not due', () => {
    expect(planRegions(keys.slice(1).map((k) => asset(k, 5)), keys, undefined, now)).toEqual(['r00']);
    expect(planRegions(keys.map((k) => asset(k, 29)), keys, undefined, now)).toEqual([]);
  });

  it('an asset of an older format does not count', () => {
    expect(planRegions([{ name: `r00.f${FORMAT - 1}.points.tar`, updatedAt: new Date(now).toISOString() }], ['r00'], undefined, now)).toEqual(['r00']);
  });

  it('one region or all (oldest first, at most one matrix)', () => {
    expect(planRegions([], keys, 'r07', now)).toEqual(['r07']);
    expect(() => planRegions([], keys, 'nope', now)).toThrow();
    expect(planRegions([], keys, 'all', now)).toHaveLength(40); // a batch; the oldest first
    expect(planRegions([], Array.from({ length: 400 }, (_, i) => `k${i}`), 'all', now)).toHaveLength(40);
    expect(planRegions(keys.slice(5).map((k) => asset(k, 5)), keys, 'all', now).slice(0, 5)).toEqual(['r00', 'r01', 'r02', 'r03', 'r04']);
  });

  it('a daily run stays small: about every 30 days each unit', () => {
    expect(dailyCount(90)).toBe(3);
    expect(dailyCount(91)).toBe(4);
    expect(dailyCount(1)).toBe(1);
  });
});

describe('retired versions', () => {
  const files = { cctv: 'cctv-2026-12-02.pmtiles', roofs: 'roofs-2026-12-02.pmtiles' };
  const t0 = Date.parse('2026-12-02T03:00:00Z');
  const H = 3600e3;

  it('a replaced version waits for the cache time, then it is deleted', () => {
    const prev = { files: { cctv: 'cctv-2026-12-01.pmtiles', roofs: 'roofs-2026-12-01.pmtiles' }, retired: [] };
    const first = retireVersions(prev, files, t0);
    expect(first.deletable).toEqual([]);
    expect(first.retired.map((r) => r.file)).toEqual(['cctv-2026-12-01.pmtiles', 'roofs-2026-12-01.pmtiles']);
    const second = retireVersions({ files, retired: first.retired }, { cctv: 'cctv-2026-12-03.pmtiles', roofs: 'roofs-2026-12-03.pmtiles' }, t0 + 25 * H);
    expect(second.deletable.sort()).toEqual(['cctv-2026-12-01.pmtiles', 'roofs-2026-12-01.pmtiles']);
    expect(second.retired.map((r) => r.file).sort()).toEqual(['cctv-2026-12-02.pmtiles', 'roofs-2026-12-02.pmtiles']);
  });

  it('the same version again is not retired; the unversioned names of the old layout are', () => {
    expect(retireVersions({ files, retired: [] }, files, t0)).toEqual({ retired: [], deletable: [] });
    expect(retireVersions({ sets: { cctv: {}, trees: {} } }, files, t0).retired.map((r) => r.file)).toEqual(['cctv.pmtiles', 'trees.pmtiles']);
    expect(retireVersions(null, files, t0)).toEqual({ retired: [], deletable: [] });
  });
});

describe('regions', () => {
  const sq = (x: number, y: number, w: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]] });
  const feat = (id: string, parent: string | undefined, path: string, geometry: unknown) => ({ type: 'Feature', geometry, properties: { id, parent, urls: { pbf: `https://download.geofabrik.de/${path}-latest.osm.pbf` } } });
  const index = { features: [
    feat('europe', undefined, 'europe', sq(0, 0, 40)),
    feat('germany', 'europe', 'europe/germany', sq(0, 0, 20)),
    feat('brandenburg', 'germany', 'europe/germany/brandenburg', sq(0, 0, 10)),
    feat('berlin', 'germany', 'europe/germany/berlin', sq(4, 4, 2)),
    feat('hessen', 'germany', 'europe/germany/hessen', sq(10, 0, 10)),
    feat('dach', 'europe', 'europe/dach', sq(0, 0, 25)),
  ] };

  it('leaves of the index, no collective extracts, unique keys', () => {
    const r = leafRegions(index);
    expect(r.map((x: { key: string }) => x.key)).toEqual(['europe_germany_brandenburg', 'europe_germany_berlin', 'europe_germany_hessen']);
    expect(regionKey('https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf')).toBe('north-america_us_new-york');
  });

  it('ownership: a seam point belongs to one region, Berlin is cut out of Brandenburg', () => {
    const regions = leafRegions(index);
    const bb = makeOwner(regions, 'europe_germany_brandenburg'), be = makeOwner(regions, 'europe_germany_berlin'), he = makeOwner(regions, 'europe_germany_hessen');
    expect([bb(5, 5.5), be(5, 5.5)]).toEqual([false, true]); // in Berlin
    expect([bb(2, 2), be(2, 2), he(2, 2)]).toEqual([true, false, false]);
    expect([bb(12, 2), he(12, 2)]).toEqual([false, true]);
    expect(bb(30, 30) || he(30, 30)).toBe(false);
  });
});

describe('units', () => {
  const sq = (x: number, y: number, w: number, h = w) => ({ type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] });
  const feat = (id: string, path: string, geometry: unknown) => ({ type: 'Feature', geometry, properties: { id, urls: { pbf: `https://download.geofabrik.de/${path}-latest.osm.pbf` } } });
  // europe 0..30 > germany 0..20 > { brandenburg 0..10 (contains berlin 4..6), berlin, hessen 10..20 }, poland 20..30; us aggregate with a state below it
  const index = { features: [
    feat('europe', 'europe', sq(0, 0, 30, 10)),
    feat('germany', 'europe/germany', sq(0, 0, 20, 10)),
    feat('brandenburg', 'europe/germany/brandenburg', sq(0, 0, 10)),
    feat('berlin', 'europe/germany/berlin', sq(4, 4, 2)),
    feat('hessen', 'europe/germany/hessen', sq(10, 0, 10)),
    feat('poland', 'europe/poland', sq(20, 0, 10)),
    feat('dach', 'europe/dach', sq(0, 0, 25)),
    feat('us', 'north-america/us', sq(100, 0, 30)),
    feat('us/ohio', 'north-america/us/ohio', sq(100, 0, 10)),
  ] };
  const GB = 1e9;
  const keysOf = (sizes: Record<string, number>, max = 3 * GB) => unitRegions(index, sizes, max).map((r: { key: string }) => r.key);

  it('the tree is by path, collective extracts are no nodes (their children become roots)', () => {
    const t = regionTree(index);
    expect(t.roots.map((n: { key: string }) => n.key)).toEqual(['europe', 'north-america_us_ohio']);
    expect(t.nodes.get('europe_germany').children.map((n: { key: string }) => n.key)).toEqual(['europe_germany_berlin', 'europe_germany_brandenburg', 'europe_germany_hessen']);
    expect(t.nodes.has('europe_dach')).toBe(false);
  });

  it('below a collective extract the nearest ancestor is the parent: a unit north-america covers the states', () => {
    const idx2 = { features: [
      feat('north-america', 'north-america', sq(100, 0, 40, 10)),
      feat('us', 'north-america/us', sq(100, 0, 30, 10)),
      feat('us/ohio', 'north-america/us/ohio', sq(100, 0, 10)),
      feat('canada', 'north-america/canada', sq(130, 0, 10)),
    ] };
    expect(regionTree(idx2).roots.map((n: { key: string }) => n.key)).toEqual(['north-america']);
    const keys = (sizes: Record<string, number>) => unitRegions(idx2, sizes, 20 * GB).map((r: { key: string }) => r.key);
    expect(keys({ 'north-america': 19 * GB })).toEqual(['north-america']);
    expect(keys({ 'north-america': 21 * GB })).toEqual(['north-america_canada', 'north-america_us_ohio']);
  });

  it('threshold: the biggest region that fits is one unit, bigger ones are split', () => {
    const sizes = { europe: 30 * GB, europe_germany: 4 * GB, europe_germany_berlin: 0.1 * GB, europe_germany_brandenburg: 0.3 * GB, europe_germany_hessen: 0.4 * GB, europe_poland: 1.5 * GB };
    expect(keysOf(sizes)).toEqual(['europe_germany_berlin', 'europe_germany_brandenburg', 'europe_germany_hessen', 'europe_poland', 'north-america_us_ohio']);
    expect(keysOf({ ...sizes, europe_germany: 2.9 * GB })).toEqual(['europe_germany', 'europe_poland', 'north-america_us_ohio']); // fits: its children are not units
    expect(keysOf({ ...sizes, europe_germany: 3 * GB })).toEqual(['europe_germany', 'europe_poland', 'north-america_us_ohio']); // exactly the limit still fits
    expect(keysOf({ ...sizes, europe: 3 * GB })).toEqual(['europe', 'north-america_us_ohio']);
    expect(UNIT_MAX_BYTES).toBe(20 * GB);
  });

  it('unknown sizes: a region with children is split (safe), a leaf is a unit', () => {
    expect(keysOf({})).toEqual(['europe_germany_berlin', 'europe_germany_brandenburg', 'europe_germany_hessen', 'europe_poland', 'north-america_us_ohio']);
  });

  it('every point of the leaves is owned by exactly one unit, whatever the split (no gaps, no doublings)', () => {
    const leaves = leafRegions(index);
    const inLeaf = (x: number, y: number) => leaves.some((l: { bbox: number[] }) => x >= l.bbox[0] && x < l.bbox[2] && y >= l.bbox[1] && y < l.bbox[3]);
    const splits = [
      {},
      { europe: 30 * GB, europe_germany: 4 * GB },
      { europe: 2 * GB },
      { europe: 30 * GB, europe_germany: 2 * GB, europe_poland: 1 * GB },
      { europe: 30 * GB, europe_germany: 4 * GB, europe_germany_brandenburg: 1 * GB, europe_germany_hessen: 1 * GB },
    ];
    for (const sizes of splits) {
      const units = unitRegions(index, sizes);
      const owners = units.map((u: { key: string }) => makeOwner(units, u.key));
      for (let x = 100.25; x < 130; x += 0.5) for (let y = 0.25; y < 20; y += 0.5) { // US: nothing but the state is a leaf, the aggregate us is no unit
        expect(owners.filter((o: (x: number, y: number) => boolean) => o(x, y)).length).toBe(inLeaf(x, y) ? 1 : 0);
      }
      for (let x = 0.25; x < 35; x += 0.5) {
        for (let y = 0.25; y < 12; y += 0.5) {
          const n = owners.filter((o: (x: number, y: number) => boolean) => o(x, y)).length;
          expect(n, `${JSON.stringify(sizes)} at ${x},${y}`).toBe(inLeaf(x, y) ? 1 : 0);
        }
      }
    }
  });

  it('a seam of units keeps Berlin out of Brandenburg even when Germany is one unit', () => {
    const units = unitRegions(index, { europe: 30 * GB, europe_germany: 2 * GB });
    expect(units.map((u: { key: string }) => u.key)).toEqual(['europe_germany', 'europe_poland', 'north-america_us_ohio']);
    const de = makeOwner(units, 'europe_germany');
    expect(de(5, 5)).toBe(true); // Berlin lies inside germany, which has no separate unit for it
    expect(de(25, 5)).toBe(false); // Poland
  });

  it('the committed size table: positive byte counts, keys of the index layout', () => {
    for (const [k, v] of Object.entries(sizesTable as Record<string, number>)) {
      expect(k).toMatch(/^[a-z0-9-]+(_[a-z0-9-]+)*$/);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('download pauses', () => {
  it('Retry-After as seconds or date', () => {
    expect(retryAfterSeconds('120')).toBe(120);
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('2026-10-21T07:26:00Z'))).toBe(120);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('soon')).toBeNull();
  });

  it('the server\'s pause is respected, else growing up to 10 minutes (plus at most 25 % jitter)', () => {
    expect(backoffMs(1, 120)).toBeGreaterThanOrEqual(120_000);
    expect(backoffMs(1, 120)).toBeLessThanOrEqual(150_000);
    expect(backoffMs(1)).toBeGreaterThanOrEqual(30_000);
    expect(backoffMs(3)).toBeGreaterThanOrEqual(120_000);
    expect(backoffMs(20)).toBeLessThanOrEqual(750_000);
  });

  it('the size probe only asks what the selection needs and keeps known sizes', async () => {
    const idx = { features: [
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { id: 'a', urls: { pbf: 'https://download.geofabrik.de/a-latest.osm.pbf' } } },
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { id: 'b', urls: { pbf: 'https://download.geofabrik.de/a/b-latest.osm.pbf' } } },
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { id: 'c', urls: { pbf: 'https://download.geofabrik.de/c-latest.osm.pbf' } } },
    ] };
    const asked: string[] = [];
    const sizes = await probeSizes(idx, { a: 9e9 }, 3e9, async (url: string) => { asked.push(url); return url.includes('/c-') ? 1e9 : 2e9; }, 0);
    expect(sizes).toEqual({ a: 9e9, a_b: 2e9, c: 1e9 });
    expect(asked).toHaveLength(2);
  });
});

describe('download without a connection', () => {
  // a fake curl first on the PATH: counts its calls and fails like curl does when the TCP connection is refused (exit 7)
  const withFakeCurl = async (script: string, fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-curl-'));
    writeFileSync(join(dir, 'curl'), `#!/bin/bash\necho x >> "${dir}/calls"\n${script}\n`);
    chmodSync(join(dir, 'curl'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      await fn(dir);
    } finally {
      process.env.PATH = path;
    }
  };
  const calls = (dir: string) => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').length;

  it('curl exit 7: gives up after 3 tries with GeofabrikUnreachable (exit code 75 in main)', async () => {
    await withFakeCurl('exit 7', async (dir) => {
      await expect(download('https://download.geofabrik.de/x.osm.pbf', join(dir, 'x.pbf'), 8, { connectPauseMs: [0] })).rejects.toBeInstanceOf(GeofabrikUnreachable);
      expect(calls(dir)).toBe(3);
    });
    expect(UNREACHABLE_EXIT).toBe(75);
  });

  it('an HTTP answer (429 with Retry-After) is not "unreachable": it retries with the pause and then succeeds', async () => {
    // 1st call: 429 + exit 22 (--fail); 2nd call: 200 and a file
    const script = `n=$(wc -l < "$(dirname "$0")/calls")
hdr=""; out=""; while [ $# -gt 0 ]; do case "$1" in -D) hdr=$2; shift;; -o) out=$2; shift;; esac; shift; done
if [ "$n" -lt 2 ]; then printf 'HTTP/2 429\r\nretry-after: 0\r\n\r\n' > "$hdr"; exit 22; fi
printf 'HTTP/2 200\r\n\r\n' > "$hdr"; echo data > "$out"`;
    await withFakeCurl(script, async (dir) => {
      await download('https://download.geofabrik.de/x.osm.pbf', join(dir, 'x.pbf'), 8, { connectPauseMs: [0] });
      expect(calls(dir)).toBe(2);
      expect(readFileSync(join(dir, 'x.pbf'), 'utf8')).toBe('data\n');
    });
  });
});
