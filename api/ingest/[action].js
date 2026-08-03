import daily from '../../server/autoCollection/ingest/daily.js';
import heartbeat from '../../server/autoCollection/ingest/heartbeat.js';
import pair from '../../server/autoCollection/ingest/pair.js';

// Preserve the existing public routes (/api/ingest/daily, /heartbeat and /pair)
// while deploying one Vercel function instead of three.
export const config = { api: { bodyParser: false } };

const handlers = Object.freeze({ daily, heartbeat, pair });

export function resolveIngestHandler(action) {
  return handlers[action] || null;
}

export default function handler(req, res) {
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const target = resolveIngestHandler(action);
  if (!target) return res.status(404).json({ error: 'not_found' });
  return target(req, res);
}
