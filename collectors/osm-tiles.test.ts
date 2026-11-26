import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { FIELDS, LINES, lineFeature, metres, parseNode, parseWay, parseRelation, parseEnforcement, simplify, toFeature, treeLineRecord, treeRecord, SET_ZOOM, SETS, FILES, GROUPS, THEMES, FORMAT, retireVersions, roofFeature, retryAfterSeconds, backoffMs, download, downloadFirst, MirrorUnreachable, publish, PLANET_MIRRORS, parkingRecord, parkingArea, ringCentre } from './osm-tiles.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(SETS).toEqual(['cctv', 'blitzer', 'alpr', 'webcam', 'wind', 'resource', 'fahrradparken', 'trees']);
    expect(FILES).toEqual([...SETS, 'roofs', 'netz-region', 'netz-stadt', 'netz-stadt-tram']);
    expect(THEMES['netz_stadt-tram_stations']).toMatchObject({ file: 'netz-stadt-tram', layer: 'stations' });
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
      if (s.geometry === 'netz') expect(s.variant, id).toBeTruthy();
      if (s.geometry === 'polygon') expect(typeof s.polygonFeature === 'function', id).toBeTruthy();
    }
  });

  it('roofs and trees are z15 only, the groups are the units of the two jobs', () => {
    expect(THEMES.roofs.zoom).toEqual([15, 15]);
    expect(GROUPS).toEqual({ points: ['cctv', 'blitzer', 'alpr', 'webcam', 'wind', 'resource', 'fahrradparken'], trees: ['trees'], roofs: ['roofs'], netz: ['netz-region', 'netz-stadt', 'netz-stadt-tram'] });
  });
});

describe('fahrradparken', () => {
  it('node: typed fields, junk and missing values left out', () => {
    const node = parseNode('n42 x8.681234 y50.11 Tamenity=bicycle_parking,bicycle_parking=stands,capacity=12,covered=yes,fee=maybe,capacity:cargo_bike=2');
    expect(toFeature('fahrradparken', parkingRecord(node)).properties).toEqual({ type: 'stands', capacity: 12, covered: 'yes', cargo: 1, id: 42 });
    const bare = parseNode('n7 x1 y2 Tamenity=bicycle_parking,capacity=ca.%20%10');
    expect(toFeature('fahrradparken', parkingRecord(bare)).properties).toEqual({ id: 7 });
  });

  it('area: a point in the centre and the outline at zoom 14', () => {
    const ring = [[8, 50], [8.002, 50], [8.002, 50.001], [8, 50.001], [8, 50]];
    const [point, outline] = parkingArea({ properties: { '@type': 'way', '@id': 5, amenity: 'bicycle_parking', covered: 'no' }, geometry: { type: 'Polygon', coordinates: [ring] } })!;
    expect(point).toEqual({ type: 'Feature', geometry: { type: 'Point', coordinates: [8.001, 50.0005] }, properties: { covered: 'no', osm: 'w', id: 5 } });
    expect(outline).toMatchObject({ tippecanoe: { layer: 'fahrradparken_flaechen', minzoom: 14 }, geometry: { type: 'Polygon', coordinates: [ring] }, properties: point.properties });
  });

  it('keeps only bicycle parkings (osmium also exports what a relation refers to)', () => {
    expect(parkingArea({ properties: { building: 'yes' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } })).toBeNull();
  });

  it('centre of a degenerate ring is the mean of its corners', () => {
    expect(ringCentre([[1, 1], [2, 2], [3, 3], [1, 1]])).toEqual([2, 2]);
  });
});

describe('relations', () => {
  it('parses the members of a relation line of OPL', () => {
    const line = 'r5 v1 dV c1 t2020 i1 uu Ttype=route,route=tram,ref=1 Mn1@stop,w2@,n3@platform';
    expect(parseRelation(line)).toEqual({
      id: '5', tags: { type: 'route', route: 'tram', ref: '1' },
      members: [{ type: 'n', ref: '1', role: 'stop' }, { type: 'w', ref: '2', role: '' }, { type: 'n', ref: '3', role: 'platform' }],
    });
    expect(parseEnforcement(line)).toBeNull();
    expect(parseEnforcement('r6 Ttype=enforcement Mn7@device,w8@from')).toEqual({ tags: { type: 'enforcement' }, members: [{ ref: '7', role: 'device' }] });
    expect(parseRelation('n1 x1 y2')).toBeNull();
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

  it('curl exit 7: gives up after 3 tries with MirrorUnreachable (downloadFirst then takes the next mirror)', async () => {
    await withFakeCurl('exit 7', async (dir) => {
      await expect(download('https://planet.example/x.osm.pbf', join(dir, 'x.pbf'), 8, { connectPauseMs: [0] })).rejects.toBeInstanceOf(MirrorUnreachable);
      expect(calls(dir)).toBe(3);
    });
  });

  it('an HTTP answer (429 with Retry-After) is not "unreachable": it retries with the pause and then succeeds', async () => {
    // 1st call: 429 + exit 22 (--fail); 2nd call: 200 and a file
    const script = `n=$(wc -l < "$(dirname "$0")/calls")
hdr=""; out=""; while [ $# -gt 0 ]; do case "$1" in -D) hdr=$2; shift;; -o) out=$2; shift;; esac; shift; done
if [ "$n" -lt 2 ]; then printf 'HTTP/2 429\r\nretry-after: 0\r\n\r\n' > "$hdr"; exit 22; fi
printf 'HTTP/2 200\r\n\r\n' > "$hdr"; echo data > "$out"`;
    await withFakeCurl(script, async (dir) => {
      await download('https://planet.example/x.osm.pbf', join(dir, 'x.pbf'), 8, { connectPauseMs: [0] });
      expect(calls(dir)).toBe(2);
      expect(readFileSync(join(dir, 'x.pbf'), 'utf8')).toBe('data\n');
    });
  });
});

describe('mirrors', () => {
  it('the first mirror that works is used; a partial file of a failed one is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-mirror-'));
    const file = join(dir, 'planet.pbf');
    const seen: string[] = [];
    const used = await downloadFirst(['https://a/', 'https://b/', 'https://c/'], file, async (url: string, f: string) => {
      seen.push(`${url}:${existsSync(f)}`);
      if (url === 'https://a/') {
        writeFileSync(f, 'partial');
        throw new Error('stalled');
      }
      writeFileSync(f, 'planet');
    });
    expect(used).toBe('https://b/');
    expect(seen).toEqual(['https://a/:false', 'https://b/:false']); // b did not resume the file of a
    expect(readFileSync(file, 'utf8')).toBe('planet');
  });

  it('all mirrors failing throws the last error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-mirror-'));
    await expect(downloadFirst(['https://a/', 'https://b/'], join(dir, 'p'), async (url: string) => { throw new Error(`down ${url}`); })).rejects.toThrow('down https://b/');
  });

  it('gwdg is first (fastest measured), the planet server is among the fallbacks', () => {
    expect(PLANET_MIRRORS[0]).toContain('gwdg');
    expect(PLANET_MIRRORS.some((u) => u.includes('planet.openstreetmap.org/pbf'))).toBe(true);
  });
});

describe('publish', () => {
  const t0 = Date.parse('2026-12-02T03:00:00Z');
  const write = (dir: string, name: string, part: object) => writeFileSync(join(dir, name), JSON.stringify(part));
  const parts = () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-parts-'));
    write(dir, 'nodes.json', { groups: ['points', 'trees', 'netz'], dataAt: t0 - 3600e3, files: { cctv: 'cctv-2026-12-02.pmtiles', trees: 'trees-2026-12-02.pmtiles' }, sets: { cctv: { bytes: 5, features: 2 }, trees: { bytes: 7, features: 3 } }, heatCells: { cctv: 4 } });
    write(dir, 'roofs.json', { groups: ['roofs'], dataAt: t0 - 7200e3, files: { roofs: 'roofs-2026-12-02.pmtiles' }, sets: { roofs: { bytes: 9, features: 1 } } });
    return dir;
  };

  it('joins the parts of both jobs to one meta.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'osm-dist-'));
    const meta = publish(parts(), out, { date: '2026-12-02', now: t0 });
    expect(Object.keys(meta.files).sort()).toEqual(['cctv', 'roofs', 'trees']);
    expect(meta.sets.roofs.bytes).toBe(9);
    expect(meta.heatCells).toBe(4);
    expect(meta.oldest).toBe(t0 - 7200e3);
    expect(meta.newest).toBe(t0 - 3600e3);
    expect(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')).version).toBe('2026-12-02');
    expect(existsSync(join(out, 'LICENSE.txt'))).toBe(true);
  });

  it('refuses to publish when a job delivered nothing (its files would vanish from meta.json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-parts-'));
    write(dir, 'roofs.json', { groups: ['roofs'], files: { roofs: 'roofs-2026-12-02.pmtiles' }, sets: {} });
    expect(() => publish(dir, mkdtempSync(join(tmpdir(), 'osm-dist-')), { now: t0 })).toThrow(/points/);
  });

  it('the superseded versions are retired, deleted after the cache time', () => {
    const prev = join(mkdtempSync(join(tmpdir(), 'osm-prev-')), 'meta.json');
    writeFileSync(prev, JSON.stringify({ files: { cctv: 'cctv-2026-11-02.pmtiles' }, retired: [{ file: 'old.pmtiles', at: t0 - 48 * 3600e3 }] }));
    const out = mkdtempSync(join(tmpdir(), 'osm-dist-'));
    const list = join(out, 'delete.txt');
    const meta = publish(parts(), out, { prev, deleteList: list, now: t0 });
    expect(meta.retired.map((r: { file: string }) => r.file)).toEqual(['cctv-2026-11-02.pmtiles']);
    expect(readFileSync(list, 'utf8')).toBe('old.pmtiles\n');
  });

  it('updates the bucket manifest: new files in (with source and licence), deleted ones out, the rest stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-man-'));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ 'other.json': { updated: 'x', bytes: 1, source: 's', license: 'l' }, 'old.pmtiles': { updated: 'x', bytes: 2, source: '', license: '' } }));
    const prev = join(dir, 'prev.json');
    writeFileSync(prev, JSON.stringify({ files: {}, retired: [{ file: 'old.pmtiles', at: t0 - 48 * 3600e3 }] }));
    publish(parts(), join(dir, 'dist'), { prev, manifest, now: t0 });
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(Object.keys(m)).toEqual(expect.arrayContaining(['cctv-2026-12-02.pmtiles', 'roofs-2026-12-02.pmtiles', 'meta.json', 'LICENSE.txt', 'other.json']));
    expect(m['roofs-2026-12-02.pmtiles']).toMatchObject({ bytes: 9, license: expect.stringContaining('ODbL') });
    expect(m['old.pmtiles']).toBeUndefined();
  });
});
