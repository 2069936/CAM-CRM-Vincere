// The field names the Deep Export manifest actually carries, read out of the
// code that writes them.
//
// WHY READ THE C# INSTEAD OF A FIXTURE. scripts/import_strategy_catalog.mjs
// reads manifest.json for the machine that produced an export and the moment
// it was taken. It asked for two names - `manifest.machineId` and
// `manifest.createdAtUtc` - that DeepExportRunner has never written: the first
// is nested under `source`, the second does not exist. Nothing failed. Every
// template imported since the catalogue landed carries a null machine and a
// null date, and no output said so.
//
// A fixture written by hand would have been written from the same wrong
// reading and would still be green today. So the test builds its manifest from
// the names in DeepExportRunner.cs itself: rename a field on either side and
// the two stop agreeing, which is the only thing that can actually fail.
//
// This parses the anonymous object initializer rather than running the agent,
// because the agent is C# on Windows and the test suite is vitest on whatever
// CI is. It is a narrow parser for one known shape, and it throws instead of
// returning something empty when that shape is not where it expects - a silent
// {} here would make every assertion built on it vacuous.

/** Comments and literals blanked out, so no brace inside one is counted. */
function withoutLiterals(source) {
  let out = '';
  let at = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (at < source.length) {
    const pair = source.slice(at, at + 2);
    if (pair === '//') {
      const line = source.indexOf('\n', at);
      const stop = line === -1 ? source.length : line;
      out += blank(source.slice(at, stop));
      at = stop;
    } else if (pair === '/*') {
      const close = source.indexOf('*/', at + 2);
      const stop = close === -1 ? source.length : close + 2;
      out += blank(source.slice(at, stop));
      at = stop;
    } else if (source[at] === '"' || source[at] === "'") {
      const quote = source[at];
      let scan = at + 1;
      while (scan < source.length) {
        if (source[scan] === '\\') { scan += 2; continue; }
        if (source[scan] === quote) { scan += 1; break; }
        scan += 1;
      }
      out += blank(source.slice(at, scan));
      at = scan;
    } else {
      out += source[at];
      at += 1;
    }
  }
  return out;
}

/** The comma-separated members of the initializer whose `{` is at `open`. */
function membersOf(source, open) {
  const members = [];
  let depth = 0;
  let start = open + 1;
  for (let at = start; at < source.length; at += 1) {
    const character = source[at];
    if (character === '{' || character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === '}') {
      if (depth === 0) {
        members.push([start, at]);
        return members;
      }
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      members.push([start, at]);
      start = at + 1;
    }
  }
  throw new Error('the manifest initializer is never closed');
}

function shapeAt(source, open) {
  const shape = {};
  for (const [start, end] of membersOf(source, open)) {
    const member = source.slice(start, end);
    const assigned = /^\s*([A-Za-z_]\w*)\s*=/.exec(member);
    if (!assigned) {
      // `files,` and `warnings,` name the variable and the field at once.
      const shorthand = /^\s*([A-Za-z_]\w*)\s*$/.exec(member);
      if (shorthand) shape[shorthand[1]] = true;
      continue;
    }
    // `new {` anywhere in the value, so `db = x == null ? null : new { .. }`
    // is read as the object it is. `Guid.NewGuid()` is not `new`, and the
    // literals are already blanked, so nothing else can look like one.
    const nested = /\bnew\b[^{;]*\{/.exec(member);
    shape[assigned[1]] = nested
      ? shapeAt(source, start + nested.index + nested[0].length - 1)
      : true;
  }
  return shape;
}

/**
 * The shape of the object DeepExportRunner serialises to manifest.json, as a
 * nested object: `true` for a leaf field, an object for a nested one.
 */
export function manifestShapeOf(runnerSource) {
  const source = withoutLiterals(runnerSource);
  const declaration = /\bvar\s+manifest\s*=\s*new\b[^{;]*\{/.exec(source);
  if (!declaration) throw new Error('no `var manifest = new {` in DeepExportRunner.cs');
  return shapeAt(source, declaration.index + declaration[0].length - 1);
}

/** Every leaf path in a shape, dotted: `createdAt`, `source.machineId`, ... */
export function pathsOf(shape, prefix = '') {
  return Object.entries(shape).flatMap(([name, value]) => (
    value === true ? [prefix + name] : pathsOf(value, `${prefix}${name}.`)
  ));
}

/** A manifest carrying `fill(path)` at every field the writer declares. */
export function manifestFrom(shape, fill) {
  const built = {};
  for (const [name, value] of Object.entries(shape)) {
    built[name] = value === true ? fill(name) : manifestFrom(value, (nested) => fill(`${name}.${nested}`));
  }
  return built;
}
