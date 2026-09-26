import { buildClientSegments } from './clientSegments';
import { ACCOUNT_STATUSES, ACCOUNT_TYPES, isCashType } from './reconcile';
import { ACCOUNT_NATURES, classifyAccountNature } from './simulationAccounts';
import { strategyRan } from './strategyRan';

// THE TWO MESSAGES A CLIENT ACTUALLY RECEIVES ASK "DID IT RUN", NOT "WAS IT
// ENABLED".
//
// `strategy_snapshots.enabled` is the state of a checkbox at export time, and
// the exports are taken after the desk switches the algos off. The on-screen
// report sheet moved onto `strategyRan` and these two did not, so the manager's
// table and the WhatsApp message about the same close disagreed. Measured over
// the stored book: on 38 funded account lines the message named no algorithm at
// all while something had run on it — Avery Elm's CGD06581068071881 on
// 2026-07-30 read nothing against RBO, Oakley Larch's read nothing against
// OGX_PF the same day. This is the only reader of the rule that reaches a
// person outside the desk, so it is the one that must not be left behind.
//
// buildSimulationSection's `enabledStrategies` below stays on the checkbox
// DELIBERATELY: it reports what the grid was carrying on a simulated account,
// beside that account's own order and execution counts, and "2 strategies
// enabled, 40 orders, 15 executions" is the sentence a CAM checks a sim session
// against.

function ciLookup(registry, accountName) {
  if (!registry || !accountName) return {};
  if (registry[accountName]) return registry[accountName];
  const lower = accountName.toLowerCase();
  const key = Object.keys(registry).find(k => k.toLowerCase() === lower);
  return key ? registry[key] : {};
}

export function buildWeeklyMessageReport(client) {
  if (!client) return '';
  const imports = (client.dailyImports || []);
  if (!imports.length) return '';

  // Last 5 trade days (Mon-Fri, ignoring no-close days)
  const recent = imports.slice(-7).filter((di) => di.status === 'Closed' || di.snapshots?.length > 0);
  if (!recent.length) return '';

  const sign = (n) => (n >= 0 ? '+' : '');
  const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));

  const registry = client.accountRegistry || {};
  const dailyTotals = recent.map((di) => {
    const pnl = (di.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0);
    return { date: di.date, pnl };
  });

  const weekPnl = dailyTotals.reduce((s, d) => s + d.pnl, 0);
  const bestDay = dailyTotals.reduce((best, d) => d.pnl > best.pnl ? d : best, dailyTotals[0]);
  const worstDay = dailyTotals.reduce((worst, d) => d.pnl < worst.pnl ? d : worst, dailyTotals[0]);
  const positiveDays = dailyTotals.filter((d) => d.pnl > 0).length;

  const latestImport = recent.at(-1);
  const fundedSnaps = (latestImport?.snapshots || []).filter((s) => ciLookup(registry, s.accountName)?.accountType === 'Funded');

  const weekStart = recent[0]?.date;
  const weekEnd = recent.at(-1)?.date;

  const lines = [];
  lines.push(`📊 *Weekly Summary - ${weekStart} → ${weekEnd}*`);
  lines.push(`👤 ${client?.name || 'Client'}`);
  lines.push('');
  lines.push(`💰 *Net P&L:* ${sign(weekPnl)}${fmt(weekPnl)}`);
  lines.push(`📅 *Trading days:* ${recent.length} | ✅ Positive: ${positiveDays}`);
  lines.push(`📈 *Best day:* ${sign(bestDay.pnl)}${fmt(bestDay.pnl)} (${bestDay.date})`);
  if (worstDay.date !== bestDay.date) {
    lines.push(`📉 *Worst day:* ${sign(worstDay.pnl)}${fmt(worstDay.pnl)} (${worstDay.date})`);
  }
  lines.push('');

  if (fundedSnaps.length) {
    lines.push(`✅ *Funded Accounts (${fundedSnaps.length}):*`);
    for (const s of fundedSnaps) {
      const meta = ciLookup(registry, s.accountName) || {};
      const alias = meta.alias || s.accountName;
      const strats = (s.strategies || []).filter((st) => strategyRan(st)).map((st) => st.strategyFamily || st.strategyName).join(', ');
      const dd = Number(s.trailingMaxDrawdown || 0);
      lines.push(`  • ${alias}${strats ? ` [${strats}]` : ''}${dd > 0 ? ` - Buffer: ${fmt(dd)}` : ''}`);
    }
    lines.push('');
  }

  lines.push(`_Great week! Any questions, reply here._`);
  return lines.join('\n');
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function summarizeAccountRows(rows = []) {
  const totals = rows.reduce(
    (acc, item) => ({
      grossRealizedPnl: acc.grossRealizedPnl + Number(item.grossRealizedPnl || 0),
      weeklyPnl: acc.weeklyPnl + Number(item.weeklyPnl || 0),
      aggregateBalance: acc.aggregateBalance + Number(item.accountBalance || 0),
      unrealizedPnl: acc.unrealizedPnl + Number(item.unrealizedPnl || 0),
    }),
    { grossRealizedPnl: 0, weeklyPnl: 0, aggregateBalance: 0, unrealizedPnl: 0 },
  );

  return {
    totals,
    counts: {
      accounts: rows.length,
    },
  };
}

export function buildClientMessageReport(client, dailyImport) {
  const snapshots = dailyImport?.snapshots || [];
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };

  const funded = snapshots.filter((s) => ciLookup(registry, s.accountName)?.accountType === 'Funded');
  const evals = snapshots.filter((s) => ciLookup(registry, s.accountName)?.accountType?.startsWith('Evaluation'));

  const totalDaily = snapshots.reduce((sum, s) => sum + Number(s.grossRealizedPnl || 0), 0);
  const totalWeekly = snapshots.reduce((sum, s) => sum + Number(s.weeklyPnl || 0), 0);

  const sign = (n) => (n >= 0 ? '+' : '');
  const fmt = (n) => formatCurrency(n);
  const date = dailyImport?.date || new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`📊 *Daily Update - ${date}*`);
  lines.push(`👤 ${client?.name || 'Client'}`);
  lines.push('');
  lines.push(`💰 *Daily P&L:* ${sign(totalDaily)}${fmt(totalDaily)}`);
  lines.push(`📈 *Weekly P&L:* ${sign(totalWeekly)}${fmt(totalWeekly)}`);
  lines.push('');

  if (funded.length) {
    lines.push(`✅ *Funded Accounts (${funded.length}):*`);
    for (const s of funded) {
      const meta = ciLookup(registry, s.accountName) || {};
      const alias = meta.alias || s.accountName;
      const dd = Number(s.trailingMaxDrawdown || 0);
      const pnl = Number(s.grossRealizedPnl || 0);
      const strats = (s.strategies || []).filter((st) => strategyRan(st)).map((st) => st.strategyFamily || st.strategyName).join(', ');
      lines.push(`  • ${alias}: ${sign(pnl)}${fmt(pnl)} daily${dd > 0 ? ` | Buffer: ${fmt(dd)}` : ''}${strats ? ` | ${strats}` : ''}`);
    }
    lines.push('');
  }

  if (evals.length) {
    lines.push(`🔄 *Evaluations (${evals.length}):*`);
    for (const s of evals) {
      const meta = ciLookup(registry, s.accountName) || {};
      const alias = meta.alias || s.accountName;
      const pnl = Number(s.grossRealizedPnl || 0);
      lines.push(`  • ${alias}: ${sign(pnl)}${fmt(pnl)} daily`);
    }
    lines.push('');
  }

  lines.push('_Any questions? Reply to this message._');

  return lines.join('\n');
}

/**
 * The simulation block of a client report: its own accounts, its own balance,
 * its own performance, and the words that say it is not money.
 *
 * Written because the report the desk actually sent Craig Weschke on 2026-08-06
 * read `ACCOUNTS 2 · DAILY REALIZED PNL $0 · WEEKLY PNL $0` while his Sim101 —
 * the only account of his that traded that day — ran 40 orders and 15 executions
 * for a realized -$1,297.9999999 on two enabled strategies, and his CAM had
 * hand-written a note to him about exactly that session. The desk could not show
 * the thing it was being paid to run.
 *
 * @param {number} liveAccountCount how many real-money accounts the report shows,
 *   so every simulated count can be printed against its denominator.
 * @returns {null|object} null when there is nothing simulated and nothing
 *   undetermined — absence of a section, not a section full of zeros.
 */
export function buildSimulationSection(client, dailyImport, liveAccountCount = 0) {
  const sim = dailyImport?.simulation;
  const simSnapshots = sim?.snapshots || [];
  const undeterminedSnapshots = sim?.undetermined?.snapshots || [];
  if (!simSnapshots.length && !undeterminedSnapshots.length) return null;

  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };

  const rowsFor = (snapshots, nature) => snapshots.map((snapshot) => {
    const meta = ciLookup(registry, snapshot.accountName) || {};
    const classification = classifyAccountNature(meta, { accountName: snapshot.accountName });
    const strategies = (snapshot.strategies || []).filter((strategy) => strategy.enabled);
    return {
      ...snapshot,
      meta,
      nature,
      // The sentence a CAM can check. "Treated as simulation because the account
      // is named Sim101" is auditable; a silent bucket change is not.
      natureReason: classification.reason,
      natureSource: classification.source,
      heuristic: classification.heuristic,
      enabledStrategies: strategies.map((strategy) => strategy.strategyName || strategy.strategyFamily || 'Strategy'),
    };
  });

  const simRows = rowsFor(simSnapshots, ACCOUNT_NATURES.SIMULATION);
  const undeterminedRows = rowsFor(undeterminedSnapshots, ACCOUNT_NATURES.UNDETERMINED);

  const orders = (sim?.orders || []).length;
  const executions = (sim?.executions || []).length;
  const enabledStrategies = (sim?.strategies || []).filter((strategy) => strategy.enabled).length;

  return {
    // Every label that will sit next to a number. Currency formatting alone does
    // not carry "this is not money", so the words do.
    //
    // The wording follows WHAT IS ACTUALLY IN THE SECTION. With no simulated
    // account in it, the block was still headed "Simulation (not real money)"
    // above the sentence "These accounts trade simulated funds" — printed over a
    // list of accounts whose whole classification is that nobody knows what they
    // are. A client reading it was told $200,000 of possibly-real money was play
    // money, which is the same misreport as the opposite one and lands on the
    // client rather than on the desk.
    label: simRows.length
      ? 'Simulation (not real money)'
      : 'Accounts not included in the figures above',
    note: simRows.length
      ? 'These accounts trade simulated funds. Their balances and results are shown separately and are not included in any figure above.'
      : 'These accounts could not be identified as either real money or simulated funds, so they are left out of every figure above. They are not being reported as simulated either.',
    hasSimulation: simRows.length > 0,
    accounts: simRows,
    totals: summarizeAccountRows(simRows).totals,
    counts: {
      accounts: simRows.length,
      // Every count carries its denominator.
      ofAccountsReported: simRows.length + undeterminedRows.length + liveAccountCount,
      liveAccounts: liveAccountCount,
      orders,
      executions,
      enabledStrategies,
      // 10 of the 11 simulation accounts in the real exports were idle on
      // 2026-08-06 — no strategies, no orders, no executions, balance still at
      // NinjaTrader's stock $100,000. "Idle" and "flat" are different facts.
      traded: orders > 0 || executions > 0,
    },
    // Reported, never bucketed. These accounts are in neither the real totals
    // above nor the simulated totals here.
    undetermined: undeterminedRows.length
      ? {
        label: 'Nature undetermined - counted as neither',
        accounts: undeterminedRows,
        totals: summarizeAccountRows(undeterminedRows).totals,
        counts: { accounts: undeterminedRows.length },
      }
      : null,
  };
}

export function buildDailyReportSummary(client, dailyImport) {
  const snapshots = dailyImport?.snapshots || [];
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const grouped = {
    evaluations: [],
    funded: [],
    // `cash` is every cash account combined; cashIra / cashStraight split it so
    // the two can be reported separately without losing the combined total.
    cash: [],
    cashIra: [],
    cashStraight: [],
    cashLegacy: [],
    // Real money whose pool nobody has named yet. Its own bucket rather than a
    // corner of `ignored`: an account the desk has not classified is still the
    // client's money, and `ignored` is not counted anywhere.
    unclassified: [],
    /* AN ACCOUNT THIS REPORT HAS NEVER BEEN TOLD ABOUT.
     *
     * Different from `unclassified`, and the difference is the whole reason
     * this bucket exists. `unclassified` means the desk has seen the account
     * and not named its pool yet, so it is certainly the client's money and is
     * counted. THIS means nobody has told this report the account exists at
     * all, which only happens offline: the agent renders from a roster the CRM
     * sent the last time it was reachable, and an account opened since is
     * simply absent from it.
     *
     * It cannot be counted, because the one thing an unknown account might be
     * is an evaluation, and an evaluation's profit is not the client's money.
     * Measured on a real capture from 2026-09-22: folding the unknown accounts
     * in headlined +$1,565 against a true $0.00, all of it challenge capital.
     * Even five of six accounts correctly typed still headlined +$1,548.28.
     *
     * So it gets a row, a section and its own subtotal, and stays out of the
     * total - exactly like the evaluations beside it. The report is still made,
     * and it is made correctly, which is better than refusing to make one.
     */
    pendingClassification: [],
    ignored: [],
    /* A BREACHED ACCOUNT IS NOT THIS CLIENT'S DAY.
     *
     * A prop account that breached in July still exports a row every evening,
     * so it kept appearing on every daily report after it died, with its dead
     * balance in the section subtotal. The client reads their report and sees
     * an account they lost weeks ago listed beside the ones they are trading.
     *
     * The day it fails IS the day's news, and it stays: that is when the loss
     * happened and when the client has to be told. Every day after that it is
     * history, and history belongs in the account's own record, not in today's
     * close.
     *
     * Kept in its own bucket rather than dropped, so the report can say how
     * many it left out. Silently shrinking a client's account list is how the
     * desk stops trusting the number. */
    retired: [],
  };

  const closeDate = String(dailyImport?.date || '').slice(0, 10);
  /* WHICH ACCOUNTS THIS CLOSE ITSELF SAYS DIED TODAY.
   *
   * `dateFailed` is the stamp a CAM's save leaves, and it is the cleanest
   * evidence, but it cannot be the only one: on the stored book 48 accounts
   * are Failed and exactly ONE carries the stamp, because the stamp was added
   * after most of them were classified. A rule that required it would have
   * hidden nothing and left the report exactly as it was.
   *
   * The close knows anyway. Reconcile raises a Critical "Drawdown breached"
   * flag naming the account on the day the buffer goes to zero, which is the
   * day the account died and the day the client has to be told. */
  const breachedOnThisClose = new Set(
    (dailyImport?.flags || [])
      .filter((flag) => flag.type === 'Drawdown breached')
      .map((flag) => String(flag.accountName || '').toLowerCase())
      .filter(Boolean),
  );

  for (const snapshot of snapshots) {
    const meta = ciLookup(registry, snapshot.accountName) || {};
    const row = { ...snapshot, meta };
    // Failed, and nothing about THIS close says it happened today.
    const failedOn = String(meta.dateFailed || '').slice(0, 10);
    const diedToday = (failedOn && failedOn === closeDate)
      || breachedOnThisClose.has(String(snapshot.accountName || '').toLowerCase());
    if (meta.status === ACCOUNT_STATUSES.FAILED && !diedToday) {
      grouped.retired.push(row);
      continue;
    }
    if (isCashType(meta.accountType)) {
      grouped.cash.push(row);
      if (meta.accountType === ACCOUNT_TYPES.CASH_IRA) grouped.cashIra.push(row);
      else if (meta.accountType === ACCOUNT_TYPES.CASH_STRAIGHT) grouped.cashStraight.push(row);
      else grouped.cashLegacy.push(row);
    }
    else if (meta.accountType === 'Funded') grouped.funded.push(row);
    else if (meta.accountType === 'Inactive / Ignore') grouped.ignored.push(row);
    else if (meta.accountType?.startsWith('Evaluation')) grouped.evaluations.push(row);
    else if (meta.accountType === ACCOUNT_TYPES.PENDING_CLASSIFICATION) grouped.pendingClassification.push(row);
    else grouped.unclassified.push(row);
  }

  // UNCLASSIFIED IS REAL MONEY AND IS COUNTED.
  //
  // It used to fall into `ignored`, which is in no total, so a close whose
  // account type nobody had set yet was worth $0 on the client's report. That is
  // the default state of every account the day it first appears — reconcile
  // raises `New account ... needs manual classification` for exactly this — so it
  // is the state a FIRST import is read in. Printed from the 11 real exports with
  // an empty registry, all 11 clients' reports read $0.00 real money against a
  // simulation block showing $100,000: Craig's 2026-08-06 said $0.00 / 0 accounts
  // while his two funded accounts held $85,829.60. That is the same $0 dcd3196
  // set out to fix, from a second cause, and it survived the sim split because
  // the split happens upstream of this grouping.
  //
  // `operationsSegments.js` has always counted the same accounts (SEGMENTS.
  // UNCLASSIFIED is not in EXCLUDED_FROM_TOTAL), so the desk's own view and the
  // client's report disagreed on the same accounts on the same day. This is the
  // report moving to the view, not a new policy.
  //
  // `ignored` keeps only 'Inactive / Ignore' — an explicit human decision that
  // this account is not to be counted, which is a different fact from "not yet
  // looked at".
  const allVisible = [...grouped.evaluations, ...grouped.funded, ...grouped.cash, ...grouped.unclassified, ...grouped.pendingClassification];
  /* EVALUATIONS ARE COUNTED, AND NOT TOWARDS THE DAILY PnL.
   *
   * An evaluation is a challenge account. Its profit and loss is not the
   * client's money: passing or failing is the outcome that matters, and the
   * number moves on funded capital the client does not have. Folding it into
   * "Daily realized PnL" made the headline number answer a question nobody
   * asked. A client with a $0 day on real capital and a failed evaluation read
   * as having lost the evaluation's money.
   *
   * Observed on 2026-09-08: a report headlined -$1,319 where -$810 of it was a
   * Failed evaluation account.
   *
   * They keep their row, their section and their own subtotal in `segments`, so
   * nothing is hidden. They are simply not in the total, exactly like the
   * simulation block beside them.
   *
   * THE DESK'S OWN VIEW STILL COUNTS THEM, deliberately. operationsSegments.js
   * answers "how are the algos doing", where an evaluation's result is real
   * evidence. This answers "what happened to this client's money today". The
   * two disagreeing on evaluations is the correct disagreement; they agree on
   * everything else, which is what the earlier alignment was for.
   */
  const countedTowardsDailyPnl = [...grouped.funded, ...grouped.cash, ...grouped.unclassified];
  // `totals` is REAL MONEY ONLY and always has been. `snapshots` above never
  // contains a simulated close (reconcile.js and buildCrmStateFromTables both
  // split first), and `simulation` below is built from its own arrays, so the
  // two can never be summed by accident.
  const { totals } = summarizeAccountRows(countedTowardsDailyPnl);
  const evaluationTotals = summarizeAccountRows(grouped.evaluations).totals;
  // Beside the headline, never inside it. Same treatment as the evaluations
  // above and for the same reason: a reader must be able to see what these
  // accounts did without it moving the client's daily number.
  const pendingClassificationTotals = summarizeAccountRows(grouped.pendingClassification).totals;
  // The denominator is every LIVE CLOSE, not every close the report happened to
  // group into a tile. `allVisible` drops an Unassigned or Inactive / Ignore
  // account, so a client with two unclassified real accounts and one Sim101 was
  // told "Simulated accounts 1 of 1" - which reads as "everything you have is
  // simulated" on the one report where that sentence must be exact.
  const simulation = buildSimulationSection(client, dailyImport, snapshots.length);

  const openFlags = (dailyImport?.flags || []).filter((f) => f.status !== 'Resolved' && f.status !== 'Acknowledged');
  const criticalFlags = openFlags.filter((f) => f.severity === 'Critical');

  // Prior close for delta
  const imports = client?.dailyImports || [];
  const currentIdx = imports.findIndex((d) => d.date === dailyImport?.date);
  const priorImport = currentIdx > 0 ? imports[currentIdx - 1] : null;
  const priorDailyPnl = priorImport
    ? (priorImport.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0)
    : null;

  return {
    clientName: client?.name || 'Client',
    camName: '',
    date: dailyImport?.date || '',
    status: dailyImport?.status || 'No data',
    generatedAt: new Date().toISOString(),
    grouped,
    totals,
    // Per-account-type subtotals so the report can show balance + realized PnL
    // split by pool (Eval-standard / Funded / Cash / Bullet Bot) instead of one
    // combined total. Eval-standard is kept separate from Bullet Bot because a
    // bullet-bot eval is tracked by pass/fail, not by balance. Cash PnL is net
    // of fees (the NinjaTrader "Realized PnL" column already subtracts them).
    segments: buildClientSegments(client, dailyImport),
    // Shown beside the headline, never inside it. A reader has to be able to
    // see what the evaluations did without it moving the client's daily number.
    evaluationTotals,
    pendingClassificationTotals,
    // Its own block, its own totals, never folded into `totals` or `counts`.
    // Null when the client has no simulation and nothing undetermined, so a
    // renderer can tell "no sim engagement" apart from "a sim engagement that
    // made $0" — Craig's Sim101 lost $1,297.9999999 on a day the report printed
    // $0, and the two must never look the same again.
    simulation,
    priorDailyPnl,
    flags: dailyImport?.flags || [],
    openFlags,
    criticalFlags,
    counts: {
      accounts: allVisible.length,
      evaluations: grouped.evaluations.length,
      funded: grouped.funded.length,
      cash: grouped.cash.length,
      cashIra: grouped.cashIra.length,
      cashStraight: grouped.cashStraight.length,
      openFlags: openFlags.length,
      criticalFlags: criticalFlags.length,
      // Accounts that failed on an earlier day and are therefore not on this
      // report. Counted so the sheet can say so rather than just being shorter.
      retired: grouped.retired.length,
    },
  };
}

// Every client's daily report for one date (for a CAM's "all clients for the
// day" export). Only clients that have an import on that date are included.
export function buildCamDayReport(clients = [], date) {
  const rows = [];
  for (const client of clients) {
    const dailyImport = (client.dailyImports || []).find((d) => d.date === date);
    if (!dailyImport) continue;
    rows.push({ client, dailyImport, report: buildDailyReportSummary(client, dailyImport) });
  }
  return rows.sort((a, b) => (b.report.totals.grossRealizedPnl || 0) - (a.report.totals.grossRealizedPnl || 0));
}

// buildTeamWeeklyReport USED TO BE HERE, behind the "Weekly Report" button.
//
// It was a FOURTH independent answer to what the desk made: its own wall-clock
// week boundary (`new Date()`, so on a book whose last close is 2026-07-30 it
// covered a week with nothing in it), its own loop over `snapshots` with no
// segment filter at all, and one headline "Portfolio P&L" that added the cash
// desk's real client money to the prop desk's simulated plan size.
//
// The button now renders formatDeskReport() from deskMoney.js, the same object
// the tiles and the history table render, so there is one computation and one
// answer. Deleted rather than left unused: a helper named buildTeamWeeklyReport
// is one the next person will wire back up.
