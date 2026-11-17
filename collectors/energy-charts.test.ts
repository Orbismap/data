import { describe, expect, it } from 'vitest';
// @ts-expect-error – plain JS collector
import { collectEnergy, mixFromPower, priceAt } from './energy-charts.mjs';

const T0 = 1_794_870_000; // seconds
const power = {
  unix_seconds: [T0, T0 + 900, T0 + 1800],
  production_types: [
    { name: 'Wind onshore', data: [100, 200, null] },
    { name: 'Wind offshore', data: [50, 50, null] },
    { name: 'Solar', data: [0, 10, null] },
    { name: 'Fossil gas', data: [300, 240, null] },
    { name: 'Nuclear', data: [100, 100, null] },
    { name: 'Hydro pumped storage consumption', data: [-10, -10, null] },
    { name: 'Load', data: [800, 700, null] },
  ],
};

describe('mixFromPower', () => {
  it('takes the newest step with data and sums the groups', () => {
    const m = mixFromPower(power);
    expect(m.t).toBe((T0 + 900) * 1000);
    expect(m.gen).toMatchObject({ wind: 250, solar: 10, fossil: 240, nuclear: 100, hydro: 0 });
    expect(m.load).toBe(700);
    expect(m.share).toBeCloseTo((260 / 600) * 100, 1);
  });
  it('rejects answers without generation', () => {
    expect(mixFromPower(null)).toBeNull();
    expect(mixFromPower({ unix_seconds: [1], production_types: [{ name: 'Load', data: [5] }] })).toBeNull();
  });
});

describe('priceAt', () => {
  it('uses the step at or before the time', () => {
    const p = { unix_seconds: [T0, T0 + 3600], price: [80, 95] };
    expect(priceAt(p, (T0 + 900) * 1000)).toBe(80);
    expect(priceAt(p, (T0 + 4000) * 1000)).toBe(95);
    expect(priceAt(p, (T0 - 10) * 1000)).toBeNull();
  });
});

describe('collectEnergy', () => {
  it('collects countries, keeps a missing price null and skips failures', async () => {
    const calls: string[] = [];
    const get = async (url: string) => {
      calls.push(url);
      if (url.includes('country=xx')) throw new Error('HTTP 404');
      if (url.includes('/price')) return { unix_seconds: [T0 + 900], price: [42] };
      return power;
    };
    const out = await collectEnergy(get, { gapMs: 0, now: (T0 + 1000) * 1000, countries: { de: 'DE-LU', gb: null, xx: null } });
    expect(Object.keys(out.countries)).toEqual(['de', 'gb']);
    expect(out.countries.de.price).toBe(42);
    expect(out.countries.gb.price).toBeNull();
    expect(out.time).toBe((T0 + 900) * 1000);
    expect(calls.filter((c) => c.includes('/price'))).toHaveLength(1);
  });
});
