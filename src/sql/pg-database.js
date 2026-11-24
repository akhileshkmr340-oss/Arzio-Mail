// A PostgreSQL database with the same synchronous interface as node:sqlite's
// DatabaseSync (prepare().get/all/run, exec, close), so the rest of Arzio
// runs unchanged on either database.
import { createBridge } from './bridge.js';
import { translateQuery, translateSchema } from './translate.js';

const isDdl = (sql) => /^\s*(--[^\n]*\n\s*)*(CREATE|ALTER|DROP|PRAGMA)\b/i.test(sql) || /CREATE\s+(TABLE|INDEX|TRIGGER|VIRTUAL)/i.test(sql);

export class PgDatabase {
  constructor(url, { ssl, schema } = {}) {
    this.dialect = 'postgres';
    if (schema === 'auto') schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    this.schema = schema || null;
    this.bridge = createBridge(new URL('./pg-handler.js', import.meta.url), { url, ssl, schema: this.schema });
    this.cache = new Map();
    this.pks = new Map();
    this.ctx = {
      tablesWithId: new Set(),
      primaryKey: (table) => this.primaryKey(table),
    };
    this.bridge.call('query', 'SELECT 1', []);
    const coll = this.bridge.call('query', "SELECT datcollate FROM pg_database WHERE datname = current_database()", []).rows[0]?.datcollate;
    if (coll && !/^(C|POSIX)(\.|$)/i.test(coll)) {
      console.warn(`[postgres] Database collation is ${coll}. Create the database with LC_COLLATE 'C' (see docs/OPERATIONS.md) so dates and addresses sort and compare exactly.`);
    }
    // Tables that already exist (on restart) and have an id column
    for (const r of this.bridge.call('query', "SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'", []).rows) this.ctx.tablesWithId.add(r.table_name);
  }

  primaryKey(table) {
    const t = table.toLowerCase();
    if (!this.pks.has(t)) {
      const rows = this.bridge.call('query', `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [t]).rows;
      this.pks.set(t, rows.map((r) => r.col));
    }
    return this.pks.get(t);
  }

  exec(sql) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) { this.bridge.call('exec', sql); return; }
    if (isDdl(sql)) {
      this.bridge.call('exec', translateSchema(sql, this.ctx));
      this.cache.clear();
      return;
    }
    // Plain statements without parameters
    for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) this.bridge.call('query', translateQuery(stmt, this.ctx).text, []);
  }

  prepare(sql) {
    let t = this.cache.get(sql);
    if (!t) { t = translateQuery(sql, this.ctx); this.cache.set(sql, t); }
    const run = (params) => {
      try {
        return this.bridge.call('query', t.text, params.map(toPg));
      } catch (e) {
        e.message = `${e.message} [SQL: ${t.text.slice(0, 300)}]`;
        throw e;
      }
    };
    return {
      get: (...p) => run(p).rows[0],
      all: (...p) => run(p).rows,
      run: (...p) => { const r = run(p); return { changes: r.rowCount, lastInsertRowid: t.returnsId ? r.rows[0]?.id : undefined }; },
    };
  }

  close() {
    try { this.bridge.call('end'); } catch { /* closing */ }
    this.bridge.close();
  }
}

function toPg(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  return v;
}
