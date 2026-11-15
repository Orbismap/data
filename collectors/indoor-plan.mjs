// Plan helper for indoor workflow: reads state files and prints JSON array of regions to refresh.
// Usage: node collectors/indoor-plan.mjs <stateDir> [region|all]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REGIONS = ['europe', 'russia', 'asia', 'north-america', 'central-america', 'south-america', 'africa', 'oceania'];
const MAX_AGE_DAYS = 30;

function main() {
  const dir = process.argv[2] || 'state';
  const arg = process.argv[3] || '';

  const state = {};
  for (const r of REGIONS) {
    const f = join(dir, `${r}.json`);
    try {
      if (existsSync(f)) {
        const d = JSON.parse(readFileSync(f, 'utf8'));
        state[r] = d.built ? new Date(d.built) : null;
      } else {
        state[r] = null;
      }
    } catch {
      state[r] = null;
    }
  }

  let toRefresh = [];
  if (arg === 'all') {
    toRefresh = [...REGIONS];
  } else if (arg && REGIONS.includes(arg)) {
    toRefresh = [arg];
  } else {
    const now = Date.now();
    const stale = REGIONS.filter((r) => {
      if (!state[r]) return true;
      return (now - state[r].getTime()) > MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    });
    if (stale.length === 0) {
      const sorted = [...REGIONS].sort((a, b) => (state[a]?.getTime() || 0) - (state[b]?.getTime() || 0));
      toRefresh = [sorted[0]];
    } else {
      const oldest = stale.sort((a, b) => (state[a]?.getTime() || 0) - (state[b]?.getTime() || 0))[0];
      toRefresh = [oldest];
    }
  }

  console.log(JSON.stringify(toRefresh));
}

main();
EOF
node --check /Users/malte/Develpoment/Websites/orbis-data/collectors/indoor-plan.mjs && echo "OK" && node /Users/malte/Develpoment/Websites/orbis-data/collectors/indoor-plan.mjs /tmp 2>&1 | tail -3