// Bundles collectors/fetch-data.ts (+ the app modules it imports) into dist/fetch-data.mjs.
//
// fetch-data.ts imports the same loaders the Orbis app uses (src/api/camfeeds.ts, earth.ts, cams.ts, events.ts) as
// `@orbis/api/<name>`. esbuild resolves `@orbis` to <ORBIS_SRC>/src, where ORBIS_SRC is the root of a checkout
// of malte9799/orbis:
//   - CI: the workflows check it out into ./orbis (default of ORBIS_SRC)
//   - local: `git clone https://github.com/malte9799/orbis ../orbis`, then `ORBIS_SRC=../orbis pnpm collect ...`
// The checkout needs no node_modules: bare imports of those modules are looked up in this repo's node_modules.
// The path is also baked into the bundle (__ORBIS_SRC__), the street-panos task reads public/data/games/countries.json from it.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const orbis = resolve(process.env.ORBIS_SRC ?? resolve(root, 'orbis'));
if (!existsSync(resolve(orbis, 'src/api/camfeeds.ts'))) {
  console.error(`No orbis checkout at ${orbis} (set ORBIS_SRC, see README)`);
  process.exit(1);
}

await build({
  entryPoints: [resolve(root, 'collectors/fetch-data.ts')],
  outfile: resolve(root, 'dist/fetch-data.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@orbis': resolve(orbis, 'src') },
  nodePaths: [resolve(root, 'node_modules')],
  define: { __ORBIS_SRC__: JSON.stringify(orbis) },
  // CJS packages (pbf, …) call require() – give the ESM bundle one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log(`bundled dist/fetch-data.mjs (orbis: ${orbis})`);
