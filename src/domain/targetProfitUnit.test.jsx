// @vitest-environment jsdom
//
// The writers and the readers of `trading_accounts.target_profit`, tied to each
// other so a unit change on either side fails here.
//
// WHY THIS SHAPE. The field held two units: AccountManager wrote the profit
// AMOUNT a firm publishes (3,000 on a 50k) when a CAM picked a plan, App.jsx
// wrote the absolute BALANCE that passes (54,100) when a CAM classified an
// account, and nine of the eleven readers of the time compared the stored value
// to a live balance. The two client report readers that landed since
// (evaluationReport, progressToTarget) read it as a balance too, and are pinned
// below with the rest. Picking a plan on a 50k evaluation therefore made it read as already
// passed, everywhere progress is shown. accountTargets.js carries the argument
// for the balance.
//
// A test that fed a hand-written `targetProfit: 53000` to one reader and checked
// the percentage would pass green with that bug still in place — the fixture
// would be supplying the unit the reader wants while the writer supplied
// something else. This repo has shipped four tests that passed because they
// matched a comment instead of the behaviour, so:
//
//   * NO TEST BELOW WRITES A TARGET. Every target comes out of a real writer —
//     the rendered AccountManager plan picker, or classificationDefaults(),
//     the function App.jsx's handler runs on classification.
//   * The readers are the real readers, called through their own entry points,
//     not re-implemented arithmetic.
//   * Each pair is probed at TWO balances, and the assertions point in opposite
//     directions: an account sitting at its own start has NOT reached target, and
//     one sitting at the written target HAS. One anchor alone is not enough —
//     "reached at target" still passes if the field is an amount, because a
//     50k balance clears a 3,000 target too. It is the pair that pins the unit.
//
// So: flip the unit in a writer and the "at start" half fails. Flip it in a
// reader and one half or the other fails. Flip both and the two writers stop
// agreeing with each other, which `writers agree on the unit` catches.

import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AccountManager from '../components/AccountManager';
import Dashboard from '../components/Dashboard';
import { classificationDefaults } from './accountTargets';
import { reconcileDailyImport, ACCOUNT_TYPES, PAYOUT_STATES, ACCOUNT_STATUSES } from './reconcile';
import { buildBulletBotAccountRecords } from './bulletBotStats';
import { PROP_FIRM_RULES, STANDARD_ACCOUNT_SIZES, GENERIC_TARGET_BALANCE, plansFor } from './propFirmRules';
import { evaluationProgressFor, EVALUATION_PROGRESS } from './evaluationReport';
import { buildProgressToTargetRows } from './progressToTarget';
import {
  buildClientOverview,
  buildPayoutAlerts,
  buildAllFundedAccounts,
  buildIncomeProjection,
  buildCamFundedRows,
  buildManagerEvaluationRows,
  buildPortfolioInsights,
  weeklyTargetPct,
} from '../App';

/* A 50k Legends account. Legends is in FIRM_PATTERNS and PROP_FIRM_RULES holds
 * Apprentice and Elite at 50k, so the plan picker has something to offer and
 * resolveAccountLimits has a rule to find. The size is the one the book is
 * mostly made of. */
const FIRM = 'Legends';
const PLAN = 'Elite';
const SIZE = 50000;
const RULE_KEY = `${FIRM}|${PLAN}|${SIZE}`;

/* Read off PROP_FIRM_RULES rather than typed here, so this stays true if the
 * desk re-researches Legends. It is the published profit AMOUNT — the number the
 * old code wrote into the balance column. Nothing asserts a target equals it;
 * it is only used to prove the writers are NOT emitting it. */
const PUBLISHED_AMOUNT = PROP_FIRM_RULES[RULE_KEY].profitTarget;

function accountFixture(overrides = {}) {
  return {
    accountName: 'LEG-1',
    alias: 'Legends Main',
    accountType: ACCOUNT_TYPES.FUNDED,
    status: ACCOUNT_STATUSES.ACTIVE,
    connection: FIRM,
    startBalance: SIZE,
    payoutState: PAYOUT_STATES.NOT_REQUESTED,
    maxDrawdownLimit: 2000,
    ...overrides,
  };
}

// ───────────────────────────── WRITERS ─────────────────────────────
// Each returns the value its real code path puts in `targetProfit`.

/**
 * The plan picker in the account registry. Renders the real AccountManager,
 * opens the plan <select> for the row and picks a plan, then returns the
 * `targetProfit` from the patch the component emitted. Nothing here constructs a
 * target.
 */
function writeByPickingAPlan(account) {
  const patches = [];
  render(
    <AccountManager
      accounts={{ [account.accountName]: { ...account, targetProfit: '' } }}
      snapshots={[{ accountName: account.accountName, accountBalance: SIZE }]}
      dailyImports={[{ date: '2026-09-01', snapshots: [{ accountName: account.accountName, accountBalance: SIZE }] }]}
      onUpdateAccount={(name, patch) => patches.push({ name, patch })}
      onAddAccount={() => {}}
      onRemoveAccount={() => {}}
    />,
  );
  // Guard the premise: if the picker stops offering plans this writer is no
  // longer being exercised, and a silent pass would mean nothing.
  expect(plansFor(FIRM)).toContain(PLAN);
  fireEvent.change(screen.getByLabelText(`Plan for ${account.accountName}`), { target: { value: PLAN } });
  cleanup();

  expect(patches).toHaveLength(1);
  expect(patches[0].patch).toHaveProperty('targetProfit');
  return Number(patches[0].patch.targetProfit);
}

/**
 * The classification default. App.jsx's onUpdateAccount handler merges
 * `classificationDefaults(patch.accountType, meta, balance)` into the patch when
 * a CAM sets an account's type; this is that function, the one the handler
 * runs, called on an account whose target is still empty.
 */
function writeByClassifying(account) {
  const augment = classificationDefaults(account.accountType, { ...account, targetProfit: '' }, SIZE);
  expect(augment).toHaveProperty('targetProfit');
  return Number(augment.targetProfit);
}

const WRITERS = [
  { name: 'AccountManager plan picker', write: writeByPickingAPlan },
  { name: 'App.jsx classification default', write: writeByClassifying },
];

// ───────────────────────────── READERS ─────────────────────────────
// Each answers "does this reader call the account target-reached?" for an
// account carrying `targetProfit` at the given balance. Real entry points only.

const clientWith = (account, balance) => ({
  id: 'c1',
  name: 'Client One',
  accountRegistry: { [account.accountName]: account },
  dailyImports: [{
    date: '2026-09-02',
    accounts: { [account.accountName]: account },
    snapshots: [{
      accountName: account.accountName,
      accountBalance: balance,
      grossRealizedPnl: balance - SIZE,
      weeklyPnl: balance - SIZE,
      trailingMaxDrawdown: 1500,
      strategies: [],
    }],
    executions: [],
    orders: [],
  }],
});

const READERS = [
  {
    name: 'reconcile · Payout eligible flag',
    reached: (account, balance) => reconcileDailyImport({
      clientId: 'c1',
      date: '2026-09-02',
      registry: { [account.accountName]: account },
      parsed: {
        accounts: [{ accountName: account.accountName, connection: FIRM, accountBalance: balance, grossRealizedPnl: balance - SIZE, trailingMaxDrawdown: 1500, weeklyPnl: balance - SIZE }],
        strategies: [{ accountName: account.accountName, strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true }],
        orders: [],
        executions: [],
      },
    }).flags.some((f) => f.type === 'Payout eligible'),
  },
  {
    name: 'reconcile · Evaluation target reached flag',
    accountType: ACCOUNT_TYPES.EVALUATION_BULLET,
    reached: (account, balance) => reconcileDailyImport({
      clientId: 'c1',
      date: '2026-09-02',
      registry: { [account.accountName]: account },
      parsed: {
        accounts: [{ accountName: account.accountName, connection: FIRM, accountBalance: balance, grossRealizedPnl: balance - SIZE, trailingMaxDrawdown: 1500, weeklyPnl: balance - SIZE }],
        strategies: [{ accountName: account.accountName, strategyName: '0 - BulletBot-1.0', strategyFamily: 'Bullet Bot', enabled: true }],
        orders: [],
        executions: [],
      },
    }).flags.some((f) => f.type === 'Evaluation target reached'),
  },
  {
    name: 'bulletBotStats · passed',
    accountType: ACCOUNT_TYPES.EVALUATION_BULLET,
    reached: (account, balance) => buildBulletBotAccountRecords([clientWith(account, balance)])[0].passed,
  },
  {
    name: 'App · buildPayoutAlerts ready',
    reached: (account, balance) => {
      const client = clientWith(account, balance);
      const alerts = buildPayoutAlerts(client, client.dailyImports[0]);
      return alerts.some((a) => a.ready);
    },
  },
  {
    name: 'App · buildClientOverview passProgress',
    percent: (account, balance) => {
      const client = clientWith(account, balance);
      return buildClientOverview(client, client.dailyImports[0])
        .passProgress.find((a) => a.accountName === account.accountName).progress;
    },
  },
  {
    name: 'App · buildAllFundedAccounts targetPct',
    percent: (account, balance) => buildAllFundedAccounts([clientWith(account, balance)], [])[0].targetPct,
  },
  {
    name: 'App · buildIncomeProjection pct',
    percent: (account, balance) => buildIncomeProjection([clientWith(account, balance)])[0].pct,
  },
  {
    /* The two "Target %" columns — ManagerOverview and buildCamFundedRows — are
     * the only readers that want the field as an AMOUNT, and they divide a
     * week's PnL by it. Both now go through weeklyTargetPct, so pinning it pins
     * both. The fixture's weeklyPnl is `balance - SIZE`, so an account sitting at
     * its start has made nothing this week and one at its target has made exactly
     * the profit the target asked for. */
    name: 'App · weeklyTargetPct (both Target % columns)',
    percent: (account, balance) => weeklyTargetPct(account, {
      accountBalance: balance,
      weeklyPnl: balance - SIZE,
    }),
  },
  {
    /* ManagerOverview's evaluations table, the other "Target %" column. Its
     * builder only computes a figure when the week moved, and prints nothing on
     * a flat week, so at the account's own start the claim it makes is a blank,
     * not 0%. The "at target" half is where the unit bites: a week that made the
     * whole remaining profit is 100%, and divided by the balance it would be a
     * single digit. */
    name: 'App · buildManagerEvaluationRows targetPct',
    accountType: ACCOUNT_TYPES.EVALUATION_BULLET,
    blankOnFlatWeek: true,
    percent: (account, balance) => {
      const rows = buildManagerEvaluationRows([clientWith(account, balance)], [], '');
      expect(rows).toHaveLength(1);
      return rows[0].targetPct;
    },
  },
  {
    name: 'App · buildCamFundedRows pct',
    percent: (account, balance) => buildCamFundedRows([clientWith(account, balance)])[0].pct,
  },
  {
    /* The arithmetic lives inline in Dashboard's JSX, so the only way to read
     * its verdict is to render it. `title="Funded"` is what turns the target
     * column on (AccountTable keys `isFunded` off the title).
     *
     * Both halves are read, not just the percentage. The cell computes the
     * percentage from `target - start` and the reached state from
     * `balance >= target`, and those two are separately unit-sensitive: flipping
     * only the comparison to `balance - start >= target` leaves the percentage
     * untouched, so a percentage-only assertion passes with the bug back in. */
    name: 'Dashboard · funded target cell',
    percent: (account, balance) => renderDashboardTargetCell(account, balance, 'Funded').percent,
    reached: (account, balance) => renderDashboardTargetCell(account, balance, 'Funded').reached,
  },
  {
    name: 'Dashboard · evaluation target cell',
    accountType: ACCOUNT_TYPES.EVALUATION_BULLET,
    percent: (account, balance) => renderDashboardTargetCell(account, balance, 'Bullet Bot').percent,
    reached: (account, balance) => renderDashboardTargetCell(account, balance, 'Bullet Bot').reached,
  },
  {
    /* The client report's evaluations section (PR 64). Reads the stored value as
     * a balance and has both claims: a percentage, and a REACHED state that is
     * decided by `balance >= target` before any percentage is computed. */
    name: 'evaluationReport · evaluationProgressFor',
    accountType: ACCOUNT_TYPES.EVALUATION_BULLET,
    percent: (account, balance) => evaluationProgressFor(reportRow(account, balance)).percent,
    reached: (account, balance) =>
      evaluationProgressFor(reportRow(account, balance)).state === EVALUATION_PROGRESS.REACHED,
  },
  {
    /* The client report's "Progress to target" table. */
    name: 'progressToTarget · buildProgressToTargetRows',
    percent: (account, balance) => {
      const rows = buildProgressToTargetRows({ grouped: { funded: [reportRow(account, balance)], evaluations: [] } });
      // Guard the premise: a stored target is what admits a row, so an empty
      // result means this reader was never exercised.
      expect(rows).toHaveLength(1);
      return rows[0].percent;
    },
  },
];

/** A report row as buildDailyReportSummary groups it: the close plus `meta`. */
function reportRow(account, balance) {
  return { accountName: account.accountName, accountBalance: balance, meta: account };
}

/**
 * Renders Dashboard and reads the target cell's two claims: the percentage, and
 * whether it is calling the account done. `title` is what selects the funded or
 * the evaluation cell.
 */
function renderDashboardTargetCell(account, balance, title) {
  const client = clientWith(account, balance);
  render(
    <Dashboard
      dailyImport={client.dailyImports[0]}
      client={client}
      title={title}
      mode={title === 'Funded' ? 'funded' : 'evaluations'}
      rows={[{
        accountName: account.accountName,
        accountBalance: balance,
        weeklyPnl: balance - SIZE,
        grossRealizedPnl: balance - SIZE,
        strategies: [],
        meta: account,
      }]}
      onUpdateAccount={() => {}}
    />,
  );
  const cell = document.querySelector('.target-cell small');
  // Guard the premise: a missing cell means the column did not render and this
  // reader was never exercised, which must not read as a pass.
  expect(cell).not.toBeNull();
  const text = String(cell.textContent);
  // The funded cell prints the percentage and marks reached with the 'positive'
  // class; the evaluation cell replaces the percentage with '✓ Passed'.
  const reached = cell.classList.contains('positive');
  const percent = reached && !/%/.test(text) ? 100 : Number(text.replace('%', ''));
  cleanup();
  return { percent, reached };
}

// ───────────────────────────── THE PAIRINGS ─────────────────────────────

describe('target_profit: every writer against every reader', () => {
  for (const writer of WRITERS) {
    for (const reader of READERS) {
      const type = reader.accountType ?? ACCOUNT_TYPES.FUNDED;

      it(`${writer.name} -> ${reader.name}: not reached at the account's own start`, () => {
        const account = accountFixture({ accountType: type });
        const targetProfit = writer.write(account);
        const written = { ...account, targetProfit };

        // The premise of the whole file: if a writer ever emits the published
        // profit amount again, say so here rather than letting a reader's
        // verdict explain it.
        expect(targetProfit).toBeGreaterThan(SIZE);
        expect(targetProfit).not.toBe(PUBLISHED_AMOUNT);

        // Both halves where a reader has both: the percentage and the verdict
        // are separately unit-sensitive, and asserting one lets the other flip.
        if (reader.reached) expect(reader.reached(written, SIZE)).toBe(false);
        if (reader.percent) {
          if (reader.blankOnFlatWeek) expect(reader.percent(written, SIZE)).toBeNull();
          else expect(reader.percent(written, SIZE)).toBe(0);
        }
      });

      it(`${writer.name} -> ${reader.name}: reached at the written target`, () => {
        const account = accountFixture({ accountType: type });
        const targetProfit = writer.write(account);
        const written = { ...account, targetProfit };

        if (reader.reached) expect(reader.reached(written, targetProfit)).toBe(true);
        if (reader.percent) expect(reader.percent(written, targetProfit)).toBe(100);
      });
    }
  }
});

describe('the two writers agree on the unit', () => {
  it('both emit a balance above the account size, not the published profit amount', () => {
    const account = accountFixture();
    const fromPlan = writeByPickingAPlan(account);
    const fromClassification = writeByClassifying(account);

    for (const written of [fromPlan, fromClassification]) {
      expect(written).toBeGreaterThan(SIZE);
      // The two tables differ by design — the firm rule is researched per plan,
      // accountTargets' is the desk's standard — so they are not asserted equal.
      // What matters is that neither is the amount, and both are reachable only
      // by an account that has actually made money.
      expect(written).not.toBe(PUBLISHED_AMOUNT);
      expect(written - SIZE).toBeLessThan(SIZE);
    }
  });

  it('the published amount, already stored, no longer reads as passed', () => {
    // This used to demonstrate the defect: 3,000 on a 50k start, at its opening
    // balance, raised "Payout eligible". The writers no longer produce it, but
    // production still held one such row (step 61 converts it), and a reader
    // must refuse it rather than wait for the migration.
    expect(PUBLISHED_AMOUNT).toBeLessThan(SIZE);
    const account = accountFixture({ targetProfit: PUBLISHED_AMOUNT });
    const reader = READERS.find((r) => r.name === 'reconcile · Payout eligible flag');
    // An account that has made nothing, sitting at its opening balance.
    expect(reader.reached(account, SIZE)).toBe(false);
  });
});

// ───────────────── STORED TARGETS NO READER MAY USE ─────────────────
//
// The writers above cannot produce these any more. Production still holds
// them, counted read only on 2026-10-06 (8 of 726 positive targets under
// 10,000, src/domain/storedTarget.js names each):
//
//   AMOUNT    3,000 on a stored 50,000 start (the Bullet Bot row step 61
//             converts). Read at the opening balance: the account made nothing.
//   NO_START  4,000 with no stored start (the six Funded rows). Read with a close
//             AT 4,000 and an earliest close of 3,500, so a reader that falls
//             back to the earliest close finds a start and a "reached" account.
//
// The rule is that a stored target is used only above a known start, and a
// reader given one that is not says "target not set" rather than "reached" or
// 100%. Each pair below said "reached" or 100% BEFORE this change; the readers
// that already refused these shapes (buildPayoutAlerts, passProgress,
// buildAllFundedAccounts, buildIncomeProjection, weeklyTargetPct and both
// Target % columns) are not repeated here, because a test that cannot fail on
// the old code proves nothing about the new one.

const UNUSABLE = {
  AMOUNT: {
    meta: { targetProfit: 3000, startBalance: 50000 },
    balance: 50000,
  },
  NO_START: {
    meta: { targetProfit: 4000, startBalance: '' },
    balance: 4000,
    firstClose: 3500,
  },
};

/** The client's history for the readers that take a start from the earliest close. */
function historyFor(account, shape) {
  return [{
    date: '2026-08-03',
    snapshots: [{ accountName: account.accountName, accountBalance: shape.firstClose ?? shape.balance }],
  }];
}

const REFUSING = [
  { reader: 'reconcile · Payout eligible flag', shapes: ['AMOUNT', 'NO_START'] },
  { reader: 'reconcile · Evaluation target reached flag', shapes: ['AMOUNT', 'NO_START'] },
  { reader: 'bulletBotStats · passed', shapes: ['AMOUNT', 'NO_START'] },
  // The two Dashboard cells are read below by what they print instead: a cell
  // that refuses has no progress bar left to read a verdict from.
];

describe('a stored target that is not above a known start is not a target', () => {
  for (const { reader: name, shapes } of REFUSING) {
    const reader = READERS.find((r) => r.name === name);
    for (const shapeName of shapes) {
      const shape = UNUSABLE[shapeName];
      it(`${name}: ${shapeName} is not reached`, () => {
        const account = accountFixture({ accountType: reader.accountType ?? ACCOUNT_TYPES.FUNDED, ...shape.meta });
        expect(reader.reached(account, shape.balance)).toBe(false);
      });
    }
  }

  for (const title of ['Funded', 'Bullet Bot']) {
    for (const shapeName of Object.keys(UNUSABLE)) {
      it(`Dashboard ${title} cell: ${shapeName} says "Target not set", not a percentage`, () => {
        const shape = UNUSABLE[shapeName];
        const account = accountFixture({
          accountType: title === 'Funded' ? ACCOUNT_TYPES.FUNDED : ACCOUNT_TYPES.EVALUATION_BULLET,
          ...shape.meta,
        });
        const client = clientWith(account, shape.balance);
        render(
          <Dashboard
            dailyImport={client.dailyImports[0]}
            client={client}
            title={title}
            mode={title === 'Funded' ? 'funded' : 'evaluations'}
            rows={[{ accountName: account.accountName, accountBalance: shape.balance, weeklyPnl: 0, grossRealizedPnl: 0, strategies: [], meta: account }]}
            onUpdateAccount={() => {}}
          />,
        );
        const cell = document.querySelector('.target-not-set');
        const progress = document.querySelector('.target-cell');
        cleanup();
        expect(progress).toBeNull();
        expect(cell?.textContent).toBe('Target not set');
      });
    }
  }

  it('evaluationProgressFor: NO_START is "no target", not reached against its earliest close', () => {
    const account = accountFixture({ accountType: ACCOUNT_TYPES.EVALUATION_BULLET, ...UNUSABLE.NO_START.meta });
    const progress = evaluationProgressFor(reportRow(account, UNUSABLE.NO_START.balance), historyFor(account, UNUSABLE.NO_START));
    expect(progress.state).toBe(EVALUATION_PROGRESS.NO_TARGET);
    expect(progress.percent).toBeNull();
  });

  it('buildProgressToTargetRows: NO_START keeps its row and prints no percentage', () => {
    const account = accountFixture({ ...UNUSABLE.NO_START.meta });
    const rows = buildProgressToTargetRows(
      { grouped: { funded: [reportRow(account, UNUSABLE.NO_START.balance)], evaluations: [] } },
      historyFor(account, UNUSABLE.NO_START),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].percent).toBeNull();
  });
});

describe('the gate does not hide a target that is fine', () => {
  // The other half: refusing too much would blank the 105 fixture rows that
  // carry a balance target and no stored start. Each must still read.
  const FINE = [
    // A written balance with no stored start: judged against the size it implies.
    { label: '54,100 with no stored start', meta: { targetProfit: 54100, startBalance: '' }, at: 54100, below: 50000 },
    // The production Funded row above its own small start.
    { label: '8,000 on a 6,000 start', meta: { targetProfit: 8000, startBalance: 6000 }, at: 8000, below: 6000 },
  ];
  for (const fine of FINE) {
    for (const name of ['reconcile · Payout eligible flag', 'Dashboard · funded target cell']) {
      const reader = READERS.find((r) => r.name === name);
      it(`${name}: ${fine.label} is reached at the target and not below it`, () => {
        const account = accountFixture(fine.meta);
        expect(reader.reached(account, fine.at)).toBe(true);
        expect(reader.reached(account, fine.below)).toBe(false);
      });
    }
  }
});

describe('the payout insight measures what is left from the balance', () => {
  /* buildPortfolioInsights printed `target - profit` as "remaining", and target
   * is a BALANCE: 50k account, target 54,100, balance 53,800 read "$50,300
   * remaining" when $300 is. */
  it('says $300 remaining at 53,800 of 54,100', () => {
    const account = accountFixture({ targetProfit: 54100 });
    const insight = buildPortfolioInsights([clientWith(account, 53800)])
      .find((entry) => entry.type === 'Payout Opportunity');
    expect(insight).toBeDefined();
    expect(insight.facts.find((fact) => fact.label === 'Remaining').value).toBe('$300');
    expect(insight.message).toContain('$300 remaining');
  });
});

// ─────────────── EVERY SIZE THE RULES SELL, NOT JUST 50K ───────────────
//
// Everything above runs on a 50k account with its start typed in. A second
// review rendered the plan picker on a Legends 25k with Start Bal empty: it
// wrote 26,500 and no start, and every reader then refused the value the app
// itself had just written ("Target not set", no "Payout eligible"), because the
// gate only knew 50k, 100k and 150k. The book is mostly 50k, so the 50k tests
// above never saw it.

/** Renders the plan picker on an account with an EMPTY Start Bal whose only
 * close on record is `size`, picks `plan`, and returns the account with the
 * picker's patch applied: exactly the row the registry would now hold. */
function pickPlanWithNoStart({ firm, plan, size, type = ACCOUNT_TYPES.FUNDED }) {
  const account = accountFixture({ accountName: 'NS-1', connection: firm, accountType: type, startBalance: '', targetProfit: '' });
  const patches = [];
  render(
    <AccountManager
      accounts={{ [account.accountName]: account }}
      snapshots={[{ accountName: account.accountName, accountBalance: size }]}
      dailyImports={[{ date: '2026-09-01', snapshots: [{ accountName: account.accountName, accountBalance: size }] }]}
      onUpdateAccount={(name, patch) => patches.push(patch)}
      onAddAccount={() => {}}
      onRemoveAccount={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText(`Plan for ${account.accountName}`), { target: { value: plan } });
  cleanup();
  expect(patches).toHaveLength(1);
  return { ...account, ...patches[0] };
}

/** Whether the registry row marks its own Target $ as unused. */
function registrySaysUnused(account) {
  render(
    <AccountManager
      accounts={{ [account.accountName]: account }}
      snapshots={[]}
      dailyImports={[]}
      onUpdateAccount={() => {}}
      onAddAccount={() => {}}
      onRemoveAccount={() => {}}
    />,
  );
  const unused = [...document.querySelectorAll('small')].some((el) => /^Not used/.test(el.textContent));
  cleanup();
  return unused;
}

/* One plan per firm and size that publishes a profit target, read off the rules
 * table, so a size added there is covered here without editing this file. */
const PICKABLE = (() => {
  const seen = new Map();
  for (const [key, rule] of Object.entries(PROP_FIRM_RULES)) {
    const [firm, plan, size] = key.split('|');
    if (rule.profitTarget == null) continue;
    const id = `${firm}|${size}`;
    if (!seen.has(id)) seen.set(id, { firm, plan, size: Number(size), amount: rule.profitTarget });
  }
  return [...seen.values()];
})();

describe('the plan picker on an account with no stored start, at every size it sells', () => {
  it('covers more than the 50k the book is made of', () => {
    expect(new Set(PICKABLE.map((entry) => entry.size)).size).toBeGreaterThan(1);
    expect(PICKABLE.some((entry) => entry.size === 25000)).toBe(true);
  });

  const payout = READERS.find((r) => r.name === 'reconcile · Payout eligible flag');
  const evalReached = READERS.find((r) => r.name === 'reconcile · Evaluation target reached flag');
  const dashboard = READERS.find((r) => r.name === 'Dashboard · funded target cell');

  for (const { firm, plan, size, amount } of PICKABLE) {
    it(`${firm} ${plan} ${size / 1000}k: what the picker writes, every reader uses`, () => {
      const funded = pickPlanWithNoStart({ firm, plan, size });
      const target = Number(funded.targetProfit);
      // The premise: the picker wrote the passing balance for this size.
      expect(target).toBe(size + amount);

      expect(registrySaysUnused(funded)).toBe(false);
      expect(payout.reached(funded, target + 100)).toBe(true);
      expect(payout.reached(funded, size)).toBe(false);
      expect(dashboard.reached(funded, target)).toBe(true);
      expect(dashboard.reached(funded, size)).toBe(false);

      const evaluation = pickPlanWithNoStart({ firm, plan, size, type: ACCOUNT_TYPES.EVALUATION_BULLET });
      expect(evalReached.reached(evaluation, target)).toBe(true);
      expect(evalReached.reached(evaluation, size)).toBe(false);
    });
  }

  it('writes the start it measured the target from, so the amount is recoverable', () => {
    // A target with no start beside it is the shape storedTarget.js has to
    // guess at. The picker knows the size it added the amount to; it says so.
    for (const { firm, plan, size, amount } of PICKABLE) {
      const written = pickPlanWithNoStart({ firm, plan, size });
      expect(Number(written.targetProfit) - Number(written.startBalance)).toBe(amount);
    }
  });

  it('never overwrites a start the desk typed', () => {
    const account = accountFixture({ accountName: 'NS-2', startBalance: 51234, targetProfit: '' });
    const patches = [];
    render(
      <AccountManager
        accounts={{ [account.accountName]: account }}
        snapshots={[]}
        dailyImports={[]}
        onUpdateAccount={(name, patch) => patches.push(patch)}
        onAddAccount={() => {}}
        onRemoveAccount={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(`Plan for ${account.accountName}`), { target: { value: PLAN } });
    cleanup();
    expect({ ...account, ...patches[0] }.startBalance).toBe(51234);
  });
});

describe('a stored balance with no stored start is judged against the size it sits on', () => {
  /* Rows already in the table, or typed by hand, carry no start and never pass
   * through the picker again. Each is read against the standard size just below
   * it, at every size propFirmRules says firms sell. */
  const payout = READERS.find((r) => r.name === 'reconcile · Payout eligible flag');
  const dashboard = READERS.find((r) => r.name === 'Dashboard · funded target cell');

  const cases = STANDARD_ACCOUNT_SIZES.map((size) => ({ size, target: size + size * 0.06 }));
  // 80,000 on a 75k: nearer 75k than 100k, and above it.
  cases.push({ size: 75000, target: 80000 });

  for (const { size, target } of cases) {
    it(`${target.toLocaleString('en-US')} with no start reads as a target above ${size.toLocaleString('en-US')}`, () => {
      const account = accountFixture({ accountName: 'NS-3', targetProfit: target, startBalance: '' });
      expect(registrySaysUnused(account)).toBe(false);
      expect(payout.reached(account, target)).toBe(true);
      expect(payout.reached(account, size)).toBe(false);
      expect(dashboard.reached(account, target)).toBe(true);
      expect(dashboard.reached(account, size)).toBe(false);
    });
  }
});

describe('a profit amount stored with no start is still refused at every size', () => {
  /* The other side of widening the ladder. Every amount a firm or the desk
   * publishes, stored where a balance belongs and with no start beside it, must
   * not snap to some small size and read as reached by an account that opened
   * many times larger. 6,000 is the one a loose band lets through: it is 20%
   * over a 5k account, and it is the 100k amount every firm here publishes. */
  const payout = READERS.find((r) => r.name === 'reconcile · Payout eligible flag');
  const amounts = new Map();
  for (const [key, rule] of Object.entries(PROP_FIRM_RULES)) {
    if (rule.profitTarget != null) amounts.set(rule.profitTarget, Number(key.split('|')[2]));
  }
  for (const [size, balance] of Object.entries(GENERIC_TARGET_BALANCE)) {
    amounts.set(balance - Number(size), Number(size));
  }

  it('includes the amounts the review named', () => {
    expect([...amounts.keys()]).toEqual(expect.arrayContaining([3000, 4000, 6000]));
  });

  for (const [amount, size] of amounts) {
    it(`${amount.toLocaleString('en-US')} on a ${size / 1000}k account with no start is not reached`, () => {
      const account = accountFixture({ accountName: 'NS-4', targetProfit: amount, startBalance: '' });
      expect(payout.reached(account, size)).toBe(false);
      expect(registrySaysUnused(account)).toBe(true);
    });
  }
});
