import { describe, expect, it } from 'vitest';
// @ts-expect-error – plain JS collector
import { MAX_AGE_S, MIN_INTERVAL_S, MIN_STATES, checkStates, nextDelayMs, retrySeconds } from './opensky-loop.mjs';

const states = (n: number) => Array.from({ length: n }, () => ['abc123']);
const NOW = 1_800_000_000;

describe('checkStates', () => {
  it('accepts a fresh global snapshot', () => {
    expect(checkStates({ time: NOW - 20, states: states(MIN_STATES) }, NOW)).toBeNull();
  });
  it('rejects empty, short, undated and stale answers', () => {
    expect(checkStates(null, NOW)).not.toBeNull();
    expect(checkStates({ time: NOW, states: null }, NOW)).not.toBeNull();
    expect(checkStates({ time: NOW, states: states(MIN_STATES - 1) }, NOW)).not.toBeNull();
    expect(checkStates({ states: states(MIN_STATES) }, NOW)).not.toBeNull();
    expect(checkStates({ time: NOW - MAX_AGE_S - 1, states: states(MIN_STATES) }, NOW)).not.toBeNull();
  });
});

describe('timing', () => {
  it('measures the interval from the fetch start', () => {
    expect(nextDelayMs(1000, 1000 + 4000, 90_000)).toBe(86_000);
    expect(nextDelayMs(1000, 1000 + 120_000, 90_000)).toBe(0);
  });
  it('lets a rate limit win', () => {
    expect(nextDelayMs(1000, 2000, 90_000, 600_000)).toBe(600_000);
  });
  it('keeps the credit budget: 4 credits per fetch, 4000 per day', () => {
    expect((86_400 / MIN_INTERVAL_S) * 4).toBeLessThanOrEqual(4000);
  });
  it('reads Retry-After seconds', () => {
    expect(retrySeconds('120')).toBe(120);
    expect(retrySeconds(null)).toBeNull();
    expect(retrySeconds('x')).toBeNull();
  });
});
