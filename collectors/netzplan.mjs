// Network plans: rail route relations of OpenStreetMap (+ their stop nodes, no track geometry) -> a drawn plan as GeoJSON features:
// stations with names, and the lines as parallel coloured strands running straight from station to station. Pure functions, called by
// collectors/osm-tiles.mjs (geometry 'netz') once per variant with the whole world; the app (layer `netzplaene`) only styles the tiles.

/** `order`: position inside a bundle and priority of labels; `color`: for lines without a colour in OSM (the app's legend shows the same) */
export const NET_MODES = {
  regional: { color: '#d9232e', order: 0 },
  sbahn: { color: '#008d4f', order: 1 },
  ubahn: { color: '#1561a9', order: 2 },
  stadtbahn: { color: '#e2571e', order: 3 },
  tram: { color: '#be1414', order: 4 },
};

/** the plans that are built, one world file each (netz-<variant>.pmtiles), with the modes drawn in it */
export const NET_VARIANTS = {
  region: ['regional', 'sbahn'],
  stadt: ['sbahn', 'ubahn', 'stadtbahn'],
  'stadt-tram': ['sbahn', 'ubahn', 'stadtbahn', 'tram'],
};
/** the layers of every file */
export const NET_LAYERS = ['lines', 'labels', 'stations'];

/** zoom from which a feature is in the tiles: line numbers and stations come in with the city zooms */
const MIN_ZOOM = { lines: 6, labels: 9, stations: 8 };
/** lines ending at a station that are named under it (properties end0.., color0..) */
export const MAX_END_BADGES = 4;
/** Text colour of labels that stand for lines of several colours. */
const INK = '#262b33';

/** Train services that belong on no local plan. */
const NOT_LOCAL = ['long_distance', 'high_speed', 'night', 'car', 'car_shuttle', 'international', 'national', 'tourism'];
const LONG_DISTANCE = /^(ICE?|ECE?|EN|NJ|FLX|TGV|RJX?|THA|EST|WB)(\s?\d|$)/;
const S_BAHN = /^S\s?\d/;
const REGIONAL_REF = /^(RE|RB|R|TER|IRE)\s?\d/;

/** the mode a route relation is drawn as, or undefined (not on a plan) */
export function modeOf(t) {
  const ref = (t.ref ?? '').trim();
  if (!ref || t.state === 'proposed' || t.state === 'construction') return undefined;
  if (t.route === 'subway') return 'ubahn';
  if (t.route === 'tram') return 'tram';
  if (S_BAHN.test(ref) && (t.route === 'train' || t.route === 'light_rail')) return 'sbahn';
  if (t.route === 'light_rail' || t.route === 'monorail') return 'stadtbahn';
  if (t.route === 'train') {
    if (LONG_DISTANCE.test(ref) || NOT_LOCAL.includes(t.service ?? '')) return undefined;
    // suburban railways that are not called "S": the RER of Paris, commuter rail in North America, Japan's city lines ...
    return (t.service === 'commuter' || t.passenger === 'suburban') && !REGIONAL_REF.test(ref) ? 'sbahn' : 'regional';
  }
  return undefined;
}

/** the node members of a route relation where it calls: the stop positions, else (fewer than two) the platform nodes */
export function stopMembers(relation) {
  const nodes = relation.members.filter((m) => m.type === 'n');
  const stops = nodes.filter((m) => m.role.startsWith('stop'));
  return stops.length >= 2 ? stops : nodes.filter((m) => m.role.startsWith('platform'));
}

const validColor = (c) => (c && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? (c.startsWith('#') ? c : `#${c}`).toLowerCase() : undefined);

/** A line colour (#rgb or #rrggbb) as text on the white halo: light ones (yellow, light green) are darkened until they read. */
export function inkColor(color) {
  let h = color.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (light <= 0.55) return color;
  return `#${[r, g, b].map((v) => Math.round((v * 0.55) / light).toString(16).padStart(2, '0')).join('')}`;
}

/** The station name as a plan prints it: without the "S+U" prefixes, city suffixes and platform numbers of the stop nodes. */
export const stationName = (raw) =>
  raw.replace(/^(S\s?\+\s?U|S|U)[\s-]+(?=\p{Lu})/u, '').replace(/\s*\((Berlin|Gleis[^)]*|Bahnsteig[^)]*)\)/gi, '').replace(/\s+(Gleis|Bahnsteig|Steig)\s*\w+$/i, '').trim();

const matchKey = (name) => name.toLowerCase().replace(/\bhbf\b/g, 'hauptbahnhof').replace(/straße\b|strasse\b/g, 'str.').replace(/[\s\-–,/]+/g, ' ').trim();
const containsWords = (a, b) => ` ${a} `.includes(` ${b} `);

/** Stops of one name this close (m) are one station. */
const SAME_NAME_M = 600;
/** Names that say nothing outside their town: the longer name of the station is kept. */
const GENERIC_NAME = /^(hauptbahnhof|bahnhof|central|centre|station)$/;
/** One name contains the other ("Berlin Hauptbahnhof" / "Hauptbahnhof") this close (m): one station too. */
const PART_NAME_M = 250;
/** An express line follows the stations of slower lines if that way is at most this much longer than the straight line. */
const DETOUR = 1.15;

const RAD = Math.PI / 180;
/** metres between two points {lat, lon} (haversine) */
function metres(a, b) {
  const h = Math.sin(((b.lat - a.lat) * RAD) / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(((b.lon - a.lon) * RAD) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const getOr = (map, key, make) => {
  let v = map.get(key);
  if (v === undefined) map.set(key, (v = make()));
  return v;
};

/** Joins directed segments (station pairs) that follow each other into polylines, so that offsets bend without gaps. */
function chains(segments) {
  const from = new Map();
  const incoming = new Set();
  segments.forEach(([a, b], i) => {
    getOr(from, a, () => []).push(i);
    incoming.add(b);
  });
  const used = new Set();
  const out = [];
  const walk = (start) => {
    const path = [segments[start][0], segments[start][1]];
    used.add(start);
    for (;;) {
      const next = from.get(path[path.length - 1])?.find((i) => !used.has(i) && segments[i][1] !== path[path.length - 2]);
      if (next === undefined) break;
      used.add(next);
      path.push(segments[next][1]);
    }
    out.push(path);
  };
  // chain heads first, then what is left (rings)
  segments.forEach(([a], i) => { if (!used.has(i) && !incoming.has(a)) walk(i); });
  segments.forEach((_, i) => { if (!used.has(i)) walk(i); });
  return out;
}

/**
 * One plan of the whole input. `relations`: route relations [{ id, tags, members: [{ type: 'n'|'w'|'r', ref, role }] }],
 * `nodes`: Map ref -> { x, y, tags } of their stop nodes, `modes`: which modes are drawn.
 * Returns { lines, labels, stations } (GeoJSON features with `tippecanoe.minzoom`) and `count`, the number of lines.
 */
export function netzplan(relations, nodes, modes) {
  // ---- stations: stop nodes grouped by name and distance ----
  const stations = [];
  const stationOfNode = new Map();
  const cells = new Map(); // 0.01° grid
  const near = (lat, lon) => {
    const out = [];
    const y = Math.round(lat * 100), x = Math.round(lon * 100);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) out.push(...(cells.get(`${y + dy}:${x + dx}`) ?? []));
    return out;
  };
  const stationFor = (ref) => {
    const known = stationOfNode.get(ref);
    if (known !== undefined) return known;
    const node = nodes.get(ref);
    const name = stationName(node?.tags.name ?? '');
    if (!node || !name) return undefined;
    const key = matchKey(name);
    const at = { lat: node.y, lon: node.x };
    let found;
    for (const i of near(at.lat, at.lon)) {
      const s = stations[i];
      const d = metres(at, s);
      if ((s.key === key && d <= SAME_NAME_M) || (d <= PART_NAME_M && (containsWords(s.key, key) || containsWords(key, s.key)))) { found = s; break; }
    }
    if (found) {
      found.count++;
      found.lat += (at.lat - found.lat) / found.count;
      found.lon += (at.lon - found.lon) / found.count;
      if (GENERIC_NAME.test(found.key) ? !GENERIC_NAME.test(key) : name.length < found.name.length && !GENERIC_NAME.test(key)) { found.name = name; found.key = key; }
    } else {
      found = { index: stations.length, name, key, lat: at.lat, lon: at.lon, count: 1, node: Number(ref) };
      stations.push(found);
      getOr(cells, `${Math.round(at.lat * 100)}:${Math.round(at.lon * 100)}`, () => []).push(found.index);
    }
    stationOfNode.set(ref, found.index);
    return found.index;
  };

  // ---- lines: all directions and branches of one ref that share a station are one line (the S1 of the next city is another) ----
  const all = new Set();
  const lineAt = new Map(); // "mode|ref|station" -> line
  for (const rel of relations) {
    const t = rel.tags;
    const mode = modeOf(t);
    if (!mode || !modes.includes(mode)) continue;
    // a stop outside the data leaves no gap: its neighbours are joined
    const seq = [];
    for (const m of stopMembers(rel)) {
      const s = stationFor(m.ref);
      if (s !== undefined && seq[seq.length - 1] !== s) seq.push(s);
    }
    if (seq.length < 2) continue;
    const ref = t.ref.trim();
    const key = `${mode}|${ref}|`;
    // a variant may join parts that had no station in common so far
    const [line = { ref, mode, color: undefined, variants: [], stations: new Set() }, ...others] = new Set(seq.map((s) => lineAt.get(key + s)).filter(Boolean));
    all.add(line);
    line.color ??= validColor(t.colour);
    line.variants.push(seq);
    for (const other of others) {
      line.color ??= other.color;
      line.variants.push(...other.variants);
      for (const s of other.stations) { line.stations.add(s); lineAt.set(key + s, line); }
      all.delete(other);
    }
    for (const s of seq) { line.stations.add(s); lineAt.set(key + s, line); }
  }
  const lines = [...all].sort((x, y) => NET_MODES[x.mode].order - NET_MODES[y.mode].order || x.ref.localeCompare(y.ref, 'de', { numeric: true }));
  lines.forEach((l, i) => {
    l.order = i;
    l.color ??= NET_MODES[l.mode].color;
    l.variants.sort((x, y) => y.length - x.length);
  });

  // ---- edges: shared by all lines running between two stations ----
  const distance = (a, b) => metres(stations[a], stations[b]);
  /** lines that may share track: S-Bahn and regional trains, light rail and tram, the underground by itself */
  const family = (m) => (m === 'regional' || m === 'sbahn' ? 'rail' : m === 'ubahn' ? 'ubahn' : 'light');
  const edges = new Map();
  const graphs = new Map(); // family -> station -> neighbour -> metres
  const wanted = [];
  for (const line of lines) for (const seq of line.variants) for (let i = 1; i < seq.length; i++) wanted.push({ line, a: seq[i - 1], b: seq[i], length: distance(seq[i - 1], seq[i]) });
  wanted.sort((x, y) => x.length - y.length);

  /** shortest way a -> b over the kept (shorter) edges, no longer than `max` */
  const detour = (g, a, b, max) => {
    const best = new Map([[a, 0]]);
    const prev = new Map();
    const open = new Set([a]);
    while (open.size) {
      let at = -1;
      for (const s of open) if (at < 0 || best.get(s) < best.get(at)) at = s;
      open.delete(at);
      if (at === b) {
        const path = [b];
        while (path[0] !== a) path.unshift(prev.get(path[0]));
        return path;
      }
      for (const [next, d] of g.get(at) ?? []) {
        if (at === a && next === b) continue;
        const total = best.get(at) + d;
        // the remaining straight distance bounds the search to the corridor
        if (total + distance(next, b) > max || total >= (best.get(next) ?? Infinity)) continue;
        best.set(next, total);
        prev.set(next, at);
        open.add(next);
      }
    }
    return undefined;
  };

  /** per family and station pair: the stations passed between the two */
  const routes = new Map();
  const routeId = (line, a, b) => `${family(line.mode)}|${pairKey(a, b)}`;
  for (const w of wanted) {
    const fam = family(w.line.mode);
    const id = routeId(w.line, w.a, w.b);
    if (routes.has(id)) continue;
    const g = getOr(graphs, fam, () => new Map());
    const path = (fam === 'ubahn' ? undefined : detour(g, w.a, w.b, w.length * DETOUR)) ?? [w.a, w.b];
    if (path.length === 2) {
      getOr(g, w.a, () => new Map()).set(w.b, w.length);
      getOr(g, w.b, () => new Map()).set(w.a, w.length);
    }
    routes.set(id, path);
  }

  // Lines are walked in bundle order: the first one along an edge gives it its direction, so that neighbouring edges
  // offset their strands to the same side.
  for (const line of lines) {
    for (const seq of line.variants) {
      for (let i = 1; i < seq.length; i++) {
        const stored = routes.get(routeId(line, seq[i - 1], seq[i]));
        const path = stored[0] === seq[i - 1] ? stored : [...stored].reverse();
        for (let j = 1; j < path.length; j++) {
          const a = path[j - 1], b = path[j];
          getOr(edges, pairKey(a, b), () => ({ a, b, lines: new Set() })).lines.add(line);
        }
      }
    }
  }

  // ---- strands: one per colour and edge; lines of one colour share it ----
  const width = new Array(stations.length).fill(0);
  const strandGroups = new Map();
  const labelGroups = new Map();
  const refsOf = (list) => [...new Set(list.map((l) => l.ref))].join(' · ');
  const keyOf = (list) => list.map((l) => l.order).join(',');
  for (const e of edges.values()) {
    const here = [...e.lines].sort((x, y) => x.order - y.order);
    const byColor = new Map();
    for (const l of here) getOr(byColor, l.color, () => []).push(l);
    const n = byColor.size;
    let i = 0;
    for (const group of byColor.values()) {
      const off = i++ - (n - 1) / 2;
      getOr(strandGroups, `${keyOf(group)}|${off}`, () => ({ props: { color: group[0].color, refs: refsOf(group), mode: group[0].mode, off }, segments: [] })).segments.push([e.a, e.b]);
    }
    getOr(labelGroups, keyOf(here), () => ({ props: { refs: refsOf(here), color: n === 1 ? inkColor(here[0].color) : INK, n }, segments: [] })).segments.push([e.a, e.b]);
    for (const s of [e.a, e.b]) width[s] = Math.max(width[s], n);
  }

  const position = (i) => [+stations[i].lon.toFixed(5), +stations[i].lat.toFixed(5)];
  const feature = (layer, properties, geometry) => ({ type: 'Feature', tippecanoe: { minzoom: MIN_ZOOM[layer] }, properties, geometry });
  const strands = [...strandGroups.values()].map((g, i) =>
    feature('lines', { id: i + 1, ...g.props }, { type: 'MultiLineString', coordinates: chains(g.segments).map((c) => c.map(position)) }));
  const labels = [];
  for (const g of labelGroups.values()) {
    for (const c of chains(g.segments)) labels.push(feature('labels', { id: labels.length + 1, ...g.props }, { type: 'LineString', coordinates: c.map(position) }));
  }

  // ---- stations ----
  const linesAt = stations.map(() => []);
  const endsAt = stations.map(() => []);
  for (const line of lines) {
    for (const s of line.stations) linesAt[s].push(line);
    // a short working that ends in the middle of the line is no terminus: only stations with one neighbour count
    const neighbours = new Map();
    for (const seq of line.variants) {
      for (let i = 0; i < seq.length; i++) {
        const set = getOr(neighbours, seq[i], () => new Set());
        if (i > 0) set.add(seq[i - 1]);
        if (i < seq.length - 1) set.add(seq[i + 1]);
      }
    }
    for (const [s, set] of neighbours) if (set.size === 1) endsAt[s].push(line);
  }
  const points = [];
  for (const s of stations) {
    const here = linesAt[s.index];
    if (!here.length) continue;
    const terminating = endsAt[s.index];
    /** 2: interchange, 1: end of a line, 0: other */
    const rank = here.length > 1 && (new Set(here.map((l) => l.color)).size > 1 || new Set(here.map((l) => l.mode)).size > 1) ? 2 : terminating.length ? 1 : 0;
    // refs: every line calling here; n: widest bundle at the station (strands side by side)
    const props = { id: s.node, name: s.name, refs: refsOf(here), n: Math.max(1, width[s.index]), rank };
    terminating.slice(0, MAX_END_BADGES).forEach((l, i) => { props[`end${i}`] = l.ref; props[`color${i}`] = inkColor(l.color); });
    points.push(feature('stations', props, { type: 'Point', coordinates: position(s.index) }));
  }

  return { lines: strands, labels, stations: points, count: lines.length };
}
