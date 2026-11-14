// Central OpenSky fetch: one loop for ALL visitors of Orbis instead of one fetch per browser.
//   node collectors/opensky-loop.mjs [--once] [--out <dir>]
// Every INTERVAL_S seconds: GET states/all?extended=1 (OAuth2 client credentials) -> gzip -> aircraft/opensky-states.json
// in the R2 bucket orbis-live. The payload stays OpenSky's raw JSON (the app parses it).
// Credits: a global states/all costs 4 credits, the daily budget is 4000 -> at most 1000 fetches/day (one per 86 s).
// That is why INTERVAL_S never goes below 90 s with credentials, however it is configured.
// A failed round keeps the old object (nothing is uploaded for errors, empty or stale answers).
// Env: OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET (OAuth2 client), R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (orbis-live),
//      LOOP_MINUTES (default 350, the job limit is 360), INTERVAL_S (default 90), R2_BUCKET (default orbis-live).
// Without OpenSky credentials: one anonymous fetch into --out (default ./out/aircraft), no upload (local runs, forks).
// Without R2 credentials: the loop runs but only writes to --out.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { RULES } from './manifest.mjs';

const sh = promisify(execFile);

export const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
export const STATES_URL = 'https://opensky-network.org/api/states/all?extended=1';
export const KEY = 'aircraft/opensky-states.json';
export const CACHE = 'public, max-age=60, stale-while-revalidate=120';
export const MIN_INTERVAL_S = 90; // 4 credits per fetch, 4000 credits per day
export const MIN_STATES = 500; // a global snapshot has 5,000+ aircraft; less is a broken answer
export const MAX_AGE_S = 10 * 60; // the `time` of a snapshot may be at most this old
const TOKEN_MARGIN_MS = 2 * 60 * 1000; // refresh the token this long before it expires
const FETCH_TIMEOUT_MS = 45 * 1000;
const MANIFEST_EVERY = 4; // rounds between manifest updates (~6 min)
const MAX_FAILS = 12; // failed rounds in a row (~18 min) -> exit with an error, the next dispatch starts a new loop

/** Seconds from a Retry-After style header value, null when missing or not a number. */
export function retrySeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Checks a parsed states/all answer; returns an error text or null when the snapshot is usable. */
export function checkStates(json, nowS = Date.now() / 1000) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.states)) return 'no states array';
  if (json.states.length < MIN_STATES) return `only ${json.states.length} states`;
  if (typeof json.time !== 'number') return 'no time field';
  if (nowS - json.time > MAX_AGE_S) return `snapshot is ${Math.round(nowS - json.time)} s old`;
  return null;
}

/** Wait before the next round: the interval is measured from the start of the last fetch, a rate limit wins. */
export function nextDelayMs(startedAt, now, intervalMs, retryAfterMs = 0) {
  return Math.max(startedAt + intervalMs - now, retryAfterMs, 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[opensky ${new Date().toISOString()}] ${msg}`);

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
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`token HTTP ${res.status}`);
      const j = await res.json();
      if (!j.access_token) throw new Error('token answer without access_token');
      token = j.access_token;
      expires = Date.now() + (Number(j.expires_in) || 1800) * 1000; // 30 min by OpenSky's docs
      return token;
    },
  };
}

// ---- one fetch ---------------------------------------------------------------------------------------

/** Returns { body, remaining } or { retryAfterMs } (429) or throws. 401 refreshes the token once. */
async function fetchStates(tokens) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'User-Agent': 'orbis-data-collector' };
    if (tokens) headers.Authorization = `Bearer ${await tokens.get(attempt > 0)}`;
    const res = await fetch(STATES_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const remaining = res.headers.get('x-rate-limit-remaining');
    if (res.status === 401 && tokens && attempt === 0) continue;
    if (res.status === 429) {
      const s = retrySeconds(res.headers.get('x-rate-limit-retry-after-seconds'));
      return { retryAfterMs: (s ?? 600) * 1000, remaining };
    }
    if (!res.ok) throw new Error(`states HTTP ${res.status}`);
    const text = await res.text();
    return { body: text, remaining };
  }
  throw new Error('states HTTP 401 after token refresh');
}

// ---- R2 (aws CLI, as upload.sh) ----------------------------------------------------------------------

function r2(opts) {
  const { R2_ACCOUNT_ID: acc, AWS_ACCESS_KEY_ID: k, AWS_SECRET_ACCESS_KEY: s } = process.env;
  if (!acc || !k || !s) return null;
  const bucket = process.env.R2_BUCKET || 'orbis-live';
  const env = { ...process.env, AWS_DEFAULT_REGION: 'auto', AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' };
  const aws = (args) => sh('aws', [...args, '--endpoint-url', `https://${acc}.r2.cloudflarestorage.com`], { env, timeout: 60000 });
  return {
    bucket,
    cp: (from, to, extra = []) => aws(['s3', 'cp', from, to, '--only-show-errors', ...extra]),
    async age(key) {
      // seconds since the object was written; null when missing or unreadable
      try {
        const { stdout } = await aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--query', 'LastModified', '--output', 'text']);
        const t = Date.parse(stdout.trim());
        return Number.isNaN(t) ? null : (Date.now() - t) / 1000;
      } catch {
        return null;
      }
    },
  };
}

async function updateManifest(store, tmp, bytes) {
  const mf = join(tmp, 'manifest.json');
  let m = {};
  try {
    await store.cp(`s3://${store.bucket}/manifest.json`, mf);
    m = JSON.parse(readFileSync(mf, 'utf8'));
  } catch {
    log('manifest not readable, skipped');
    return; // never overwrite a manifest we could not read
  }
  const [, source = '', license = ''] = RULES.find(([re]) => re.test(KEY)) ?? [];
  m[KEY] = { updated: new Date().toISOString(), bytes, source, license };
  writeFileSync(mf, JSON.stringify(m));
  await store.cp(mf, `s3://${store.bucket}/manifest.json`, ['--cache-control', 'public, max-age=60, stale-while-revalidate=300', '--content-type', 'application/json']);
}

// ---- main --------------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : process.env.OPENSKY_OUT || 'out/aircraft';
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  const authed = Boolean(id && secret);
  const once = args.includes('--once') || !authed; // anonymous: a single fetch, never a loop
  const intervalMs = Math.max(Number(process.env.INTERVAL_S) || MIN_INTERVAL_S, MIN_INTERVAL_S) * 1000;
  const loopMs = (Number(process.env.LOOP_MINUTES) || 350) * 60 * 1000;
  const endAt = Date.now() + loopMs;
  const tokens = authed ? tokenSource(id, secret) : null;
  const store = authed ? r2() : null;
  mkdirSync(out, { recursive: true });
  const tmp = join(out, '.tmp');
  mkdirSync(tmp, { recursive: true });
  if (!authed) log('no OPENSKY_CLIENT_ID/SECRET: one anonymous fetch, no upload');
  else if (!store) log('no R2 credentials: writing to the output directory only');

  // a restarted loop must not fetch right after the previous one (credits): wait for the rest of the interval
  if (store) {
    const age = await store.age(KEY);
    if (age !== null && age * 1000 < intervalMs) {
      const wait = intervalMs - age * 1000;
      log(`snapshot is ${Math.round(age)} s old, waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }

  let round = 0;
  let fails = 0;
  for (;;) {
    const startedAt = Date.now();
    let retryAfterMs = 0;
    try {
      const r = await fetchStates(tokens);
      if (r.remaining !== null) log(`credits remaining: ${r.remaining}`);
      if (r.retryAfterMs !== undefined) {
        retryAfterMs = r.retryAfterMs;
        throw new Error(`rate limited, retry after ${Math.round(retryAfterMs / 1000)} s`);
      }
      const err = checkStates(JSON.parse(r.body));
      if (err) throw new Error(`unusable answer: ${err}`);
      const gz = gzipSync(r.body, { level: 9 });
      writeFileSync(join(out, 'opensky-states.json.gz'), gz);
      if (store) {
        const file = join(tmp, 'opensky-states.json.gz');
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
      log(`round ${round}: ${r.body.length} bytes, ${gz.length} gzip${store ? ', uploaded' : ''}`);
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

if (process.argv[1]?.endsWith('opensky-loop.mjs')) await main();
