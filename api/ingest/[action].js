import accounts from '../../server/autoCollection/ingest/accounts.js';
import agentUpdate from '../../server/autoCollection/ingest/agentUpdate.js';
import daily from '../../server/autoCollection/ingest/daily.js';
import heartbeat from '../../server/autoCollection/ingest/heartbeat.js';
import pair from '../../server/autoCollection/ingest/pair.js';
import quarantine from '../../server/autoCollection/ingest/quarantine.js';
import reportEmail from '../../server/autoCollection/ingest/reportEmail.js';
import strategies from '../../server/autoCollection/ingest/strategies.js';

// Preserve the existing public routes (/api/ingest/accounts, /daily, /heartbeat,
// /pair and /quarantine) while deploying one Vercel function instead of five.
//
// /accounts is a key here and not a file of its own for the reason api/admin
// states: Vercel's Hobby plan caps the project at 12 serverless functions and
// api/ holds 6 of them. A tracker that cost a seventh for nothing would be a bad
// trade.
//
// /strategies is the per strategy reading for the live algorithm comparison
// (step 57). Its own key and not a field on /accounts, because /accounts answers
// 400 to a key it does not know and a new agent would lose its account rows.
//
// /report-email joined them and is the odd one: every route above authenticates
// the agent against `ingest_devices`, and that one deliberately reads no table
// at all. It exists for the day Postgres is down and Vercel is not, which is
// the day the others cannot answer.
//
// /agent-update is where agent 1.3.0 and later asks whether a Manager wants it
// updated and reports how the update is going (step 70). Its own key for the
// reason /strategies has one: the heartbeat answers 400 to a key it does not
// know.
export const config = { api: { bodyParser: false } };

const handlers = Object.freeze({
  accounts,
  'agent-update': agentUpdate,
  daily,
  heartbeat,
  pair,
  quarantine,
  'report-email': reportEmail,
  strategies,
});

export function resolveIngestHandler(action) {
  return handlers[action] || null;
}

export default function handler(req, res) {
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const target = resolveIngestHandler(action);
  if (!target) return res.status(404).json({ error: 'not_found' });
  return target(req, res);
}
