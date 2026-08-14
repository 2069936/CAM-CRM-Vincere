// Accounts that stopped reporting — told apart from accounts that failed, and
// told apart from a client that stopped filing.
//
// THE FLAG THIS EXISTS TO ANSWER. reconcile.js:582 raises `Missing account`
// with one sentence — "<alias> existed before but did not appear in this close."
// Read back off public/local-snapshot.json through buildCamFlagQueue, that is
// 106 open problems across 19 clients held in 309 flag rows, and the sentence
// carries nothing to act on. It is also not always true:
//
//   29 of the 106 sit on accounts that have never appeared in ANY close on the
//      book. "Existed before" is false for 27% of them — those accounts have
//      not stopped, they have not started.
//    9 of the 106 sit on accounts that are reporting again, and all 9 are in
//      their client's most recent close. The problem is over and the flag is
//      open. (Counted by re-reading account_snapshots per flag row: 9 problems
//      behind 12 of the 309 stored flag rows. An earlier draft of this comment
//      said 14 and it does not reproduce under any reading of the book — the
//      number is 9 whether you ask "is it in the latest close" or "did it
//      report after the day the flag stands on".)
//    7 of the 106 are Reese North on 2026-07-13, an import that carried zero
//      account rows. One collection failure, written out as seven account
//      failures.
//
// THE ASSUMPTION THIS EXISTS TO BLOCK. A vanished account is assumed to have
// failed. Of the 195 accounts on this book that stopped appearing and were
// absent for at least two further closes, 52 were past their trailing drawdown
// on the last MEASURED reading before they went quiet, 141 were healthy on it —
// one of them holding $148,223 with $2,171 of buffer left, then gone for 7
// closes — and 2 had never been measured at all. Calling a missing account
// failed would be wrong 143 times out of 195. So this module never says failed.
// It says what the last close said, and when.
//
// WHY "LAST MEASURED" AND NOT "LAST CLOSE", with the two rows it moves. Ask the
// same question of the very last close each account filed and the split is
// 52 / 139 / 4, not 52 / 141 / 2. The two that move are Harper Juniper's
// CCF23009250154227 (last close 2026-07-20) and EKG54594881787638 (last close
// 2026-07-27): both carried trailing_max_drawdown 0 on that final close, and
// readingOf reads 0 as "no column", not "no buffer". Their last real readings
// are $1,046 and $2,000, both from 2026-07-13. Neither answer is free — quoting
// a 7-to-14-day-old buffer as if it were the closing one is the direction that
// costs money — so the row carries the reading AND its own date, and prints the
// date separately whenever it predates the close (`buffer.fromLastSeenClose`).
//
// EVERYTHING HERE IS COMPOSED, NOT RE-DERIVED:
//   - accountLifecycle.js decides running / quiet / finished / stale / unknown
//     from evidence and refuses to read the status column as an outcome. Its
//     records carry the last close, the last balance, and the last MEASURED
//     drawdown with its own date.
//   - accountAbsence.js owns the five-way absence split and the existence rule
//     min(date_added, first observed report), which is what keeps an account
//     registered after the last close off this list entirely.
//   - simulationAccounts.js decides which accounts hold play money. A simulator
//     is absent from most closes by design and is never a missing account.

import { ABSENCE_REASONS, existsFrom, isoDay, nameKey } from './accountAbsence';
import { LIFECYCLE_STATES, buildAccountLifecycleStates } from './accountLifecycle';
import { ACCOUNT_TYPES } from './reconcile';
import { ACCOUNT_NATURES, NATURE_LABELS, classifyAccountNature } from './simulationAccounts';

/**
 * What the record says about an account that is not in the close.
 *
 * Seven, because they call for seven different actions, and because the two the
 * desk actually confuses — "it was fine when we last saw it" and "it was already
 * over its line when we last saw it" — have to be one glance apart.
 *
 * PAST_DRAWDOWN is deliberately not called failed. A negative buffer on the last
 * close is the strongest evidence on this book and it is still evidence: 143
 * accounts here are past their limit and nobody has marked them Failed, 1 of 50
 * accounts that went negative got a positive buffer back, and 30 accounts the
 * desk HAS marked Failed are still turning up in closes. Naming the shape after
 * the reading rather than after a verdict is the whole point.
 */
export const QUIET_SHAPES = {
  NOT_YET_REGISTERED: 'not-yet-registered',
  CLIENT_FILED_NOTHING: 'client-filed-nothing',
  REPORTING_AGAIN: 'reporting-again',
  NEVER_REPORTED: 'never-reported',
  PAST_DRAWDOWN: 'past-drawdown-when-last-seen',
  NEVER_MEASURED: 'never-measured-when-last-seen',
  NO_DRAWDOWN_RULE: 'no-drawdown-rule',
  HEALTHY: 'healthy-when-last-seen',
};

export const QUIET_SHAPE_LABELS = {
  'not-yet-registered': 'Did not exist on that close',
  'client-filed-nothing': 'Nothing was collected that day',
  'reporting-again': 'Reporting again',
  'never-reported': 'Never seen in any close',
  'past-drawdown-when-last-seen': 'Past its drawdown when it went quiet',
  'never-measured-when-last-seen': 'Buffer never measured',
  'no-drawdown-rule': 'Cash — no drawdown rule',
  'healthy-when-last-seen': 'Healthy when it went quiet',
};

export const QUIET_SHAPE_TEXT = {
  'not-yet-registered': 'The earliest date this account can be shown to have existed is AFTER the close the flag stands on, so it could not have appeared in it. reconcile.js sweeps the registry as it stands TODAY against a close from weeks ago and has no existence rule at all, which is how a flag gets raised against an account that did not yet exist. Nothing to chase: close it.',
  'client-filed-nothing': 'The import for that day carried no account rows at all, so every account on the client is absent for the same single reason. Chase the collection, not the accounts — 8 of the 485 closes on this book are in this state, one of them holding 15 orders against 0 accounts.',
  'reporting-again': 'The account is back in its client’s latest close. Whatever happened, it is over — 6 accounts on this book missed a close and returned, which is why absence is never treated as final.',
  'never-reported': 'Registered, existed on the day, and has never appeared in any close we hold. Pre-registered is not the same claim as stopped, and the flag that says "existed before" is simply wrong about these.',
  'past-drawdown-when-last-seen': 'The last trailing-drawdown reading before it went quiet was negative — under the model NinjaTrader exports for 750 of 764 accounts the number IS the buffer remaining. Strong evidence, not a confirmation: the desk carries 143 accounts past their limit that nobody has marked Failed, and the prop firm, not this CRM, closes an account.',
  // 66, not 89: 585 of the 3,100 snapshot rows read 0, and grouping those rows
  // by (client, account) over the 96 clients this panel is built from gives 689
  // accounts that ever filed, 66 of which read 0 on EVERY close they filed and
  // 85 of which read 0 on their last one. accountLifecycle.js:210 quotes 89/108
  // for the same idea over a different scope; only the figures measured on the
  // book this panel renders are quoted here.
  'never-measured-when-last-seen': 'Its trailing drawdown column read exactly 0 on every close it ever filed, so its buffer was never measured. 585 of the 3,100 snapshot rows on this book read 0 and 66 of the 689 accounts that ever filed have read 0 on every close — that is an import with no column, never a buffer of nothing left.',
  'no-drawdown-rule': 'A cash account has no trailing drawdown rule to be inside or outside, so there is no buffer to report. 53 accounts on this book.',
  'healthy-when-last-seen': 'It was inside its trailing drawdown on the last close it filed. Nothing in the book explains why it stopped, which makes it the shape worth a phone call: one of these was holding $148,223 with $2,171 of buffer left and has been gone for 7 closes.',
};

/**
 * Field separator for the composite keys below.
 *
 * U+0001, for the reason camFlagQueue.js:45 gives: an account alias is free text
 * typed by a human and a NinjaTrader time is written `1/1/2020 4:45:00 PM`, so
 * neither '/' nor '|' is safe in a key built from either. U+0001 cannot occur in
 * a client id, an account name or an ISO date.
 */
const SEP = '\u0001';

function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const rounded = Math.round(Number(value));
  return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function closesPhrase(n) {
  return `${n} ${plural(n, 'close', 'closes')}`;
}

/**
 * Does this close carry any account row at all?
 *
 * Simulated rows count. splitSimulationRows moves a Sim101's snapshot out of
 * `snapshots` and into `simulation.snapshots`, so a close whose only account is
 * a simulator has an empty live array and is emphatically not an uncollected
 * day — reportReasons.hasOrderRows documents the same trap from the orders side,
 * where probing only the live array called a client's orders "not on file".
 */
function closeHasRows(close) {
  return Boolean(
    (close?.snapshots || []).length
    || (close?.simulation?.snapshots || []).length
    || (close?.simulation?.undetermined?.snapshots || []).length,
  );
}

function sortedCloses(client, bound) {
  return (client?.dailyImports || [])
    .filter((close) => close?.date && (!bound || String(close.date).slice(0, 10) <= bound))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * The desk's own calendar: every date ANY client in the set filed an import on.
 *
 * Needed because a client's own closes cannot detect a client that stopped
 * filing. accountLifecycle counts absence in that client's closes, so a client
 * whose last import is 2026-07-13 has closesSinceSeen = 0 on every account it
 * owns and looks perfect. Against the desk calendar the same client is 13
 * trading dates behind. 24 of the 96 clients on this book are in that state,
 * holding 136 registered accounts between them, and not one of those accounts
 * can raise a Missing account flag — a flag needs a close, and there is no close.
 *
 * The denominator is dates the desk filed, never calendar days: the book holds
 * 14 trading dates inside 18 calendar days, so charging a client for a Saturday
 * would turn a weekend into a collection failure.
 */
function deskCalendar(clients, bound) {
  const dates = new Set();
  for (const client of clients || []) {
    for (const close of client?.dailyImports || []) {
      const day = isoDay(close?.date);
      if (day && (!bound || day <= bound)) dates.add(day);
    }
  }
  return [...dates].sort();
}

/**
 * One quiet account, with the four facts a CAM needs on the row.
 *
 * `buffer.date` is carried separately from `lastSeenDate` and is not decoration:
 * accountLifecycle.readingOf returns null for a trailing drawdown of exactly 0,
 * so the last MEASURED buffer can be older than the last close the account
 * filed. It is on 2 of the 193 measured quiet accounts here, and on those two
 * the row has to say the reading is from an earlier close rather than let a
 * date be read off the wrong row.
 */
function rowFor(record, {
  shape, absenceReason, clientFiledNothingOnLastSeen, absentClosesWithRows, clientStoppedFiling,
  existence, shelved, simulated,
}) {
  const buffer = {
    value: record.drawdown.value,
    date: record.drawdown.date,
    breached: record.drawdown.breached,
    model: record.drawdownModel,
    limit: record.maxDrawdownLimit,
    // True when the reading and the last close are the same day. False means the
    // buffer quoted below is the last one ever measured, from an earlier close.
    fromLastSeenClose: record.drawdown.date !== null && record.drawdown.date === record.lastSeenDate,
  };
  const row = {
    key: [record.clientId, nameKey(record.accountName)].join(SEP),
    clientId: record.clientId,
    clientName: record.clientName,
    accountName: record.accountName,
    alias: record.alias,
    accountType: record.accountType || '',
    // The DECLARED status, printed beside the observed reading and never used to
    // produce one. On this book the two disagree for 130 of the 487 testable
    // accounts.
    status: record.status || '',
    declaredFailed: record.declaredFailed,
    registered: record.registered,
    cash: record.cash,
    shape,
    absenceReason,
    lastSeenDate: record.lastSeenDate,
    firstSeenDate: record.firstSeenDate,
    // Absence measured in this client's own closes, and the client's close count
    // travels with it — "absent 12 closes" out of 13 and out of 40 are different
    // situations.
    closesSinceSeen: record.closesSinceSeen,
    closes: record.closes,
    seenCloses: record.seenCloses,
    // It has happened before, to this account: 6 accounts on the book missed a
    // close and came back. A row that skipped closes inside its own span is
    // weaker evidence of a stop than one that never did.
    skippedCloses: record.skippedCloses,
    balanceThen: record.lastBalance,
    realizedThen: record.lastDailyPnl,
    buffer,
    lastTradeDate: record.lastTradeDate,
    tradeEvidence: record.tradeEvidence,
    lifecycleState: record.state,
    clientFiledNothingOnLastSeen,
    // How many of the closes it has missed actually carried account rows. When
    // this is 0 the account's whole absence is explained by the collection —
    // every close since it was last seen was an empty import — and calling that
    // an account problem is the mistake this module exists to stop.
    //
    // 0 of the 122 quiet accounts on this book are in that state, so the guard
    // changes nothing here today. It is kept because the 8 empty closes on this
    // book all happen to sit at the START of a client's history, and one landing
    // in the middle of one would otherwise turn a collection gap into as many
    // account problems as the client has accounts.
    absentClosesWithRows,
    // The client this account belongs to has ALSO stopped filing imports since.
    // 2 of the 122 here, and both facts are true at once: the account went quiet
    // inside the closes the client did file, and the client then stopped filing
    // at all. The row says so rather than letting the account carry a question
    // that belongs to the client.
    clientStoppedFiling: Boolean(clientStoppedFiling),
    // The earliest date the account can be SHOWN to have existed, with the basis
    // that decided it — min(date_added, first observed close), straight out of
    // accountAbsence. Carried on every row because it is what makes a flag
    // checkable: Reese North's seven accounts all carry date_added 2026-07-16
    // and the only close the client ever filed is 2026-07-13, so the seven
    // Missing account flags standing against them are about a day on which not
    // one of them existed.
    existsFrom: existence?.date ?? null,
    existsFromBasis: existence?.basis ?? null,
    // Kept on the row rather than used to drop it. Shelved and simulated
    // accounts stay reachable so the panel can count them apart and still show
    // them, instead of a sweep that silently skips 84 accounts.
    shelved: Boolean(shelved),
    simulated: Boolean(simulated),
  };
  row.evidenceLine = evidenceLineOf(row);
  return row;
}

/**
 * The one line the CAM reads instead of "did not appear in this close".
 *
 * The two shapes the desk confuses have to read differently in the first six
 * words, because they are read at a glance and not in full:
 *
 *   Last seen 2026-07-13 with $2,171 of buffer left on a $148,223 balance —
 *   absent for the 7 closes since.
 *
 *   Last seen 2026-07-22 already $2 past its trailing drawdown on a $47,998
 *   balance — absent for the 5 closes since.
 */
function evidenceLineOf(row) {
  const absent = row.closesSinceSeen === null
    ? null
    : `absent for the ${closesPhrase(row.closesSinceSeen)} since`;

  if (row.shape === QUIET_SHAPES.NEVER_REPORTED) {
    return `Never seen in any of this client's ${closesPhrase(row.closes)}. It has not stopped — it has not started.`;
  }
  if (row.shape === QUIET_SHAPES.REPORTING_AGAIN) {
    return `Reported again on ${row.lastSeenDate}, this client's latest close. Nothing is missing now.`;
  }

  // Every close it has missed was an empty import. The account has not gone
  // quiet — nobody has collected the client since.
  if (row.absentClosesWithRows === 0 && row.closesSinceSeen > 0) {
    return `Last seen ${row.lastSeenDate}, and every one of the ${closesPhrase(row.closesSinceSeen)} since carried no account rows at all. Nothing here is about this account.`;
  }

  const balance = money(row.balanceThen);
  const on = balance ? ` on a ${balance} balance` : '';
  const asOf = row.buffer.value !== null && !row.buffer.fromLastSeenClose && row.buffer.date
    ? ` (that reading is from ${row.buffer.date}, the last close that carried the column)`
    : '';

  if (row.shape === QUIET_SHAPES.PAST_DRAWDOWN) {
    const past = row.buffer.model === 'limit'
      ? `already at ${money(Math.abs(row.buffer.value))} of its ${money(row.buffer.limit)} drawdown allowance`
      : `already ${money(Math.abs(row.buffer.value))} past its trailing drawdown`;
    return `Last seen ${row.lastSeenDate} ${past}${on}${asOf} — ${absent}.`;
  }
  if (row.shape === QUIET_SHAPES.NEVER_MEASURED) {
    return `Last seen ${row.lastSeenDate}${on}, buffer never measured — ${absent}.`;
  }
  if (row.shape === QUIET_SHAPES.NO_DRAWDOWN_RULE) {
    return `Last seen ${row.lastSeenDate}${on}, a cash account with no drawdown rule — ${absent}.`;
  }
  return `Last seen ${row.lastSeenDate} with ${money(row.buffer.value)} of buffer left${on}${asOf} — ${absent}.`;
}

/**
 * Which of the seven shapes an account is in, given its lifecycle record.
 *
 * Order is the argument. "It is back" outranks every reading, because a reading
 * from before it came back describes a situation that has ended; "it was never
 * here" outranks the rest because there is no last close to read anything off.
 * Cash is separated before the healthy branch: accountLifecycle.breachOf returns
 * null rather than false for a cash account, so calling one healthy would be
 * reporting "inside its limits" for an account that has no limit.
 */
export function shapeOf(record) {
  if (!record.seenCloses) return QUIET_SHAPES.NEVER_REPORTED;
  if (record.closesSinceSeen === 0) return QUIET_SHAPES.REPORTING_AGAIN;
  if (record.drawdown.breached === true) return QUIET_SHAPES.PAST_DRAWDOWN;
  if (record.cash) return QUIET_SHAPES.NO_DRAWDOWN_RULE;
  if (record.drawdown.value === null) return QUIET_SHAPES.NEVER_MEASURED;
  return QUIET_SHAPES.HEALTHY;
}

/**
 * The absence reason, from accountAbsence's five-way split rather than a sixth
 * vocabulary invented here. Kept alongside `shape` because they answer different
 * questions: the reason says why the account is not in the close, the shape says
 * what the book last knew about it.
 */
function absenceReasonOf(record) {
  if (!record.seenCloses) return ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE;
  if (record.state === LIFECYCLE_STATES.FINISHED) return ABSENCE_REASONS.ABSENT_FINISHED;
  return ABSENCE_REASONS.ABSENT_STILL_LIVE;
}

/**
 * Accounts that have gone quiet, the collection failures behind some of them,
 * and the simulation accounts that belong beside neither.
 *
 * @param {Array} clients        CRM client shape (id, name, accountRegistry, dailyImports)
 * @param {object} options
 * @param {string} options.asOf  ignore closes after this day
 * @param {number} options.absentCloses
 *        how many of the client's own closes an account must have missed. 2, not
 *        1: sweeping this book, "absent for at least N of its client's closes"
 *        gives 220 accounts at N=1 and 195 at N=2, and 6 accounts missed exactly
 *        one close and came back. One missed close is not yet a fact.
 */
export function buildQuietAccounts(clients = [], { asOf = '', absentCloses = 2 } = {}) {
  const bound = String(asOf || '').slice(0, 10);
  const view = buildAccountLifecycleStates(clients, { asOf: bound });
  const deskDates = deskCalendar(clients, bound);
  const lastDeskDate = deskDates[deskDates.length - 1] || null;

  // Per client: its closes, which of them carried no account row, and the last
  // date it filed anything at all.
  const clientState = new Map();
  for (const client of clients || []) {
    const closes = sortedCloses(client, bound);
    const emptyDates = [];
    let lastFiled = null;
    for (const close of closes) {
      const day = isoDay(close.date);
      if (closeHasRows(close)) lastFiled = day;
      else if (day) emptyDates.push(day);
    }
    clientState.set(client.id, {
      client,
      closes,
      closeDates: closes.map((close) => isoDay(close.date)).filter(Boolean),
      emptyDates,
      lastFiled,
      lastClose: closes.length ? isoDay(closes[closes.length - 1].date) : null,
      // Which accounts reported on each close, so a cohort can say whether the
      // whole reporting book stopped at once or only part of it.
      reportedBy: new Map(closes.map((close) => [
        isoDay(close.date),
        new Set([...(close.snapshots || []), ...(close.simulation?.snapshots || [])]
          .map((snapshot) => nameKey(snapshot?.accountName))
          .filter(Boolean)),
      ])),
    });
  }

  // (clientId, accountNameKey) -> lifecycle record and its existence date, built
  // once. Everything below needs both, and scanning the 718 records per account
  // per close is the kind of nested sweep that makes a panel feel broken on a
  // 40-client CAM.
  const recordByAccount = new Map();
  const existenceByAccount = new Map();
  for (const record of view.accounts) {
    const key = [record.clientId, nameKey(record.accountName)].join(SEP);
    recordByAccount.set(key, record);
    existenceByAccount.set(key, existsFrom(record.dateAdded, record.firstSeenDate));
  }

  /* ------------------------------------------------------------------ *
   * 1. Collection first. A client that filed nothing is ONE problem.
   * ------------------------------------------------------------------ */
  const filedNothing = [];
  const filedNothingKeys = new Set();
  const stoppedFiling = [];
  for (const [clientId, state] of clientState) {
    const registry = state.client.accountRegistry || {};
    for (const day of state.emptyDates) {
      // How many accounts the gap actually covers, under the same existence rule
      // the export uses: an account registered after the day could not have
      // filed on it, and listing it would invent an absence.
      //
      // MEASURED, AND IT IS NOT A ROUNDING DETAIL. All 8 empty closes on this
      // book cover ZERO accounts. Reese North's only close is 2026-07-13 and all
      // 7 of its registry rows carry date_added 2026-07-16; Brook Glen's is the
      // same close against 10 rows added on 07-22 and 07-28. The desk did not
      // lose those days' data — those clients had no accounts yet. reconcile.js
      // still raises a Missing account flag per row, because its registry sweep
      // has no existence rule.
      let existed = 0;
      let notYet = 0;
      let shelvedOnDay = 0;
      for (const [accountName, meta] of Object.entries(registry)) {
        if (meta?.accountType === ACCOUNT_TYPES.IGNORE) { shelvedOnDay += 1; continue; }
        if (classifyAccountNature(meta || {}, { accountName }).nature === ACCOUNT_NATURES.SIMULATION) continue;
        const start = existenceByAccount.get([clientId, nameKey(accountName)].join(SEP))?.date
          ?? existsFrom(meta?.dateAdded, null).date;
        if (start && start <= day) existed += 1;
        else notYet += 1;
      }
      filedNothing.push({
        key: [clientId, day].join(SEP),
        clientId,
        clientName: state.client.name || clientId,
        date: day,
        accountsCovered: existed,
        notYetRegistered: notYet,
        shelved: shelvedOnDay,
        registered: Object.keys(registry).length,
        isLastClose: day === state.lastClose,
      });
      filedNothingKeys.add([clientId, day].join(SEP));
    }

    // The other half, and on this book the bigger one: the client has no import
    // at all on desk dates that other clients filed. Invisible to every
    // account-level rule in the app, because accountLifecycle counts absence in
    // the client's OWN closes and this client has none to be absent from.
    if (lastDeskDate && state.closeDates.length) {
      const missed = state.lastFiled
        ? deskDates.filter((date) => date > state.lastFiled)
        : deskDates.filter((date) => date >= state.closeDates[0]);
      if (missed.length >= absentCloses) {
        stoppedFiling.push({
          key: clientId,
          clientId,
          clientName: state.client.name || clientId,
          lastFiled: state.lastFiled,
          // 5 clients here have imports and have never filed a single account
          // row on any of them. "Stopped" would be the wrong word for those, so
          // the flag is carried and the panel says which it is.
          neverFiledAnyRow: !state.lastFiled,
          deskDatesMissed: missed.length,
          deskDates: deskDates.length,
          registered: Object.keys(registry).length,
        });
      }
    }
  }

  const stoppedFilingClients = new Set(stoppedFiling.map((entry) => entry.clientId));

  /* ------------------------------------------------------------------ *
   * 2. The accounts themselves.
   * ------------------------------------------------------------------ */
  const quiet = [];
  const cameBack = [];
  const neverReported = [];
  const countedApart = {
    ignore: 0,
    simulation: 0,
    notYetRegistered: 0,
    // Split out of notYetRegistered: an account with NO provable existence date
    // at all is not the same claim as one registered after the last close, and
    // folding the two would let a null be read as a positive fact. 0 accounts
    // here — date_added is populated on 764 of 764 — so this is a guard, not a
    // finding, and it is the guard accountAbsence.js:88 asks for by name.
    existenceUnknown: 0,
    unregistered: 0,
  };
  // The same four buckets, counted ONLY over accounts that actually meet the
  // absence test. countedApart above is "how many exist at all"; this is "how
  // many of them the headline is leaving out", and they are not the same number:
  // 84 accounts are shelved, 61 of those went quiet. Without this the panel can
  // only say 122 and cannot say what it is 122 out of.
  const setAsideQuiet = { ignore: 0, simulation: 0, unregistered: 0 };
  const simulation = [];
  // Every account, whatever bucket it lands in, so a flag can be answered about
  // an account this panel deliberately does not list.
  const evidenceByAccount = new Map();

  const registryMetaOf = (clientId, accountName) => {
    const registry = clientState.get(clientId)?.client?.accountRegistry || {};
    const direct = registry[accountName];
    if (direct) return direct;
    const key = nameKey(accountName);
    const found = Object.keys(registry).find((name) => nameKey(name) === key);
    return found ? registry[found] : null;
  };

  for (const record of view.accounts) {
    const state = clientState.get(record.clientId);
    if (!state) continue;
    const key = [record.clientId, nameKey(record.accountName)].join(SEP);
    const meta = registryMetaOf(record.clientId, record.accountName);

    // A simulator is absent from most closes by design — it only appears in the
    // grid while somebody has it loaded — so it can never be a missing account.
    // buildAccountLifecycleStates already drops the ones typed 'Simulation';
    // this catches the ones recognised only by NinjaTrader's Sim<number> naming,
    // which is the only signal that works on the unredacted exports (11 of 11)
    // and fires on 0 of the 685 registry rows here, because redaction renames
    // accounts and Sim101 is not what any of them is called any more.
    //
    // NO `Boolean(meta) &&` GUARD. It used to be there and it skipped the exact
    // accounts that need the name test most: 33 of the 718 records on this book
    // are snapshots with no registry row, so they have no account_type to read
    // and the name is the ONLY signal they carry. With the guard the panel also
    // claimed "every one of the 718 accounts was classified" while 685 of them
    // were. classifyAccountNature({}, {accountName}) falls through to the name
    // test and returns LIVE by default, which is what an unnamed orphan should
    // be — but a `Sim101` trading under a hard-deleted registry row would have
    // been listed as a quiet real-money account.
    const simulated = classifyAccountNature(meta || {}, { accountName: record.accountName })
      .nature === ACCOUNT_NATURES.SIMULATION;
    // 84 of the registry rows are shelved as Inactive / Ignore, and 61 of the
    // 195 accounts that stopped reporting are among them. In a headline they
    // read as a collection failure; they are a shelf.
    const shelved = record.accountType === ACCOUNT_TYPES.IGNORE;
    const shape = shapeOf(record);
    const existence = existenceByAccount.get(key) || existsFrom(meta?.dateAdded, record.firstSeenDate);

    const row = rowFor(record, {
      shape,
      absenceReason: shape === QUIET_SHAPES.REPORTING_AGAIN ? null : absenceReasonOf(record),
      clientFiledNothingOnLastSeen: record.lastSeenDate
        ? filedNothingKeys.has([record.clientId, record.lastSeenDate].join(SEP))
        : false,
      absentClosesWithRows: record.lastSeenDate
        ? state.closeDates.filter(
          (date) => date > record.lastSeenDate && !state.emptyDates.includes(date),
        ).length
        : null,
      clientStoppedFiling: stoppedFilingClients.has(record.clientId),
      existence,
      shelved,
      simulated,
    });
    evidenceByAccount.set(key, row);

    // Does this account meet the absence test, whatever bucket it lands in? The
    // headline is 122 and the answer to "how many accounts went quiet" is 195;
    // the difference is entirely accounts set aside below, and a headline that
    // cannot name the gap is a headline the CountedApart block contradicts.
    const meetsAbsenceTest = Boolean(record.seenCloses)
      && record.closesSinceSeen !== null
      && record.closesSinceSeen >= absentCloses;

    if (simulated) {
      countedApart.simulation += 1;
      if (meetsAbsenceTest) setAsideQuiet.simulation += 1;
      continue;
    }
    if (shelved) {
      countedApart.ignore += 1;
      if (meetsAbsenceTest) setAsideQuiet.ignore += 1;
      continue;
    }
    if (!record.registered) {
      // A snapshot whose account has no registry row — 33 of them here, 12 of
      // which went quiet. Classified, never listed as missing: there is no
      // registry row for it to be missing from, which is also why
      // accountLifecycle refuses to suggest retiring one.
      countedApart.unregistered += 1;
      if (meetsAbsenceTest) setAsideQuiet.unregistered += 1;
      continue;
    }

    if (shape === QUIET_SHAPES.NEVER_REPORTED) {
      if (!existence.date) {
        // Neither date_added nor an observed close. Nothing can be said about
        // when it started, so it is not counted absent and not counted as
        // registered-late either — see countedApart.existenceUnknown above.
        countedApart.existenceUnknown += 1;
        continue;
      }
      if (state.lastClose && existence.date > state.lastClose) {
        // Registered after the last close on file. It could not have reported,
        // so counting it absent would manufacture the absence.
        countedApart.notYetRegistered += 1;
        continue;
      }
      neverReported.push(row);
      continue;
    }

    if (shape === QUIET_SHAPES.REPORTING_AGAIN) {
      // Only the ones that actually had a gap. Without this test the bucket is
      // every account in every latest close — 427 of the 718 records here — and
      // "came back" said about an account that never left is noise that buries
      // the handful it is meant to name.
      if (record.skippedCloses > 0) cameBack.push(row);
      continue;
    }

    if (record.closesSinceSeen < absentCloses) continue;
    quiet.push(row);
  }

  /* ------------------------------------------------------------------ *
   * 3. Simulation accounts, listed rather than dropped.
   *
   * They belong beside the quiet accounts for the same reason the quiet ones
   * needed a home: a CAM has to see them separately from the working book. One
   * is not real money, the other is not reporting, and neither belongs in a
   * total. Today they appear only inside SimulationReportSection, which is a
   * client-facing report block behind an opt-in toggle.
   * ------------------------------------------------------------------ */
  for (const [clientId, state] of clientState) {
    const registry = state.client.accountRegistry || {};
    for (const [accountName, meta] of Object.entries(registry)) {
      const nature = classifyAccountNature(meta || {}, { accountName });
      if (nature.nature === ACCOUNT_NATURES.LIVE) continue;

      // A simulator's closes live in dailyImport.simulation, which the lifecycle
      // module deliberately does not read, so its last sighting is taken from
      // there directly.
      let lastSeenDate = null;
      let balance = null;
      let realized = null;
      let closesSeen = 0;
      let orders = 0;
      let executions = 0;
      const key = nameKey(accountName);
      for (const close of state.closes) {
        const side = close.simulation || {};
        const rows = [...(side.snapshots || []), ...(side.undetermined?.snapshots || [])];
        const mine = rows.filter((snapshot) => nameKey(snapshot?.accountName) === key);
        if (!mine.length) continue;
        closesSeen += 1;
        lastSeenDate = isoDay(close.date);
        balance = Number(mine[0].accountBalance ?? null);
        realized = Number(mine[0].grossRealizedPnl ?? null);
        orders = [...(side.orders || []), ...(side.undetermined?.orders || [])]
          .filter((row) => nameKey(row?.accountName) === key).length;
        executions = [...(side.executions || []), ...(side.undetermined?.executions || [])]
          .filter((row) => nameKey(row?.accountName) === key).length;
      }

      simulation.push({
        key: [clientId, key].join(SEP),
        clientId,
        clientName: state.client.name || clientId,
        accountName,
        alias: meta?.alias || accountName,
        accountType: meta?.accountType || '',
        status: meta?.status || '',
        nature: nature.nature,
        natureLabel: NATURE_LABELS[nature.nature],
        natureReason: nature.reason,
        // Announced, because the name test is a heuristic and a
        // reclassification a CAM cannot see is what once deleted a client's
        // whole trading day without a trace.
        heuristic: nature.heuristic,
        conflict: nature.conflict,
        lastSeenDate,
        closesSeen,
        closes: state.closeDates.length,
        // null, never 0. A simulator that has never been loaded has no balance
        // on file, and printing $0 would state a figure nobody reported.
        balance: closesSeen ? (Number.isFinite(balance) ? balance : null) : null,
        realized: closesSeen ? (Number.isFinite(realized) ? realized : null) : null,
        orders,
        executions,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. Cohorts. Several accounts of one client that stopped on the SAME close
   *    are one event, and the flag reports them as N.
   * ------------------------------------------------------------------ */
  // For every close: how many accounts filed on it, and how many of those never
  // filed again. Counted over ALL lifecycle records, not just the listed ones —
  // a cohort that leaves out the shelved accounts cannot answer "did the WHOLE
  // close stop", and answering that wrongly is what turns one machine going off
  // into eight account failures.
  const closeReturnStats = new Map();
  for (const [clientId, state] of clientState) {
    for (const [day, names] of state.reportedBy) {
      if (!day) continue;
      let neverReturned = 0;
      for (const name of names) {
        const rec = recordByAccount.get([clientId, name].join(SEP));
        if (rec && rec.lastSeenDate === day && rec.closesSinceSeen > 0) neverReturned += 1;
      }
      closeReturnStats.set([clientId, day].join(SEP), { reported: names.size, neverReturned });
    }
  }

  const cohortMap = new Map();
  for (const row of quiet) {
    const key = [row.clientId, row.lastSeenDate].join(SEP);
    if (!cohortMap.has(key)) {
      const stats = closeReturnStats.get(key) || { reported: 0, neverReturned: 0 };
      cohortMap.set(key, {
        key,
        clientId: row.clientId,
        clientName: row.clientName,
        lastSeenDate: row.lastSeenDate,
        reportedThatClose: stats.reported,
        neverReturnedThatClose: stats.neverReturned,
        rows: [],
      });
    }
    cohortMap.get(key).rows.push(row);
  }
  const cohorts = [...cohortMap.values()].map((cohort) => ({
    ...cohort,
    accounts: cohort.rows.length,
    // EVERY account that filed on that close stopped on it. That is one event —
    // a machine, a connection, a rename — and not N account failures. Jordan
    // Cedar 2026-07-15 is the shape: all 8 accounts that reported that day never
    // reported again, and a different set of 5 has filed on every close since.
    wholeClose: cohort.reportedThatClose > 0
      && cohort.neverReturnedThatClose === cohort.reportedThatClose,
    closesSinceSeen: cohort.rows[0]?.closesSinceSeen ?? null,
    shapes: countShapes(cohort.rows),
  })).sort((a, b) => (
    b.accounts - a.accounts
    || String(a.lastSeenDate).localeCompare(String(b.lastSeenDate))
    || String(a.clientName).localeCompare(String(b.clientName))
  ));

  const bySeverity = (a, b) => (
    (b.buffer.breached === true ? 1 : 0) - (a.buffer.breached === true ? 1 : 0)
    || (b.balanceThen || 0) - (a.balanceThen || 0)
  );

  return {
    // The last close the evidence actually reaches, never the date on the
    // picker. The ops screen seeds its picker from the wall clock, and this book
    // ends 2026-07-30.
    asOf: view.asOf,
    bound: bound || null,
    absentCloses,
    deskDates,
    accounts: quiet.slice().sort(bySeverity),
    cohorts,
    cameBack: cameBack.slice().sort(bySeverity),
    neverReported: neverReported.slice().sort((a, b) => String(a.clientName).localeCompare(String(b.clientName))),
    collection: { filedNothing, stoppedFiling },
    simulation: simulation.sort((a, b) => String(a.clientName).localeCompare(String(b.clientName))),
    countedApart,
    setAsideQuiet,
    evidenceByAccount,
    counts: {
      // Every count carries what it is out of.
      accountsOnRecord: view.accounts.length,
      quiet: quiet.length,
      // EVERY account that meets the absence test, including the ones set aside
      // below. 195 on this book against 122 listed, and the 73 in between are
      // 61 shelved as Inactive / Ignore and 12 with no registry row. The
      // headline used to read "122 of 718 accounts have filed nothing for 2 or
      // more of their client's own closes", which is a false sentence — 195
      // have. 122 is how many are worth a CAM's time, and both numbers are
      // printed now rather than one standing in for the other.
      quietOnRecord: quiet.length
        + setAsideQuiet.ignore + setAsideQuiet.simulation + setAsideQuiet.unregistered,
      quietSetAside: setAsideQuiet.ignore + setAsideQuiet.simulation + setAsideQuiet.unregistered,
      quietShapes: countShapes(quiet),
      cameBack: cameBack.length,
      neverReported: neverReported.length,
      cohorts: cohorts.length,
      cohortsWholeClose: cohorts.filter((cohort) => cohort.wholeClose).length,
      accountsInCohortsOfThreeOrMore: cohorts
        .filter((cohort) => cohort.accounts >= 3)
        .reduce((sum, cohort) => sum + cohort.accounts, 0),
      clientsWithQuiet: new Set(quiet.map((row) => row.clientId)).size,
      // Accounts that carry BOTH stories: they went quiet inside the closes
      // their client did file, and their client has since stopped filing
      // altogether. 2 of the 122 here. Reported rather than assigned to one
      // side, because both are true.
      quietOnClientsThatStoppedFiling: quiet.filter((row) => row.clientStoppedFiling).length,
      clients: clientState.size,
      // The denominator "32 of N clients have a quiet account" actually has: a
      // client with no import at all has no close for an account to be absent
      // from, so it can never contribute. 84 of the 96 clients here have closes;
      // the other 12 hold 0 registered accounts between them (measured), which
      // is why they are absent from every block on this panel rather than being
      // a hole in it.
      clientsWithCloses: [...clientState.values()].filter((state) => state.closeDates.length).length,
      filedNothing: filedNothing.length,
      // Accounts the empty closes actually cover. 0 on this book, against 23
      // registry rows on those same clients — every one of them registered after
      // the empty close. An empty close is not automatically a lost day.
      filedNothingAccounts: filedNothing.reduce((sum, entry) => sum + entry.accountsCovered, 0),
      filedNothingNotYetRegistered: filedNothing.reduce((sum, entry) => sum + entry.notYetRegistered, 0),
      stoppedFiling: stoppedFiling.length,
      stoppedFilingAccounts: stoppedFiling.reduce((sum, entry) => sum + entry.registered, 0),
      simulation: simulation.filter((row) => row.nature === ACCOUNT_NATURES.SIMULATION).length,
      simulationUndetermined: simulation.filter((row) => row.nature === ACCOUNT_NATURES.UNDETERMINED).length,
    },
  };
}

function countShapes(rows) {
  const counts = {};
  for (const shape of Object.values(QUIET_SHAPES)) counts[shape] = 0;
  for (const row of rows) counts[row.shape] += 1;
  return counts;
}

/**
 * The evidence for one `Missing account` flag row, or null when the flag is not
 * one.
 *
 * WHY THE EVIDENCE IS ATTACHED HERE AND NOT WRITTEN INTO THE MESSAGE.
 * reconcile.js emits the flag from inside one close and has no history to read:
 * `reconcileDailyImport` accepts a `history` argument and not one of its five
 * callers passes it. Even if it did, a better message would only reach imports
 * reconciled after the change — the 309 flag rows already in operational_flags
 * keep the sentence they were written with, and buildCamFlagQueue groups by
 * message, so a reworded flag would split every live problem into an old row and
 * a new one. Reading the evidence back out of account_snapshots at render time
 * fixes all 106 open problems, including the ones raised weeks ago.
 *
 * @param {object} model  the result of buildQuietAccounts
 * @param {object} flagRow  a buildCamFlagQueue row (clientId, accountName, lastSeen)
 */
export function quietEvidenceForFlag(model, flagRow) {
  if (!model || !flagRow) return null;
  const key = [flagRow.clientId, nameKey(flagRow.accountName)].join(SEP);
  const day = String(flagRow.lastSeen || '').slice(0, 10) || null;
  // An unnamed flag looks up nothing. 2 of the 106 open Missing account problems
  // here carry trading_account_id null, so their accountName resolves to '' —
  // and '' is a key like any other, which would silently hand them whichever
  // record happens to be stored under an empty name. There is none on this book,
  // and that is exactly the kind of thing that stops being true.
  const row = nameKey(flagRow.accountName)
    ? model.evidenceByAccount.get(key) || null
    : null;
  const gap = day
    ? model.collection.filedNothing.find(
      (entry) => entry.clientId === flagRow.clientId && entry.date === day,
    ) || null
    : null;

  // 1. THE FLAG IS ABOUT A DAY THE ACCOUNT DID NOT EXIST. Highest precedence,
  // because nothing else about the account is relevant once that is true and
  // there is nothing whatever to chase. reconcile.js sweeps the registry AS IT
  // STANDS TODAY against the close being reconciled and applies no existence
  // rule, so a row added on 2026-07-16 raises a Missing account flag on a close
  // from 2026-07-13. Reese North's seven flags are all exactly this.
  if (row && row.existsFrom && day && row.existsFrom > day) {
    return {
      shape: QUIET_SHAPES.NOT_YET_REGISTERED,
      label: QUIET_SHAPE_LABELS[QUIET_SHAPES.NOT_YET_REGISTERED],
      bucket: 'not-yet-registered',
      row,
      collection: gap,
      evidenceLine: `This account's earliest provable existence date is ${row.existsFrom} (${row.existsFromBasis}), after the ${day} close the flag stands on. It could not have appeared in it.`,
    };
  }

  // 2. COLLECTION OUTRANKS THE ACCOUNT. The flag's most recent occurrence sits
  // on a close that carried no account rows at all, so this account is absent
  // for the same reason every one of its siblings is: nobody collected that day.
  if (gap) {
    return {
      shape: QUIET_SHAPES.CLIENT_FILED_NOTHING,
      label: QUIET_SHAPE_LABELS[QUIET_SHAPES.CLIENT_FILED_NOTHING],
      bucket: 'client-filed-nothing',
      row,
      collection: gap,
      evidenceLine: gap.accountsCovered
        ? `Nothing was collected for ${gap.clientName} on ${gap.date}: the import carried no account rows at all, and all ${gap.accountsCovered} accounts that existed that day are absent for that one reason.`
        : `Nothing was collected for ${gap.clientName} on ${gap.date} — and none of its ${gap.registered} accounts existed yet on that date either. There is no account absence here to chase.`,
    };
  }

  // 3. What the last close actually said about the account.
  if (row) {
    return {
      shape: row.shape,
      label: QUIET_SHAPE_LABELS[row.shape],
      bucket: row.shape,
      row,
      collection: null,
      evidenceLine: row.evidenceLine,
    };
  }

  // Deliberately null rather than a reassuring sentence. Two of the 106 open
  // problems on this book name NO account at all — operational_flags.
  // trading_account_id is null on both, so supabaseStore resolves accountName to
  // '' and there is no account to read anything about. (An earlier version of
  // this comment said they named an account with no registry row; they do not
  // name one.) A row that said "nothing found, looks fine" would be the same
  // invention this module exists to stop, and a row keyed on the empty string
  // would attach some other account's evidence to a flag that never named it.
  return null;
}
