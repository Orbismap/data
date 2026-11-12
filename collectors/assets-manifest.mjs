// manifest.json for the orbis-assets bucket. The bucket's files are uploaded by hand / by the Orbis build (no collector
// writes them), so the manifest is built from a listing of the bucket instead of a local output directory:
//   aws s3api list-objects-v2 --bucket orbis-assets --endpoint-url ... --output json > listing.json
//   node collectors/assets-manifest.mjs listing.json manifest.json
// Entry per file { updated, bytes, source, license } (same shape as collectors/manifest.mjs); directories with many
// files (data/airports/ has 443) collapse to one entry `<dir>/` (bytes summed, `files`, newest `updated`).
// Keys without a rule keep an empty source/license so the gap stays visible. manifest.json itself is skipped.

import { readFileSync, writeFileSync } from 'node:fs';

const ODBL = 'ODbL 1.0, © OpenStreetMap contributors';
const PD = 'public domain (NASA/ESA/JAXA media usage guidelines)';

/** [key regex, source, license] – first match wins. See docs/DATENQUELLEN.md of the orbis repo (sections 12, 13). */
export const ASSET_RULES = [
  [/^data\/airports\//, 'OpenStreetMap (Overpass API), pre-built airport plans (443 airports, Orbis build)', ODBL],
  [/^models\//, '3D models of spacecraft and small bodies (NASA 3D Resources, ESA, JAXA); see public/licenses in the orbis repo', PD + '; per model see docs/DATENQUELLEN.md section 13'],
  [/^textures\//, 'Solar System Scope, NASA/USGS planetary maps (docs/DATENQUELLEN.md section 12)', 'CC BY 4.0 (Solar System Scope) / public domain (NASA)'],
  [/^draco\//, 'Google Draco decoder (https://github.com/google/draco)', 'Apache 2.0'],
  [/^data\/(ne110m_|ne50m_|ne10m_)/, 'Natural Earth (https://www.naturalearthdata.com)', 'public domain'],
  [/^data\//, 'Orbis build (public/data of the orbis repo, sources in docs/DATENQUELLEN.md)', 'per dataset, see docs/DATENQUELLEN.md'],
  [/^index\.json$/, 'Orbismap/data', 'n/a'],
];

export function buildAssetsManifest(listing, now = new Date().toISOString()) {
  const groups = new Map();
  const manifest = {};
  for (const o of listing.Contents ?? []) {
    if (o.Key === 'manifest.json' || o.Key.endsWith('/')) continue;
    const [, source = '', license = ''] = ASSET_RULES.find(([re]) => re.test(o.Key)) ?? [];
    const entry = { updated: new Date(o.LastModified ?? now).toISOString(), bytes: o.Size, source, license };
    const parts = o.Key.split('/');
    if (parts.length >= 3) {
      const dir = parts.slice(0, 2).join('/') + '/';
      const g = groups.get(dir) ?? { ...entry, bytes: 0, files: 0 };
      g.bytes += o.Size;
      g.files++;
      if (entry.updated > g.updated) g.updated = entry.updated;
      groups.set(dir, g);
    } else manifest[o.Key] = entry;
  }
  for (const [k, g] of groups) manifest[k] = g;
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1]?.endsWith('assets-manifest.mjs')) {
  const [listingPath, outPath] = process.argv.slice(2);
  if (!listingPath || !outPath) throw new Error('usage: assets-manifest <listing.json> <out.json>');
  const m = buildAssetsManifest(JSON.parse(readFileSync(listingPath, 'utf8')));
  writeFileSync(outPath, JSON.stringify(m));
  console.log(`assets manifest: ${Object.keys(m).length} entries`);
}
