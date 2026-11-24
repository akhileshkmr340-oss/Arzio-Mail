// Runs inside the bridge worker: one PostgreSQL connection, queries in order.
import pg from 'pg';

// Return integers and numbers as JS numbers, like SQLite does
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(701, (v) => (v === null ? null : Number(v)));  // float8

export async function init({ url, ssl, schema }) {
  const client = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: ssl !== 'no-verify' } : undefined });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('ARZIO_DB_SCHEMA must be lowercase letters, digits and _');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  }
  client.on('error', (e) => console.error('[postgres]', e.message));
  return {
    async query(text, params) {
      const r = await client.query({ text, values: params });
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(text) {
      await client.query(text);
      return true;
    },
    async end() { await client.end(); return true; },
  };
}
