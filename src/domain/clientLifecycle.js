// Client lifecycle: the whole story of a client, not just today's close.
//
// When they started -> how many accounts they have run -> how many evaluations
// they took and how many passed (and how long that took) -> which accounts got
// funded, with which prop firms and at what size -> which algos they leaned on
// -> how long to first payout and what they withdrew -> how their cash balance
// moved -> and whether they are still with us.
//
// Everything is derived from data the CRM already stores: the persistent account
// registry (dateAdded / dateFunded / dateFailed / dateLastPayout / payoutHistory)
// plus the daily imports (snapshots and strategies). Nothing here needs a new
// upload step from the CAM.
//
// CHURN is deliberately manual: a client counts as churned only when someone
// sets their stage to Inactive. Inferring churn from "no activity" would mark a
// client dead just because their CAM stopped uploading closes.
import { ACCOUNT_TYPES, ACCOUNT_STATUSES, isCashType } from './reconcile';

export const CLIENT_STAGE_INACTIVE = 'Inactive';

/**
 * The stages a client can be at, in the order they run.
 *
 * ONE list. It was written out three times — the Client stage selector, the
 * "Add new client" form and the pipeline board's own STAGES — and only one of
 * those three could lose a client if they drifted: the board renders a column
 * per name in its copy and drops every card whose stage is not one of them,
 * silently and with no count anywhere saying so. A stage added to the selector
 * and not to the board is a client who disappears off the pipeline the moment a
 * CAM assigns it.
 *
 * Today's book cannot show that — every one of its 96 clients is Active or
 * Paused — which is exactly why it is a constant and a guard rather than a
 * comment. The board still buckets anything unrecognised into a column of its
 * own instead of trusting this list to be complete: a value written by hand in
 * the SQL editor, or by a version of the app older than this one, is a real
 * client either way.
 */
export const CLIENT_STAGES = ['Onboarding', 'Active', 'At Risk', 'Paused', CLIENT_STAGE_INACTIVE];

/** What a client with no stage recorded counts as, everywhere. */
export const CLIENT_STAGE_DEFAULT = 'Active';

/**
 * Where a client imported from a sign-up sheet starts.
 *
 * Named rather than typed out at the two import sites, so the stage names appear
 * in this file and nowhere else — the check in clientLifecycle.test.js is
 * whole-file and a default is just as capable of drifting from the list as an
 * option is.
 */
export const CLIENT_STAGE_NEW = 'Onboarding';

/** The column an unrecognised stage lands in, rather than nowhere. */
export const CLIENT_STAGE_OTHER = 'Other';

/**
 * The pipeline board's lanes, with nobody left out of one.
 *
 * The board used to bucket into a private copy of the stage list and then render
 * a column per name in that same list — so `byStage[stage]` would happily create
 * a bucket for an unrecognised stage and then never render it. The client was
 * gone from the board, and no count on the page disagreed with the board, so
 * there was nothing to notice.
 *
 * Two things here, and they are separate on purpose. The known stages always get
 * a lane, in order, EMPTY OR NOT — an empty "At Risk" column is information, and
 * a board whose columns come and goes with the data cannot be read at a glance.
 * Anything else gets one shared lane at the end, which appears only when
 * somebody is actually in it.
 *
 * The total is returned rather than left to be recomputed: the caller prints it
 * against the roster, and the only way a lane can lose a client is if those two
 * numbers are derived separately.
 */
export function pipelineColumns(clients = [], stageOf = (client) => client?.profile?.stage) {
  const byStage = new Map(CLIENT_STAGES.map((stage) => [stage, []]));
  const other = [];
  for (const client of clients) {
    const stage = stageOf(client) || CLIENT_STAGE_DEFAULT;
    if (byStage.has(stage)) byStage.get(stage).push(client);
    else other.push(client);
  }
  const columns = [...byStage.entries()].map(([stage, members]) => ({
    stage,
    clients: members,
    known: true,
  }));
  if (other.length) columns.push({ stage: CLIENT_STAGE_OTHER, clients: other, known: false });
  return {
    columns,
    placed: columns.reduce((sum, column) => sum + column.clients.length, 0),
    unknown: other.length,
  };
}

function toDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function daysBetween(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  const ms = Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86400000);
}

function average(values) {
  const nums = values.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length);
}

export function isChurnedClient(client) {
  // Manual only. profile.stage is what the Client stage selector writes;
  // client.status === 'Inactive' is the soft-delete path, counted separately.
  return client?.profile?.stage === CLIENT_STAGE_INACTIVE;
}

/**
 * WHY A CLIENT LEFT, as a fixed list rather than a sentence.
 *
 * The desk manager's instruction was specific: the CRM should capture why when a
 * CAM marks a client Inactive, "as a short list of options rather than free
 * text, so the reasons can be counted later. Free text that nobody can aggregate
 * is how this question gets asked again in three months." A note may accompany
 * the option; the OPTION is the part that has to be structured.
 *
 * `code` is what is stored and what the panel groups on; `label` is what is
 * shown. Storing the code means the wording can be rewritten later without
 * rewriting the rows, and it means a reason survives redaction as itself —
 * scripts/redact-export.mjs keeps `churn_reason` because it is an enum, and
 * redacts `churn_note` because it is prose a CAM wrote about a person.
 *
 * `other` is on the list and is NOT the same thing as no reason. Choosing it is
 * a CAM saying "none of these"; an absent reason is nobody having been asked.
 * Collapsing the second into the first is the one thing the manager ruled out by
 * name, and CHURN_REASON_UNRECORDED below is what keeps them apart.
 */
export const CHURN_REASONS = [
  { code: 'not-profitable', label: 'Not profitable' },
  { code: 'cost', label: 'Cost of the service' },
  { code: 'lost-funding', label: 'Lost funded account' },
  { code: 'unresponsive', label: 'Stopped responding' },
  { code: 'switched-provider', label: 'Went elsewhere' },
  { code: 'personal', label: 'Personal circumstances' },
  { code: 'other', label: 'Other' },
];

/**
 * The reason of a client who was marked Inactive before this was ever asked.
 *
 * Not a member of CHURN_REASONS: it can never be chosen, only observed. It is a
 * synthetic grouping key so the panel can count "how many of these do we simply
 * not know", which is a number the desk should be able to watch fall.
 */
export const CHURN_REASON_UNRECORDED = 'unrecorded';
export const CHURN_REASON_UNRECORDED_LABEL = 'Not recorded';

export function churnReasonLabel(code) {
  const text = String(code || '').trim();
  if (!text) return CHURN_REASON_UNRECORDED_LABEL;
  // An unknown code prints as itself rather than as "Other". A row written by a
  // hand-run UPDATE, or by a build older than a list change, is a reason nobody
  // on this list gave — printing it as one of them would invent agreement.
  return CHURN_REASONS.find((reason) => reason.code === text)?.label || text;
}

/**
 * What the CRM knows about one client's departure.
 *
 * Lives on `client.churn`, NOT on `client.profile`. The profile object is
 * re-sent whole on every edit of the Client profile card (updateProfile spreads
 * it), so a churn field parked there would be written back by someone correcting
 * a phone number — on a database where step 39 has not run, that would turn
 * every profile save into a failed write instead of only the classification
 * itself. Keeping it out of `profile` confines the new columns to the one path
 * that records a classification.
 *
 * Every field is allowed to be absent, and absent stays absent: no default
 * reason, no back-dated date.
 */
export function clientChurnRecord(client) {
  const churn = client?.churn || {};
  const code = String(churn.reason || '').trim();
  return {
    recorded: Boolean(code),
    reasonCode: code || CHURN_REASON_UNRECORDED,
    reasonLabel: churnReasonLabel(code),
    reasonNote: String(churn.note || '').trim(),
    churnedAt: toDate(churn.at) || '',
  };
}

/**
 * Splits a client list into the ones a CAM still works and the ones they only
 * need for history.
 *
 * ONLY 'Inactive' leaves the working list, and it leaves it by the same
 * definition the churn panels already use (isChurnedClient), so the sidebar and
 * the retention numbers cannot disagree about who is still a client.
 *
 * The other four stages deliberately stay put:
 *  - At Risk is the stage that means "needs MORE attention". Moving it out of
 *    sight would invert the sidebar's whole urgency sort, which already floats
 *    trouble to the top.
 *  - Paused is a client who is coming back and still has a restart date to
 *    chase. On the real book (public/local-snapshot.json) that is 1 client out
 *    of 133 in the sidebar — burying 1 row saves no scrolling and costs a
 *    lookup every time the CAM wonders where they went.
 *  - Onboarding is the most active work there is (3 clients on the same book).
 *  - Active is the working list by definition.
 *
 * Order is preserved on both sides, so whichever sort or manual drag order the
 * caller applied still holds within each group.
 */
export function partitionSidebarClients(clients = []) {
  const working = [];
  const former = [];
  for (const client of clients || []) {
    if (isChurnedClient(client)) former.push(client);
    else working.push(client);
  }
  return { working, former };
}

// Earliest date we can prove the client existed: their recorded start date, or
// the first account they ever had, or their first uploaded close.
export function clientStartDate(client) {
  const candidates = [toDate(client?.profile?.startDate)];
  for (const meta of Object.values(client?.accountRegistry || {})) {
    candidates.push(toDate(meta?.dateAdded));
  }
  const firstImport = (client?.dailyImports || [])[0];
  candidates.push(toDate(firstImport?.date));
  const valid = candidates.filter(Boolean).sort();
  return valid[0] || '';
}

// Which algos the client actually ran, counted by how many (account, day) pairs
// each strategy family appeared in across every close we hold.
export function clientAlgoUsage(client) {
  const counts = new Map();
  for (const dailyImport of client?.dailyImports || []) {
    for (const strategy of dailyImport?.strategies || []) {
      const family = strategy.strategyFamily || strategy.strategyName || '';
      if (!family) continue;
      const entry = counts.get(family) || { family, days: 0, accounts: new Set() };
      entry.days += 1;
      if (strategy.accountName) entry.accounts.add(strategy.accountName);
      counts.set(family, entry);
    }
  }
  return [...counts.values()]
    .map((entry) => ({ family: entry.family, days: entry.days, accounts: entry.accounts.size }))
    .sort((a, b) => b.days - a.days || a.family.localeCompare(b.family));
}

// Cash balance over time, one point per close that carried a cash account.
export function clientCashMovement(client) {
  const registry = client?.accountRegistry || {};
  const points = [];
  for (const dailyImport of client?.dailyImports || []) {
    let balance = 0;
    let realized = 0;
    let found = false;
    for (const snapshot of dailyImport?.snapshots || []) {
      const meta = registry[snapshot.accountName] || {};
      if (!isCashType(meta.accountType)) continue;
      found = true;
      balance += Number(snapshot.accountBalance || 0);
      realized += Number(snapshot.grossRealizedPnl || 0);
    }
    if (found) points.push({ date: dailyImport.date, balance, realized });
  }
  return points;
}

// One account's contribution to the story.
function accountStory(meta) {
  const passedAt = toDate(meta.dateFunded);
  const failedAt = toDate(meta.dateFailed);
  const bornAt = toDate(meta.dateAdded);
  const isEvaluation = String(meta.accountType || '').startsWith('Evaluation');
  const payouts = Array.isArray(meta.payoutHistory) ? meta.payoutHistory : [];
  const payoutTotal = payouts.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const firstPayoutAt = payouts
    .map((p) => toDate(p.date))
    .filter(Boolean)
    .sort()[0] || toDate(meta.dateLastPayout);
  return {
    accountName: meta.accountName || '',
    alias: meta.alias || meta.accountName || '',
    accountType: meta.accountType || ACCOUNT_TYPES.UNASSIGNED,
    status: meta.status || ACCOUNT_STATUSES.ACTIVE,
    propFirm: meta.connection || '',
    startBalance: Number(meta.startBalance || 0),
    bornAt,
    passedAt,
    failedAt,
    isEvaluation,
    isFunded: meta.accountType === ACCOUNT_TYPES.FUNDED || Boolean(passedAt),
    isCash: isCashType(meta.accountType),
    daysToPass: passedAt ? daysBetween(bornAt, passedAt) : null,
    daysToFirstPayout: firstPayoutAt && passedAt ? daysBetween(passedAt, firstPayoutAt) : null,
    payoutCount: payouts.length || Number(meta.payoutCount || 0) || 0,
    payoutTotal,
    firstPayoutAt,
    lastPayoutAt: toDate(meta.dateLastPayout),
  };
}

/**
 * Full lifecycle for one client.
 * @param client the client object from state
 * @param opts.camName the CAM currently managing them (state has no back-ref)
 */
export function buildClientLifecycle(client, { camName = '' } = {}) {
  const registry = client?.accountRegistry || {};
  const accounts = Object.values(registry).filter(Boolean).map(accountStory);

  const evaluations = accounts.filter((a) => a.isEvaluation || a.passedAt);
  const passed = evaluations.filter((a) => a.passedAt);
  const failed = evaluations.filter((a) => a.failedAt && !a.passedAt);
  const funded = accounts.filter((a) => a.isFunded);
  const cash = accounts.filter((a) => a.isCash);

  const propFirms = new Map();
  for (const account of funded) {
    const firm = account.propFirm || 'Unknown';
    const entry = propFirms.get(firm) || { firm, accounts: 0, startBalance: 0, payoutTotal: 0 };
    entry.accounts += 1;
    entry.startBalance += account.startBalance;
    entry.payoutTotal += account.payoutTotal;
    propFirms.set(firm, entry);
  }

  const payoutAccounts = accounts.filter((a) => a.payoutCount > 0);
  const cashMovement = clientCashMovement(client);

  // Timeline of everything that happened, oldest first.
  const events = [];
  const startedAt = clientStartDate(client);
  if (startedAt) events.push({ date: startedAt, kind: 'start', label: 'Client started' });
  for (const account of accounts) {
    if (account.bornAt) {
      events.push({ date: account.bornAt, kind: 'account-added', label: `${account.alias} added`, accountName: account.accountName });
    }
    if (account.passedAt) {
      events.push({ date: account.passedAt, kind: 'funded', label: `${account.alias} funded${account.propFirm ? ` (${account.propFirm})` : ''}`, accountName: account.accountName });
    }
    if (account.failedAt) {
      events.push({ date: account.failedAt, kind: 'failed', label: `${account.alias} failed`, accountName: account.accountName });
    }
    for (const payout of Array.isArray(registry[account.accountName]?.payoutHistory) ? registry[account.accountName].payoutHistory : []) {
      const date = toDate(payout.date);
      if (date) {
        events.push({ date, kind: 'payout', label: `${account.alias} payout $${Number(payout.amount || 0).toLocaleString()}`, accountName: account.accountName });
      }
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  const churned = isChurnedClient(client);

  return {
    clientId: client?.id || '',
    clientName: client?.name || '',
    camName,
    startedAt,
    churned,
    // Carried whether or not they are churned, and read only when they are: a
    // client who was reactivated keeps the record of the last time they left,
    // and re-churning overwrites it. Nothing shows a stale record, because
    // nothing reads it unless `churned` is true.
    churn: clientChurnRecord(client),
    stage: client?.profile?.stage || '',
    daysWithUs: startedAt ? daysBetween(startedAt, new Date().toISOString().slice(0, 10)) : null,

    totalAccounts: accounts.length,
    evaluationCount: evaluations.length,
    passedCount: passed.length,
    failedCount: failed.length,
    passRate: evaluations.length ? passed.length / evaluations.length : null,
    avgDaysToPass: average(passed.map((a) => a.daysToPass)),

    fundedCount: funded.length,
    fundedStartBalance: funded.reduce((sum, a) => sum + a.startBalance, 0),
    propFirms: [...propFirms.values()].sort((a, b) => b.accounts - a.accounts),

    payoutCount: accounts.reduce((sum, a) => sum + a.payoutCount, 0),
    payoutTotal: accounts.reduce((sum, a) => sum + a.payoutTotal, 0),
    avgDaysToFirstPayout: average(payoutAccounts.map((a) => a.daysToFirstPayout)),

    cashAccounts: cash.length,
    cashBalance: cashMovement.length ? cashMovement[cashMovement.length - 1].balance : 0,
    cashMovement,

    algos: clientAlgoUsage(client),
    accounts,
    events,
  };
}

/**
 * Churn and retention across a set of clients.
 * Churn is manual (stage === 'Inactive'), so this is a straight count, not a
 * time-decayed model. Retention is simply the complement.
 *
 * `churnedClients` is the ROW SET behind the number, not a name list. The desk
 * manager's complaint about this panel was that the count "tells him almost
 * nothing", and a count you cannot open is the whole of that complaint — so
 * every row carries what he asked to see and filter on: whose book it was, when
 * they left, and why.
 *
 * `camNameByClientId` is optional and works exactly as it does in
 * DeviationAlertList: a CAM reading his own book already knows whose client it
 * is, a manager reading eight books does not. Omitted, attribution is left empty
 * rather than guessed at.
 */
export function buildChurnRetention(clients = [], { camNameByClientId = null } = {}) {
  const total = clients.length;
  const churnedClients = clients.filter(isChurnedClient);
  const churned = churnedClients.length;
  const active = total - churned;
  return {
    total,
    active,
    churned,
    churnRate: total ? churned / total : 0,
    retentionRate: total ? active / total : 0,
    churnedClients: churnedClients.map((client) => ({
      clientId: client.id,
      clientName: client.name,
      camName: camNameByClientId ? camNameByClientId[client.id] || '' : '',
      startedAt: clientStartDate(client),
      ...clientChurnRecord(client),
    })),
  };
}

/**
 * The churn rows a manager is actually looking at, after his filters.
 *
 * Pure, and separate from the component, for the reason the previous round of
 * this screen made expensive: the drill-down that got deleted was driven by the
 * page's own as-of date state, so choosing a date "in the panel" silently
 * re-pinned every KPI above it. Filters that belong to a panel are computed from
 * arguments the panel owns, and this function is where that is enforceable.
 *
 * WHAT IT REPORTS AS WELL AS WHAT IT KEEPS:
 *
 *  - `scoped` is the count after the CAM and date filters but BEFORE the reason
 *    filter, which is what `reasons` is counted over. That makes the reason
 *    breakdown a legend and a control at once: each option shows how many rows
 *    picking it would leave.
 *  - `undatedHidden` is the rows dropped purely because a date range is on and
 *    they carry no churn date. A client marked Inactive before step 39 has no
 *    date, cannot satisfy any range, and would otherwise vanish from a filtered
 *    view with nothing said. Absence gets counted out loud instead.
 */
export function buildChurnDetail(churnedClients = [], {
  cam = '',
  reason = '',
  from = '',
  to = '',
} = {}) {
  const rows = Array.isArray(churnedClients) ? churnedClients : [];
  const fromDay = toDate(from) || '';
  const toDay = toDate(to) || '';
  const dateFiltered = Boolean(fromDay || toDay);

  const inRange = (row) => {
    if (!dateFiltered) return true;
    if (!row.churnedAt) return false;
    if (fromDay && row.churnedAt < fromDay) return false;
    if (toDay && row.churnedAt > toDay) return false;
    return true;
  };
  const matchesCam = (row) => !cam || (row.camName || '') === cam;

  const scopedRows = rows.filter((row) => matchesCam(row) && inRange(row));
  const undatedHidden = dateFiltered
    ? rows.filter((row) => matchesCam(row) && !row.churnedAt).length
    : 0;

  const counts = new Map();
  for (const row of scopedRows) {
    const code = row.reasonCode || CHURN_REASON_UNRECORDED;
    const entry = counts.get(code) || { code, label: row.reasonLabel || churnReasonLabel(code), count: 0 };
    entry.count += 1;
    counts.set(code, entry);
  }

  const visible = scopedRows.filter((row) => !reason || (row.reasonCode || CHURN_REASON_UNRECORDED) === reason);

  return {
    // Newest departure first — the desk cares about what just happened — with
    // the rows that carry no date last rather than sorted as if they were the
    // oldest, so the rows a date range excludes are also the rows that sit
    // together at the end when no range is on.
    //
    // TWO THINGS HERE ARE NOT GUARDS, AND SAYING SO IS CHEAPER THAN FINDING OUT.
    // Descending on the date alone would already put the undated at the bottom,
    // because '' compares below every date — so deleting the first clause
    // changes no output and breaks no test. It is the intent written down, and
    // what the suite pins is its DIRECTION: filed at the top instead, "sorts
    // newest departure first and puts the undated last" fails, and a client
    // whose departure was never dated is presented as the freshest news on the
    // desk. `.slice()` is the same kind of thing: the two filters above already
    // hand this a new array, so nothing here can reach the caller's rows today
    // and removing it breaks nothing either. It is what keeps that true if
    // either filter is ever short-circuited to return `rows` itself.
    rows: visible.slice().sort((a, b) => (
      Number(Boolean(b.churnedAt)) - Number(Boolean(a.churnedAt))
      || (b.churnedAt || '').localeCompare(a.churnedAt || '')
      || String(a.clientName || '').localeCompare(String(b.clientName || ''))
    )),
    total: rows.length,
    scoped: scopedRows.length,
    cams: [...new Set(rows.map((row) => row.camName).filter(Boolean))].sort(),
    reasons: [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    undatedHidden,
    dateFiltered,
  };
}

/**
 * Roll lifecycles up across many clients (CAM view / team view).
 *
 * `camNameByClientId` is passed straight down to buildChurnRetention so the
 * manager's roll-up can attribute each departure to a book. It changes no
 * number here — the same clients are counted either way.
 */
export function buildLifecycleRollup(clients = [], { camNameByClientId = null } = {}) {
  const lifecycles = clients.map((client) => buildClientLifecycle(client));
  const evaluationCount = lifecycles.reduce((sum, l) => sum + l.evaluationCount, 0);
  const passedCount = lifecycles.reduce((sum, l) => sum + l.passedCount, 0);
  const firmTotals = new Map();
  for (const lifecycle of lifecycles) {
    for (const firm of lifecycle.propFirms) {
      const entry = firmTotals.get(firm.firm) || { firm: firm.firm, accounts: 0, payoutTotal: 0 };
      entry.accounts += firm.accounts;
      entry.payoutTotal += firm.payoutTotal;
      firmTotals.set(firm.firm, entry);
    }
  }
  const algoTotals = new Map();
  for (const lifecycle of lifecycles) {
    for (const algo of lifecycle.algos) {
      const entry = algoTotals.get(algo.family) || { family: algo.family, days: 0, accounts: 0 };
      entry.days += algo.days;
      entry.accounts += algo.accounts;
      algoTotals.set(algo.family, entry);
    }
  }
  return {
    clients: lifecycles.length,
    totalAccounts: lifecycles.reduce((sum, l) => sum + l.totalAccounts, 0),
    evaluationCount,
    passedCount,
    passRate: evaluationCount ? passedCount / evaluationCount : null,
    avgDaysToPass: average(lifecycles.map((l) => l.avgDaysToPass)),
    fundedCount: lifecycles.reduce((sum, l) => sum + l.fundedCount, 0),
    payoutCount: lifecycles.reduce((sum, l) => sum + l.payoutCount, 0),
    payoutTotal: lifecycles.reduce((sum, l) => sum + l.payoutTotal, 0),
    avgDaysToFirstPayout: average(lifecycles.map((l) => l.avgDaysToFirstPayout)),
    cashAccounts: lifecycles.reduce((sum, l) => sum + l.cashAccounts, 0),
    cashBalance: lifecycles.reduce((sum, l) => sum + l.cashBalance, 0),
    propFirms: [...firmTotals.values()].sort((a, b) => b.accounts - a.accounts),
    algos: [...algoTotals.values()].sort((a, b) => b.days - a.days),
    ...buildChurnRetention(clients, { camNameByClientId }),
  };
}
