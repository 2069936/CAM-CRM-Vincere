import { buildDailyEmailPackage } from './dailyEmailPackage';

/* ---------------------------------------------------------------------------
 * Who gets an email, and which clients are in it.
 *
 * THE BOOK IS SPLIT ONE WAY IN THIS APP AND THIS FOLLOWS IT. A client does not
 * name its CAM; the CAM profile carries `clientIds` (supabaseStore.js builds it
 * from client_assignments), so that is what is read here rather than a second
 * derivation that could drift from the sidebar the CAM looks at all day.
 *
 * THE ADDRESS IS NOT ON THE CAM PROFILE. cam_profiles has an `email` column and
 * on production it is empty on all 8 rows; the addresses live on `app_users`,
 * which is what Users & Access shows and what every one of the 10 accounts has
 * filled in. Reading the profile would have sent nothing and reported success.
 *
 * NOBODY IS EMAILED TWICE AND NOBODY IS EMAILED BY ACCIDENT. Two users can
 * point at one CAM profile, and a manager account has no profile at all. A
 * profile with no reachable user is reported rather than skipped, because a CAM
 * who silently stops receiving their close is worse than a job that fails.
 * ------------------------------------------------------------------------- */

const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * @param camProfiles  from buildCrmStateFromTables: { id, name, status, clientIds }.
 * @param users        app_users rows shaped { email, name, camProfileId, status }.
 * @param clients      the whole book.
 * @returns {{ deliveries: Array, unreachable: Array }}
 */
export function planDailyEmails({ clients = [], camProfiles = [], users = [] }) {
  const clientById = new Map();
  for (const client of clients) if (client?.id) clientById.set(String(client.id), client);

  const usersByProfile = new Map();
  for (const user of users) {
    if (!user?.email || !user?.camProfileId) continue;
    if (lower(user.status) === 'inactive' || lower(user.status) === 'disabled') continue;
    const key = String(user.camProfileId);
    if (!usersByProfile.has(key)) usersByProfile.set(key, []);
    usersByProfile.get(key).push(user);
  }

  const deliveries = [];
  const unreachable = [];

  for (const profile of camProfiles) {
    if (lower(profile?.status) === 'inactive') continue;
    const book = (profile?.clientIds || [])
      .map((id) => clientById.get(String(id)))
      .filter(Boolean);
    if (!book.length) continue;

    const recipients = usersByProfile.get(String(profile.id)) || [];
    if (!recipients.length) {
      unreachable.push({ camProfileId: profile.id, camName: profile.name || '', clients: book.length });
      continue;
    }

    /* One message to all of a profile's addresses rather than one each: two
     * users on one profile are one person with two logins far more often than
     * they are two people, and two copies of the same close is how a daily
     * email starts being filtered away. */
    deliveries.push({
      camProfileId: profile.id,
      camName: profile.name || '',
      to: recipients.map((user) => ({ email: user.email, name: user.name || profile.name || '' })),
      clients: book,
    });
  }

  return { deliveries, unreachable };
}

/**
 * The plan with each delivery's message already built.
 *
 * Kept apart from planDailyEmails so the split of the book can be asserted
 * without building 62 reports, and so a failure to build one CAM's package
 * names that CAM instead of ending the run.
 */
export function buildDailyEmailRun({ clients, camProfiles, users, date, generatedAt = null }) {
  const { deliveries, unreachable } = planDailyEmails({ clients, camProfiles, users });
  const messages = [];
  const failed = [];

  for (const delivery of deliveries) {
    try {
      const built = buildDailyEmailPackage({
        clients: delivery.clients,
        date,
        generatedAt,
        camName: delivery.camName,
      });
      // A CAM whose whole book was quiet gets no email. There is nothing to
      // read and a daily "nothing happened" is how a daily email is muted.
      if (!built.built.length) continue;
      messages.push({ ...delivery, ...built });
    } catch (error) {
      failed.push({ camName: delivery.camName, reason: error?.message || 'could not be built' });
    }
  }

  return { messages, unreachable, failed };
}
