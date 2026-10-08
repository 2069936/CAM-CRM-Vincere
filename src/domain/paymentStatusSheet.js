import {
  normalizePaymentStatus,
  parseSubscriptionAmount,
  subscriptionAmountOf,
  subscriptionPriceFor,
} from './subscriptionPrice';

/* ------------------------------------------------------------------------- *
 * The desk's "CAM Clients Payment Status" sheet, pasted from Google Sheets.
 *
 * THE SHEET IS THE SOURCE OF TRUTH FOR WHO PAYS WHAT, and it lives outside the
 * CRM. Its Active tab is laid out side by side in five column groups, each
 * with its own little header:
 *
 *   Paying a subscription | Free CAM          | Undetermined | Paused / Payment Failed / Free expired | Iddle Clients
 *   Name Email Amount Notes | Name Email Notes | Name Email Notes | Name Email Notes                  | Name Email
 *
 * and a second tab, Cancelled, holds Name and Email only. Copying a tab out of
 * Google Sheets gives tab separated text with one line per sheet row, so a row
 * of the paste carries up to five clients, one per group, and a group is
 * recognised by what its title row SAYS, not by which column it starts in:
 * the desk adds a Notes column or drops one without telling anybody.
 *
 * NOTHING HERE WRITES. This file parses, matches and plans; the screen shows
 * the plan and only an explicit Apply changes a client. A paste that was meant
 * for a different textarea must cost nothing.
 *
 * MATCHING IS BY EMAIL FIRST, because the sheet's names are whatever the CAM
 * typed and the CRM's are whatever the intake form held, and "Jon Smith" and
 * "Jonathan Smith" are the same man. Primary email, then the additional
 * emails on the CRM record, then an exact name as the last resort. A row that
 * could be two clients is reported as ambiguous and never applied by a guess.
 * ------------------------------------------------------------------------- */

/** Group title cells, as the sheet spells them, to the status they mean. */
const GROUP_TITLES = [
  { status: 'paying', test: /paying\s+a\s+subscription|^paying\b/i },
  { status: 'free', test: /^free\s*cam\b|^free\b/i },
  { status: 'undetermined', test: /^undetermined\b/i },
  { status: 'paused', test: /^paused\b|payment\s+failed|free\s+expired/i },
  { status: 'idle', test: /^id+le\b/i },
  { status: 'cancelled', test: /^cancell?ed\b/i },
];

const HEADER_ROLES = [
  { role: 'name', test: /^(client\s*)?(full\s*)?names?$/i },
  { role: 'email', test: /^e-?mails?(\s*\(.*\))?$/i },
  { role: 'amount', test: /amount|price|^monthly|^\$$/i },
  { role: 'notes', test: /^notes?\b|^comments?\b/i },
];

const cleanCell = (cell) => String(cell ?? '').replace(/^"|"$/g, '').trim();

function groupTitleOf(cell) {
  const text = cleanCell(cell);
  if (!text) return null;
  return GROUP_TITLES.find((entry) => entry.test.test(text))?.status || null;
}

function headerRoleOf(cell) {
  const text = cleanCell(cell);
  if (!text) return null;
  return HEADER_ROLES.find((entry) => entry.test.test(text))?.role || null;
}

/** Every email in a cell, trimmed and lowercased. "a@x.com / b@y.com" gives both. */
export function normalizeEmails(cell) {
  const out = [];
  for (const piece of String(cell ?? '').split(/[\s/,;|]+/)) {
    const email = piece.trim().toLowerCase().replace(/^<|>$/g, '');
    if (email.includes('@') && !out.includes(email)) out.push(email);
  }
  return out;
}

/** The name as the matcher compares it: trimmed, lowercased, one space between words. */
export function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTitleRow(cells) {
  const filled = cells.map(cleanCell).filter(Boolean);
  if (!filled.length) return false;
  const titles = filled.filter((cell) => groupTitleOf(cell));
  // At least one group title, and nothing in the row that is plainly data.
  return titles.length > 0 && filled.every((cell) => groupTitleOf(cell) || headerRoleOf(cell));
}

function isHeaderRow(cells) {
  const filled = cells.map(cleanCell).filter(Boolean);
  if (!filled.length) return false;
  const roles = filled.map(headerRoleOf);
  return roles.every(Boolean) && roles.includes('name');
}

/** Column spans for each group on a title row: from its title to the next title. */
function groupsFromTitleRow(cells, width) {
  const starts = [];
  cells.forEach((cell, index) => {
    const status = groupTitleOf(cell);
    if (status) starts.push({ status, start: index });
  });
  return starts.map((entry, i) => ({
    status: entry.status,
    start: entry.start,
    end: i + 1 < starts.length ? starts[i + 1].start - 1 : Math.max(entry.start, width - 1),
    columns: null,
  }));
}

/** The default column order inside a group when the header row is missing. */
function defaultColumns(group) {
  const columns = { name: group.start, email: group.start + 1 };
  if (group.status === 'paying') {
    columns.amount = group.start + 2;
    columns.notes = group.start + 3;
  } else if (group.status !== 'idle' && group.status !== 'cancelled') {
    columns.notes = group.start + 2;
  }
  return columns;
}

/** Column roles inside a group read off the header row under its title. */
function columnsFromHeader(group, headerCells) {
  const columns = {};
  for (let index = group.start; index <= group.end && index < headerCells.length; index += 1) {
    const role = headerRoleOf(headerCells[index]);
    if (role && !(role in columns)) columns[role] = index;
  }
  return 'name' in columns || 'email' in columns ? columns : defaultColumns(group);
}

/**
 * Parse a tab separated paste of the Active tab, the Cancelled tab, or both one
 * after the other.
 *
 * @returns {{ rows: SheetRow[], warnings: string[], groups: string[] }}
 *   rows: one per client found, in sheet order. Each carries `status`, `name`,
 *   `emails` (normalised), `amount` (whole dollars or null), `amountUnknown`
 *   (a paying row whose amount could not be read, "???" included), `notes`,
 *   and the 1-based `line` it came from.
 */
export function parsePaymentStatusSheet(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  const warnings = [];
  const seen = new Set();
  let groups = null;
  let pendingTitles = null;

  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    const cells = line.split('\t');

    if (isTitleRow(cells)) {
      pendingTitles = groupsFromTitleRow(cells, cells.length);
      groups = pendingTitles.map((group) => ({ ...group, columns: defaultColumns(group) }));
      groups.forEach((group) => seen.add(group.status));
      return;
    }

    if (isHeaderRow(cells)) {
      if (pendingTitles) {
        // The last group runs to the end of the header row: a title row pasted
        // without its trailing tabs is narrower than the header under it.
        const last = pendingTitles.length - 1;
        groups = pendingTitles.map((group, i) => {
          const widened = { ...group, end: i === last ? Math.max(group.end, cells.length - 1) : group.end };
          return { ...widened, columns: columnsFromHeader(widened, cells) };
        });
        pendingTitles = null;
      } else {
        // A header with no group title above it is the Cancelled tab: Name and
        // Email only, every row on it churned.
        const start = cells.findIndex((cell) => headerRoleOf(cell) === 'name');
        const group = { status: 'cancelled', start, end: cells.length - 1 };
        groups = [{ ...group, columns: columnsFromHeader(group, cells) }];
        seen.add('cancelled');
      }
      return;
    }
    pendingTitles = null;

    if (!groups) {
      warnings.push(`Line ${lineIndex + 1}: skipped, no group header found above it.`);
      return;
    }

    for (const group of groups) {
      const at = (role) => (role in group.columns ? cleanCell(cells[group.columns[role]]) : '');
      const name = at('name');
      const emailCell = at('email');
      if (!name && !emailCell) continue;
      const amountText = at('amount');
      const amount = group.status === 'paying' ? parseSubscriptionAmount(amountText) : null;
      rows.push({
        line: lineIndex + 1,
        status: group.status,
        name,
        emailCell,
        emails: normalizeEmails(emailCell),
        amountText,
        amount,
        amountUnknown: group.status === 'paying' && amount === null,
        notes: at('notes'),
      });
    }
  });

  return { rows, warnings, groups: [...seen] };
}

/* ── Matching ─────────────────────────────────────────────────────────────── */

function clientEmails(client) {
  const primary = normalizeEmails(client?.profile?.email);
  const additional = (client?.profile?.additionalEmails || []).flatMap((email) => normalizeEmails(email));
  return { primary, additional };
}

function indexClients(clients) {
  const byPrimary = new Map();
  const byAdditional = new Map();
  const byName = new Map();
  const add = (map, key, client) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(client)) map.get(key).push(client);
  };
  for (const client of clients || []) {
    if (!client || client.deletedAt) continue;
    const { primary, additional } = clientEmails(client);
    primary.forEach((email) => add(byPrimary, email, client));
    additional.forEach((email) => add(byAdditional, email, client));
    add(byName, normalizeName(client.name), client);
    add(byName, normalizeName(client.profile?.fullName), client);
  }
  return { byPrimary, byAdditional, byName };
}

function candidatesIn(map, keys) {
  const out = [];
  for (const key of keys) {
    for (const client of map.get(key) || []) if (!out.includes(client)) out.push(client);
  }
  return out;
}

export const MATCH_BASES = Object.freeze({
  PRIMARY_EMAIL: 'primary email',
  ADDITIONAL_EMAIL: 'additional email',
  NAME: 'exact name',
});

/**
 * Map sheet rows to CRM clients: primary email, then additional emails, then
 * an exact normalised name.
 *
 * @returns {{ matched: {row, client, basis}[], ambiguous: {row, basis, candidates}[], unmatched: SheetRow[] }}
 */
export function matchPaymentStatusRows(rows, clients) {
  const index = indexClients(clients);
  const matched = [];
  const ambiguous = [];
  const unmatched = [];

  for (const row of rows || []) {
    const attempts = [
      [MATCH_BASES.PRIMARY_EMAIL, candidatesIn(index.byPrimary, row.emails)],
      [MATCH_BASES.ADDITIONAL_EMAIL, candidatesIn(index.byAdditional, row.emails)],
      [MATCH_BASES.NAME, row.name ? candidatesIn(index.byName, [normalizeName(row.name)]) : []],
    ];
    const hit = attempts.find(([, candidates]) => candidates.length > 0);
    if (!hit) {
      unmatched.push(row);
      continue;
    }
    const [basis, candidates] = hit;
    if (candidates.length === 1) matched.push({ row, client: candidates[0], basis });
    else ambiguous.push({ row, basis, candidates });
  }
  return { matched, ambiguous, unmatched };
}

/* ── The plan ─────────────────────────────────────────────────────────────── */

export function currentPaymentOf(client) {
  const status = normalizePaymentStatus(client?.paymentStatus ?? client?.profile?.paymentStatus,
    client?.subscriptionPrice ?? client?.profile?.subscriptionPrice);
  const price = client?.profile?.subscriptionPrice ?? client?.subscriptionPrice;
  const amount = status === 'paying' ? subscriptionAmountOf(price) : null;
  return { status, amount, price: subscriptionPriceFor(status, amount) };
}

/**
 * What applying the matched rows would change.
 *
 * A client the sheet names twice with the same answer is one change; named
 * twice with different answers is a conflict, listed and never applied.
 *
 * @returns {{ changes: PlanEntry[], unchanged: PlanEntry[], conflicts: {client, entries}[] }}
 */
export function planPaymentStatusChanges(matched) {
  const byClient = new Map();
  for (const { row, client, basis } of matched || []) {
    const current = currentPaymentOf(client);
    const nextStatus = row.status;
    const nextAmount = nextStatus === 'paying' ? row.amount : null;
    const next = { status: nextStatus, amount: nextAmount, price: subscriptionPriceFor(nextStatus, nextAmount) };
    const entry = {
      clientId: client.id,
      client,
      row,
      basis,
      current,
      next,
      amountUnknown: Boolean(row.amountUnknown),
      changed: current.status !== next.status || current.price !== next.price,
    };
    if (!byClient.has(client.id)) byClient.set(client.id, []);
    byClient.get(client.id).push(entry);
  }

  const changes = [];
  const unchanged = [];
  const conflicts = [];
  for (const entries of byClient.values()) {
    const first = entries[0];
    const agree = entries.every((entry) => entry.next.status === first.next.status && entry.next.price === first.next.price);
    if (!agree) {
      conflicts.push({ client: first.client, entries });
      continue;
    }
    (first.changed ? changes : unchanged).push(first);
  }
  return { changes, unchanged, conflicts };
}

/** The patch `updateSupabaseClient` takes for one plan entry. */
export function paymentPatchFor(entry) {
  return {
    profile: {
      ...(entry.client?.profile || {}),
      paymentStatus: entry.next.status,
      subscriptionPrice: entry.next.price,
    },
  };
}

/**
 * Everything the screen needs from one paste, in one call.
 */
export function buildPaymentStatusImport(text, clients) {
  const parsed = parsePaymentStatusSheet(text);
  const matches = matchPaymentStatusRows(parsed.rows, clients);
  const plan = planPaymentStatusChanges(matches.matched);
  return {
    parsed,
    ...matches,
    ...plan,
    counts: {
      rows: parsed.rows.length,
      matched: matches.matched.length,
      ambiguous: matches.ambiguous.length,
      unmatched: matches.unmatched.length,
      changes: plan.changes.length,
      unchanged: plan.unchanged.length,
      conflicts: plan.conflicts.length,
      amountUnknown: plan.changes.filter((entry) => entry.amountUnknown).length
        + plan.unchanged.filter((entry) => entry.amountUnknown).length,
    },
  };
}

/**
 * The plan applied to an in-memory book, the way the CRM state ends up after
 * Apply. Pure, for tests and for the second pass that proves idempotence.
 */
export function applyPaymentStatusPlan(clients, plan) {
  const patches = new Map((plan?.changes || []).map((entry) => [entry.clientId, paymentPatchFor(entry)]));
  return (clients || []).map((client) => {
    const patch = patches.get(client.id);
    if (!patch) return client;
    return {
      ...client,
      ...patch,
      paymentStatus: patch.profile.paymentStatus,
      subscriptionPrice: patch.profile.subscriptionPrice,
    };
  });
}
