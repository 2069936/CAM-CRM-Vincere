// The payment status sheet, parsed, matched and planned over a FICTIONAL book.
// Every name and email here is invented; the real sheet never enters the
// repository.

import { describe, expect, it } from 'vitest';
import {
  MATCH_BASES,
  applyPaymentStatusPlan,
  buildPaymentStatusImport,
  matchPaymentStatusRows,
  normalizeEmails,
  parsePaymentStatusSheet,
  planPaymentStatusChanges,
} from './paymentStatusSheet';

const T = '\t';
const line = (...cells) => cells.join(T);

/* The Active tab the way Google Sheets pastes it: a title row with the five
   groups side by side, then each group's own little header, then the rows. */
const TITLE_ROW = line(
  'Paying a subscription', '', '', '',
  'Free CAM', '', '',
  'Undetermined', '', '',
  'Paused / Payment Failed / Free expired', '', '',
  'Iddle Clients', '',
);
const HEADER_ROW = line(
  'Name', 'Email', 'Amount', 'Notes',
  'Name', 'Email', 'Notes',
  'Name', 'Email', 'Notes',
  'Name', 'Email', 'Notes',
  'Name', 'Email',
);

const ACTIVE_TAB = [
  TITLE_ROW,
  HEADER_ROW,
  line(
    'Ada Quill', 'ADA@Quill.test ', '$400', '',
    'Bo Finch', 'bo@finch.test/bo.finch@other.test', '3 months free start Sept',
    'Cal Reed', 'cal@reed.test', '',
    'Dee Vane', 'dee@vane.test', 'payment failed',
    'Eli Moss', 'eli@moss.test',
  ),
  line(
    'Fern Hale', 'fern@hale.test', '???', 'ask her',
    'Gil Orr', 'gil@orr.test', 'Free until October 17',
    '', '', '',
    '', '', '',
    '', '',
  ),
  line(
    'Hal Penn', 'hal@penn.test', '$183', '',
    '', '', '',
    '', '', '',
    '', '', '',
    '', '',
  ),
].join('\n');

const CANCELLED_TAB = [
  line('Name', 'Email'),
  line('Ivy Lark', 'ivy@lark.test'),
  line('Jon Tusk', ''),
].join('\n');

const client = (id, name, over = {}) => ({
  id,
  name,
  status: 'Active',
  deletedAt: null,
  subscriptionPrice: over.price || 'Undetermined',
  paymentStatus: over.status,
  profile: {
    email: over.email || '',
    additionalEmails: over.additional || [],
    fullName: over.fullName || '',
    subscriptionPrice: over.price || 'Undetermined',
    paymentStatus: over.status,
  },
});

const book = () => [
  client('ada', 'Ada Quill', { email: 'ada@quill.test' }),
  // Primary email differs from the sheet; the second email on the sheet cell is
  // one of Bo's additional emails.
  client('bo', 'Robert Finch', { email: 'robert@finch.test', additional: ['bo.finch@other.test'], price: '$500', status: 'paying' }),
  // No email on record at all: only the name can match.
  client('cal', 'Cal Reed'),
  client('dee', 'Dee Vane', { email: 'dee@vane.test', price: '$250', status: 'paying' }),
  client('eli', 'Eli Moss', { email: 'eli@moss.test' }),
  client('fern', 'Fern Hale', { email: 'fern@hale.test' }),
  // Two clients with the same name and no email: the sheet row is ambiguous.
  client('gil1', 'Gil Orr'),
  client('gil2', 'Gil Orr'),
  client('ivy', 'Ivy Lark', { email: 'ivy@lark.test', price: '$500', status: 'paying' }),
  // Already what the sheet says: must not be a change.
  client('hal', 'Hal Penn', { email: 'hal@penn.test', price: '$183', status: 'paying' }),
  // Deleted: never a match, even by email.
  { ...client('gone', 'Ada Quill', { email: 'ada@quill.test' }), deletedAt: '2026-01-01' },
];

describe('reading the paste', () => {
  it('finds the five groups by what their title row says', () => {
    const { rows, groups, warnings } = parsePaymentStatusSheet(ACTIVE_TAB);
    expect(groups).toEqual(['paying', 'free', 'undetermined', 'paused', 'idle']);
    expect(warnings).toEqual([]);
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ['Ada Quill', 'paying'],
      ['Bo Finch', 'free'],
      ['Cal Reed', 'undetermined'],
      ['Dee Vane', 'paused'],
      ['Eli Moss', 'idle'],
      ['Fern Hale', 'paying'],
      ['Gil Orr', 'free'],
      ['Hal Penn', 'paying'],
    ]);
  });

  it('reads the groups by title, not by column position', () => {
    // The desk reordered the groups and dropped the paused Notes column.
    const reordered = [
      line('Free CAM', '', '', 'Paying a subscription', '', '', '', 'Paused', ''),
      line('Name', 'Email', 'Notes', 'Name', 'Email', 'Amount', 'Notes', 'Name', 'Email'),
      line('Bo Finch', 'bo@finch.test', 'free', 'Ada Quill', 'ada@quill.test', '$375', '', 'Dee Vane', 'dee@vane.test'),
    ].join('\n');
    const { rows } = parsePaymentStatusSheet(reordered);
    expect(rows.map((row) => [row.name, row.status, row.amount])).toEqual([
      ['Bo Finch', 'free', null],
      ['Ada Quill', 'paying', 375],
      ['Dee Vane', 'paused', null],
    ]);
  });

  it('lets the last group run to the end of a header row wider than its title row', () => {
    // A title pasted without its trailing tabs is one cell wide; the header
    // under it still has four columns and they all belong to that group.
    const narrow = [
      'Paying a subscription',
      line('Name', 'Email', 'Amount', 'Notes'),
      line('Ada Quill', 'ada@quill.test', '$400', 'ok'),
    ].join('\n');
    expect(parsePaymentStatusSheet(narrow).rows).toMatchObject([
      { name: 'Ada Quill', emails: ['ada@quill.test'], amount: 400, notes: 'ok', status: 'paying' },
    ]);
  });

  it('falls back to Name, Email, Amount, Notes when a group has no header row', () => {
    const bare = [
      line('Paying a subscription', '', '', '', 'Free CAM'),
      line('Ada Quill', 'ada@quill.test', '$333', 'note', 'Bo Finch', 'bo@finch.test'),
    ].join('\n');
    const { rows } = parsePaymentStatusSheet(bare);
    expect(rows).toMatchObject([
      { name: 'Ada Quill', status: 'paying', amount: 333, notes: 'note' },
      { name: 'Bo Finch', status: 'free', emails: ['bo@finch.test'] },
    ]);
  });

  it('normalises emails and reads both halves of a two-email cell', () => {
    const { rows } = parsePaymentStatusSheet(ACTIVE_TAB);
    expect(rows[0].emails).toEqual(['ada@quill.test']);
    expect(rows[1].emails).toEqual(['bo@finch.test', 'bo.finch@other.test']);
    expect(normalizeEmails(' A@B.test, c@d.test; E@F.test ')).toEqual(['a@b.test', 'c@d.test', 'e@f.test']);
    // A slash with no spaces around it, which is how the sheet writes most of them.
    expect(normalizeEmails('one@x.test/two@y.test')).toEqual(['one@x.test', 'two@y.test']);
    expect(normalizeEmails('one@x.test / two@y.test')).toEqual(['one@x.test', 'two@y.test']);
    expect(normalizeEmails('one@x.test two@y.test')).toEqual(['one@x.test', 'two@y.test']);
    expect(normalizeEmails('not an email')).toEqual([]);
  });

  it('parses the amount, and keeps "???" as paying with no amount, flagged', () => {
    const { rows } = parsePaymentStatusSheet(ACTIVE_TAB);
    const ada = rows.find((row) => row.name === 'Ada Quill');
    const fern = rows.find((row) => row.name === 'Fern Hale');
    const hal = rows.find((row) => row.name === 'Hal Penn');
    expect(ada).toMatchObject({ amount: 400, amountUnknown: false });
    expect(hal).toMatchObject({ amount: 183, amountUnknown: false });
    expect(fern).toMatchObject({ status: 'paying', amount: null, amountUnknown: true, amountText: '???', notes: 'ask her' });
    // Only a paying row can have an unknown amount.
    expect(rows.find((row) => row.name === 'Bo Finch')).toMatchObject({ amount: null, amountUnknown: false });
  });

  it('keeps the sheet notes', () => {
    const { rows } = parsePaymentStatusSheet(ACTIVE_TAB);
    expect(rows.find((row) => row.name === 'Bo Finch').notes).toBe('3 months free start Sept');
    expect(rows.find((row) => row.name === 'Gil Orr').notes).toBe('Free until October 17');
  });

  it('treats a bare Name, Email header as the Cancelled tab', () => {
    const { rows, groups } = parsePaymentStatusSheet(CANCELLED_TAB);
    expect(groups).toEqual(['cancelled']);
    expect(rows).toMatchObject([
      { name: 'Ivy Lark', status: 'cancelled', emails: ['ivy@lark.test'] },
      { name: 'Jon Tusk', status: 'cancelled', emails: [] },
    ]);
  });

  it('reads both tabs pasted one after the other', () => {
    const { rows, groups } = parsePaymentStatusSheet(`${ACTIVE_TAB}\n\n${CANCELLED_TAB}`);
    expect(groups).toEqual(['paying', 'free', 'undetermined', 'paused', 'idle', 'cancelled']);
    expect(rows.filter((row) => row.status === 'cancelled').map((row) => row.name)).toEqual(['Ivy Lark', 'Jon Tusk']);
    expect(rows).toHaveLength(10);
  });

  it('skips rows above any header and says so, and survives Windows line endings and nothing at all', () => {
    const { rows, warnings } = parsePaymentStatusSheet(`stray\tline\r\n${HEADER_ROW.replace(/Name/, 'Name')}\r\n`);
    expect(rows).toEqual([]);
    expect(warnings).toEqual(['Line 1: skipped, no group header found above it.']);
    expect(parsePaymentStatusSheet('')).toEqual({ rows: [], warnings: [], groups: [] });
    expect(parsePaymentStatusSheet(null).rows).toEqual([]);
  });
});

describe('matching rows to clients', () => {
  const match = () => matchPaymentStatusRows(parsePaymentStatusSheet(`${ACTIVE_TAB}\n${CANCELLED_TAB}`).rows, book());

  it('matches by primary email first, case and whitespace aside, and never a deleted client', () => {
    const ada = match().matched.find((entry) => entry.row.name === 'Ada Quill');
    expect(ada.client.id).toBe('ada');
    expect(ada.basis).toBe(MATCH_BASES.PRIMARY_EMAIL);
  });

  it('then by an additional email, so the second half of a two-email cell finds the client', () => {
    const bo = match().matched.find((entry) => entry.row.name === 'Bo Finch');
    expect(bo.client.id).toBe('bo');
    expect(bo.basis).toBe(MATCH_BASES.ADDITIONAL_EMAIL);
  });

  it('then by exact name when the record has no email', () => {
    const cal = match().matched.find((entry) => entry.row.name === 'Cal Reed');
    expect(cal.client.id).toBe('cal');
    expect(cal.basis).toBe(MATCH_BASES.NAME);
  });

  it('prefers the email over the name when they point at different clients', () => {
    // A sheet row whose email is Dee's but whose name is Cal's.
    const rows = parsePaymentStatusSheet([TITLE_ROW, HEADER_ROW, line('Cal Reed', 'dee@vane.test', '$500')].join('\n')).rows;
    const { matched } = matchPaymentStatusRows(rows, book());
    expect(matched[0].client.id).toBe('dee');
    expect(matched[0].basis).toBe(MATCH_BASES.PRIMARY_EMAIL);
  });

  it('reports a name shared by two clients as ambiguous rather than guessing', () => {
    const { ambiguous } = match();
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].row.name).toBe('Gil Orr');
    expect(ambiguous[0].candidates.map((c) => c.id).sort()).toEqual(['gil1', 'gil2']);
  });

  it('lists what it could not place, for Pedro to handle by hand', () => {
    const { unmatched } = match();
    expect(unmatched.map((row) => [row.name, row.status])).toEqual([['Jon Tusk', 'cancelled']]);
  });

  it('matches a name against the full name on the profile too, ignoring case and spacing', () => {
    const clients = [client('x', 'X Account', { fullName: 'Kit  Vale' })];
    const rows = parsePaymentStatusSheet([line('Name', 'Email'), line(' kit vale ', '')].join('\n')).rows;
    expect(matchPaymentStatusRows(rows, clients).matched[0].client.id).toBe('x');
  });
});

describe('the plan', () => {
  const build = () => buildPaymentStatusImport(`${ACTIVE_TAB}\n${CANCELLED_TAB}`, book());

  it('changes only what differs, and says what each change is', () => {
    const { changes, unchanged, counts } = build();
    const byId = Object.fromEntries(changes.map((entry) => [entry.clientId, entry]));
    expect(Object.keys(byId).sort()).toEqual(['ada', 'bo', 'dee', 'eli', 'fern', 'ivy']);
    expect(byId.ada).toMatchObject({
      current: { status: 'undetermined', amount: null, price: 'Undetermined' },
      next: { status: 'paying', amount: 400, price: '$400' },
    });
    expect(byId.bo.next).toEqual({ status: 'free', amount: null, price: 'Free' });
    expect(byId.dee.next).toEqual({ status: 'paused', amount: null, price: 'Undetermined' });
    expect(byId.eli.next).toEqual({ status: 'idle', amount: null, price: 'Undetermined' });
    expect(byId.ivy.next).toEqual({ status: 'cancelled', amount: null, price: 'Undetermined' });
    expect(byId.fern).toMatchObject({ amountUnknown: true, next: { status: 'paying', amount: null, price: 'Undetermined' } });
    // Cal is already undetermined and Hal already carries $183 paying.
    expect(unchanged.map((entry) => entry.clientId).sort()).toEqual(['cal', 'hal']);
    expect(counts).toMatchObject({ rows: 10, matched: 8, ambiguous: 1, unmatched: 1, changes: 6, unchanged: 2, amountUnknown: 1 });
  });

  it('counts a client whose status is right but whose amount moved as a change', () => {
    const rows = parsePaymentStatusSheet([TITLE_ROW, HEADER_ROW, line('Hal Penn', 'hal@penn.test', '$250')].join('\n')).rows;
    const plan = planPaymentStatusChanges(matchPaymentStatusRows(rows, book()).matched);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].next.price).toBe('$250');
  });

  it('refuses to apply a client the sheet names twice with different answers', () => {
    const twice = [TITLE_ROW, HEADER_ROW,
      line('Ada Quill', 'ada@quill.test', '$400'),
      line('', '', '', '', 'Ada Quill', 'ada@quill.test', 'now free'),
    ].join('\n');
    const result = buildPaymentStatusImport(twice, book());
    expect(result.changes).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].client.id).toBe('ada');
  });

  it('builds the patch the client save takes, with the whole profile and both fields', () => {
    const { changes } = build();
    const ada = changes.find((entry) => entry.clientId === 'ada');
    const after = applyPaymentStatusPlan(book(), { changes: [ada] }).find((c) => c.id === 'ada');
    expect(after.profile).toMatchObject({ email: 'ada@quill.test', paymentStatus: 'paying', subscriptionPrice: '$400' });
    expect(after).toMatchObject({ paymentStatus: 'paying', subscriptionPrice: '$400' });
  });

  it('is idempotent: applied twice, the second pass changes nothing', () => {
    const first = build();
    const applied = applyPaymentStatusPlan(book(), first);
    const second = buildPaymentStatusImport(`${ACTIVE_TAB}\n${CANCELLED_TAB}`, applied);
    expect(second.changes).toEqual([]);
    expect(second.counts.unchanged).toBe(first.counts.changes + first.counts.unchanged);
    // And the parts that were never applied are reported the same way again.
    expect(second.counts).toMatchObject({ ambiguous: 1, unmatched: 1 });
    expect(applyPaymentStatusPlan(applied, second)).toEqual(applied);
  });
});
