/* The daily report email, as it runs inside Supabase.
 *
 * DELIBERATELY TOO SMALL TO HOLD A BUG. Everything that decides anything lives
 * in _bundle.js, built from src/domain by scripts/build_daily_email_bundle.mjs
 * and covered by 82 tests that need no network. What is left here is reading
 * the environment, fetching rows, and handing them over. If this file grows a
 * decision, that decision has escaped its tests.
 *
 * WHY HERE AND NOT VERCEL. The PDF path needs a Chromium in a serverless
 * function and a secret in Vercel, and nobody on this desk has that access.
 * The reports are standalone HTML built by plain JavaScript, so they can be
 * built where the data already is: schedule in pg_cron, key in Vault, both
 * reachable from the SQL editor a CAM already uses.
 *
 * Deploy:  supabase functions deploy daily-report-email
 * Schedule: docs/daily-report-email.md has the SQL, and it is the only place
 *           the secrets are named.
 */

// @ts-ignore  Deno resolves this at deploy time; the repo has no Deno types.
import { AgentReportError, buildAgentReportMessage, runDailyEmails, sendViaBrevo } from './_bundle.js';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

/** Columns the run needs. Nothing wider: this reads with a service role. */
const COLUMNS: Record<string, string> = {
  cam_profiles: 'id, legacy_key, name, status, client_order',
  clients: 'id, name, stage, deleted_at',
  client_assignments: 'client_id, cam_profile_id',
  trading_accounts: 'id, client_id, account_name, alias, connection, account_type, status, simulation_mode, target_profit, start_balance, max_drawdown_limit',
  daily_imports: 'id, client_id, trading_date, status',
  account_snapshots: 'id, daily_import_id, trading_account_id, account_name, connection, gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl, unrealized_pnl',
  /* parameters_raw and params_parsed are NOT here. 12,239 rows of them carry a
   * live licence key and the algorithm tuning, the raw export is an allowlist
   * that would drop them anyway, and a column never read is a column that
   * cannot leak. */
  strategy_snapshots: 'id, daily_import_id, trading_account_id, account_snapshot_id, strategy_name, strategy_family, strategy_version, instrument, data_series, direction, enabled, realized, unrealized',
};

/** The desk's trading day. Passed in by the schedule; this is only the default. */
function todayInNewYork(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function rest(url: string, key: string, path: string, query: string): Promise<unknown[]> {
  const response = await fetch(`${url}/rest/v1/${path}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Could not read ${path} (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

/* THE SECOND DOOR: ONE MACHINE'S OWN CLOSE, ON A DAY POSTGRES CANNOT ANSWER.
 *
 * Here rather than on Vercel because the Brevo key has to live somewhere, and
 * the two obvious places are closed: nobody on this desk can add an
 * environment variable to the Vercel deployment, and the repository is public,
 * so a committed ciphertext would be published to the world permanently. A
 * Supabase Edge Function secret is neither - the CAM sets and rotates it
 * himself, it is not a row in Postgres, and it is not in git.
 *
 * It reads no table, which is the entire point: on 2026-09-26 the database was
 * unreachable for three days and the desk could not send a client a report.
 * Edge Functions run apart from the project's Postgres, so this answers when
 * the rest does not. The machine posts the capture it already holds and the
 * report is built here.
 *
 * Its own secret, not the cron's. The cron secret is known only to a scheduled
 * job inside the database; this one is cached on about thirty client machines,
 * and the two must be revocable apart.
 */
async function handleAgentReport(request: Request): Promise<Response> {
  const secret = Deno.env.get('AGENT_MAIL_SECRET') || '';
  const apiKey = Deno.env.get('BREVO_API_KEY') || '';
  const to = Deno.env.get('AGENT_MAIL_TO') || '';
  const from = Deno.env.get('DAILY_EMAIL_FROM') || '';
  /* Refuses rather than accepting anonymously. Reachable from anywhere
   * whatever the agent does, and a relay that sends for whoever asks is a
   * relay that sends for whoever finds it. */
  if (!secret || !apiKey || !to || !from) {
    return json(503, { ok: false, error: 'mail_not_configured' });
  }
  if (request.headers.get('x-agent-mail-secret') !== secret) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, error: 'bad_json' });
  }

  try {
    /* THE DESTINATION IS NOT IN THE REQUEST. A leaked agent secret lets
     * somebody send the desk its own reports; it does not turn this into a
     * way to mail anyone. */
    const message = buildAgentReportMessage({
      capture: body?.capture,
      roster: body?.roster,
      rosterFetchedAt: body?.rosterFetchedAt,
      clientName: String(body?.clientName || '').trim(),
      from,
      to: [{ email: to }],
    });
    const result = await sendViaBrevo({ apiKey, ...message });
    return json(202, { ok: true, date: message.date, messageId: result?.messageId || null });
  } catch (error) {
    if (error instanceof AgentReportError) {
      return json(400, { ok: false, error: error.code, message: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { ok: false, error: 'send_failed', message });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function handler(request: Request): Promise<Response> {
  // Two doors, two credentials. The path decides which.
  if (new URL(request.url).pathname.endsWith('/agent')) return handleAgentReport(request);

  const cronSecret = Deno.env.get('DAILY_EMAIL_CRON_SECRET');
  /* The function is reachable over the internet whatever the schedule does, so
   * it checks a secret of its own rather than trusting that only pg_cron knows
   * the URL. Absent, it refuses: a job that silently accepts anyone is worse
   * than one that does not run. */
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) {
    return new Response('Not authorised.', { status: 401 });
  }

  const url = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const apiKey = Deno.env.get('BREVO_API_KEY') || '';
  const fromEmail = Deno.env.get('DAILY_EMAIL_FROM') || '';
  const fromName = Deno.env.get('DAILY_EMAIL_FROM_NAME') || 'Vincere CRM';
  if (!url || !serviceKey) return new Response('The database is not configured.', { status: 500 });

  const date = new URL(request.url).searchParams.get('date') || todayInNewYork();

  try {
    /* The whole directory, but only ONE DAY of closes. The book is 764 accounts
     * and 16,435 strategy rows across its history; a day is a few thousand. */
    const [camProfiles, clients, assignments, accounts, imports, users] = await Promise.all([
      rest(url, serviceKey, 'cam_profiles', `select=${COLUMNS.cam_profiles}`),
      rest(url, serviceKey, 'clients', `select=${COLUMNS.clients}`),
      rest(url, serviceKey, 'client_assignments', `select=${COLUMNS.client_assignments}`),
      rest(url, serviceKey, 'trading_accounts', `select=${COLUMNS.trading_accounts}`),
      rest(url, serviceKey, 'daily_imports', `select=${COLUMNS.daily_imports}&trading_date=eq.${date}`),
      rest(url, serviceKey, 'app_users', 'select=email, display_name, username, cam_profile_id, status'),
    ]);

    const importIds = (imports as Array<{ id: string }>).map((row) => row.id);
    const inList = `(${importIds.join(',')})`;
    const [snapshots, strategies] = importIds.length
      ? await Promise.all([
        rest(url, serviceKey, 'account_snapshots', `select=${COLUMNS.account_snapshots}&daily_import_id=in.${inList}`),
        rest(url, serviceKey, 'strategy_snapshots', `select=${COLUMNS.strategy_snapshots}&daily_import_id=in.${inList}`),
      ])
      : [[], []];

    const result = await runDailyEmails({
      tables: {
        cam_profiles: camProfiles,
        clients,
        client_assignments: assignments,
        trading_accounts: accounts,
        daily_imports: imports,
        account_snapshots: snapshots,
        strategy_snapshots: strategies,
      },
      userRows: users,
      date,
      generatedAt: new Date().toISOString(),
      send: ({ to, subject, text, attachments }: Record<string, unknown>) => sendViaBrevo({
        apiKey,
        from: { email: fromEmail, name: fromName },
        to, subject, text, attachments,
      }),
    });

    /* The body is the run's own report and it is what a person reads when they
     * ask why a CAM did not get their close. `ok` is false when anything was
     * refused, so the schedule's log shows a failure rather than a 200 with a
     * list of problems inside it. */
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ ok: false, date, error: message }, null, 2), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

Deno.serve(handler);
