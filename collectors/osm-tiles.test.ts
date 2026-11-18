import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { FIELDS, LINES, lineFeature, metres, parseNode, parseWay, simplify, toFeature, treeLineRecord, treeRecord, SET_ZOOM, SETS, FILES, GROUPS, THEMES, FORMAT, assetName, stateAsset, planRegions, retireVersions, roofFeature, leafRegions, regionKey, makeOwner } from './osm-tiles.mjs';

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
    expect(planRegions([], keys, 'all', now)).toHaveLength(60);
    expect(planRegions([], Array.from({ length: 400 }, (_, i) => `k${i}`), 'all', now)).toHaveLength(250);
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
