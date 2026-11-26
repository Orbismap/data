// Deletes superseded versions of the OSM files in the bucket orbis-osm once the CDN cache time has passed, between the monthly builds
// (workflow osm-cleanup):
//   node collectors/osm-cleanup.mjs <meta.json> <delete-list> [manifest.json]
// <meta.json> = the live one. Writes the keys that are due to <delete-list> (one per line) and, if there are any, takes them out of
// meta.retired and out of manifest.json (both rewritten in place; the workflow uploads them after deleting). Nothing due: both files
// stay as they are. A file that meta.files names is never listed.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { retireVersions } from './osm-tiles.mjs';

/** only PMTiles in the top level of the bucket: meta.json, LICENSE.txt, heat/ and karte/ can never be deleted from here */
const VERSION_KEY = /^[a-z0-9_-]+\.pmtiles$/;

/** @returns the keys due for deletion and meta + manifest without them (the arguments stay unchanged) */
export function cleanup(meta, manifest = null, now = Date.now()) {
  if (!Object.keys(meta?.files ?? {}).length) throw new Error('meta.json names no current files: nothing may be deleted');
  // the current files as the "new build": nothing is retired anew, current names are never deletable
  const due = retireVersions(meta, meta.files, now).deletable;
  const foreign = due.filter((key) => !VERSION_KEY.test(key));
  if (foreign.length) throw new Error(`meta.retired names keys that are no tile versions: ${foreign.join(', ')}`);
  if (!due.length) return { due, meta, manifest };
  const next = { ...meta, retired: meta.retired.filter((r) => !due.includes(r.file)) };
  if (!manifest) return { due, meta: next, manifest };
  const entries = Object.fromEntries(Object.entries(manifest).filter(([key]) => !due.includes(key)));
  // `updated` stays: the health check reads it as the age of the last build, and a cleanup is none
  if (entries['meta.json']) entries['meta.json'] = { ...entries['meta.json'], bytes: Buffer.byteLength(JSON.stringify(next)) };
  return { due, meta: next, manifest: entries };
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

function main([metaPath, listPath, manifestPath]) {
  if (!metaPath || !listPath) throw new Error('usage: osm-cleanup <meta.json> <delete-list> [manifest.json]');
  const result = cleanup(readJson(metaPath), manifestPath ? readJson(manifestPath) : null);
  writeFileSync(listPath, result.due.map((key) => `${key}\n`).join(''));
  if (result.due.length) {
    writeFileSync(metaPath, JSON.stringify(result.meta));
    if (manifestPath) writeFileSync(manifestPath, JSON.stringify(result.manifest));
  }
  console.log(`due for deletion: ${result.due.length}, still waiting: ${(result.meta.retired?.length ?? 0)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
