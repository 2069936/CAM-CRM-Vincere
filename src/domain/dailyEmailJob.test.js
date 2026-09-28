import { describe, expect, it, vi } from 'vitest';
import { runDailyEmails, usersFromRows } from './dailyEmailJob';

/* Synthetic tables in the shape buildCrmStateFromTables reads them, so the run
 * is asserted end to end with only the send injected. */

const TABLES = {
  cam_profiles: [
    { id: 'p-peter', legacy_key: 'peter', name: 'Peter', status: 'Active' },
    { id: 'p-camila', legacy_key: 'camila', name: 'Camila', status: 'Active' },
  ],
  clients: [
    { id: 'c1', name: 'One', stage: 'Active' },
    { id: 'c2', name: 'Two', stage: 'Active' },
  ],
  client_assignments: [
    { client_id: 'c1', cam_profile_id: 'p-peter' },
    { client_id: 'c2', cam_profile_id: 'p-camila' },
  ],
  trading_accounts: [
    { id: 'a1', client_id: 'c1', account_name: 'A1', account_type: 'Funded', status: 'Active' },
    { id: 'a2', client_id: 'c2', account_name: 'A2', account_type: 'Funded', status: 'Active' },
  ],
  daily_imports: [
    { id: 'i1', client_id: 'c1', trading_date: '2026-09-28', status: 'Closed' },
    { id: 'i2', client_id: 'c2', trading_date: '2026-09-28', status: 'Closed' },
  ],
  account_snapshots: [
    { id: 's1', daily_import_id: 'i1', trading_account_id: 'a1', account_name: 'A1', gross_realized_pnl: 120, weekly_pnl: 300, account_balance: 50000 },
    { id: 's2', daily_import_id: 'i2', trading_account_id: 'a2', account_name: 'A2', gross_realized_pnl: -40, weekly_pnl: 10, account_balance: 49000 },
  ],
  strategy_snapshots: [],
};

const USER_ROWS = [
  { email: 'pedro@vinceretrading.com', display_name: 'Peter', cam_profile_id: 'p-peter', status: 'Active' },
  { email: 'camila@vinceretrading.com', display_name: 'Camila', cam_profile_id: 'p-camila', status: 'Active' },
];

const run = (send, extra = {}) => runDailyEmails({
  tables: TABLES, userRows: USER_ROWS, date: '2026-09-28', send, generatedAt: '2026-09-28T21:00:00Z', ...extra,
});

describe('reading app_users', () => {
  const PROFILES = [{ id: 'p-peter', legacy_key: 'peter' }];

  it('takes the address and the profile and drops what has neither', () => {
    expect(usersFromRows([
      { email: 'a@x.com', display_name: 'A', cam_profile_id: 'p-peter', status: 'Active' },
      { email: 'manager@x.com', display_name: 'M', cam_profile_id: null },
      { display_name: 'No address', cam_profile_id: 'p-peter' },
    ], PROFILES)).toEqual([
      { email: 'a@x.com', name: 'A', camProfileId: 'peter', status: 'Active' },
    ]);
  });

  /* app_users.cam_profile_id is the UUID; buildCrmStateFromTables exposes the
   * profile under its legacy_key. Matched on either alone this joins nothing,
   * every CAM comes out unreachable, and the run reports a clean success
   * having sent no mail. */
  it('translates the UUID on the user row to the key the app uses', () => {
    expect(usersFromRows([{ email: 'a@x.com', cam_profile_id: 'p-peter' }], PROFILES)[0].camProfileId)
      .toBe('peter');
  });

  it('keeps an unresolvable profile id rather than dropping the user silently', () => {
    // A missing profile row and a user pointing at a profile that never
    // existed are different problems; this keeps them apart downstream.
    expect(usersFromRows([{ email: 'a@x.com', cam_profile_id: 'p-ghost' }], PROFILES)[0].camProfileId)
      .toBe('p-ghost');
  });

  it('falls back to the username when there is no display name', () => {
    expect(usersFromRows([{ email: 'a@x.com', username: 'eduardo', cam_profile_id: 'p-peter' }], PROFILES)[0].name)
      .toBe('eduardo');
  });
});

describe('the run', () => {
  it('sends one message per CAM, each to their own address', async () => {
    const send = vi.fn(async () => ({ messageId: '<id>' }));
    const result = await run(send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.sent.map((entry) => entry.to.join())).toEqual([
      'pedro@vinceretrading.com', 'camila@vinceretrading.com',
    ]);
    expect(result.ok).toBe(true);
  });

  it('hands the sender a built message and nothing to build', async () => {
    const send = vi.fn(async () => ({ messageId: null }));
    await run(send);
    const [message] = send.mock.calls[0];
    expect(message.subject).toBe('Daily reports · 2026-09-28 · 1 client');
    expect(message.text).toContain('Daily Update');
    expect(message.attachments.map((a) => a.name)).toEqual([
      'reports-2026-09-28.zip', 'raw-2026-09-28.json',
    ]);
  });

  /* A provider that refuses one message must not stop the rest, and must not
   * be reported as success. An unverified sender and an exhausted daily quota
   * arrive the same way, and a CAM who stops receiving their close must not
   * have to be the one who notices. */
  it('keeps going when one message is refused, and says which', async () => {
    const send = vi.fn(async ({ to }) => {
      if (to[0].email.startsWith('pedro')) throw new Error('The email was refused (400): Sender not valid.');
      return { messageId: '<ok>' };
    });
    const result = await run(send);

    expect(result.sent.map((entry) => entry.camName)).toEqual(['Camila']);
    expect(result.refused).toEqual([{
      camName: 'Peter',
      to: ['pedro@vinceretrading.com'],
      reason: 'The email was refused (400): Sender not valid.',
    }]);
    expect(result.ok).toBe(false);
  });

  it('reports a CAM with no address rather than sending nothing quietly', async () => {
    const send = vi.fn(async () => ({ messageId: '<id>' }));
    const result = await run(send, { userRows: [USER_ROWS[0]] });

    expect(result.sent).toHaveLength(1);
    expect(result.unreachable).toEqual([
      // The legacy key, which is how the rest of the app names a CAM.
      { camProfileId: 'camila', camName: 'Camila', clients: 1 },
    ]);
    // Unreachable is a fact about the directory, not a failure of the run.
    expect(result.ok).toBe(true);
  });

  it('sends nothing at all on a day nobody closed', async () => {
    const send = vi.fn();
    const result = await run(send, { date: '1999-01-01' });
    expect(send).not.toHaveBeenCalled();
    expect(result.sent).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('records the date it ran for, so a log says which close this was', async () => {
    const result = await run(vi.fn(async () => ({})));
    expect(result.date).toBe('2026-09-28');
  });
});
