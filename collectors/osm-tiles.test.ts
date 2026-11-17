import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { FIELDS, LINES, lineFeature, metres, parseNode, parseWay, simplify, toFeature, treeLineRecord, treeRecord, SET_ZOOM } from './osm-tiles.mjs';

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
