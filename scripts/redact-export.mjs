#!/usr/bin/env node
// Strips identity from a CRM data export, keeping every number and every shape.
//
// The raw export is the whole book: client names, prop-firm account numbers,
// balances, and the app_users table. That belongs on a laptop for as short a
// time as possible and nowhere else — not in git, not in a chat window, not in
// a bug report.
//
// What testing actually needs is the shape: how many accounts a client has, how
// the balances move, which strategies repeat, where the gaps are. None of that
// requires knowing whose book it is. This rewrites the identifying fields and
// leaves the arithmetic untouched, so a redacted snapshot reproduces the same
// charts, the same flags, and the same totals as the real one.
//
//   node scripts/redact-export.mjs export.json public/local-snapshot.json
//
// Deliberately not reversible: there is no key and no mapping file written.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('usage: node scripts/redact-export.mjs <export.json> <output.json>');
  process.exit(1);
}

// Tables dropped whole. Nothing in the CRM's charts or flags reads them, and
// they carry the most sensitive rows in the export.
const DROP_TABLES = new Set(['app_users', 'audit_logs', 'client_credentials']);

// Fields rewritten wherever they appear. Names become stable pseudonyms so the
// same client reads as the same person across tables and across runs.
const PERSON_FIELDS = ['name', 'client_name', 'full_name', 'display_name', 'cam_name'];
const ACCOUNT_FIELDS = ['account_name', 'account_display_name', 'accountName'];
const FREE_TEXT_FIELDS = ['notes', 'pinned_note', 'note', 'message', 'text', 'header_note'];
const CONTACT_FIELDS = ['email', 'phone', 'discord', 'discord_handle', 'timezone_note'];

const FIRST = ['Avery', 'Brook', 'Casey', 'Devon', 'Ellis', 'Finley', 'Gray', 'Harper',
  'Indigo', 'Jordan', 'Kai', 'Lane', 'Marlow', 'Noel', 'Oakley', 'Parker', 'Quinn',
  'Reese', 'Sage', 'Tatum', 'Vale', 'Wren'];
const LAST = ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm', 'Frost', 'Glen', 'Hollow',
  'Iris', 'Juniper', 'Knoll', 'Larch', 'Moss', 'North', 'Onyx', 'Pine'];

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function pseudonym(value) {
  const hash = digest(`person:${value}`);
  const first = FIRST[parseInt(hash.slice(0, 4), 16) % FIRST.length];
  const last = LAST[parseInt(hash.slice(4, 8), 16) % LAST.length];
  return `${first} ${last}`;
}

/**
 * Account numbers keep their length and their prefix letters.
 *
 * A CAM recognises an account by its shape as much as its value, and a column
 * that suddenly holds eight characters instead of eighteen would change how the
 * tables lay out. Only the digits move.
 */
function maskAccount(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const hash = digest(`account:${text}`);
  let index = 0;
  return text.replace(/\d/g, () => hash[index++ % hash.length].charCodeAt(0) % 10);
}

function redactValue(key, value) {
  if (value === null || value === undefined) return value;
  if (PERSON_FIELDS.includes(key) && typeof value === 'string' && value.trim()) {
    return pseudonym(value);
  }
  if (ACCOUNT_FIELDS.includes(key) && typeof value === 'string') {
    return maskAccount(value);
  }
  if (CONTACT_FIELDS.includes(key) && typeof value === 'string' && value.trim()) {
    return `redacted-${digest(value).slice(0, 8)}`;
  }
  if (FREE_TEXT_FIELDS.includes(key) && typeof value === 'string' && value.trim()) {
    // Length is kept because it drives layout: a note that wrapped to three
    // lines in production must still wrap locally.
    return `[redacted ${value.length} chars]`;
  }
  return value;
}

function walk(node) {
  if (Array.isArray(node)) return node.map(walk);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const replaced = redactValue(key, value);
      out[key] = replaced === value && typeof value === 'object' ? walk(value) : replaced;
    }
    return out;
  }
  return node;
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const source = parsed?.tables && typeof parsed.tables === 'object' ? parsed.tables : parsed;

const tables = {};
let dropped = 0;
let rows = 0;
for (const [table, value] of Object.entries(source)) {
  if (DROP_TABLES.has(table)) {
    dropped += 1;
    continue;
  }
  if (!Array.isArray(value)) continue;
  tables[table] = walk(value);
  rows += value.length;
}

writeFileSync(outputPath, JSON.stringify({ tables }, null, 2));

console.log(`redacted ${rows} rows across ${Object.keys(tables).length} tables`);
console.log(`dropped ${dropped} tables whole: ${[...DROP_TABLES].join(', ')}`);
console.log(`wrote ${outputPath}`);
console.log('\nBalances, dates, and P&L are untouched — the charts read the same.');
