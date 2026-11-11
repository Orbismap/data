import { describe, expect, it } from 'vitest';
import { fakeD1 } from '../d1-fake';
// @ts-expect-error – plain JS worker file, deployed on its own
import worker from './src/index.js';

const migration = new URL('./migrations/0001_init.sql', import.meta.url).pathname;
const TOKEN = 'secret-token';
const OLD = {
  'cam:1': { d: 90, at: 1700000000000 },
  'cam:2': { d: 12.5, at: 1700000001000, p: { down: 10, alt: 5, roll: 0, fov: 60 }, pos: [11.4, 53.7] },
};

/** `seed`: entries that are in the table before the first request */
function setup(seed?: Record<string, unknown>) {
  const db = fakeD1([migration]);
  for (const [k, v] of Object.entries(seed ?? {})) db.raw.prepare('INSERT INTO dirs (key, value, updated_at) VALUES (?, ?, ?)').run(k, JSON.stringify(v), (v as { at?: number }).at ?? null);
  const env: Record<string, unknown> = { DB: db, ADMIN_TOKEN: TOKEN };
  const req = (method: string, path: string, body?: unknown, auth = true) =>
    worker.fetch(new Request(`https://w.example${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {} }), env);
  const rows = () => (db.raw.prepare('SELECT key, value FROM dirs ORDER BY key').all() as { key: string; value: string }[]).map((r) => [r.key, JSON.parse(r.value)]);
  return { env, db, req, rows };
}

describe('GET /dirs', () => {
  it('answers { dirs: {} } for an empty database, cacheable for 60 s', async () => {
    const { req } = setup();
    const res = await req('GET', '/dirs', undefined, false);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.text()).toBe('{"dirs":{}}');
  });
  it('assembles the same object as the old KV key, byte for byte', async () => {
    const { req } = setup(OLD);
    expect(await (await req('GET', '/dirs', undefined, false)).text()).toBe(JSON.stringify({ dirs: OLD }));
  });
  it('404 for other paths, 405 for other methods', async () => {
    const { req } = setup();
    expect((await req('GET', '/nope')).status).toBe(404);
    expect((await req('POST', '/dirs')).status).toBe(405);
  });
});

describe('PUT and DELETE /dirs', () => {
  it('need the admin token', async () => {
    const { req } = setup();
    expect((await req('PUT', '/dirs', { key: 'a', dir: 5 }, false)).status).toBe(401);
    expect((await req('DELETE', '/dirs?key=a', undefined, false)).status).toBe(401);
  });
  it('upsert one entry, optional pose and position, and overwrite it', async () => {
    const { req, rows } = setup();
    const res = await req('PUT', '/dirs', { key: 'cam:3', dir: 123.46, pose: { down: 5, alt: 3, roll: 0, fov: 70 }, pos: [11.1234567, 53.7] });
    expect(await res.text()).toBe('{"ok":true}');
    const [[k, v]] = rows();
    expect(k).toBe('cam:3');
    expect(v).toMatchObject({ d: 123.5, p: { down: 5, alt: 3, roll: 0, fov: 70 }, pos: [11.123457, 53.7] });
    await req('PUT', '/dirs', { key: 'cam:3', dir: 10 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0][1]).toMatchObject({ d: 10 });
    expect(rows()[0][1].p).toBeUndefined();
  });
  it('validates key, direction, pose and position', async () => {
    const { req } = setup();
    expect((await req('PUT', '/dirs', { key: 'a', dir: 360 })).status).toBe(400);
    expect((await req('PUT', '/dirs', { key: '', dir: 1 })).status).toBe(400);
    expect((await req('PUT', '/dirs', { key: 'a', dir: 1, pose: { down: 99, alt: 1, roll: 0, fov: 60 } })).status).toBe(400);
    expect((await req('PUT', '/dirs', { key: 'a', dir: 1, pos: [500, 0] })).status).toBe(400);
  });
  it('DELETE removes one entry and keeps the others', async () => {
    const { req, rows } = setup(OLD);
    expect(await (await req('DELETE', '/dirs?key=cam:1')).text()).toBe('{"ok":true}');
    expect(rows().map(([k]) => k)).toEqual(['cam:2']);
    expect((await req('DELETE', '/dirs?key=')).status).toBe(400);
  });
  it('refuses a new entry beyond 20000 but still updates existing ones', async () => {
    const { req, db } = setup();
    db.raw.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO dirs SELECT 'k' || i, '{\"d\":1,\"at\":1}', 1 FROM n");
    expect((await req('PUT', '/dirs', { key: 'new', dir: 1 })).status).toBe(413);
    expect((await req('PUT', '/dirs', { key: 'k5', dir: 2 })).status).toBe(200);
  });
  it('two writes at the same time both survive', async () => {
    const { req, rows } = setup();
    await Promise.all([req('PUT', '/dirs', { key: 'a', dir: 1 }), req('PUT', '/dirs', { key: 'b', dir: 2 })]);
    expect(rows().map(([k]) => k)).toEqual(['a', 'b']);
  });
});
