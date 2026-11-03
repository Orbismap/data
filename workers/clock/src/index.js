// Orbis clock (Cloudflare Worker, free plan): one cron trigger every minute that mirrors small upstream
// feeds RAW into the R2 bucket "orbis-live" (public at https://orbis-live.maltee.dev). Browsers then read one
// cached copy instead of every visitor hitting the upstream (and its rate limits).
//
// Nothing is parsed (free plan: 10 ms CPU per invocation; waiting on fetch() does not count). The body is
// passed straight through to R2. Subrequest limit: 50 per invocation, so the jobs are spread over the minutes:
// a job with `every` N minutes runs when (minuteOfDay + offset(id)) % N === 0, offset = stable hash of the id.
//
// Per job: HEAD the old object (conditional request from its customMetadata), fetch upstream, on 304 do
// nothing (saves a R2 Class A write), on 2xx put the body. A failing job keeps the old object and never
// stops the other jobs. After a run that wrote something, manifest.json is rebuilt from LIST + customMetadata.
//
// Heavy jobs are not run here: DISPATCH below starts the GitHub Actions workflows of Orbismap/data (repository_dispatch).
//
// Setup: R2 binding LIVE (bucket orbis-live), cron "* * * * *". Secret GH_DISPATCH_TOKEN for DISPATCH (README: fine-grained PAT).
// Local: `pnpm exec wrangler dev -c workers/clock/wrangler.jsonc --test-scheduled --var RUN_ALL:1`, then
// `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` – RUN_ALL runs every mirror job once (and dispatches nothing).

const UA = 'Orbis (+https://maltee.dev/orbis)';
const TIMEOUT_MS = 20000;
const MAX_SUBREQUESTS = 40; // free plan: 50 per invocation; head + fetch + put of a job each count, plus list + put for the manifest
const MANIFEST_KEY = 'manifest.json';
const PUBLIC_DOMAIN = 'public domain';

const SWPC = 'https://services.swpc.noaa.gov';
const NHC_MAP = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const JSON_T = 'application/json';
const GEOJSON_T = 'application/geo+json';
const XML_T = 'application/atom+xml';
const TEXT_T = 'text/plain; charset=utf-8';

// URLs exactly as the Orbis app uses them today (src/api/*.ts). The EMSC window is computed at runtime
// like in loadEmsc() (src/api/europe.ts): last 7 days, Europe bounding box, M >= 1.5.
const emscUrl = () => {
  const start = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19);
  const q = new URLSearchParams({
    format: 'json',
    minlatitude: '27',
    maxlatitude: '72',
    minlongitude: '-25',
    maxlongitude: '45',
    minmagnitude: '1.5',
    starttime: start,
    limit: '2000',
    orderby: 'time',
  });
  return `https://www.seismicportal.eu/fdsnws/event/1/query?${q}`;
};

// NWS: the app asks per event type (loadNwsSevere in src/api/events.ts); same event list here.
const NWS_EVENTS = [
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Extreme Wind Warning',
  'Flash Flood Warning',
  'Snow Squall Warning',
];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// cache = Cache-Control of the object; derived from `every` unless given (see cacheControl()).

export const JOBS = [
  // ---- every 5 min --------------------------------------------------------------------------------
  { id: 'usgs-quakes', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson', key: 'events/usgs-2.5_week.geojson', every: 5, type: GEOJSON_T, license: `USGS, ${PUBLIC_DOMAIN}` },
  { id: 'emsc-quakes', url: emscUrl, key: 'events/emsc-europe.json', every: 5, type: JSON_T, license: 'EMSC / SeismicPortal, CC BY 4.0' },
  { id: 'gdacs', url: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;FL;VO;DR;WF', key: 'events/gdacs.json', every: 5, type: JSON_T, license: 'GDACS (EU/UN), attribution required' },
  { id: 'eonet', url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=45', key: 'events/eonet.json', every: 5, type: JSON_T, license: `NASA EONET, ${PUBLIC_DOMAIN}` },
  ...NWS_EVENTS.map((event) => ({
    id: `nws-${slug(event)}`,
    url: `https://api.weather.gov/alerts/active?event=${encodeURIComponent(event)}`,
    key: `events/nws/${slug(event)}.geojson`,
    every: 5,
    type: GEOJSON_T,
    headers: { Accept: 'application/geo+json' },
    license: `NOAA/NWS, ${PUBLIC_DOMAIN}`,
  })),
  { id: 'tsunami-paaq', url: 'https://www.tsunami.gov/events/xml/PAAQAtom.xml', key: 'tsunami/PAAQ.xml', every: 5, type: XML_T, license: `NOAA Tsunami Warning Centers, ${PUBLIC_DOMAIN}` },
  { id: 'tsunami-pheb', url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml', key: 'tsunami/PHEB.xml', every: 5, type: XML_T, license: `NOAA Tsunami Warning Centers, ${PUBLIC_DOMAIN}` },
  { id: 'swpc-ovation', url: `${SWPC}/json/ovation_aurora_latest.json`, key: 'space/swpc/ovation_aurora_latest.json', every: 5, type: JSON_T, license: `NOAA SWPC, ${PUBLIC_DOMAIN}` },
  { id: 'swpc-kp', url: `${SWPC}/products/noaa-planetary-k-index.json`, key: 'space/swpc/noaa-planetary-k-index.json', every: 5, type: JSON_T, license: `NOAA SWPC, ${PUBLIC_DOMAIN}` },
  // plasma-2-hour.json / mag-2-hour.json (used by loadSpaceWeather in src/api/earth.ts) answer 404 upstream since NOAA retired them (2026-11) -> not mirrored
  { id: 'swpc-xrays', url: `${SWPC}/json/goes/primary/xrays-1-day.json`, key: 'space/swpc/xrays-1-day.json', every: 5, type: JSON_T, license: `NOAA SWPC, ${PUBLIC_DOMAIN}` },

  // ---- every 10 min -------------------------------------------------------------------------------
  { id: 'ndbc-latest', url: 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt', key: 'ocean/ndbc-latest_obs.txt', every: 10, type: TEXT_T, license: `NOAA NDBC, ${PUBLIC_DOMAIN}` },
  // NHC: loadCyclones() in src/api/earth.ts – layers 5 (forecast points), 6 (forecast track), 7 (cone), 10 (past points), 11 (past track)
  ...[['point', 5], ['fcst', 6], ['cone', 7], ['pastpt', 10], ['past', 11]].map(([part, layer]) => ({
    id: `nhc-${part}`,
    url: `${NHC_MAP}/${layer}/query?where=1%3D1&outFields=*&f=geojson`,
    key: `cyclones/nhc-${part}.geojson`,
    every: 10,
    type: GEOJSON_T,
    license: `NOAA NHC/CPHC, ${PUBLIC_DOMAIN}`,
  })),
  // Launch Library 2 and CelesTrak are NOT mirrored here: both rate-limit per IP and the shared Cloudflare egress IPs get
  // HTTP 429/403. They run in the GitHub Actions group live-15m (collectors/fetch-data.ts: ll2-*, celestrak) instead.
];

// ---- GitHub Actions dispatch -------------------------------------------------------------------------
// Heavy jobs run in GitHub Actions (Orbismap/data); the clock only starts them on time (UTC, from the scheduled event).
// Entry: { id, event /* repository_dispatch event_type = workflow */, payload /* client_payload */,
//          minutes: [..], hours?: [..] /* default every hour */, days?: [..] /* 0 = Sunday .. 6, default every day */ }
// Each dispatch is one subrequest (counted in run()). Collectors: collectors/ and .github/workflows in this repo.
export const DISPATCH = [
  { id: 'live-15m', event: 'live-15m', minutes: [7, 22, 37, 52] }, // every 15 min (same minutes as the old data.yml cron)
  { id: 'daily', event: 'daily', hours: [3], minutes: [5] },
  { id: 'weekly', event: 'weekly', days: [1], hours: [4], minutes: [5] }, // Mondays
  { id: 'osm-tiles', event: 'osm-tiles', hours: [3], minutes: [17] },
  { id: 'wetter', event: 'wetter', hours: [3, 9, 15, 21], minutes: [20] }, // ICON runs 00/06/12/18 UTC are complete ~3 h later
];

/** dispatch entries due at this time (UTC); all of them with runAll */
export function dispatchDue(table, date, runAll = false) {
  return table.filter(
    (d) => runAll || (d.minutes.includes(date.getUTCMinutes()) && (d.hours ?? [date.getUTCHours()]).includes(date.getUTCHours()) && (d.days ?? [date.getUTCDay()]).includes(date.getUTCDay())),
  );
}

let warnedNoToken = false;

/** repository_dispatch to Orbismap/data; without the secret GH_DISPATCH_TOKEN it logs once per isolate and returns false */
export async function dispatch(env, event, payload = {}) {
  if (!env.GH_DISPATCH_TOKEN) {
    if (!warnedNoToken) {
      warnedNoToken = true;
      console.warn('[clock] secret GH_DISPATCH_TOKEN missing - GitHub Actions jobs are not started');
    }
    return false;
  }
  const res = await fetch('https://api.github.com/repos/Orbismap/data/dispatches', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: event, client_payload: payload }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    res.body?.cancel();
    throw new Error(`dispatch ${event}: HTTP ${res.status}`);
  }
  res.body?.cancel(); // 204 No Content
  return true;
}

// ---- scheduling -----------------------------------------------------------------------------------------

/** FNV-1a, stable across runs; spreads job ids over the minutes. HASH_SEED is tuned so no minute is overloaded (see README). */
const HASH_SEED = 'orbis-1';
export function offset(id) {
  let h = 0x811c9dc5;
  for (const c of HASH_SEED + id) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 1440;
}

/** jobs due at this UTC minute of day (0..1439); all of them with runAll */
export function dueAt(table, minuteOfDay, runAll = false) {
  return table.filter((j) => runAll || (minuteOfDay + offset(j.id)) % j.every === 0);
}

/** Cache-Control of a mirrored object: half the interval fresh (min 60 s), stale-while-revalidate 4 intervals */
export const cacheControl = (every) => `public, max-age=${Math.max(60, Math.round((every * 60) / 2))}, stale-while-revalidate=${every * 60 * 4}`;

// ---- mirroring ------------------------------------------------------------------------------------------

/** @returns 'written' | 'unchanged' (304) */
async function mirror(env, job) {
  const prev = await env.LIVE.head(job.key);
  const meta = prev?.customMetadata ?? {};
  const headers = { 'User-Agent': UA, ...(job.headers ?? {}) };
  if (meta.etag) headers['If-None-Match'] = meta.etag;
  if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;

  const url = typeof job.url === 'function' ? job.url() : job.url;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (resp.status === 304) return 'unchanged';
  if (!resp.ok) {
    resp.body?.cancel();
    throw new Error(`HTTP ${resp.status}`);
  }

  // R2 needs a known length: stream only with Content-Length and no content-encoding (the length would not match the decoded body)
  const len = Number(resp.headers.get('content-length'));
  const stream = len > 0 && !resp.headers.get('content-encoding');
  const body = stream ? resp.body : await resp.arrayBuffer();
  const bytes = stream ? len : body.byteLength;
  if (!bytes) throw new Error('empty response');

  await env.LIVE.put(job.key, body, {
    httpMetadata: { contentType: job.type, cacheControl: job.cache ?? cacheControl(job.every) },
    customMetadata: {
      source: url,
      fetched: new Date().toISOString(),
      etag: resp.headers.get('etag') ?? '',
      lastModified: resp.headers.get('last-modified') ?? '',
      license: job.license,
    },
  });
  job.bytes = bytes;
  return 'written';
}

/**
 * Rebuilds manifest.json from LIST. Objects written by the GitHub Actions workflows have no customMetadata (aws s3 sync),
 * so source and license of those keys come from the previous manifest, which the workflows merge their entries into
 * (collectors/upload.sh). Subrequests: get + list + put.
 */
async function writeManifest(env) {
  let old = {};
  try {
    old = (await (await env.LIVE.get(MANIFEST_KEY))?.json()) ?? {};
  } catch {
    // unreadable or missing: start over, the next workflow run fills source/license again
  }
  const manifest = {};
  let cursor;
  do {
    const page = await env.LIVE.list({ cursor, include: ['customMetadata', 'httpMetadata'] });
    for (const o of page.objects) {
      if (o.key === MANIFEST_KEY) continue;
      const m = o.customMetadata ?? {};
      const prev = old[o.key] ?? {};
      manifest[o.key] = { updated: m.fetched || o.uploaded.toISOString(), bytes: o.size, source: m.source ?? prev.source ?? '', license: m.license ?? prev.license ?? '' };
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.LIVE.put(MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: JSON_T, cacheControl: 'public, max-age=60, stale-while-revalidate=300' },
  });
  return Object.keys(manifest).length;
}

export async function run(env, scheduledTime = Date.now()) {
  const t = new Date(scheduledTime);
  const minute = t.getUTCHours() * 60 + t.getUTCMinutes();
  const runAll = env.RUN_ALL === '1' || env.RUN_ALL === 1;

  // GitHub Actions dispatches: one subrequest each, only counted when the token exists (otherwise nothing is sent).
  // Not in RUN_ALL: a local test run must not start the real workflows.
  const dispatches = runAll ? [] : dispatchDue(DISPATCH, t);
  const dispatching = env.GH_DISPATCH_TOKEN ? dispatches.length : 0;
  const dispatched = Promise.allSettled(
    dispatches.map(async (d) => {
      try {
        if (await dispatch(env, d.event, d.payload)) console.log(`[clock] dispatched ${d.event}`);
      } catch (e) {
        console.error(`[clock] ${d.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );

  // budget: head + fetch + put per job (worst case 3), manifest needs get + list + put (+ pagination, ignored), dispatches 1 each
  const due = dueAt(JOBS, minute, runAll);
  const jobs = [];
  let used = 3 + dispatching; // manifest + dispatch reserve
  for (const j of due) {
    if (!runAll && used + 3 > MAX_SUBREQUESTS) {
      console.warn(`[clock] subrequest budget: skipping ${j.id} at minute ${minute}`);
      continue;
    }
    used += 3;
    jobs.push(j);
  }
  if (due.length * 3 + 3 + dispatching > MAX_SUBREQUESTS) console.warn(`[clock] minute ${minute}: ${due.length} jobs due, worst case ${due.length * 3 + 3 + dispatching} subrequests`);

  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const t0 = Date.now();
      try {
        const r = await mirror(env, job);
        console.log(`[clock] ${job.id} ${r}${r === 'written' ? ` ${job.bytes}B` : ''} ${Date.now() - t0}ms`);
        return r;
      } catch (e) {
        console.error(`[clock] ${job.id} failed: ${e instanceof Error ? e.message : e}`);
        throw e;
      }
    }),
  );

  await dispatched;

  const written = results.filter((r) => r.status === 'fulfilled' && r.value === 'written').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`[clock] minute ${minute}: ${jobs.length}/${due.length} jobs, ${written} written, ${failed} failed`);
  if (written) {
    try {
      console.log(`[clock] manifest: ${await writeManifest(env)} objects`);
    } catch (e) {
      console.error(`[clock] manifest failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env, controller.scheduledTime));
  },
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
