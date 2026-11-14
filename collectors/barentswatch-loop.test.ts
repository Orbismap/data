import { describe, expect, it } from 'vitest';
// @ts-expect-error – plain JS collector
import { MAX_AGE_S, MIN_SHIPS, WINDOW_MIN, checkArea, checkLatest, latestUrl, nextDelayMs } from './barentswatch-loop.mjs';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ships = (n: number, at = NOW - 30_000) => Array.from({ length: n }, (_, i) => ({ mmsi: 257000000 + i, msgtime: new Date(at).toISOString() }));

describe('latestUrl', () => {
  it('asks for the full model as JSON since the window start', () => {
    const u = new URL(latestUrl(NOW));
    expect(u.pathname).toBe('/v1/latest/combined');
    expect(u.searchParams.get('modelType')).toBe('Full');
    expect(u.searchParams.get('modelFormat')).toBe('Json');
    expect(Date.parse(u.searchParams.get('since')!)).toBe(NOW - WINDOW_MIN * 60_000);
  });
});

describe('checkLatest', () => {
  it('accepts a fresh list', () => {
    expect(checkLatest(ships(MIN_SHIPS), NOW)).toBeNull();
  });
  it('rejects non-arrays, short, undated and stale answers', () => {
    expect(checkLatest(null, NOW)).not.toBeNull();
    expect(checkLatest({ ships: [] }, NOW)).not.toBeNull();
    expect(checkLatest(ships(MIN_SHIPS - 1), NOW)).not.toBeNull();
    expect(checkLatest(ships(MIN_SHIPS).map(({ mmsi }) => ({ mmsi })), NOW)).not.toBeNull();
    expect(checkLatest(ships(MIN_SHIPS, NOW - MAX_AGE_S * 1000 - 1000), NOW)).not.toBeNull();
  });
});

describe('timing', () => {
  it('measures the interval from the fetch start and lets a rate limit win', () => {
    expect(nextDelayMs(1000, 5000, 60_000)).toBe(56_000);
    expect(nextDelayMs(1000, 2000, 60_000, 300_000)).toBe(300_000);
  });
});

describe('checkArea', () => {
  it('accepts a MultiPolygon and rejects the rest', () => {
    expect(checkArea({ type: 'MultiPolygon', coordinates: [[[[10, 60], [11, 60], [11, 61], [10, 60]]]] })).toBeNull();
    expect(checkArea({ type: 'MultiPolygon', coordinates: [] })).not.toBeNull();
    expect(checkArea({ type: 'Point', coordinates: [10, 60] })).not.toBeNull();
    expect(checkArea(null)).not.toBeNull();
  });
});
