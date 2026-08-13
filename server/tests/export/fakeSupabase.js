// An in-memory stand-in for the service-role Supabase client.
//
// Only the subset of the PostgREST builder the export uses: select('*'), in,
// eq, is, gte, lte, lt, order, range, insert. It applies filters in JS over
// plain rows, which means the endpoint's paging, chunking and range logic are
// exercised for real rather than mocked away — the same harness runs against a
// handful of fixture rows in the suite and against the 41,000-row redacted copy
// of the book in scripts/verify-client-export.mjs.

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return String(a) < String(b) ? -1 : 1;
}

export function createFakeSupabase(tables, { missingTables = [], inserts = [] } = {}) {
  const missing = new Set(missingTables);

  function builder(table) {
    const filters = [];
    let sort = null;
    let bounds = null;

    const chain = {
      select() { return chain; },
      in(column, values) {
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return chain;
      },
      eq(column, value) { filters.push((row) => row[column] === value); return chain; },
      is(column, value) {
        filters.push((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value));
        return chain;
      },
      gte(column, value) { filters.push((row) => row[column] !== null && row[column] !== undefined && String(row[column]) >= String(value)); return chain; },
      lte(column, value) { filters.push((row) => row[column] !== null && row[column] !== undefined && String(row[column]) <= String(value)); return chain; },
      lt(column, value) { filters.push((row) => row[column] !== null && row[column] !== undefined && String(row[column]) < String(value)); return chain; },
      order(column, { ascending = true } = {}) { sort = { column, ascending }; return chain; },
      limit(count) { bounds = { from: 0, to: count - 1 }; return chain; },
      range(from, to) { bounds = { from, to }; return chain; },
      async insert(row) {
        inserts.push({ table, row });
        return { data: null, error: null };
      },
      then(resolve, reject) {
        return Promise.resolve(chain.run()).then(resolve, reject);
      },
      run() {
        if (missing.has(table)) {
          return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
        }
        let rows = (tables[table] || []).filter((row) => filters.every((test) => test(row)));
        if (sort) {
          rows = [...rows].sort((a, b) => (sort.ascending ? 1 : -1) * compare(a[sort.column], b[sort.column]));
        }
        if (bounds) rows = rows.slice(bounds.from, bounds.to + 1);
        return { data: rows, error: null };
      },
    };
    return chain;
  }

  return {
    inserts,
    from(table) { return builder(table); },
  };
}
