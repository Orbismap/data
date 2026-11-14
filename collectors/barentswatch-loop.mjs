// Central BarentsWatch fetch: Norwegian AIS (Kystverket + Equinor + satellites, NLOD) for ALL visitors of Orbis.
//   node collectors/barentswatch-loop.mjs [--once] [--out <dir>]
// Every INTERVAL_S seconds: GET live.ais.barentswatch.no/v1/latest/combined (OAuth2 client credentials, scope `ais`), the
// newest combined position + static data per MMSI of the last WINDOW_MIN minutes -> gzip -> ais/barentswatch-latest.json in
// the R2 bucket orbis-live. The payload stays BarentsWatch's raw JSON array of AisComboFull (the app parses it).
// Once per run it also mirrors the coverage area (v1/openaisarea, a GeoJSON MultiPolygon) to ais/barentswatch-area.json: the
// app outlines it, so a visitor sees where Norwegian data exists. A failed area fetch never stops the positions.
// The token is the reason for the loop: a browser must never see the client secret, and one fetch serves every visitor.
// A failed round keeps the old object (nothing is uploaded for errors, empty or stale answers).
// Env: BARENTSWATCH_CLIENT_ID (usually "email:clientname"), BARENTSWATCH_CLIENT_SECRET, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID,
//      AWS_SECRET_ACCESS_KEY (orbis-live), LOOP_MINUTES (default 350, the job limit is 360), INTERVAL_S (default 60),
//      R2_BUCKET (default orbis-live).
// Without BarentsWatch credentials there is nothing to fetch (the API has no anonymous access): the script says so and exits.
// Without R2 credentials: the loop runs but only writes to --out.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { RULES } from './manifest.mjs';

const sh = promisify(execFile);

export const TOKEN_URL = 'https://id.barentswatch.no/connect/token';
export const LATEST_URL = 'https://live.ais.barentswatch.no/v1/latest/combined';
export const KEY = 'ais/barentswatch-latest.json';
export const AREA_URL = 'https://live.ais.barentswatch.no/v1/openaisarea';
export const AREA_KEY = 'ais/barentswatch-area.json';
export const AREA_CACHE = 'public, max-age=21600, stale-while-revalidate=86400'; // the area changes rarely
export const CACHE = 'public, max-age=45, stale-while-revalidate=120';
export const MIN_INTERVAL_S = 30; // be polite: the latest list of the whole zone is a big query
export const WINDOW_MIN = 30; // ships reported in the last 30 min (the same window as Digitraffic in the app)
export const MIN_SHIPS = 100; // the Norwegian zone always has well over a thousand; less is a broken answer
export const MAX_AGE_S = 15 * 60; // the newest report of a snapshot may be at most this old
const TOKEN_MARGIN_MS = 5 * 60 * 1000; // refresh the token this long before it expires (lifetime 3600 s)
const FETCH_TIMEOUT_MS = 60 * 1000;
const MANIFEST_EVERY = 6; // rounds between manifest updates (~6 min)
const MAX_FAILS = 15; // failed rounds in a row (~15 min) -> exit with an error, the next dispatch starts a new loop

/** Query string of one fetch: everything reported since `nowMs - WINDOW_MIN`, full model (position + static), plain JSON. */
export function latestUrl(nowMs = Date.now()) {
  const since = new Date(nowMs - WINDOW_MIN * 60 * 1000).toISOString();
  return `${LATEST_URL}?${new URLSearchParams({ since, modelType: 'Full', modelFormat: 'Json' })}`;
}

/** Checks a parsed answer; returns an error text or null when the snapshot is usable. */
export function checkLatest(json, nowMs = Date.now()) {
  if (!Array.isArray(json)) return 'not an array';
  if (json.length < MIN_SHIPS) return `only ${json.length} ships`;
  let newest = 0;
  for (const s of json) {
    const t = Date.parse(s?.msgtime ?? '');
    if (t > newest) newest = t;
  }
  if (!newest) return 'no msgtime';
  if (nowMs - newest > MAX_AGE_S * 1000) return `newest report is ${Math.round((nowMs - newest) / 1000)} s old`;
  return null;
}

/** Checks the coverage area: a GeoJSON MultiPolygon (or Polygon) with at least one ring; returns an error text or null. */
export function checkArea(json) {
  if (!json || typeof json !== 'object') return 'no object';
  if (json.type !== 'MultiPolygon' && json.type !== 'Polygon') return `type ${json.type}`;
  if (!Array.isArray(json.coordinates) || !json.coordinates.length) return 'no coordinates';
  return null;
}

/** Wait before the next round: the interval is measured from the start of the last fetch, a rate limit wins. */
export function nextDelayMs(startedAt, now, intervalMs, retryAfterMs = 0) {
  return Math.max(startedAt + intervalMs - now, retryAfterMs, 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[barentswatch ${new Date().toISOString()}] ${msg}`);

// ---- OAuth2 token ------------------------------------------------------------------------------------

function tokenSource(id, secret) {
  let token = null;
  let expires = 0;
  return {
    async get(force = false) {
      if (!force && token && Date.now() < expires - TOKEN_MARGIN_MS) return token;
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'ais' }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`token HTTP ${res.status}`);
      const j = await res.json();
      if (!j.access_token) throw new Error('token answer without access_token');
      token = j.access_token;
      expires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
      return token;
    },
  };
}

// ---- one fetch ---------------------------------------------------------------------------------------

/** Returns { body } or { retryAfterMs } (429) or throws. 401 refreshes the token once. */
async function fetchLatest(tokens) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'User-Agent': 'orbis-data-collector', Accept: 'application/json', Authorization: `Bearer ${await tokens.get(attempt > 0)}` };
    const res = await fetch(latestUrl(), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 429) {
      const s = Number(res.headers.get('retry-after'));
      res.body?.cancel();
      return { retryAfterMs: (Number.isFinite(s) && s > 0 ? s : 300) * 1000 };
    }
    if (!res.ok) {
      res.body?.cancel();
      throw new Error(`latest HTTP ${res.status}`);
    }
    return { body: await res.text() };
  }
  throw new Error('latest HTTP 401 after token refresh');
}

/** The coverage area as text (raw JSON of the API) or throws. */
async function fetchArea(tokens) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(AREA_URL, { headers: { 'User-Agent': 'orbis-data-collector', Accept: 'application/json', Authorization: `Bearer ${await tokens.get(attempt > 0)}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) {
      res.body?.cancel();
      throw new Error(`area HTTP ${res.status}`);
    }
    const body = await res.text();
    const err = checkArea(JSON.parse(body));
    if (err) throw new Error(`unusable area: ${err}`);
    return body;
  }
  throw new Error('area HTTP 401 after token refresh');
}

// ---- R2 (aws CLI, as upload.sh) ----------------------------------------------------------------------

function r2() {
  const { R2_ACCOUNT_ID: acc, AWS_ACCESS_KEY_ID: k, AWS_SECRET_ACCESS_KEY: s } = process.env;
  if (!acc || !k || !s) return null;
  const bucket = process.env.R2_BUCKET || 'orbis-live';
  const env = { ...process.env, AWS_DEFAULT_REGION: 'auto', AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' };
  const aws = (args) => sh('aws', [...args, '--endpoint-url', `https://${acc}.r2.cloudflarestorage.com`], { env, timeout: 60000 });
  return {
    bucket,
    cp: (from, to, extra = []) => aws(['s3', 'cp', from, to, '--only-show-errors', ...extra]),
  };
}

async function updateManifest(store, tmp, bytes, key = KEY) {
  const mf = join(tmp, 'manifest.json');
  let m = {};
  try {
    await store.cp(`s3://${store.bucket}/manifest.json`, mf);
    m = JSON.parse(readFileSync(mf, 'utf8'));
  } catch {
    log('manifest not readable, skipped');
    return; // never overwrite a manifest we could not read
  }
  const [, source = '', license = ''] = RULES.find(([re]) => re.test(key)) ?? [];
  m[key] = { updated: new Date().toISOString(), bytes, source, license };
  writeFileSync(mf, JSON.stringify(m));
  await store.cp(mf, `s3://${store.bucket}/manifest.json`, ['--cache-control', 'public, max-age=60, stale-while-revalidate=300', '--content-type', 'application/json']);
}

// ---- main --------------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : process.env.BARENTSWATCH_OUT || 'out/ais';
  const id = process.env.BARENTSWATCH_CLIENT_ID;
  const secret = process.env.BARENTSWATCH_CLIENT_SECRET;
  if (!id || !secret) {
    log('no BARENTSWATCH_CLIENT_ID/SECRET: the API has no anonymous access, nothing to do');
    return;
  }
  const once = args.includes('--once');
  const intervalMs = Math.max(Number(process.env.INTERVAL_S) || 60, MIN_INTERVAL_S) * 1000;
  const loopMs = (Number(process.env.LOOP_MINUTES) || 350) * 60 * 1000;
  const endAt = Date.now() + loopMs;
  const tokens = tokenSource(id, secret);
  const store = r2();
  mkdirSync(out, { recursive: true });
  const tmp = join(out, '.tmp');
  mkdirSync(tmp, { recursive: true });
  if (!store) log('no R2 credentials: writing to the output directory only');

  // the coverage area, once per run (before the positions, so the manifest of round 0 already lists it)
  try {
    const area = await fetchArea(tokens);
    const gz = gzipSync(area, { level: 9 });
    writeFileSync(join(out, 'barentswatch-area.json.gz'), gz);
    if (store) {
      const file = join(tmp, 'barentswatch-area.json.gz');
      writeFileSync(file, gz);
      await store.cp(file, `s3://${store.bucket}/${AREA_KEY}`, ['--content-encoding', 'gzip', '--content-type', 'application/json', '--cache-control', AREA_CACHE]);
      await updateManifest(store, tmp, gz.length, AREA_KEY);
    }
    log(`area: ${area.length} bytes, ${gz.length} gzip${store ? ', uploaded' : ''}`);
  } catch (e) {
    log(`area failed (old one stays): ${e instanceof Error ? e.message : e}`);
  }

  let round = 0;
  let fails = 0;
  for (;;) {
    const startedAt = Date.now();
    let retryAfterMs = 0;
    try {
      const r = await fetchLatest(tokens);
      if (r.retryAfterMs !== undefined) {
        retryAfterMs = r.retryAfterMs;
        throw new Error(`rate limited, retry after ${Math.round(retryAfterMs / 1000)} s`);
      }
      const json = JSON.parse(r.body);
      const err = checkLatest(json);
      if (err) throw new Error(`unusable answer: ${err}`);
      const gz = gzipSync(r.body, { level: 9 });
      writeFileSync(join(out, 'barentswatch-latest.json.gz'), gz);
      if (store) {
        const file = join(tmp, 'barentswatch-latest.json.gz');
        writeFileSync(file, gz);
        await store.cp(file, `s3://${store.bucket}/${KEY}`, ['--content-encoding', 'gzip', '--content-type', 'application/json', '--cache-control', CACHE]);
        if (round % MANIFEST_EVERY === 0) {
          try {
            await updateManifest(store, tmp, gz.length);
          } catch (e) {
            log(`manifest update failed: ${e instanceof Error ? e.message : e}`); // the snapshot itself is up
          }
        }
      }
      log(`round ${round}: ${json.length} ships, ${r.body.length} bytes, ${gz.length} gzip${store ? ', uploaded' : ''}`);
      fails = 0;
    } catch (e) {
      fails++;
      log(`round ${round} failed (${fails} in a row, old snapshot stays): ${e instanceof Error ? e.message : e}`);
      if (fails >= MAX_FAILS || once) {
        process.exitCode = 1;
        return;
      }
    }
    round++;
    if (once) return;
    const wait = nextDelayMs(startedAt, Date.now(), intervalMs, retryAfterMs);
    if (Date.now() + wait >= endAt) {
      log('loop time is over, exiting');
      return;
    }
    await sleep(wait);
  }
}

if (process.argv[1]?.endsWith('barentswatch-loop.mjs')) await main();
