// Translates the SQLite SQL used across Arzio into PostgreSQL, so one set of
// queries serves both databases. It covers what this codebase uses: ?
// placeholders, datetime()/date() arithmetic, INSERT OR IGNORE/REPLACE,
// case-insensitive LIKE, group_concat, instr, IS ?, last insert id, and the
// schema (identity keys, FTS, triggers).

// Walks SQL outside of quoted strings, identifiers and comments.
function scan(sql, onCode) {
  let out = '';
  let i = 0;
  let code = '';
  const flush = () => { if (code) { out += onCode(code); code = ''; } };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      flush();
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
    } else if (c === '$' && sql[i + 1] === '$') {
      flush();
      const j = sql.indexOf('$$', i + 2);
      out += sql.slice(i, j + 2);
      i = j + 2;
    } else { code += c; i++; }
  }
  flush();
  return out;
}

// Finds name( ... ) calls (outside strings) and replaces them with fn(args[]).
function rewriteCalls(sql, name, fn) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(sql))) {
    if (inString(sql, m.index)) continue;
    let depth = 1; let j = m.index + m[0].length; const start = j; const args = []; let argStart = start;
    let q = null;
    for (; j < sql.length && depth > 0; j++) {
      const c = sql[j];
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) args.push(sql.slice(argStart, j).trim()); }
      else if (c === ',' && depth === 1) { args.push(sql.slice(argStart, j).trim()); argStart = j + 1; }
    }
    result += sql.slice(last, m.index) + fn(args);
    last = j;
    re.lastIndex = j;
  }
  return result + sql.slice(last);
}
function inString(sql, idx) {
  let q = null;
  for (let i = 0; i < idx; i++) {
    const c = sql[i];
    if (q) { if (c === q) { if (sql[i + 1] === q) { i++; continue; } q = null; } } else if (c === "'" || c === '"') q = c;
  }
  return !!q;
}

const TS = "'YYYY-MM-DD HH24:MI:SS'";
function timeExpr(args, fmt) {
  const [first, ...mods] = args;
  const base = /^'now'$/i.test(first) ? "timezone('utc', now())" : `(${first})::timestamp`;
  const plus = mods.map((m) => ` + (${m})::interval`).join('');
  return `to_char(${base}${plus}, ${fmt})`;
}

function common(sql) {
  sql = rewriteCalls(sql, 'datetime', (a) => timeExpr(a, TS));
  sql = rewriteCalls(sql, 'date', (a) => (a.length && /^'now'$|::|\(/i.test(a[0]) || a.length > 1 ? timeExpr(a, "'YYYY-MM-DD'") : `date(${a.join(', ')})`));
  sql = rewriteCalls(sql, 'group_concat', (a) => `string_agg(${a[0]}, ${a[1] || "','"})`);
  sql = rewriteCalls(sql, 'instr', (a) => `strpos(${a[0]}, ${a[1]})`);
  // SQLite sums true/false as 1/0
  sql = rewriteCalls(sql, 'SUM', (a) => (/\bIS\b|[=<>]|\bLIKE\b|\bIN\s*\(/i.test(a[0]) && !/^\s*CASE\b/i.test(a[0]) ? `SUM(CASE WHEN ${a[0]} THEN 1 ELSE 0 END)` : `SUM(${a.join(', ')})`));
  return scan(sql, (code) => code
    .replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE')
    .replace(/(?<!NOT\s+|I)\bLIKE\b/gi, 'ILIKE')
    .replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?')
    .replace(/\?(\s+IS\s+(?:NOT\s+)?NULL)/gi, '?::text$1')
    .replace(/\bAS\s+([a-z]+[A-Z]\w*)\b/g, 'AS "$1"'));
}

function numberPlaceholders(sql) {
  let n = 0;
  return scan(sql, (code) => code.replace(/\?/g, () => `$${++n}`));
}

// ------------------------------------------------------------ queries
// ctx: { tablesWithId: Set, primaryKey(table) -> string[] }
export function translateQuery(sql, ctx) {
  let s = sql.trim().replace(/;\s*$/, '');
  const pragma = s.match(/^PRAGMA\s+table_info\((\w+)\)$/i);
  if (pragma) return { text: `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${pragma[1].toLowerCase()}'`, returnsId: false };
  if (/^PRAGMA\b/i.test(s)) return { text: 'SELECT 1 WHERE false', returnsId: false };
  s = common(s);
  let returnsId = false;
  const ins = s.match(/^INSERT\s+(?:OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)\s*(\(([^)]*)\))?/i);
  if (ins) {
    const [, mode, table, , colList] = ins;
    s = s.replace(/^INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO/i, 'INSERT INTO');
    if (mode && /ignore/i.test(mode)) s += ' ON CONFLICT DO NOTHING';
    if (mode && /replace/i.test(mode)) {
      const pk = ctx.primaryKey(table);
      const cols = (colList || '').split(',').map((c) => c.trim()).filter((c) => c && !pk.includes(c));
      s += ` ON CONFLICT (${pk.join(', ')}) ${cols.length ? `DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}` : 'DO NOTHING'}`;
    }
    if (ctx.tablesWithId.has(table.toLowerCase()) && !/\bRETURNING\b/i.test(s)) { s += ' RETURNING id'; returnsId = true; }
    // "DO UPDATE SET count = count + 1": name the table for the existing value
    s = s.replace(/(DO\s+UPDATE\s+SET\s+)([\s\S]*)$/i, (all, head, sets) => head + sets.replace(/=\s*(\w+)\s*([+-])/g, (x, col, op) => (/^excluded$/i.test(col) ? x : `= ${table}.${col} ${op}`)));
  }
  return { text: numberPlaceholders(s), returnsId };
}

// ------------------------------------------------------------ schema
const FTS = (name, cols) => `CREATE TABLE IF NOT EXISTS ${name} (
  rowid BIGINT PRIMARY KEY, ${cols.map((c) => `${c} TEXT NOT NULL DEFAULT ''`).join(', ')},
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', ${cols.map((c) => `coalesce(${c}, '')`).join(" || ' ' || ")})) STORED
);
CREATE INDEX IF NOT EXISTS ${name}_tsv ON ${name} USING gin(tsv)`;

// The IMAP UID triggers, written for PostgreSQL (BEFORE triggers set the UID directly)
const TRIGGERS = {
  trg_messages_uid_insert: `CREATE OR REPLACE FUNCTION arzio_uid_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE folders SET uid_next = uid_next + 1 WHERE id = NEW.folder_id RETURNING uid_next - 1 INTO NEW.imap_uid;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_messages_uid_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION arzio_uid_insert()`,
  trg_messages_uid_move: `CREATE OR REPLACE FUNCTION arzio_uid_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
    UPDATE folders SET uid_next = uid_next + 1 WHERE id = NEW.folder_id RETURNING uid_next - 1 INTO NEW.imap_uid;
    NEW.imap_deleted := 0;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_messages_uid_move BEFORE UPDATE OF folder_id ON messages FOR EACH ROW EXECUTE FUNCTION arzio_uid_move()`,
};

export function translateSchema(sql, ctx) {
  let s = sql.replace(/^\s*PRAGMA[^;]*;\s*$/gim, '');
  s = s.replace(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+(\w+)[\s\S]*?\bEND\s*;/gi, (all, name) => {
    if (!TRIGGERS[name]) throw new Error(`No PostgreSQL version of trigger ${name}`);
    return `${TRIGGERS[name]};`;
  });
  s = s.replace(/CREATE\s+VIRTUAL\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+USING\s+fts5\(([^)]*)\)/gi, (all, name, cols) => FTS(name, cols.split(',').map((c) => c.trim())));
  for (const m of s.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(\s*id\s+INTEGER\s+PRIMARY\s+KEY/gi)) ctx.tablesWithId.add(m[1].toLowerCase());
  s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\b/gi, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
  s = scan(s, (code) => code.replace(/\bINTEGER\b/gi, 'BIGINT').replace(/\bREAL\b/gi, 'DOUBLE PRECISION').replace(/\bMAX\(\s*uid_next\s*,/gi, 'GREATEST(uid_next,'));
  s = rewriteCalls(s, 'datetime', (a) => timeExpr(a, TS));
  return s;
}
