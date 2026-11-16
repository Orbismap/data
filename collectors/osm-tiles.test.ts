import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { metres, parseNode, toFeature, treeRecord, SET_ZOOM } from './osm-tiles.mjs';

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
    expect(f.properties).toEqual({ species: 'Quercus robur', height: 18, leaf_type: 'broadleaved', id: 42 });
  });

  it('a bare tree only has its id', () => {
    const f = toFeature('trees', treeRecord(parseNode('n7 x1 y2 Tnatural=tree')));
    expect(f.properties).toEqual({ id: 7 });
  });

  it('is built for zoom 15', () => {
    expect(SET_ZOOM.trees).toEqual([15, 15]);
  });
});
