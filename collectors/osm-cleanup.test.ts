import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs collector
import { cleanup } from './osm-cleanup.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const H = 3600e3;
const now = Date.parse('2026-12-02T12:00:00Z');
const entry = (bytes: number) => ({ updated: '2026-12-01T05:00:00.000Z', bytes, source: 's', license: 'l' });
const meta = (retired: { file: string; at?: number }[]) => ({ format: 9, version: '2026-12-01', files: { cctv: 'cctv-2026-12-01.pmtiles', roofs: 'roofs-2026-12-01.pmtiles' }, sets: {}, retired });
const manifest = () => ({
  'cctv-2026-11-01.pmtiles': entry(1),
  'cctv-2026-11-20.pmtiles': entry(2),
  'cctv-2026-12-01.pmtiles': entry(3),
  'karte/overlay.pmtiles': entry(4),
  'meta.json': entry(999),
});

describe('cleanup of superseded versions', () => {
  it('waits for the cache time', () => {
    const m = meta([{ file: 'cctv-2026-11-20.pmtiles', at: now - 24 * H + 1 }]);
    const r = cleanup(m, manifest(), now);
    expect(r.due).toEqual([]);
    expect(r.meta).toEqual(m);
    expect(r.manifest).toEqual(manifest());
  });

  it('lists what is due and takes it out of meta.retired and the manifest, the rest stays', () => {
    const young = { file: 'cctv-2026-11-20.pmtiles', at: now - H };
    const m = meta([{ file: 'cctv-2026-11-01.pmtiles', at: now - 24 * H }, young]);
    const r = cleanup(m, manifest(), now);
    expect(r.due).toEqual(['cctv-2026-11-01.pmtiles']);
    expect(r.meta).toEqual({ ...m, retired: [young] });
    expect(m.retired).toHaveLength(2);
    expect(Object.keys(r.manifest)).toEqual(['cctv-2026-11-20.pmtiles', 'cctv-2026-12-01.pmtiles', 'karte/overlay.pmtiles', 'meta.json']);
    // new size, but still the time of the build (the health check measures its age)
    expect(r.manifest['meta.json']).toEqual({ ...entry(999), bytes: JSON.stringify(r.meta).length });
  });

  it('never lists a published file, even if meta.retired names it', () => {
    const r = cleanup(meta([{ file: 'cctv-2026-12-01.pmtiles', at: now - 99 * H }, { file: 'cctv-2026-11-01.pmtiles', at: now - 99 * H }]), manifest(), now);
    expect(r.due).toEqual(['cctv-2026-11-01.pmtiles']);
    expect(r.manifest['cctv-2026-12-01.pmtiles']).toBeDefined();
  });

  it('keeps an entry without a time', () => {
    expect(cleanup(meta([{ file: 'cctv-2026-11-01.pmtiles' }]), null, now).due).toEqual([]);
  });

  it('refuses when meta.json names no current files', () => {
    const retired = [{ file: 'cctv.pmtiles', at: now - 99 * H }];
    for (const m of [{ retired }, { files: {}, retired }, null]) expect(() => cleanup(m, null, now)).toThrow(/no current files/);
  });

  it('refuses keys other than tile versions in the top level', () => {
    for (const file of ['meta.json', 'LICENSE.txt', 'heat/cctv.json', 'karte/overlay.pmtiles', '../x.pmtiles', 'a.pmtiles\nmeta.json']) {
      expect(() => cleanup(meta([{ file, at: now - 99 * H }]), null, now)).toThrow(/no tile versions/);
    }
  });
});

describe('osm-cleanup command', () => {
  const script = fileURLToPath(new URL('./osm-cleanup.mjs', import.meta.url));
  const run = (retired: object[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-clean-'));
    const [metaPath, listPath, manifestPath] = ['meta.json', 'delete.txt', 'manifest.json'].map((f) => join(dir, f));
    writeFileSync(metaPath, JSON.stringify(meta(retired as { file: string; at: number }[]), null, 1));
    writeFileSync(manifestPath, JSON.stringify(manifest(), null, 1));
    const before = [readFileSync(metaPath, 'utf8'), readFileSync(manifestPath, 'utf8')];
    execFileSync(process.execPath, [script, metaPath, listPath, manifestPath], { stdio: 'pipe' });
    return { before, after: [readFileSync(metaPath, 'utf8'), readFileSync(manifestPath, 'utf8')], list: readFileSync(listPath, 'utf8') };
  };

  it('writes the delete list and rewrites both files', () => {
    const r = run([{ file: 'cctv-2026-11-01.pmtiles', at: 0 }, { file: 'cctv-2026-11-20.pmtiles', at: 0 }]);
    expect(r.list).toBe('cctv-2026-11-01.pmtiles\ncctv-2026-11-20.pmtiles\n');
    expect(JSON.parse(r.after[0]).retired).toEqual([]);
    expect(JSON.parse(r.after[1])['cctv-2026-11-01.pmtiles']).toBeUndefined();
  });

  it('leaves both files alone and writes an empty list when nothing is due', () => {
    const r = run([]);
    expect(r.list).toBe('');
    expect(r.after).toEqual(r.before);
  });
});
