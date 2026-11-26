import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { NET_VARIANTS, inkColor, modeOf, netzplan, stationName, stopMembers } from './netzplan.mjs';

const node = (id: number, name: string, x: number, y = 52.5) => [String(id), { x, y, tags: { name } }] as const;
const route = (id: number, tags: Record<string, string>, stops: number[], role = 'stop') =>
  ({ id: String(id), tags: { type: 'route', ...tags }, members: stops.map((ref) => ({ type: 'n', ref: String(ref), role })) });

// A - B - C on one straight track; node 4 is the second platform node of B
const base = [node(1, 'S Anfang', 13.3), node(2, 'S+U Mitte', 13.32), node(3, 'Ende (Berlin)', 13.34), node(4, 'Mitte', 13.3205)];
const s1 = route(10, { route: 'light_rail', ref: 'S1', colour: '#DA6BA2' }, [1, 2, 3]);
const s1back = route(11, { route: 'light_rail', ref: 'S1', colour: '#DA6BA2' }, [3, 4, 1]);
const re = route(12, { route: 'train', ref: 'RE1' }, [3, 1]);
const ice = route(13, { route: 'train', ref: 'ICE 5' }, [1, 3]);
const ALL = ['regional', 'sbahn', 'ubahn', 'stadtbahn', 'tram'];
type F = { properties: Record<string, any>; geometry: { coordinates: any }; tippecanoe: { minzoom: number } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const plan = (relations: unknown[], nodes: (readonly [string, unknown])[] = base, modes = ALL) => netzplan(relations, new Map(nodes), modes) as { lines: F[]; labels: F[]; stations: F[]; count: number };

describe('netzplan', () => {
  const r = plan([s1, s1back, re, ice]);
  const station = (name: string) => r.stations.find((f) => f.properties.name === name)!.properties;

  it('groups stop nodes into stations with plain names', () => {
    expect(r.stations.map((f) => f.properties.name).sort()).toEqual(['Anfang', 'Ende', 'Mitte']);
  });

  it('counts both directions as one line and drops long distance trains', () => {
    expect(r.count).toBe(2);
    expect(station('Anfang').refs).toBe('RE1 · S1');
  });

  it('leads an express line past the stations of the slower line, side by side', () => {
    expect(r.lines.map((f) => [f.properties.refs, f.properties.off, f.geometry.coordinates.map((c: unknown[]) => c.length)])).toEqual([
      ['RE1', -0.5, [3]],
      ['S1', 0.5, [3]],
    ]);
    // both run the same way, otherwise the offsets would put them on top of each other
    const [a, b] = r.lines.map((f) => f.geometry.coordinates[0]);
    expect(a).toEqual(b);
    expect(r.labels.map((f) => f.properties.refs)).toEqual(['RE1 · S1']);
  });

  it('ranks interchanges and marks the ends of lines', () => {
    expect(station('Anfang')).toMatchObject({ rank: 2, end0: 'RE1', end1: 'S1', color1: inkColor('#da6ba2'), n: 2, id: 1 });
    expect(station('Mitte').end0).toBeUndefined();
  });

  it('numbers lines and labels and says from which zoom each layer is in the tiles', () => {
    expect(r.lines.map((f) => f.properties.id)).toEqual([1, 2]);
    expect([r.lines[0]!, r.labels[0]!, r.stations[0]!].map((f) => f.tippecanoe.minzoom)).toEqual([6, 9, 8]);
  });

  it('keeps equal refs of different networks apart, also in the geometry', () => {
    const other = [node(5, 'Nord', 13.7), node(6, 'Süd', 13.72)];
    const two = plan([s1, s1back, route(14, { route: 'light_rail', ref: 'S1', colour: '#da6ba2' }, [5, 6])], [...base, ...other]);
    expect(two.count).toBe(2);
    expect(two.lines).toHaveLength(2);
    expect(two.labels).toHaveLength(2);
  });

  it('joins two parts of a line when a later relation connects them', () => {
    const nodes = [...base, node(5, 'Weit', 13.4), node(6, 'Weiter', 13.42)];
    const parts = [route(20, { route: 'tram', ref: '1' }, [1, 2]), route(21, { route: 'tram', ref: '1' }, [5, 6]), route(22, { route: 'tram', ref: '1', colour: '112233' }, [2, 5])];
    const r = plan(parts, nodes);
    expect(r.count).toBe(1);
    expect(r.lines.map((f) => f.properties.color)).toEqual(['#112233']);
    expect(r.stations.filter((f) => f.properties.end0).map((f) => f.properties.name).sort()).toEqual(['Anfang', 'Weiter']);
  });

  it('draws only the modes of the variant', () => {
    const tram = route(23, { route: 'tram', ref: '5' }, [1, 3]);
    expect(plan([s1, re, tram], base, NET_VARIANTS.region).stations[0]!.properties.refs).toBe('RE1 · S1');
    expect(plan([s1, re, tram], base, NET_VARIANTS.stadt).stations[0]!.properties.refs).toBe('S1');
    expect(plan([s1, re, tram], base, NET_VARIANTS['stadt-tram']).stations[0]!.properties.refs).toBe('S1 · 5');
  });

  it('uses the platform nodes of routes without stop positions', () => {
    expect(plan([route(24, { route: 'tram', ref: '2' }, [1, 3], 'platform')]).count).toBe(1);
  });

  it('keeps the town in the name of a main station', () => {
    const two = [node(7, 'Kassel Hauptbahnhof', 9.49, 51.318), node(8, 'Hauptbahnhof', 9.4905, 51.318)];
    const r = plan([route(17, { route: 'tram', ref: '1' }, [1, 7]), route(18, { route: 'tram', ref: '2' }, [8, 3])], [...base, ...two]);
    expect(r.stations.map((f) => f.properties.name)).toContain('Kassel Hauptbahnhof');
    expect(r.stations.map((f) => f.properties.name)).not.toContain('Hauptbahnhof');
  });

  it('copes with an empty input', () => {
    expect(plan([]).count).toBe(0);
  });
});

describe('netzplan helpers', () => {
  it('knows suburban railways by their tags and drops tourist, long distance and planned lines', () => {
    expect(modeOf({ route: 'train', ref: 'A', service: 'commuter' })).toBe('sbahn');
    expect(modeOf({ route: 'train', ref: 'RB 40', service: 'commuter' })).toBe('regional');
    expect(modeOf({ route: 'train', ref: 'RE9', service: 'tourism' })).toBeUndefined();
    expect(modeOf({ route: 'train', ref: 'IC 2' })).toBeUndefined();
    expect(modeOf({ route: 'subway', ref: 'U9', state: 'proposed' })).toBeUndefined();
    expect(modeOf({ route: 'tram' })).toBeUndefined();
    expect(modeOf({ route: 'bus', ref: '100' })).toBeUndefined();
  });

  it('takes the stop positions, else the platforms, of the node members', () => {
    const members = [{ type: 'n', ref: '1', role: 'platform' }, { type: 'n', ref: '2', role: 'stop_entry_only' }, { type: 'n', ref: '3', role: 'stop' }, { type: 'w', ref: '4', role: 'stop' }];
    expect(stopMembers({ members }).map((m: { ref: string }) => m.ref)).toEqual(['2', '3']);
  });

  it('cleans station names', () => {
    expect(stationName('S+U Alexanderplatz (Berlin)')).toBe('Alexanderplatz');
    expect(stationName('Uhlandstraße')).toBe('Uhlandstraße');
    expect(stationName('Potsdam Hauptbahnhof Gleis 3')).toBe('Potsdam Hauptbahnhof');
  });

  it('darkens light line colours for text', () => {
    expect(inkColor('#1561a9')).toBe('#1561a9');
    expect(inkColor('#f0d722')).not.toBe('#f0d722');
    expect(inkColor('#ff0')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
