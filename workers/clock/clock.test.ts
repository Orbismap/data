import { describe, expect, it } from 'vitest';
// @ts-expect-error – plain JS worker file, deployed on its own
import { DISPATCH, dispatchDue } from './src/index.js';

const at = (iso: string) => new Date(iso);

describe('dispatchDue', () => {
  it('picks the entries of this minute, hour and weekday (UTC)', () => {
    // Monday 2026-11-16 04:05 UTC
    const ids = dispatchDue(DISPATCH, at('2026-11-16T04:05:00Z')).map((d: { id: string }) => d.id);
    expect(ids).toContain('weekly');
    expect(ids).not.toContain('daily');
    expect(dispatchDue(DISPATCH, at('2026-11-17T04:05:00Z')).map((d: { id: string }) => d.id)).not.toContain('weekly');
  });
  it('dispatches everything with runAll', () => {
    expect(dispatchDue(DISPATCH, at('2026-11-16T04:06:00Z'), true)).toHaveLength(DISPATCH.length);
  });
});

describe('opensky dispatch', () => {
  const opensky = DISPATCH.filter((d: { event: string }) => d.event === 'opensky');
  it('exists once, with the workflow event name', () => {
    expect(opensky).toHaveLength(1);
  });
  it('runs hourly, never more often (the loop spends the credits)', () => {
    let n = 0;
    for (let m = 0; m < 24 * 60; m++) n += dispatchDue(opensky, new Date(Date.UTC(2026, 10, 16, 0, m))).length;
    expect(n).toBe(24);
  });
});
