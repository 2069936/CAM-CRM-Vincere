// Per-account algorithm history: what ran, and what it was worth.
//
// The Stack Playbook already charts an account's equity curve and marks the
// dates its algo combo changed. What it could not answer is the question that
// follows every one of those marks: what did each algo contribute?
//
// SUPERSEDED CLAIM — read this before trusting the paragraph it replaces.
//
// This header used to assert that a per-algo split "is reported, not derived",
// on the strength of two measurements:
//
//   1. The Strategies tab populates `realized` on a minority of rows — 1824 of
//      2241 stored account-days have every strategy at 0, and on 894 of those
//      the account still moved.
//   2. "FIFO pairing within a day reconciled 216 account-days out of 1112", read
//      as proof that fills cannot be paired inside one export.
//
// Claim 1 still holds and is exactly why this file exists. CLAIM 2 WAS NOT A
// MEASUREMENT OF ANYTHING. It was taken against public/local-snapshot.json, and
// that fixture is REDACTED: its `time_text` and `entry_exit` columns are blanked
// out. Those are the columns pairing needs — without a time you cannot order the
// fills, and unordered fills pair at random. The 216/1112 figure measured the
// redaction, not the data. Anyone re-running FIFO against that snapshot will get
// the same number and reach the same wrong conclusion, so: do not use
// local-snapshot.json to decide what is derivable. It cannot answer the question.
//
// WHAT IS TRUE, over two real unredacted exports on consecutive trading days.
// Chronologically ordered FIFO per (account, instrument) reproduces the Accounts
// grid's Gross realized PnL to the cent on every traded account whose books can
// all be priced: 21 of 21 on 2026-08-18, and 19 of 19 on 2026-08-19 (the
// twentieth account's grid exported no gross column, so it is refused rather
// than checked against the commission-netted one). The per-strategy attribution
// then reproduces the non-zero values the Strategies grid reported with zero
// disagreements: 11 of 11 on the first day, 26 of 27 on the second — the 27th
// declined outright rather than contradicted, because both of its legs were
// blank-Strategy and nothing in the fills names an owner. It also recovers rows
// the grid left at zero. See deriveStrategyPnl.js for the five rules.
//
// AND WHAT THAT DOES NOT SHOW, WHICH IS MORE THAN IT LOOKS. Every book on BOTH
// days was flat at both ends and touched by at most one named strategy, which
// makes both figures pairing-independent: FIFO, LIFO and any other matching
// produce the same account totals and the same per-strategy split. Two green
// days are real evidence about the fill set, the multipliers and the keying, and
// NO evidence at all about FIFO, about the ordering basis, or about the
// tie-breaking.
//
// NOR ABOUT CARRY-IN, AND THAT ONE COST SOMETHING. Not one book on either day
// carried a position in, so neither run says anything whatever about a position
// opened before the file starts. The first day's perfect result was briefly read
// as covering it; it never did. A book like that is now REFUSED outright unless
// the caller can supply the previous close's priced lots, and an account holding
// one publishes nothing here.
//
// The day-two run also did something a green run cannot: it FALSIFIED a rule.
// Four grid-reported per-strategy values came out wrong under the strict
// attribution rule day one had shipped, by $311.50, $315.00, $400.00 and
// $201.00. That is what rule 4b in deriveStrategyPnl.js exists to fix, and it is
// the only reason to trust it over the rule it replaced. Read the "WHAT THIS RUN
// DOES AND DOES NOT PROVE" section of scripts/verify-derived-pnl.mjs before
// quoting any number, and the same caveat at the head of deriveStrategyPnl.js.
//
// So the split IS derived now, where it can be. What has not changed is the rule
// about honesty, which still decides everything below:
//
//   * A derived figure is shown only for an account-day whose derived total
//     reconciles with its gross AND leaves nothing unattributed AND whose
//     per-algo figures, as joined onto this account's roster, still add up to
//     that gross. The last of those is re-checked here rather than trusted from
//     the producer: a join that copies one derived row onto two same-named
//     roster rows doubles the money while every row and every status still looks
//     right. Anything less is reported as a roster plus a residual, never as a
//     split.
//   * Derived and reported stay separate fields forever. `reportedPnl` is what
//     NinjaTrader said; `derivedPnl` is what the fills say. A reader who cannot
//     tell which is which cannot judge either.
//   * Nothing is ever spread across algos to fill a gap. A made-up contribution
//     is worse than a missing one, because it looks like an answer.
//
// And what was always exact stays exact: which algos ran, and what the account
// did while they ran. The combination periods below attribute nothing at all.

const dayKey = (s) => `${s.strategyFamily || s.strategyName || 'Unknown'}${s.strategyVersion ? ` ${s.strategyVersion}` : ''}`;

const money = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// null and undefined mean "the export did not say", which is not the same claim
// as "$0" and must never be rounded into one. Legacy stored rows predate the
// distinction and carry 0 for both.
const reportedOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// A day reconciles when the strategies' reported realized adds up to the
// account's realized. Zero-vs-zero is not evidence of anything, so a flat day
// with nothing reported counts as unreported rather than as agreement.
function reconcilesOn(dayPnl, reportedSum, anyReported) {
  if (!anyReported) return false;
  return Math.abs(reportedSum - dayPnl) < 1;
}

/**
 * Chronological algo history for one account of one client.
 *
 * Shape mirrors buildAccountEquitySeries: one entry per stored close, oldest
 * first, so indexes line up with the equity chart the Playbook already draws.
 */
export function buildAlgoAccountHistory(client, accountName) {
  const lower = String(accountName || '').toLowerCase();

  const imports = [...(client?.dailyImports || [])]
    .filter((di) => di.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const days = [];
  for (const di of imports) {
    const snapshot = (di.snapshots || []).find(
      (s) => String(s.accountName || '').toLowerCase() === lower,
    );
    if (!snapshot) continue;

    const strategies = snapshot.strategies || [];
    const derivation = snapshot.derivation || null;
    const algos = strategies.map((s) => ({
      key: dayKey(s),
      family: s.strategyFamily || s.strategyName || 'Unknown',
      version: s.strategyVersion || '',
      direction: s.direction || '',
      instrument: s.instrument || '',
      enabled: Boolean(s.enabled),
      // What NinjaTrader said. `reported` is null when it said nothing at all —
      // an absent grid column, not a zero — while `realized` keeps the old
      // zero-coalesced reading every existing caller of this shape expects.
      reported: reportedOrNull(s.realized),
      realized: money(s.realized),
      // What the fills say. Populated by reconcile.js only on an account-day
      // that reconciled with nothing left unattributed; null everywhere else,
      // including on every close stored before this existed.
      derived: reportedOrNull(s.derivedRealized),
    }));

    const dayPnl = money(snapshot.grossRealizedPnl);
    const reportedSum = algos.reduce((n, a) => n + a.realized, 0);
    const anyReported = algos.some((a) => a.reported != null && a.reported !== 0);
    // The derived rows must still add up to the account's own gross before any
    // of them is shown. This is checked HERE, on the figures actually about to
    // be displayed, and not taken on trust from the producer: a join that copies
    // one derived row onto two same-named roster rows leaves every row non-null
    // and every status 'exact' while the account's money has been doubled. Only
    // the sum catches that.
    //
    // The basis is the derivation's own `reportedGross` — the raw 'Gross
    // realized PnL' column — not `dayPnl`, which prefers the commission-netted
    // 'Realized PnL' whenever the grid exported both and differs from gross on
    // nearly every traded account.
    const derivedSum = algos.reduce((n, a) => n + (a.derived == null ? 0 : a.derived), 0);
    const derivedBasis = derivation && derivation.reportedGross != null ? Number(derivation.reportedGross) : null;
    const derivedReconciles = derivedBasis != null
      && Math.abs(derivedSum - derivedBasis) <= 0.01 * (algos.length + 1);
    // A day is derived when the derivation ran, said 'exact', every algo on the
    // roster carries a figure, and those figures reconcile. Anything short of
    // that is a partial split, and a partial split shown whole is the failure
    // this feature is for. `every` is load-bearing: reconcile leaves a roster row
    // the fills never named at null rather than at a fabricated zero, so a
    // genuinely partial roster reaches here with some figures and some nulls.
    const derivedDay = derivation?.status === 'exact'
      && algos.length > 0
      && algos.every((a) => a.derived != null)
      && derivedReconciles;
    // Derived money credited to a strategy this account's Strategies grid never
    // listed. It belongs to the account and is never shown inside an algo row,
    // so it is carried out separately and named.
    const offRoster = Array.isArray(derivation?.join?.offRoster) ? derivation.join.offRoster : [];

    days.push({
      date: di.date,
      dayPnl,
      balance: money(snapshot.accountBalance),
      trailing: money(snapshot.trailingMaxDrawdown),
      algos,
      combo: [...new Set(algos.filter((a) => a.enabled).map((a) => a.key))].sort().join(' + ') || 'None',
      reportedSum,
      derivation,
      derived: Boolean(derivedDay),
      derivedSum,
      derivedReconciles,
      offRoster,
      offRosterPnl: money(derivation?.join?.offRosterRealized),
      // Money the fills paired but could not credit to any one strategy — a
      // manual leg, a detached exit, a lot carried in from a session we do not
      // hold. Surfaced, never folded into an algo and never dropped.
      unattributedResidual: money(derivation?.residual?.realized),
      reportedReconciles: reconcilesOn(dayPnl, reportedSum, anyReported),
      // Only these days may show a per-algo split. Either source will do; the
      // rows below record which one each figure came from.
      attributed: Boolean(derivedDay) || reconcilesOn(dayPnl, reportedSum, anyReported),
    });
  }

  return { days, periods: buildComboPeriods(days), algos: rollUpAlgos(days), attribution: summarize(days) };
}

// Consecutive runs of the same combo. This is the part that needs no
// attribution to be true: the roster is exact and the account's PnL is exact,
// so "this account, with this combination, over these days" is exact too.
export function buildComboPeriods(days = []) {
  const periods = [];
  for (const day of days) {
    const last = periods[periods.length - 1];
    if (last && last.combo === day.combo) {
      last.to = day.date;
      last.days += 1;
      last.totalPnl += day.dayPnl;
      last.greenDays += day.dayPnl > 0 ? 1 : 0;
      last.best = Math.max(last.best, day.dayPnl);
      last.worst = Math.min(last.worst, day.dayPnl);
    } else {
      periods.push({
        combo: day.combo,
        from: day.date,
        to: day.date,
        days: 1,
        totalPnl: day.dayPnl,
        greenDays: day.dayPnl > 0 ? 1 : 0,
        best: day.dayPnl,
        worst: day.dayPnl,
      });
    }
  }
  return periods.map((p) => ({ ...p, avgPnl: p.days ? p.totalPnl / p.days : 0 }));
}

// One row per algo that ever ran on the account.
//
// Three totals, kept apart on purpose. `reportedPnl` is what NinjaTrader's
// Strategies grid said, summed over the days it said it. `derivedPnl` is what
// this account's own fills say, summed over the days that fully derived.
// `contributionPnl` is the one to display: derived where a derivation exists,
// reported otherwise — with `derivedDays`/`reportedDays` saying which days came
// from where, because a total blended from two sources without a source label
// cannot be checked by the person reading it.
export function rollUpAlgos(days = []) {
  const map = new Map();
  for (const day of days) {
    for (const algo of day.algos) {
      let row = map.get(algo.key);
      if (!row) {
        row = {
          key: algo.key,
          family: algo.family,
          version: algo.version,
          directions: new Set(),
          instruments: new Set(),
          daysPresent: 0,
          daysEnabled: 0,
          firstSeen: day.date,
          lastSeen: day.date,
          reportedPnl: 0,
          reportedDays: 0,
          derivedPnl: 0,
          derivedDays: 0,
          contributionPnl: 0,
        };
        map.set(algo.key, row);
      }
      if (algo.direction) row.directions.add(algo.direction);
      if (algo.instrument) row.instruments.add(algo.instrument);
      row.daysPresent += 1;
      row.daysEnabled += algo.enabled ? 1 : 0;
      row.lastSeen = day.date;
      // A day can be derived, reported, or both. When it is both they agree —
      // the measurement that licensed this feature found 11 of 11 exact matches
      // and no disagreement — but each total tracks only its own source, so a
      // future divergence surfaces as a divergence instead of averaging away.
      const usableDerived = day.derived && algo.derived != null;
      if (usableDerived) {
        row.derivedPnl += algo.derived;
        row.derivedDays += 1;
      }
      if (day.reportedReconciles) {
        row.reportedPnl += algo.realized;
        row.reportedDays += 1;
      }
      // Displayed contribution: derived wins, reported fills in, and a day that
      // is neither contributes nothing rather than a guess.
      if (usableDerived) row.contributionPnl += algo.derived;
      else if (day.reportedReconciles) row.contributionPnl += algo.realized;
    }
  }
  return [...map.values()]
    .map((r) => ({ ...r, directions: [...r.directions].sort(), instruments: [...r.instruments].sort() }))
    .sort((a, b) => b.daysPresent - a.daysPresent || a.key.localeCompare(b.key));
}

// How much of this account's history actually carries a per-algo split, stated
// plainly so the UI can say so instead of implying full coverage.
export function summarize(days = []) {
  const attributedDays = days.filter((d) => d.attributed);
  const derivedDays = days.filter((d) => d.derived);
  const reportedDays = days.filter((d) => d.reportedReconciles);
  const accountTotal = days.reduce((n, d) => n + d.dayPnl, 0);
  const attributedPnl = attributedDays.reduce((n, d) => n + d.dayPnl, 0);
  // Money the fills DID pair but could not credit to one strategy, on days that
  // otherwise reconciled. Distinct from `unattributedPnl`, which is whole days
  // with no split at all. Both are shown; neither is folded into an algo.
  const residualPnl = days.reduce((n, d) => n + money(d.unattributedResidual), 0);
  // Money the fills credited to a strategy that is on no row of this account's
  // Strategies grid. Kept apart from `residualPnl` on purpose: the residual is
  // money no strategy could be named for, this is money whose strategy WAS named
  // and has nowhere on the roster to sit. It is part of `accountTotal` already —
  // it is a description of where an unattributed day's money went, never an
  // extra amount to add on.
  const offRosterPnl = days.reduce((n, d) => n + money(d.offRosterPnl), 0);
  const offRosterNames = [...new Set(days.flatMap((d) => (d.offRoster || []).map((row) => row.strategyName)))]
    .filter(Boolean)
    .sort();
  return {
    totalDays: days.length,
    attributedDays: attributedDays.length,
    derivedDays: derivedDays.length,
    reportedDays: reportedDays.length,
    accountTotal,
    attributedPnl,
    unattributedPnl: accountTotal - attributedPnl,
    residualPnl,
    offRosterPnl,
    offRosterNames,
    status: !days.length ? 'empty' : !attributedDays.length ? 'unavailable' : attributedDays.length === days.length ? 'complete' : 'partial',
  };
}
