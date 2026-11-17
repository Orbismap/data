// Electricity mix and day-ahead price per country (Energy-Charts, Fraunhofer ISE; prices Bundesnetzagentur | SMARD.de),
// CC BY 4.0. Browsers cannot ask the API for 25 countries themselves: it sends CORS only for its own site and answers
// 429 to bursts, so this collector asks politely (one call at a time) and writes ONE snapshot, energy/mix.json:
//   { v: 1, updated: ISO, time: ms of the newest step, countries: { de: { t, load, share, gen: { wind, solar, hydro, biomass,
//     nuclear, fossil, other }, price } } }
// gen in MW (generation only, pumped storage and cross-border trading left out), share = renewables of generation in %,
// price in EUR/MWh of the 15-minute or hourly step at `t` (null where the zone is unknown).

export const API = 'https://api.energy-charts.info';
/** country code -> bidding zone of the price endpoint */
export const COUNTRIES = {
  de: 'DE-LU', fr: 'FR', at: 'AT', ch: 'CH', nl: 'NL', be: 'BE', pl: 'PL', cz: 'CZ', dk: 'DK1', es: 'ES', pt: 'PT', it: 'IT-North',
  gb: null, no: 'NO2', se: 'SE3', fi: 'FI', hu: 'HU', ro: 'RO', bg: 'BG', gr: 'GR', sk: 'SK', si: 'SI', hr: 'HR', rs: 'RS',
  ie: null, lt: 'LT', lv: 'LV', ee: 'EE', lu: null,
};

const GROUPS = {
  wind: ['Wind onshore', 'Wind offshore'],
  solar: ['Solar'],
  hydro: ['Hydro Run-of-River', 'Hydro water reservoir'],
  biomass: ['Biomass'],
  nuclear: ['Nuclear'],
  fossil: ['Fossil brown coal / lignite', 'Fossil hard coal', 'Fossil oil', 'Fossil coal-derived gas', 'Fossil gas'],
  other: ['Waste', 'Geothermal', 'Others'],
};
const RENEWABLE = ['wind', 'solar', 'hydro', 'biomass'];

const lastIndex = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (typeof arr[i] === 'number') return i; return -1; };

/**
 * One country from a public_power answer: values of the newest step that has generation data.
 * Returns null when the answer has no usable step.
 */
export function mixFromPower(answer) {
  const times = answer?.unix_seconds;
  const types = answer?.production_types;
  if (!Array.isArray(times) || !Array.isArray(types)) return null;
  const by = Object.fromEntries(types.map((p) => [p.name, p.data ?? []]));
  // newest step where at least one source reports (the last steps of a day are often still empty)
  let i = -1;
  for (const names of Object.values(GROUPS)) for (const n of names) i = Math.max(i, lastIndex(by[n] ?? []));
  if (i < 0) return null;
  const at = (n) => (typeof by[n]?.[i] === 'number' ? Math.max(0, by[n][i]) : 0);
  const gen = Object.fromEntries(Object.entries(GROUPS).map(([k, names]) => [k, Math.round(names.reduce((s, n) => s + at(n), 0))]));
  const total = Object.values(gen).reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  const renewable = RENEWABLE.reduce((s, k) => s + gen[k], 0);
  const load = by.Load?.[i];
  return { t: times[i] * 1000, load: typeof load === 'number' ? Math.round(load) : null, share: Math.round((renewable / total) * 1000) / 10, gen };
}

/** Price (EUR/MWh) of the step at or before `t` (ms) from a price answer, or null. */
export function priceAt(answer, t) {
  const times = answer?.unix_seconds;
  const prices = answer?.price;
  if (!Array.isArray(times) || !Array.isArray(prices)) return null;
  let best = null;
  for (let i = 0; i < times.length; i++) if (times[i] * 1000 <= t && typeof prices[i] === 'number') best = prices[i];
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Collects all countries. `get(url)` returns parsed JSON or throws; calls run one at a time with `gapMs` in between
 * and a retry after a 429 (error message contains "429"). Countries without data are left out.
 */
export async function collectEnergy(get, { gapMs = 700, now = Date.now(), countries = COUNTRIES } = {}) {
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const range = `start=${day(now - 24 * 3600 * 1000)}&end=${day(now)}`;
  const ask = async (url) => {
    for (let attempt = 0; ; attempt++) {
      try { return await get(url); } catch (e) {
        if (attempt >= 2 || !/429/.test(String(e?.message ?? e))) throw e;
        await sleep(15_000 * (attempt + 1));
      }
    }
  };
  const out = {};
  let newest = 0;
  for (const [cc, zone] of Object.entries(countries)) {
    try {
      const mix = mixFromPower(await ask(`${API}/public_power?country=${cc}&${range}`));
      if (!mix) continue;
      let price = null;
      if (zone) {
        await sleep(gapMs);
        try { price = priceAt(await ask(`${API}/price?bzn=${zone}&${range}`), mix.t); } catch { /* the price is optional */ }
      }
      out[cc] = { ...mix, price };
      newest = Math.max(newest, mix.t);
    } catch (e) {
      console.warn(`  energy-charts ${cc}: ${e?.message ?? e}`);
    }
    await sleep(gapMs);
  }
  return { v: 1, updated: new Date(now).toISOString(), time: newest, countries: out };
}
