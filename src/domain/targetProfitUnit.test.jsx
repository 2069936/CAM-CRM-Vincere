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
import { PROP_FIRM_RULES, plansFor } from './propFirmRules';
import { evaluationProgressFor, EVALUATION_PROGRESS } from './evaluationReport';
import { buildProgressToTargetRows } from './progressToTarget';
import {
  buildClientOverview,
  buildPayoutAlerts,
  buildAllFundedAccounts,
  buildIncomeProjection,
  buildCamFundedRows,
  buildManagerEvaluationRows,
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

  it('the published amount would have read as already passed, which is the defect', () => {
    // Not an assertion about current behaviour — a demonstration of what the
    // old writer produced, so the numbers in this file's header stay checkable.
    expect(PUBLISHED_AMOUNT).toBeLessThan(SIZE);
    const account = accountFixture({ targetProfit: PUBLISHED_AMOUNT });
    const reader = READERS.find((r) => r.name === 'reconcile · Payout eligible flag');
    // An account that has made nothing, sitting at its opening balance.
    expect(reader.reached(account, SIZE)).toBe(true);
  });
});
