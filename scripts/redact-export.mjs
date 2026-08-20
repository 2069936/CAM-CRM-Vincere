#!/usr/bin/env node
// Strips identity from a CRM data export, keeping every number and every shape.
//
// The raw export is the whole book: client names, emails, license keys,
// prop-firm account numbers, balances, and the app_users table. It belongs on a
// laptop for as short a time as possible and nowhere else.
//
// SAFE BY DEFAULT. Every string is redacted unless its field is on the keep
// list below. The first version of this script did the opposite — it named the
// fields to redact — and missed product_key and additional_emails on the first
// real export, leaking 6,465 values. A list of things to hide is only ever as
// complete as the schema was on the day it was written; a list of things to
// keep fails closed when the schema grows.
//
//   node scripts/redact-export.mjs export.json public/local-snapshot.json
//
// Not reversible: no key, no mapping file.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('usage: node scripts/redact-export.mjs <export.json> <output.json>');
  process.exit(1);
}

// Dropped whole. Nothing the CRM draws reads them, and they hold the most
// sensitive rows in the export.
const DROP_TABLES = new Set(['app_users', 'audit_logs', 'client_credentials']);

/**
 * Fields whose string values survive verbatim.
 *
 * Every one of these is an enum, a classification, or a machine identifier the
 * app branches on. None of them names a person. A field not listed here is
 * redacted, so forgetting one costs a blank label — never a leak.
 */
const KEEP_FIELDS = new Set([
  // Classifications the app branches on.
  'status', 'stage', 'account_type', 'payout_state', 'risk_level', 'severity',
  // simulation_mode is a two-value enum ('simulation' | 'live') and the whole
  // point of the redacted book is that classification behaviour can be checked
  // against it. Note the standing trap this file creates for that check:
  // maskAccount below pseudonymises account_name, so a simulation account
  // CANNOT be found by name in the output — searching it for "Sim" returns 0,
  // and that is an artefact, not evidence. Use this column, or a balance
  // fingerprint, instead.
  'simulation_mode',
  'type', 'kind', 'state', 'action', 'entity_type', 'role', 'role_title',
  'preferred_channel', 'language', 'country', 'timezone', 'connection',
  'bullet_bot_pass_type', 'bullet_bot_direction', 'direction', 'side',
  'pnl_source', 'trailing_source', 'weekly_pnl_source', 'source',
  // Strategy identity: the algo charts are the point of running this locally.
  'strategy_name', 'strategy_family', 'strategy_version', 'instrument',
  'data_series', 'algo_stack', 'name_on_chart',
  // Fill mechanics. These are the fields per-strategy P&L is derived from, and
  // redacting them is not a neutral loss: with time_text and entry_exit blanked,
  // executions cannot be ordered or paired, and a measurement taken against such
  // a book concluded that deriving the split was impossible. It is not. The book
  // was censored in exactly the place the question lives.
  //
  // None of the three names anyone. time_text is a clock time, entry_exit is
  // Entry/Exit, position is a contract count and side ("2 L", "-").
  'time_text', 'entry_exit', 'position',
  // Dates and everything numeric pass through the type check below.
]);

/**
 * Fields that identify a row or point at another one.
 *
 * A UUID carries nothing and passes through. Anything else in one of these
 * fields becomes a stable token rather than the usual [redacted N] marker,
 * because those markers collide: two clients whose legacy_key is eleven
 * characters would both become "[redacted 11]" and the app would treat them as
 * the same client.
 *
 * This is also where the report blobs get caught. reports.content stores flag
 * ids in the old composite form — "Missing account|BSKELAUNCHRENDALL87905|..."
 * — which embeds an account name, which embeds a client name. No pattern scan
 * flags that, and keeping every field called "id" verbatim shipped it straight
 * through.
 */
const ID_FIELDS = new Set([
  'id', 'legacy_key', 'client_id', 'cam_profile_id', 'trading_account_id',
  'daily_import_id', 'account_snapshot_id', 'user_id', 'resolved_by_user_id',
  'covering_cam_id', 'sop_template_id', 'sop_section_id', 'sop_item_id',
  'batch_id', 'capture_id', 'device_id', 'order_id', 'parent_order_id',
  'strategy_id', 'oco',
]);

const token = (value) => `x${digest(`id:${value}`).slice(0, 14)}`;

/** Values that carry no identity whatever the field is called. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

const FIRST = ['Avery', 'Brook', 'Casey', 'Devon', 'Ellis', 'Finley', 'Gray', 'Harper',
  'Indigo', 'Jordan', 'Kai', 'Lane', 'Marlow', 'Noel', 'Oakley', 'Parker', 'Quinn',
  'Reese', 'Sage', 'Tatum', 'Vale', 'Wren'];
const LAST = ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm', 'Frost', 'Glen', 'Hollow',
  'Iris', 'Juniper', 'Knoll', 'Larch', 'Moss', 'North', 'Onyx', 'Pine'];

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

function pseudonym(value) {
  const hash = digest(`person:${value}`);
  const first = FIRST[parseInt(hash.slice(0, 4), 16) % FIRST.length];
  const last = LAST[parseInt(hash.slice(4, 8), 16) % LAST.length];
  return `${first} ${last}`;
}

/**
 * Account names keep their shape, not their characters.
 *
 * Letters move as well as digits. Prop firms hand out names like FTDFYL1001...,
 * but CAMs also name accounts after the client — a real export held ROME6100
 * for a client called Rome. Masking only the digits left the name in place, and
 * no pattern scan would ever flag it, because four letters and four digits is
 * not a shape anything matches on.
 *
 * Character classes are preserved so a column that held eighteen characters
 * still holds eighteen and the tables lay out the same.
 */
/**
 * Every real account name and alias in the source, so a mask can be checked
 * against them before it is emitted. Populated once the export is parsed.
 *
 * This exists because masking is character-wise and length-preserving: a purely
 * numeric account name becomes another number of the same length, drawn from the
 * same small space the real ones live in. On a 999-account book that collided —
 * a masked account came out equal to a DIFFERENT account's real number, and
 * verify() correctly refused to write. A masked value that happens to be a real
 * prop-firm account number is a leak whether or not it belongs to the row it
 * sits on, and retrying with a salt is cheaper than reasoning about how likely
 * it is.
 */
const REAL_IDENTIFIERS = new Set();

function maskOnce(value, salt) {
  const hash = digest(salt ? `account:${salt}:${value}` : `account:${value}`);
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let index = 0;
  return String(value).replace(/[A-Za-z0-9]/g, (char) => {
    const byte = hash[index++ % hash.length].charCodeAt(0);
    if (/\d/.test(char)) return byte % 10;
    const replacement = letters[byte % letters.length];
    return char === char.toLowerCase() ? replacement.toLowerCase() : replacement;
  });
}

function maskAccount(value) {
  // Deterministic: the same input always lands on the same salt, so the book
  // stays joinable across runs.
  for (let salt = 0; salt < 1000; salt += 1) {
    const masked = maskOnce(value, salt);
    if (!REAL_IDENTIFIERS.has(masked)) return masked;
  }
  throw new Error(`maskAccount could not find a non-colliding mask for a ${String(value).length}-character value`);
}

// Person-shaped fields get a readable pseudonym so the book stays navigable;
// everything else unlisted becomes an opaque marker of the same length.
// Both spellings. Table columns are snake_case, but reports.content stores a
// serialized app-shaped summary in camelCase, and listing only the column names
// shipped every account number in every stored report.
const PERSON_FIELDS = new Set([
  'name', 'full_name', 'client_name', 'cam_name', 'display_name',
  'fullName', 'clientName', 'camName', 'displayName',
]);
const ACCOUNT_FIELDS = new Set([
  'account_name', 'account_display_name', 'alias',
  'accountName', 'accountDisplayName',
]);

/**
 * A strategy's configuration identity, with nothing readable left.
 *
 * parameters_raw is the only field that says what an algo is actually set to.
 * The name does not: a book held five distinct parameter sets all called
 * URGO-4.5, so comparing configurations needs this field to survive in some
 * form. Replacing it with [redacted N] leaves only its length, which is a
 * fingerprint of the wrong thing.
 *
 * It also carries the client's licence key, which is per client. Hashing the
 * raw string would therefore make two clients running an identical
 * configuration look different — the exact comparison this is meant to enable.
 * The key is stripped first, so the hash reflects the settings and nothing else.
 */
const LICENCE_KEY = /V-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]{6,8}W?/gi;

/**
 * Two strategies with different parameters are not necessarily different
 * strategies.
 *
 * Risk level changes how many contracts an algo opens — PosSize1/2/3 — and
 * nothing else. A version changes what it does: entry, exit, stop, trail. One
 * hash over the whole string cannot tell those apart, and reports a client on a
 * higher risk setting as running a different version.
 *
 * NinjaTrader writes the parameters as `v1/v2/.../vN (Name1/Name2/.../NameN)`,
 * so the names are in the string and the two groups can be separated. The
 * fingerprint covers everything except sizing and the licence key; sizing gets
 * its own, so a risk change is visible as a risk change.
 */
/**
 * Splits on '/' without breaking the dates.
 *
 * NinjaTrader writes times as `1/1/2020 4:45:00 PM`, so a naive split turns one
 * value into three. A real string had 37 fragments against 31 names — three
 * dates, two extra pieces each — and the mismatch made the whole split fail
 * silently back to hashing everything together.
 */
function splitValues(text) {
  const parts = text.split('/');
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index + 2 < parts.length
      && /^\d{1,2}$/.test(parts[index])
      && /^\d{1,2}$/.test(parts[index + 1])
      && /^\d{4}\b/.test(parts[index + 2])) {
      out.push(`${parts[index]}/${parts[index + 1]}/${parts[index + 2]}`);
      index += 2;
    } else {
      out.push(parts[index]);
    }
  }
  return out;
}

function splitParameters(value) {
  const match = String(value).match(/^([\s\S]*)\(([^()]*)\)\s*$/);
  if (!match) return null;
  const values = splitValues(match[1].trim());
  const names = match[2].split('/');
  if (values.length !== names.length) return null;
  const sizing = [];
  const config = [];
  names.forEach((name, index) => {
    const key = name.trim();
    const entry = `${key}=${values[index]}`;
    if (/^PosSize\d*$/i.test(key)) sizing.push(entry);
    else if (/licen[cs]e ?key/i.test(key)) return;
    else config.push(entry);
  });
  return { sizing: sizing.join('/'), config: config.join('/') };
}

/**
 * Keeps the parameters, drops only the licence key.
 *
 * An earlier version hashed the whole string. That preserved comparisons but
 * destroyed everything downstream of them: the risk chart reads StopLossTicks
 * and ProfitTargetTicks out of this field, and against a hashed snapshot every
 * family rendered as "no stop or target on record". A local copy that cannot
 * exercise the charts is most of the reason for having one.
 *
 * The settings themselves identify nobody — they are the same numbers across
 * every client running that configuration. The licence key is the only per-client
 * value in the string, so replacing it is enough, and it also makes two clients
 * on identical settings compare equal, which hashing the raw string did not.
 */
function configFingerprint(value) {
  return String(value).replace(LICENCE_KEY, 'KEY');
}

function redactString(key, value) {
  if (!value.trim()) return value;
  if (key === 'parameters_raw' || key === 'parametersRaw') return configFingerprint(value);
  if (ID_FIELDS.has(key)) return UUID.test(value) ? value : token(value);
  if (KEEP_FIELDS.has(key)) return value;
  // Named fields are handled before the shape check. An account name that is
  // all digits — Tradovate and cash accounts look like 1745458 — would
  // otherwise be waved through as "just a number" and ship verbatim.
  if (PERSON_FIELDS.has(key)) return pseudonym(value);
  if (ACCOUNT_FIELDS.has(key)) return maskAccount(value);
  // No numeric shortcut. Postgres exports real numbers as JSON numbers, which
  // never reach this function; a *string* that looks like a number is a phone
  // number or an account number, which is to say the sensitive kind. Waving
  // those through as "just digits" leaked both.
  if (UUID.test(value) || ISO_DATE.test(value)) return value;
  // Length is kept because it drives layout: a note that wrapped to three lines
  // in production must still wrap locally.
  return `[redacted ${value.length}]`;
}

function walk(node, key = '') {
  if (typeof node === 'string') return redactString(key, node);
  // A NUMBER in an identifying field is redacted too, because Postgres exports a
  // numeric column as a JSON number and numbers never reached redactString at
  // all. One account here stores its own account number in legacy_key as a
  // number, and it shipped verbatim through every rule above it: the field was
  // on the ID list, the value was on the leak list, and neither mattered because
  // the type check upstream had already waved it through. Numeric account names
  // are ordinary (Tradovate and cash accounts look like 1745458), so this is the
  // normal case, not an exotic one.
  if (typeof node === 'number' && Number.isFinite(node)
      && (ID_FIELDS.has(key) || ACCOUNT_FIELDS.has(key) || PERSON_FIELDS.has(key))) {
    return redactString(key, String(node));
  }
  if (Array.isArray(node)) return node.map((item) => walk(item, key));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [childKey, value] of Object.entries(node)) out[childKey] = walk(value, childKey);
    return out;
  }
  return node;
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const source = parsed?.tables && typeof parsed.tables === 'object' ? parsed.tables : parsed;

// Load the real identifiers before anything is masked, so maskAccount can avoid
// landing on one. Same fields verify() checks, so the two cannot drift apart.
for (const row of source.trading_accounts || []) {
  for (const field of ['account_name', 'alias']) {
    const value = row?.[field];
    if (typeof value === 'string' && value.trim()) REAL_IDENTIFIERS.add(value);
  }
}

const tables = {};
let rows = 0;
for (const [table, value] of Object.entries(source)) {
  if (DROP_TABLES.has(table) || !Array.isArray(value)) continue;
  tables[table] = walk(value);
  rows += value.length;
}

/**
 * Checks the output against the input before writing.
 *
 * Four separate leaks got through review of this script and were only caught by
 * grepping the result by hand: product_key, account names whose letters were the
 * client's name, all-numeric account numbers that the "it's just a number"
 * shortcut waved past, and the camelCase copies inside reports.content. Manual
 * grepping does not scale to the next schema change, so the check runs here and
 * refuses to write on a hit.
 */
/**
 * A generated id token: 'x' plus 14 hex characters, from token() above.
 *
 * These have to be excluded from the leak scan by shape, because the scan is a
 * substring test and a hex digest is drawn from an alphabet that includes every
 * digit. A seven-digit account number turned up inside the token
 * "xcb1784047c2343" — which belongs to a different account, carries no identity,
 * and cannot be reversed — and the scan refused to write on it. Left in, the
 * check cries wolf on a book this size and the next real leak gets waved past
 * by whoever is tired of it.
 *
 * The exclusion is deliberately narrow: only a whole string of exactly this
 * shape. A token EMBEDDED in longer text is still scanned, and every other
 * field, including masked account names, is scanned as before.
 */
const GENERATED_TOKEN = /^x[0-9a-f]{14}$/;

/**
 * Every string in the redacted output, paired with the path it sits at.
 *
 * The scan used to run against JSON.stringify(everything), which cannot tell a
 * value that survived from a digest that happens to contain the same digits, and
 * cannot say where it is. Walking gives both.
 */
function* strings(node, path = '') {
  if (typeof node === 'string') { yield [path, node]; return; }
  if (typeof node === 'number') { yield [path, String(node)]; return; }
  if (Array.isArray(node)) { for (const item of node) yield* strings(item, path); return; }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) yield* strings(child, path ? `${path}.${key}` : key);
  }
}

/**
 * Index the redacted output ONCE, then answer every suspect against the index.
 *
 * Scanning the whole output per suspect is O(suspects x strings) and on this
 * book that is hundreds of millions of substring tests. Two structures answer
 * the same question in one pass:
 *
 *   exact  — a value that survived as a complete field value. This is the
 *            ordinary leak: a name, an account number, an email.
 *   free   — the long strings only. An identifier hidden INSIDE text (the
 *            composite flag ids in reports.content embed an account number,
 *            which embeds a client name) can only be found by containment, and
 *            containment is only affordable over the few long blobs.
 *
 * Short strings are covered by `exact`, so nothing is lost by not scanning them
 * for containment: a 7-character account number cannot hide inside a
 * 7-character field without being equal to it.
 */
const FREE_TEXT_MIN = 40;

function indexOutput(redacted) {
  const exact = new Map();
  const free = [];
  for (const [path, text] of strings(redacted, '')) {
    if (GENERATED_TOKEN.test(text)) continue;
    if (!exact.has(text)) exact.set(text, path);
    if (text.length >= FREE_TEXT_MIN) free.push([path, text]);
  }
  return { exact, free };
}

function findLeaks(index, value) {
  const where = new Map();
  const hit = index.exact.get(value);
  if (hit !== undefined) where.set(hit, 1);
  for (const [path, text] of index.free) {
    if (text.includes(value)) where.set(path, (where.get(path) || 0) + 1);
  }
  return where;
}

function verify(source, redacted) {
  const index = indexOutput(redacted);
  const suspects = [];
  const collect = (rows, field) => {
    for (const row of rows || []) {
      const value = row?.[field];
      if (typeof value === 'string' && value.trim().length > 4) suspects.push([field, value]);
    }
  };
  collect(source.clients, 'name');
  collect(source.clients, 'email');
  collect(source.clients, 'product_key');
  collect(source.clients, 'messenger');
  collect(source.clients, 'notes');
  collect(source.clients, 'phone');
  collect(source.cam_profiles, 'name');
  collect(source.cam_profiles, 'email');
  collect(source.trading_accounts, 'account_name');
  collect(source.trading_accounts, 'alias');
  collect(source.trading_accounts, 'notes');

  const leaks = suspects
    .map(([field, value]) => [field, value, findLeaks(index, value)])
    .filter(([, , where]) => where.size > 0);
  if (!leaks.length) return;

  console.error(`\nREFUSING TO WRITE: ${leaks.length} identifying value(s) survived redaction.`);
  for (const [field, value, where] of leaks.slice(0, 5)) {
    console.error(`  ${field}: ${value.slice(0, 40)}`);
    // Naming the value without naming where it survived sends the reader back
    // to grep the whole export. Say which column kept it.
    for (const [path, count] of [...where.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.error(`      survives at ${path} x${count}`);
    }
  }
  console.error('\nAdd the field to KEEP_FIELDS only if it is an enum. Otherwise it needs');
  console.error('a rule in redactString. Check both snake_case and camelCase spellings.');
  process.exit(1);
}

verify(source, tables);

writeFileSync(outputPath, JSON.stringify({ tables }, null, 2));

console.log(`redacted ${rows} rows across ${Object.keys(tables).length} tables`);
console.log(`dropped whole: ${[...DROP_TABLES].join(', ')}`);
console.log(`wrote ${outputPath}`);
console.log('\nBalances, dates, account types and strategy names are untouched.');
console.log('Every other string is redacted unless explicitly kept.');
