import daily from '../../server/autoCollection/ingest/daily.js';
import heartbeat from '../../server/autoCollection/ingest/heartbeat.js';
import pair from '../../server/autoCollection/ingest/pair.js';
import quarantine from '../../server/autoCollection/ingest/quarantine.js';
import reportEmail from '../../server/autoCollection/ingest/reportEmail.js';

// Preserve the existing public routes (/api/ingest/daily, /heartbeat, /pair and
// /quarantine) while deploying one Vercel function instead of four.
//
// /report-email joined them and is the odd one: every route above authenticates
// the agent against `ingest_devices`, and that one deliberately reads no table
// at all. It exists for the day Postgres is down and Vercel is not, which is
// the day the others cannot answer.
export const config = { api: { bodyParser: false } };

const handlers = Object.freeze({ daily, heartbeat, pair, quarantine, 'report-email': reportEmail });

export function resolveIngestHandler(action) {
  return handlers[action] || null;
}

export default function handler(req, res) {
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const target = resolveIngestHandler(action);
  if (!target) return res.status(404).json({ error: 'not_found' });
  return target(req, res);
}
