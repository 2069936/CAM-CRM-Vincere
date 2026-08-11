import { realFolders, redactedTables } from './loadReal.mjs';
import { reconcileDailyImport } from '/Users/pedro/Desktop/PEDRO/Trabajo/app2/CAM-CRM-Vincere/src/domain/reconcile.js';

const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

console.log('=== REAL CSV FOLDERS: what the parser sees vs what reconcile keeps ===');
let simBalance = 0;
let simCount = 0;
for (const f of realFolders()) {
  const sims = f.parsed.accounts.filter((a) => /^sim/i.test(String(a.accountName || '').trim()));
  const r = reconcileDailyImport({ clientId: f.folder, date: f.date, registry: {}, parsed: f.parsed });
  const simInSnapshots = r.snapshots.filter((s) => /^sim/i.test(s.accountName)).length;
  for (const s of sims) { simBalance += Number(s.accountBalance || 0); simCount += 1; }
  console.log(
    `${f.folder.padEnd(20)} ${f.clientLabel.padEnd(10)} parsedAcc=${String(f.parsed.accounts.length).padStart(2)} keptAcc=${String(r.snapshots.length).padStart(2)}` +
    ` parsedOrd=${String(f.parsed.orders.length).padStart(3)} keptOrd=${String(r.orders.length).padStart(3)}` +
    ` parsedExe=${String(f.parsed.executions.length).padStart(3)} keptExe=${String(r.executions.length).padStart(3)}` +
    ` parsedStr=${String(f.parsed.strategies.length).padStart(2)} keptStr=${String(r.strategies.length).padStart(2)}` +
    ` | sims=${sims.length} simBal=${usd(sims.reduce((s, a) => s + Number(a.accountBalance || 0), 0))}` +
    ` simRealized=${usd(sims.reduce((s, a) => s + Number(a.grossRealizedPnl || 0), 0))} SIM-IN-SNAPSHOTS=${simInSnapshots}`,
  );
}
console.log(`TOTAL sim accounts=${simCount} balance=${usd(simBalance)}`);

console.log('\n=== REDACTED BOOK ===');
const t = redactedTables();
console.log('tables:', Object.keys(t).join(', '));
console.log('trading_accounts:', t.trading_accounts?.length, 'account_snapshots:', t.account_snapshots?.length, 'clients:', t.clients?.length);
const types = {};
for (const a of t.trading_accounts || []) types[a.account_type || '(null)'] = (types[a.account_type || '(null)'] || 0) + 1;
console.log('account_type distribution:', types);
const at100k = (t.account_snapshots || []).filter((s) => Number(s.account_balance) === 100000);
console.log('snapshots at exactly 100000:', at100k.length, at100k.map((s) => `${s.connection}/tmd=${s.trailing_max_drawdown}`));
