import batches from '../../server/autoCollection/admin/ingest-batches.js';
import download from '../../server/autoCollection/admin/ingest-download.js';
import enrollment from '../../server/autoCollection/admin/ingest-enrollment.js';
import fleet from '../../server/autoCollection/admin/ingest-fleet.js';
import reprocess from '../../server/autoCollection/admin/ingest-reprocess.js';
import status from '../../server/autoCollection/admin/ingest-status.js';
import verify from '../../server/autoCollection/admin/ingest-verify.js';

// Static routes (users, data-export and intake-sheet) keep precedence. This
// dispatcher preserves each existing ingest-* URL in one Vercel function.
const handlers = Object.freeze({
  'ingest-batches': batches,
  'ingest-download': download,
  'ingest-enrollment': enrollment,
  'ingest-fleet': fleet,
  'ingest-reprocess': reprocess,
  'ingest-status': status,
  'ingest-verify': verify,
});

export function resolveAdminHandler(action) {
  return handlers[action] || null;
}

export default function handler(req, res) {
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const target = resolveAdminHandler(action);
  if (!target) return res.status(404).json({ error: 'not_found' });
  return target(req, res);
}
