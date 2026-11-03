// Test double for a D1 database on top of node:sqlite (built in since Node 22.5, no native add-on): real SQL, so the
// migrations in workers/*/migrations run unchanged. Implements prepare().bind() with first/all/run and batch().
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// node:sqlite is not known to Vite's module graph, so it is loaded the CommonJS way
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

class Stmt {
  params: unknown[] = [];
  constructor(
    readonly db: any,
    readonly sql: string,
  ) {}
  bind(...p: unknown[]) {
    const s = new Stmt(this.db, this.sql);
    s.params = p;
    return s;
  }
  // node:sqlite treats ?1 as a *named* parameter: ?N becomes $pN and the values are passed by name
  private stmt() {
    return this.db.prepare(this.sql.replace(/\?(\d+)/g, '$$p$1'));
  }
  private args() {
    return [Object.fromEntries(this.params.map((v, i) => [`p${i + 1}`, v]))];
  }
  private plain(row: any) {
    return row ? { ...row } : null;
  }
  async first() {
    return this.plain(this.stmt().get(...this.args()));
  }
  async all() {
    return { results: this.stmt().all(...this.args()).map((r: any) => ({ ...r })), success: true };
  }
  runSync() {
    const r = this.stmt().run(...this.args());
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  async run() {
    return this.runSync();
  }
}

/** a fresh in-memory D1 with the given migration files applied; `calls` counts batch() calls */
export function fakeD1(migrations: string[]) {
  const db = new DatabaseSync(':memory:');
  for (const f of migrations) db.exec(readFileSync(f, 'utf8'));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    // one transaction: all statements or none
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(s.runSync()); // synchronous: no other batch can start inside the transaction
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    raw: db,
  };
}
