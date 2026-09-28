import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCrmStateFromTables } from './supabaseStore';
import { buildDailyEmailRun, planDailyEmails } from './dailyEmailPlan';

const BOOK = JSON.parse(readFileSync('public/local-snapshot.json', 'utf8'));
const STATE = buildCrmStateFromTables(BOOK.tables || {});

const user = (email, camProfileId, extra = {}) => ({
  email, camProfileId, name: email.split('@')[0], status: 'Active', ...extra,
});

describe('who gets an email', () => {
  it('splits the book the way the CAM profile already splits it', () => {
    // The client does not name its CAM; the profile carries clientIds. Reading
    // it any other way would give the email a different book from the sidebar.
    const profiles = STATE.camProfiles || [];
    const users = profiles.map((profile) => user(`${profile.id}@vinceretrading.com`, profile.id));
    const { deliveries } = planDailyEmails({ clients: STATE.clients, camProfiles: profiles, users });

    expect(deliveries.length).toBeGreaterThan(0);
    for (const delivery of deliveries) {
      const profile = profiles.find((entry) => entry.id === delivery.camProfileId);
      expect(delivery.clients).toHaveLength((profile.clientIds || []).length);
    }
    // Every client of every emailed profile, and no client twice.
    const ids = deliveries.flatMap((d) => d.clients.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a CAM with no reachable address instead of skipping them', () => {
    /* cam_profiles.email is empty on all 8 production rows; the addresses are
     * on app_users. Reading the wrong table would have sent nothing and
     * reported success, so an unreachable profile is an output, not a gap. */
    const profiles = STATE.camProfiles || [];
    const { deliveries, unreachable } = planDailyEmails({
      clients: STATE.clients, camProfiles: profiles, users: [],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable.length).toBeGreaterThan(0);
    expect(unreachable[0]).toMatchObject({ camName: expect.any(String), clients: expect.any(Number) });
  });

  it('sends one message to a profile with two logins, not two messages', () => {
    const profile = (STATE.camProfiles || []).find((entry) => (entry.clientIds || []).length);
    const { deliveries } = planDailyEmails({
      clients: STATE.clients,
      camProfiles: [profile],
      users: [user('a@vinceretrading.com', profile.id), user('b@vinceretrading.com', profile.id)],
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].to.map((entry) => entry.email)).toEqual([
      'a@vinceretrading.com', 'b@vinceretrading.com',
    ]);
  });

  it('ignores a user with no CAM profile, which is what a manager account is', () => {
    const profile = (STATE.camProfiles || []).find((entry) => (entry.clientIds || []).length);
    const { deliveries } = planDailyEmails({
      clients: STATE.clients,
      camProfiles: [profile],
      users: [user('manager@vinceretrading.com', null), user('cam@vinceretrading.com', profile.id)],
    });
    expect(deliveries[0].to.map((entry) => entry.email)).toEqual(['cam@vinceretrading.com']);
  });

  it('does not email a disabled login', () => {
    const profile = (STATE.camProfiles || []).find((entry) => (entry.clientIds || []).length);
    const { deliveries, unreachable } = planDailyEmails({
      clients: STATE.clients,
      camProfiles: [profile],
      users: [user('gone@vinceretrading.com', profile.id, { status: 'Inactive' })],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable).toHaveLength(1);
  });

  it('does not email an inactive CAM profile at all', () => {
    const profile = (STATE.camProfiles || []).find((entry) => (entry.clientIds || []).length);
    const { deliveries, unreachable } = planDailyEmails({
      clients: STATE.clients,
      camProfiles: [{ ...profile, status: 'Inactive' }],
      users: [user('cam@vinceretrading.com', profile.id)],
    });
    expect(deliveries).toHaveLength(0);
    expect(unreachable).toHaveLength(0);
  });
});

describe('the run', () => {
  const profiles = () => (STATE.camProfiles || []).filter((entry) => (entry.clientIds || []).length);
  const usersFor = (list) => list.map((profile) => user(`${profile.id}@vinceretrading.com`, profile.id));

  it('builds one message per CAM that had a close', () => {
    const list = profiles();
    const run = buildDailyEmailRun({
      clients: STATE.clients,
      camProfiles: list,
      users: usersFor(list),
      date: '2026-07-23',
      generatedAt: '2026-07-23T21:00:00Z',
    });
    expect(run.messages.length).toBeGreaterThan(0);
    for (const message of run.messages) {
      expect(message.subject).toContain('Daily reports · 2026-07-23');
      expect(message.attachments.length).toBeGreaterThan(0);
      expect(message.built.length).toBeGreaterThan(0);
    }
    expect(run.failed).toHaveLength(0);
  });

  it('sends nothing to a CAM whose whole book was quiet', () => {
    // A daily "nothing happened" is how a daily email gets muted.
    const list = profiles();
    const run = buildDailyEmailRun({
      clients: STATE.clients, camProfiles: list, users: usersFor(list), date: '1999-01-01',
    });
    expect(run.messages).toHaveLength(0);
  });

  it('names the CAM when one package cannot be built and still sends the rest', () => {
    const list = profiles().slice(0, 3);
    const broken = { ...list[0], clientIds: ['no-such-client'] };
    const run = buildDailyEmailRun({
      clients: STATE.clients,
      camProfiles: [broken, ...list.slice(1)],
      users: usersFor([broken, ...list.slice(1)]),
      date: '2026-07-23',
    });
    // The broken one contributes no message; the others are unaffected.
    expect(run.messages.every((message) => message.camProfileId !== broken.id)).toBe(true);
    expect(run.messages.length).toBe(2);
  });
});
