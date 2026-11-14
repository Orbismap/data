// Data health check: are the published files fresh, did the workflows run through?
//   node collectors/health.mjs [--dry-run]
// --dry-run prints the issue body instead of talking to GitHub issues (workflow runs are still read via gh when available).
// Problems -> ONE open issue "Datenstatus: Probleme" (label `health`) is created/updated; no problems and issue open -> comment + close.
// Needs in Actions: GH_TOKEN (GITHUB_TOKEN), GITHUB_REPOSITORY; permissions issues: write, actions: read, contents: read.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(execFile);
const MIN = 60 * 1000;
const H = 60 * MIN;
const D = 24 * H;

// ---- thresholds: bucket -> [manifest key, max age] -------------------------------------------------------
export const THRESHOLDS = {
  'orbis-live': [
    ['events/usgs-2.5_week.geojson', 30 * MIN],
    ['firms/world.json', 60 * MIN],
    ['safecast.json', 60 * MIN],
    ['space/launches/upcoming.json', 60 * MIN],
    ['space/tle/stations.txt', 6 * H],
    ['stuk-fi.json', 60 * MIN],
    ['hc-ca.json', 60 * MIN],
    ['aircraft/opensky-states.json', 15 * MIN], // loop uploads every 90 s, the manifest entry is refreshed every ~6 min
    ['ais/barentswatch-latest.json', 15 * MIN], // loop uploads every 60 s, the manifest entry is refreshed every ~6 min
  ],
  'orbis-data': [
    ['meta.json', 50 * H],
    ['volcanoes.json', 50 * H],
  ],
  'orbis-osm': [['meta.json', 40 * D]],
};
export const WETTER_MAX_AGE = 14 * H; // orbis-wetter v1/latest.json: age of the ICON run (field `issued`)
export const MAX_FAILURE_RATIO = 0.3; // workflow runs of the last 24 h
export const MIN_RUNS_FOR_RATIO = 2; // fewer runs: a single failure is not a ratio
const HOST = (bucket) => `https://${bucket}.maltee.dev`;

const fmt = (ms) => (ms >= D ? `${(ms / D).toFixed(1)} d` : ms >= H ? `${(ms / H).toFixed(1)} h` : `${Math.round(ms / MIN)} min`);
const dry = process.argv.includes('--dry-run');
const repo = process.env.GITHUB_REPOSITORY || 'Orbismap/data';
const TITLE = 'Datenstatus: Probleme';

async function getJson(url) {
  const res = await fetch(`${url}?health=${Date.now()}`, { headers: { 'User-Agent': 'orbis-health' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function checkFreshness() {
  const problems = [];
  const now = Date.now();
  for (const [bucket, rules] of Object.entries(THRESHOLDS)) {
    const url = `${HOST(bucket)}/manifest.json`;
    let manifest;
    try {
      manifest = await getJson(url);
    } catch (e) {
      problems.push(`[${bucket}](${url}): manifest.json nicht lesbar (${e.message})`);
      continue;
    }
    for (const [key, max] of rules) {
      const updated = manifest[key]?.updated;
      const t = Date.parse(updated);
      if (!updated || Number.isNaN(t)) problems.push(`[${bucket}/${key}](${HOST(bucket)}/${key}): fehlt im Manifest`);
      else if (now - t > max) problems.push(`[${bucket}/${key}](${HOST(bucket)}/${key}): ${fmt(now - t)} alt (Grenze ${fmt(max)}), zuletzt ${updated}`);
    }
  }
  const url = `${HOST('orbis-wetter')}/v1/latest.json`;
  try {
    const latest = await getJson(url);
    let t = Number(latest.issued);
    if (!t && /^\d{10}$/.test(latest.run ?? '')) t = Date.UTC(+latest.run.slice(0, 4), +latest.run.slice(4, 6) - 1, +latest.run.slice(6, 8), +latest.run.slice(8, 10));
    if (!t) problems.push(`[orbis-wetter/v1/latest.json](${url}): kein Laufzeitfeld (issued/run)`);
    else if (now - t > WETTER_MAX_AGE) problems.push(`[orbis-wetter/v1/latest.json](${url}): Lauf ${latest.run} ist ${fmt(now - t)} alt (Grenze ${fmt(WETTER_MAX_AGE)})`);
  } catch (e) {
    problems.push(`[orbis-wetter/v1/latest.json](${url}): nicht lesbar (${e.message})`);
  }
  return problems;
}

async function checkWorkflows() {
  const problems = [];
  let runs;
  try {
    const { stdout } = await sh('gh', ['run', 'list', '--repo', repo, '--limit', '200', '--json', 'name,conclusion,status,createdAt,url,workflowName'], { maxBuffer: 20e6 });
    runs = JSON.parse(stdout);
  } catch (e) {
    return [`Workflow-Läufe nicht lesbar (\`gh run list\`): ${String(e.message).split('\n')[0]}`];
  }
  const since = Date.now() - D;
  const byName = new Map();
  for (const r of runs) {
    if (Date.parse(r.createdAt) < since || !r.conclusion || r.conclusion === 'skipped' || r.conclusion === 'cancelled') continue; // running/skipped/cancelled do not count
    const name = r.workflowName || r.name;
    const e = byName.get(name) ?? { total: 0, failed: [] };
    e.total++;
    if (r.conclusion !== 'success') e.failed.push(r);
    byName.set(name, e);
  }
  for (const [name, e] of byName) {
    if (e.total >= MIN_RUNS_FOR_RATIO && e.failed.length / e.total > MAX_FAILURE_RATIO) {
      problems.push(`Workflow **${name}**: ${e.failed.length} von ${e.total} Läufen der letzten 24 h fehlgeschlagen (${Math.round((100 * e.failed.length) / e.total)} %, Grenze ${MAX_FAILURE_RATIO * 100} %), z. B. ${e.failed.slice(0, 3).map((r) => r.url).join(', ')}`);
    }
  }
  return problems;
}

async function gh(args) {
  return (await sh('gh', args, { maxBuffer: 20e6 })).stdout;
}

const problems = [...(await checkFreshness()), ...(await checkWorkflows())];
const stamp = new Date().toISOString();
const body = problems.length
  ? `Automatische Prüfung (${stamp}, [collectors/health.mjs](https://github.com/${repo}/blob/main/collectors/health.mjs)):\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\nWorkflow-Läufe: https://github.com/${repo}/actions`
  : '';

if (dry) {
  console.log(problems.length ? `# ${TITLE}\n\n${body}` : 'Keine Probleme - ein offenes Issue würde mit "wieder ok" geschlossen.');
  process.exit(0);
}

const open = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--label', 'health', '--state', 'open', '--search', `"${TITLE}" in:title`, '--json', 'number,title']));
const issue = open.find((i) => i.title === TITLE);
if (problems.length) {
  if (issue) {
    await gh(['issue', 'edit', String(issue.number), '--repo', repo, '--body', body]);
    console.log(`updated issue #${issue.number}`);
  } else {
    try {
      await gh(['label', 'create', 'health', '--repo', repo, '--color', 'd93f0b', '--description', 'Datenstatus-Prüfung']);
    } catch {
      // label exists
    }
    console.log((await gh(['issue', 'create', '--repo', repo, '--title', TITLE, '--label', 'health', '--body', body])).trim());
  }
} else if (issue) {
  await gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', 'wieder ok']);
  await gh(['issue', 'close', String(issue.number), '--repo', repo]);
  console.log(`closed issue #${issue.number}`);
} else {
  console.log('ok');
}
