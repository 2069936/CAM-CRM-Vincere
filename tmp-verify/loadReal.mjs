// Shared loader for the real, unredacted NinjaTrader exports and the redacted book.
import fs from 'node:fs';
import path from 'node:path';
import { parseNinjaTraderCsvText } from '../src/domain/csvImport.js';

const ROOT = '/Users/pedro/Desktop/PEDRO/Trabajo/untitled folder';
const REPO = '/Users/pedro/Desktop/PEDRO/Trabajo/app2/CAM-CRM-Vincere';

export function realFolders() {
  const out = [];
  for (const entry of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const csvs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
    if (!csvs.length) continue;
    // Read by HEADER (parseNinjaTraderCsvText detects the type from the header
    // set); the four files land in a different order per client, so reading by
    // position produced an all-zero client on a previous pass.
    const parsed = { accounts: [], strategies: [], orders: [], executions: [] };
    for (const f of csvs) {
      const p = parseNinjaTraderCsvText(fs.readFileSync(path.join(dir, f), 'utf8'), f);
      if (p.type && p.type !== 'unknown') parsed[p.type] = p.rows;
    }
    const note = fs.readdirSync(dir).find((f) => f.endsWith('.txt'));
    out.push({
      folder: entry,
      dir,
      clientLabel: note ? note.replace(/ - .*/, '') : entry,
      parsed,
      date: '2026-08-06',
    });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

export function redactedTables() {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'public/local-snapshot.json'), 'utf8'));
  return raw.tables || raw;
}
