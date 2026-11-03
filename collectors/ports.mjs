// Seaports for the "Häfen" layer (src/api/ports.ts): NGA World Port Index + Upply seaports (UN/LOCODE).
// Logic ported from scripts/ports.mjs of malte9799/orbis (that script wrote public/data/ports.json); the output format is unchanged:
// { v: 1, ports: [[lon, lat, name, UN/LOCODE, country, tier, type, channel, pier, length, draft, pilotage, shelter, facilities], …] }
//   - NGA World Port Index (Pub. 150): work of the US Government, no copyright claimed (17 U.S.C. 105).
//   - Upply "Seaports Locations Data" (data.gouv.fr), CC BY 4.0.

/** Minimal CSV parser (quoted fields, doubled quotes, any delimiter). */
function parseCsv(text, delim = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
};
const yes = (s) => s.toLowerCase() === 'yes';
const TIER = { Large: 1, Medium: 2, Small: 3 };
const FAC = [
  ['Facilities - Container', 'C'],
  ['Facilities - Ro-Ro', 'R'],
  ['Facilities - Solid Bulk', 'S'],
  ['Facilities - Liquid Bulk', 'L'],
  ['Facilities - Breakbulk', 'B'],
  ['Facilities - Oil Terminal', 'O'],
  ['Facilities - LNG Terminal', 'G'],
];
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const round = (n) => Math.round(n * 1e4) / 1e4;

/** wpiText / upplyText: the two CSV files as text; returns { doc (for ports.json), fromWpi }. */
export function buildPorts(wpiText, upplyText) {
const wpi = parseCsv(wpiText);
const upply = parseCsv(upplyText, ';');

// [lon, lat, name, UN/LOCODE, country, tier, type, channel depth m, pier depth m, max length m, max draft m, pilotage (1 compulsory, 0 not, -1 unknown), shelter, facilities]
const ports = [];
const codes = new Set();
const seen = new Map(); // grid cell → names, to drop duplicates without a code
const cell = (lon, lat) => `${Math.round(lon * 5)},${Math.round(lat * 5)}`;
const addSeen = (lon, lat, name) => {
  const k = cell(lon, lat);
  (seen.get(k) ?? seen.set(k, new Set()).get(k)).add(name.toLowerCase());
};

for (const r of wpi) {
  const lat = parseFloat(r.Latitude);
  const lon = parseFloat(r.Longitude);
  const name = clean(r['Main Port Name']);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) continue;
  const code = r['UN/LOCODE'].replace(/\s+/g, '');
  if (code) codes.add(code);
  addSeen(lon, lat, name);
  const alt = clean(r['Alternate Port Name']);
  if (alt) addSeen(lon, lat, alt);
  ports.push([
    round(lon),
    round(lat),
    name,
    code,
    clean(r['Country Code']),
    TIER[r['Harbor Size']] ?? 4,
    clean(r['Harbor Type']),
    num(r['Channel Depth (m)']),
    num(r['Cargo Pier Depth (m)']),
    num(r['Maximum Vessel Length (m)']),
    num(r['Maximum Vessel Draft (m)']),
    yes(r['Pilotage - Compulsory']) ? 1 : r['Pilotage - Compulsory'] ? 0 : -1,
    clean(r['Shelter Afforded']),
    FAC.filter(([k]) => yes(r[k] ?? '')).map(([, l]) => l).join(''),
  ]);
}
const fromWpi = ports.length;

for (const r of upply) {
  const lat = parseFloat(r.latitude);
  const lon = parseFloat(r.longitude);
  const name = clean(r.name);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name || codes.has(r.code)) continue;
  // the same port without a code in the World Port Index
  const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.get(`${Math.round(lon * 5) + dx},${Math.round(lat * 5) + dy}`)?.has(name.toLowerCase()));
  if (near) continue;
  ports.push([round(lon), round(lat), name, r.code, r.country_code, 5]);
}

return { doc: { v: 1, ports }, fromWpi };
}
