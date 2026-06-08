import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, DollarSign, Activity, Server, Target } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';

const COLORS = ['#8b5cf6', '#0ea5e9', '#10b981', '#f43f5e', '#f59e0b', '#6366f1'];

export default function Dashboard({ clientName, accounts, algorithms, meta }) {
  if (!accounts || accounts.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-h2 mb-4 text-muted">Dashboard</h2>
        <p>No sync data found. Upload data to see metrics.</p>
      </div>
    );
  }

  // Helper to get meta for account
  const getMeta = (name) => meta[name] || { bucket: 'unassigned', baseBalance: 50000, target: 3000, risk: '', status: 'Active' };

  // 1. Overview Stats - Using Gross Realized as Net Profit
  const computeStats = (accList) => {
    let totalGrossRealized = 0, totalWeekly = 0;
    accList.forEach(acc => {
      totalGrossRealized += acc.grossRealized;
      totalWeekly += acc.weeklyPnL;
    });
    return { totalGrossRealized, totalWeekly, count: accList.length };
  };

  const evals = accounts.filter(a => getMeta(a.name).bucket === 'evaluation');
  const funded = accounts.filter(a => getMeta(a.name).bucket === 'funded');
  
  const evalStats = computeStats(evals);
  const fundedStats = computeStats(funded);

  // 2. Prop Firm Distribution (Gross Realized) for Pie Chart
  const propFirmData = useMemo(() => {
    const firms = {};
    accounts.forEach(acc => {
      const bucket = getMeta(acc.name).bucket;
      if (bucket === 'evaluation' || bucket === 'funded') {
        const firm = acc.connection || 'Unknown';
        if (acc.grossRealized > 0) { // Only graph positive realized PnL
          firms[firm] = (firms[firm] || 0) + acc.grossRealized;
        }
      }
    });
    return Object.entries(firms).map(([name, value]) => ({ name, value })).sort((a,b) => b.value - a.value);
  }, [accounts, meta]);

  // 3. Tree Breakdown: Account -> Algorithms
  const accountTreeData = useMemo(() => {
    const tree = [];
    const chartDataMap = {};

    accounts.forEach(acc => {
      const accMeta = getMeta(acc.name);
      if (accMeta.bucket !== 'evaluation' && accMeta.bucket !== 'funded') return;

      // Find algorithms running on this account
      const accAlgos = algorithms.filter(alg => alg.accountName === acc.name);
      
      const distanceToTarget = accMeta.target - acc.grossRealized;

      tree.push({
        ...acc,
        ...accMeta,
        propFirm: acc.connection || 'Unknown',
        distanceToTarget,
        algorithms: accAlgos
      });

      // Accumulate for Bar chart (Algorithm total realized)
      accAlgos.forEach(alg => {
        if (!chartDataMap[alg.name]) chartDataMap[alg.name] = { name: alg.name, Realized: 0 };
        chartDataMap[alg.name].Realized += alg.realized;
      });
    });

    return {
      tree: tree.sort((a, b) => b.grossRealized - a.grossRealized),
      chart: Object.values(chartDataMap).sort((a, b) => b.Realized - a.Realized)
    };
  }, [algorithms, accounts, meta]);

  const StatCard = ({ title, value, icon, isCurrency = true, isPnL = false }) => {
    let colorClass = 'text-[var(--primary)]';
    if (isPnL) colorClass = value >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]';
    const displayValue = isCurrency 
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
      : value;

    return (
      <div className="card flex flex-col justify-between">
        <div className="flex justify-between items-start mb-2">
          <p className="text-sm font-medium text-muted">{title}</p>
          <div className={`p-2 rounded-md bg-[var(--bg-base)] ${colorClass}`}>{icon}</div>
        </div>
        <h3 className={`text-h2 ${colorClass}`}>{displayValue}</h3>
      </div>
    );
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--bg-surface)] border border-[var(--border)] p-3 rounded-md shadow-lg">
          <p className="font-semibold mb-1">{label || payload[0].name}</p>
          <p className="text-sm text-[var(--primary)]">
            Value: ${payload[0].value.toLocaleString(undefined, {minimumFractionDigits: 2})}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-h2 mb-2">{clientName} - Overview</h2>
        <p className="text-muted">Metrics and algorithm performance across classified accounts. Profit is strictly Gross Realized PnL.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Evaluations Summary */}
        <div className="flex flex-col gap-4">
          <h3 className="text-h3 flex items-center gap-2">
            <Activity size={24} className="text-[var(--primary)]" />
            Evaluations ({evalStats.count})
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <StatCard title="Gross Realized PnL" value={evalStats.totalGrossRealized} icon={<DollarSign size={20} />} isPnL />
            <StatCard title="Weekly PnL" value={evalStats.totalWeekly} icon={evalStats.totalWeekly >= 0 ? <TrendingUp size={20}/> : <TrendingDown size={20}/>} isPnL />
          </div>
        </div>

        {/* Funded Summary */}
        <div className="flex flex-col gap-4">
          <h3 className="text-h3 flex items-center gap-2">
            <Activity size={24} className="text-[var(--success)]" />
            Funded ({fundedStats.count})
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <StatCard title="Gross Realized PnL" value={fundedStats.totalGrossRealized} icon={<DollarSign size={20} />} isPnL />
            <StatCard title="Weekly PnL" value={fundedStats.totalWeekly} icon={fundedStats.totalWeekly >= 0 ? <TrendingUp size={20}/> : <TrendingDown size={20}/>} isPnL />
          </div>
        </div>
      </div>

      {/* Visualizations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mt-4">
        <div className="card">
          <h3 className="card-title mb-6">Algorithm Realized PnL (Across Accounts)</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={accountTreeData.chart} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} tickMargin={10} />
                <YAxis stroke="var(--text-muted)" fontSize={12} tickFormatter={val => `$${val}`} />
                <Tooltip content={<CustomTooltip />} cursor={{fill: 'var(--bg-surface-hover)'}} />
                <Bar dataKey="Realized" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title mb-6">Gross Realized PnL by Prop Firm</h3>
          <div className="h-72">
            {propFirmData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={propFirmData}
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {propFirmData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                  <Legend verticalAlign="bottom" height={36} wrapperStyle={{ fontSize: '12px', color: 'var(--text-main)' }}/>
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-muted">No positive realized PnL to distribute</div>
            )}
          </div>
        </div>
      </div>

      {/* Account -> Algorithms Tree Breakdown */}
      <div className="mt-4">
        <h3 className="text-h2 mb-4">Account Breakdown (Tree View)</h3>
        <div className="flex flex-col gap-6">
          {accountTreeData.tree.map(acc => (
            <div key={acc.name} className="card p-0 overflow-hidden border border-[var(--border)]">
              {/* Account Parent Header */}
              <div className="bg-[var(--bg-surface-hover)] p-4 flex flex-col md:flex-row justify-between items-start md:items-center border-b border-[var(--border)] gap-4">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h4 className="text-h3 text-white">{acc.name}</h4>
                    <span className={`badge ${acc.bucket === 'funded' ? 'badge-success' : 'badge-primary'}`}>
                      {acc.bucket}
                    </span>
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${acc.status === 'Active' ? 'text-[var(--success)] border-[var(--success)]' : acc.status === 'Parked' ? 'text-[var(--primary)] border-[var(--primary)]' : 'text-muted border-[var(--border)]'}`}>
                      {acc.status}
                    </span>
                  </div>
                  <p className="text-sm text-muted flex items-center gap-2">
                    <Server size={14} /> {acc.propFirm} • Base: ${acc.baseBalance.toLocaleString()} • Risk: {acc.risk || 'N/A'}
                  </p>
                </div>
                
                <div className="flex gap-6 text-right">
                  <div className="hidden md:block">
                    <p className="text-xs text-muted mb-1 flex items-center justify-end gap-1"><Target size={12}/> Target Dist.</p>
                    <p className={`text-sm font-bold ${acc.distanceToTarget <= 0 ? 'text-[var(--success)]' : 'text-muted'}`}>
                      {acc.distanceToTarget <= 0 ? 'GOAL MET' : `$${acc.distanceToTarget.toLocaleString(undefined, {minimumFractionDigits: 2})}`}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted mb-1">Weekly PnL</p>
                    <p className={`text-sm font-bold ${acc.weeklyPnL >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                      ${acc.weeklyPnL.toLocaleString(undefined, {minimumFractionDigits: 2})}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted mb-1">Gross Realized</p>
                    <p className={`text-lg font-bold ${acc.grossRealized >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                      ${acc.grossRealized.toLocaleString(undefined, {minimumFractionDigits: 2})}
                    </p>
                  </div>
                </div>
              </div>

              {/* Algorithms Child Table */}
              <div className="bg-[var(--bg-base)]">
                {acc.algorithms.length > 0 ? (
                  <div className="table-container p-4">
                    <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Algorithms Running</p>
                    <table className="table text-sm border border-[var(--border)] rounded-md overflow-hidden">
                      <thead className="bg-[var(--bg-surface)]">
                        <tr>
                          <th className="py-2 px-3 text-xs">Algorithm Name</th>
                          <th className="py-2 px-3 text-xs">Instrument</th>
                          <th className="py-2 px-3 text-xs">Status</th>
                          <th className="py-2 px-3 text-xs">Alg. Realized</th>
                          <th className="py-2 px-3 text-xs">Alg. Unrealized</th>
                        </tr>
                      </thead>
                      <tbody>
                        {acc.algorithms.map((alg, idx) => (
                          <tr key={idx} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-surface-hover)]">
                            <td className="py-2 px-3 font-medium text-[var(--primary)]">{alg.name}</td>
                            <td className="py-2 px-3">{alg.instrument}</td>
                            <td className="py-2 px-3">
                              {alg.enabled ? <span className="text-[var(--success)] text-xs">Enabled</span> : <span className="text-muted text-xs">Disabled</span>}
                            </td>
                            <td className={`py-2 px-3 font-mono text-xs ${alg.realized >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                              ${alg.realized.toLocaleString(undefined, {minimumFractionDigits: 2})}
                            </td>
                            <td className={`py-2 px-3 font-mono text-xs ${alg.unrealized >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                              ${alg.unrealized.toLocaleString(undefined, {minimumFractionDigits: 2})}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4 text-sm text-muted text-center italic">No algorithms running on this account in the latest sync.</div>
                )}
              </div>
            </div>
          ))}
          {accountTreeData.tree.length === 0 && (
            <div className="card text-center py-10">
              <p className="text-muted">No accounts classified as Evaluation or Funded.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
