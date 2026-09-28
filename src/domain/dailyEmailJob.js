import { buildCrmStateFromTables } from './supabaseStore';
import { buildDailyEmailRun } from './dailyEmailPlan';

/* ---------------------------------------------------------------------------
 * The whole run, with the network at the edges.
 *
 * Everything between reading rows and handing a built message to a sender is
 * here, so the only thing that cannot be asserted under vitest is the two lines
 * that fetch and the one that posts. The Edge Function that calls this is
 * deliberately too small to hold a bug.
 *
 * ONE FAILURE MUST NOT COST THE OTHERS. A provider that refuses one CAM's
 * message must not stop the rest, and it must not be reported as success. Every
 * send is attempted, every outcome is returned, and the caller decides what a
 * partial run means.
 * ------------------------------------------------------------------------- */

/* TWO TABLES NAME THE SAME CAM TWO DIFFERENT WAYS.
 *
 * app_users.cam_profile_id holds the row's UUID. buildCrmStateFromTables
 * exposes the profile with `id` set to its legacy_key - 'peter', not
 * 'p-3f9c...' - because that is the key the rest of the app has always used.
 * Matched on either one alone this joins nothing, every CAM comes out
 * unreachable, and the run reports a clean success having sent no mail. The
 * same shape of mistake as reading the address off cam_profiles, which is
 * empty on all 8 production rows.
 *
 * So the translation happens here, from the cam_profiles rows themselves,
 * where both identities are side by side and neither has to be guessed.
 */
export function usersFromRows(rows = [], camProfileRows = []) {
  const legacyByUuid = new Map();
  for (const profile of camProfileRows) {
    if (profile?.id) legacyByUuid.set(String(profile.id), profile.legacy_key || profile.id);
  }
  return rows
    .map((row) => {
      const raw = row.cam_profile_id ? String(row.cam_profile_id) : '';
      return {
        email: row.email || '',
        name: row.display_name || row.username || '',
        // The legacy key when we can resolve it, the raw value when we cannot:
        // a profile row that is missing is a different problem from a user
        // pointing at a profile that never existed, and this keeps them apart.
        camProfileId: raw ? (legacyByUuid.get(raw) || raw) : null,
        status: row.status || 'Active',
      };
    })
    .filter((user) => user.email && user.camProfileId);
}

/**
 * @param tables       the rows for the date, shaped as buildCrmStateFromTables wants.
 * @param userRows     app_users rows.
 * @param date         'YYYY-MM-DD'.
 * @param send         ({ to, subject, text, attachments }) => Promise. Injected.
 * @param generatedAt  ISO stamp, passed in so a run is reproducible.
 */
export async function runDailyEmails({ tables, userRows = [], date, send, generatedAt = null }) {
  const state = buildCrmStateFromTables(tables || {});
  const run = buildDailyEmailRun({
    clients: state.clients || [],
    camProfiles: state.camProfiles || [],
    users: usersFromRows(userRows, (tables || {}).cam_profiles || []),
    date,
    generatedAt,
  });

  const sent = [];
  const refused = [];

  for (const message of run.messages) {
    try {
      const result = await send({
        to: message.to,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments,
      });
      sent.push({
        camName: message.camName,
        to: message.to.map((entry) => entry.email),
        clients: message.built.length,
        messageId: result?.messageId || null,
      });
    } catch (error) {
      /* Named, not swallowed. An unverified sender and an exhausted daily quota
       * are different problems that arrive the same way, and a CAM who stops
       * receiving their close must not have to notice it themselves. */
      refused.push({
        camName: message.camName,
        to: message.to.map((entry) => entry.email),
        reason: error?.message || 'the provider refused the message',
      });
    }
  }

  return {
    date,
    sent,
    refused,
    unreachable: run.unreachable,
    notBuilt: run.failed,
    // A run that sent nothing is not a run that succeeded quietly.
    ok: refused.length === 0 && run.failed.length === 0,
  };
}
