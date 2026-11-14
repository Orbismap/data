// Merges the files of an output directory into a bucket's manifest.json:
//   node collectors/manifest.mjs <dir> <existing-manifest.json|-> <out.json> [--collapse]
// Entry per key: { updated, bytes, source, license } (same shape as the clock worker writes). `updated` is the
// file's mtime (files that were only downloaded to the directory keep the mtime of their upload).
// Existing entries stay (a group run only knows its own keys); entries for keys in <dir> are replaced.
// Keys without a rule below get an empty source/license, so the gap is visible. manifest.json itself is skipped.
// --collapse: one entry per top-level directory (osm-tiles has thousands of tile files).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ODBL = 'ODbL 1.0, © OpenStreetMap contributors';
const OSM = 'OpenStreetMap (Overpass API)';

/** [key regex, source, license] – first match wins. Licenses from docs/DATENQUELLEN.md of the orbis repo. */
export const RULES = [
  [/^safecast\.json$/, 'https://tt.safecast.org/devices', 'Safecast, CC0 1.0'],
  [/^bfs-odl\.json$/, 'https://www.imis.bfs.de/ogc/opendata/ows (odlinfo_odl_1h_latest)', 'BfS ODL-Messnetz, Datenlizenz Deutschland 2.0 (DL-DE 2.0)'],
  [/^stuk-fi\.json$/, 'https://opendata.fmi.fi/wfs (stuk::observations::external-radiation::latest::multipointcoverage)', 'STUK / Finnish Meteorological Institute, CC BY 4.0, attribution "Säteilyturvakeskus STUK / Ilmatieteen laitos (FMI)" (https://en.ilmatieteenlaitos.fi/open-data-licence)'],
  [/^hc-ca\.json$/, 'https://maps-cartes.services.geo.ca/server_serveur/rest/services/HC/fpsn_en/MapServer/1', 'Health Canada Fixed Point Surveillance Network, Open Government Licence – Canada, attribution "Health Canada" (https://open.canada.ca/en/open-government-licence-canada)'],
  [/^wikidata\//, 'https://query.wikidata.org/sparql (mines, oil/gas/coal fields with coordinates)', 'Wikidata, CC0 1.0'],
  [/^wri\//, 'https://github.com/wri/global-power-plant-database (output_database/global_power_plant_database.csv)', 'WRI Global Power Plant Database, CC BY 4.0, attribution "World Resources Institute" (https://datasets.wri.org/dataset/globalpowerplantdatabase)'],
  [/^ports\.json$/, 'https://msi.nga.mil (World Port Index, Pub. 150) + https://www.data.gouv.fr/datasets/seaports-locations-data (Upply)', 'NGA World Port Index: US Government work, no copyright claimed (public domain); Upply Seaports Locations Data: CC BY 4.0, attribution "Upply"'],
  [/^wahlen\/de\.json$/, 'https://github.com/awiedem/german_election_data (GERDA: federal_cty_unharm.csv, ltw_wkr_unharm.csv), aggregated to Bundeslaender', 'Bundestagswahlen: GERDA (Heddesheimer, Hilbig, Sichart & Wiedemann 2025), CC BY 4.0; Landtagswahlen: (c) Statistische Aemter des Bundes und der Laender, Regionaldatenbank Deutschland (https://www.regionalstatistik.de), Datenlizenz Deutschland - Namensnennung - 2.0 (dl-de/by-2-0), aggregated (changed) via GERDA'],
  [/^wahlen\/de-geo\.json$/, 'https://sgx.geodatenzentrum.de/wfs_vg2500 (BKG Verwaltungsgebiete 1:2 500 000, vg2500_lan)', '(c) GeoBasis-DE / BKG (year of download), Datenlizenz Deutschland - Namensnennung - 2.0 (dl-de/by-2-0), simplified (changed)'],
  [/^openmeteo\//, 'https://open-meteo.com (api.open-meteo.com/v1/forecast)', 'Open-Meteo, CC BY 4.0 (non-commercial API)'],
  [/^firms\//, 'https://firms.modaps.eosdis.nasa.gov/api', 'NASA FIRMS, free (NASA open data policy), attribution'],
  [/^demos\.json$/, 'https://api.demonstrations.org/v1/event/all', 'demonstrations.org (Demos Berlin e.V.), CC BY-SA 4.0'],
  [/^space\/launches\//, 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/', 'The Space Devs (Launch Library 2), free tier, attribution "The Space Devs"'],
  [/^space\/tle\//, 'https://celestrak.org/NORAD/elements/gp.php', 'CelesTrak, free, attribution'],
  [/^ccc-us\.json$/, 'https://dataverse.harvard.edu (doi:10.7910/DVN/RI9JFU)', 'Crowd Counting Consortium, CC0 1.0'],
  [/^ukraine-harm\.json$/, 'https://ukraine.bellingcat.com/', 'Bellingcat, licence not stated – attribution and link'],
  [/^ukraine-support\.json$/, 'https://www.ifw-kiel.de/topics/war-against-ukraine/ukraine-support-tracker/', 'Kiel Institute, licence not stated – attribution and link'],
  [/^ipc-gaza\.json$/, 'https://data.humdata.org (IPC)', 'IPC via HDX, CC0'],
  [/^gaza-displacement\.json$/, 'https://data.humdata.org (IDMC)', 'IDMC via HDX, CC BY-IGO'],
  [/^healthsites-pse\.json$/, 'https://data.humdata.org (Healthsites.io)', 'Healthsites.io / OpenStreetMap via HDX, ODbL'],
  [/^ukraine-oblast\.json$/, 'https://data.humdata.org (Insecurity Insight, WHO SSA), github.com/Vadimkin/ukrainian-air-raid-sirens-dataset', 'Insecurity Insight CC BY-SA; WHO SSA CC BY; air raid sirens dataset MIT'],
  [/^osm-cables\//, OSM, ODBL],
  [/^osm-datacenters\//, OSM, ODBL],
  [/^volcanoes\.json$/, 'https://volcano.si.edu (GVP-VOTW WFS)', 'Smithsonian Global Volcanism Program, attribution (no explicit licence stated)'],
  [/^radio\//, 'https://www.radio-browser.info', 'Radio Browser, community database, free use'],
  [/^mars\//, 'https://mars.nasa.gov/mmgis-maps', 'NASA/JPL, public domain (NASA media usage guidelines)'],
  [/^cams\/world\.json$/, 'camera feeds listed in docs/DATENQUELLEN.md section 8 (positions only)', 'positions only; see per-feed terms in docs/DATENQUELLEN.md'],
  [/^cams\//, 'camera feed of the same name (src/api/camfeeds.ts)', 'per feed, see docs/DATENQUELLEN.md section 8'],
  [/^street\//, 'https://tiles.mapillary.com (Mapillary vector tiles)', 'Mapillary, CC BY-SA 4.0'],
  [/^ais\/barentswatch-area\.json$/, 'https://live.ais.barentswatch.no/v1/openaisarea (once per loop run, collectors/barentswatch-loop.mjs)', 'BarentsWatch / Kystverket (Norwegian Coastal Administration), NLOD 2.0; terms: https://www.barentswatch.no/en/articles/api-terms-and-conditions/'],
  [/^ais\/barentswatch-latest\.json$/, 'https://live.ais.barentswatch.no/v1/latest/combined (central fetch every 60 s, collectors/barentswatch-loop.mjs)', 'BarentsWatch / Kystverket (Norwegian Coastal Administration), NLOD 2.0; terms: https://www.barentswatch.no/en/articles/api-terms-and-conditions/'],
  [/^aircraft\/opensky-states\.json$/, 'https://opensky-network.org/api/states/all?extended=1 (central fetch every 90 s, collectors/opensky-loop.mjs)', 'OpenSky Network, free for research and non-commercial use, attribution (Schäfer et al., IPSN 2014); terms: https://opensky-network.org/about/terms-of-use'],
  [/^meta\.json$/, 'Orbismap/data collectors', 'n/a'],
  // orbis-osm
  [/^((cctv|blitzer|alpr|webcam|wind|resource)\.pmtiles|heat\/)/, 'OpenStreetMap, Geofabrik extracts (https://download.geofabrik.de)', ODBL],
  // orbis-wetter
  [/^v1\/static\/dem\//, 'Mapzen Terrain Tiles / Terrarium z5 (https://registry.opendata.aws/terrain-tiles; SRTM, GMTED2010, ETOPO1 u. a., https://github.com/tilezen/joerd/blob/master/docs/attribution.md), resampled to 0.5 deg / 0.125 deg OWX (collectors/wetter-dem.py)', 'AWS Open Data terrain tiles, free use with attribution of the underlying sources (SRTM/NASA public domain, GMTED2010/USGS public domain, ETOPO1/NOAA public domain)'],
  [/^LICENSE\.txt$/, 'Orbismap/data collectors', ODBL],
];

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

export function buildManifest(dir, existing = {}, collapse = false) {
  const manifest = { ...existing };
  const groups = new Map();
  for (const key of walk(dir)) {
    if (key === 'manifest.json') continue;
    const st = statSync(join(dir, key));
    const [, source = '', license = ''] = RULES.find(([re]) => re.test(key)) ?? [];
    const entry = { updated: st.mtime.toISOString(), bytes: st.size, source, license };
    const top = key.split('/')[0];
    if (collapse && key.includes('/')) {
      const g = groups.get(top) ?? { ...entry, bytes: 0, files: 0 };
      g.bytes += st.size;
      g.files++;
      if (entry.updated > g.updated) g.updated = entry.updated;
      groups.set(top, g);
    } else manifest[key] = entry;
  }
  for (const [top, g] of groups) manifest[`${top}/`] = g;
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1]?.endsWith('manifest.mjs')) {
  const [dir, existingPath, outPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!dir || !existingPath || !outPath) throw new Error('usage: manifest <dir> <existing-manifest.json|-> <out.json> [--collapse]');
  let existing = {};
  if (existingPath !== '-' && existsSync(existingPath)) {
    try {
      existing = JSON.parse(readFileSync(existingPath, 'utf8'));
    } catch (e) {
      console.warn(`existing manifest unreadable (${e.message}) – starting fresh`);
    }
  }
  const manifest = buildManifest(dir, existing, process.argv.includes('--collapse'));
  writeFileSync(outPath, JSON.stringify(manifest));
  console.log(`manifest: ${Object.keys(manifest).length} entries`);
}
