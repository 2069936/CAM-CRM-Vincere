import { buildLifecycleByAlgo } from '../domain/accountLifecycle';

function days(n) {
  return n == null ? '-' : `${n}d`;
}

// Which algo combo gets accounts funded / lasts longer / survives. Reused in the
// Stack Playbook, CAM overview, and Manager overview.
export default function LifecycleByAlgo({ clients = [], asOf = '' }) {
  // Default the "still alive" clock to today so active accounts count real days.
  const today = asOf || new Date().toISOString().slice(0, 10);
  const rows = buildLifecycleByAlgo(clients, { asOf: today }).filter((r) => r.accounts > 0);
  if (!rows.length) return <p className="muted" style={{ padding: '8px 0' }}>No account lifecycle data yet — set each account&apos;s algo stack.</p>;
  return (
    <div className="table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            <th>Combo</th>
            <th>Accounts</th>
            <th>Funded rate</th>
            <th>Avg lifespan</th>
            <th>Avg days to fund</th>
            <th>F / X / Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.combo}>
              <td><strong>{r.combo}</strong></td>
              <td>{r.accounts}</td>
              <td className={r.fundedRate >= 50 ? 'positive' : r.fundedRate > 0 ? '' : 'negative'}>{r.fundedRate}%</td>
              <td>{days(r.avgLifespan)}</td>
              <td className="muted">{days(r.avgDaysToFund)}</td>
              <td className="muted">{r.funded} / {r.failed} / {r.active}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
