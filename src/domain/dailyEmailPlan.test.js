import { describe, expect, it } from 'vitest';
import { buildDailyEmailRun, planDailyEmails } from './dailyEmailPlan';

/* The synthetic half. dailyEmailPlan.book.test.js asserts the same rules
 * against the real split of the real book and is dropped from any run without
 * public/local-snapshot.json, which is every CI run. */

const client = (id, name) => ({
  id,
  name,
  accountRegistry: { [`${id}-A`]: { accountType: 'Funded', status: 'Active' } },
  dailyImports: [{
    id: `${id}-close`,
    date: '2026-09-28',
    accounts: {},
    flags: [],
    snapshots: [{
      accountName: `${id}-A`,
      grossRealizedPnl: 10,
      weeklyPnl: 10,
      accountBalance: 50000,
      unrealizedPnl: 0,
      strategies: [],
      meta: { accountType: 'Funded', alias: `${id}-A`, status: 'Active' },
    }],
  }],
});

const CLIENTS = [client('c1', 'One'), client('c2', 'Two'), client('c3', 'Three')];
const PETER = { id: 'cam-peter', name: 'Peter', status: 'Active', clientIds: ['c1', 'c2'] };
const CAMILA = { id: 'cam-camila', name: 'Camila', status: 'Active', clientIds: ['c3'] };

const user = (email, camProfileId, extra = {}) => ({
  email, camProfileId, name: email.split('@')[0], status: 'Active', ...extra,
});

describe('who gets an email', () => {
  it('gives each CAM the clients their profile names, and no others', () => {
    // The client does not name its CAM; the profile carries clientIds. Reading
    // it any other way would give the email a different book from the sidebar.
    const { deliveries } = planDailyEmails({
      clients: CLIENTS,
      camProfiles: [PETER, CAMILA],
      users: [user('pedro@vinceretrading.com', 'cam-peter'), user('camila@vinceretrading.com', 'cam-camila')],
    });
    expect(deliveries.map((d) => d.clients.map((c) => c.id))).toEqual([['c1', 'c2'], ['c3']]);
  });

  it('names a CAM with no reachable address instead of skipping them', () => {
    /* cam_profiles.email is empty on all 8 production rows; the addresses are
     * on app_users. Reading the wrong table would have sent nothing and
     * reported success, so an unreachable profile is an output, not a gap. */
    const { deliveries, unreachable } = planDailyEmails({
      clients: CLIENTS, camProfiles: [PETER, CAMILA], users: [user('pedro@vinceretrading.com', 'cam-peter')],
    });
    expect(deliveries).toHaveLength(1);
    expect(unreachable).toEqual([{ camProfileId: 'cam-camila', camName: 'Camila', clients: 1 }]);
  });

  it('sends one message to a profile with two logins, not two messages', () => {
    // Two users on one profile are one person with two logins far more often
    // than two people, and two copies is how a daily email gets filtered away.
    const { deliveries } = planDailyEmails({
      clients: CLIENTS,
      camProfiles: [PETER],
      users: [user('pedro@vinceretrading.com', 'cam-peter'), user('peter@vinceretrading.com', 'cam-peter')],
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].to.map((entry) => entry.email))
      .toEqual(['pedro@vinceretrading.com', 'peter@vinceretrading.com']);
  });

  it('ignores a user with no CAM profile, which is what a manager account is', () => {
    const { deliveries } = planDailyEmails({
      clients: CLIENTS,
      camProfiles: [PETER],
      users: [user('manager@vinceretrading.com', null), user('pedro@vinceretrading.com', 'cam-peter')],
    });
    expect(deliveries[0].to.map((entry) => entry.email)).toEqual(['pedro@vinceretrading.com']);
  });

  it('ignores a user with a profile but no address', () => {
    const { deliveries, unreachable } = planDailyEmails({
      clients: CLIENTS, camProfiles: [PETER], users: [{ camProfileId: 'cam-peter', name: 'No address' }],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable).toHaveLength(1);
  });

  it('does not email a disabled login', () => {
    const { deliveries, unreachable } = planDailyEmails({
      clients: CLIENTS, camProfiles: [PETER], users: [user('gone@vinceretrading.com', 'cam-peter', { status: 'Inactive' })],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable).toHaveLength(1);
  });

  it('does not email an inactive CAM profile at all, nor report it unreachable', () => {
    const { deliveries, unreachable } = planDailyEmails({
      clients: CLIENTS,
      camProfiles: [{ ...PETER, status: 'Inactive' }],
      users: [user('pedro@vinceretrading.com', 'cam-peter')],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable).toHaveLength(0);
  });

  it('skips a profile whose named clients are not in the book', () => {
    const { deliveries, unreachable } = planDailyEmails({
      clients: CLIENTS,
      camProfiles: [{ ...PETER, clientIds: ['gone-1', 'gone-2'] }],
      users: [user('pedro@vinceretrading.com', 'cam-peter')],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable).toHaveLength(0);
  });
});

describe('the run', () => {
  const users = [
    user('pedro@vinceretrading.com', 'cam-peter'),
    user('camila@vinceretrading.com', 'cam-camila'),
  ];

  it('builds one message per CAM that had a close', () => {
    const run = buildDailyEmailRun({
      clients: CLIENTS, camProfiles: [PETER, CAMILA], users, date: '2026-09-28',
      generatedAt: '2026-09-28T21:00:00Z',
    });
    expect(run.messages).toHaveLength(2);
    expect(run.messages[0].subject).toBe('Daily reports · 2026-09-28 · 2 clients');
    expect(run.messages[1].subject).toBe('Daily reports · 2026-09-28 · 1 client');
    expect(run.failed).toHaveLength(0);
  });

  it('addresses each message to that CAM alone', () => {
    const run = buildDailyEmailRun({
      clients: CLIENTS, camProfiles: [PETER, CAMILA], users, date: '2026-09-28',
    });
    expect(run.messages.map((m) => m.to.map((t) => t.email))).toEqual([
      ['pedro@vinceretrading.com'], ['camila@vinceretrading.com'],
    ]);
  });

  it('sends nothing to a CAM whose whole book was quiet', () => {
    // A daily "nothing happened" is how a daily email gets muted.
    const run = buildDailyEmailRun({
      clients: CLIENTS, camProfiles: [PETER, CAMILA], users, date: '1999-01-01',
    });
    expect(run.messages).toHaveLength(0);
  });

  it('carries the unreachable CAMs through, so the run can report them', () => {
    const run = buildDailyEmailRun({
      clients: CLIENTS, camProfiles: [PETER, CAMILA], users: [users[0]], date: '2026-09-28',
    });
    expect(run.messages).toHaveLength(1);
    expect(run.unreachable).toEqual([{ camProfileId: 'cam-camila', camName: 'Camila', clients: 1 }]);
  });
});
