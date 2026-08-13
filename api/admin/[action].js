import clientExport from '../../server/export/clientExport.js';
import batches from '../../server/autoCollection/admin/ingest-batches.js';
import download from '../../server/autoCollection/admin/ingest-download.js';
import enrollment from '../../server/autoCollection/admin/ingest-enrollment.js';
import fleet from '../../server/autoCollection/admin/ingest-fleet.js';
import reprocess from '../../server/autoCollection/admin/ingest-reprocess.js';
import status from '../../server/autoCollection/admin/ingest-status.js';
import verify from '../../server/autoCollection/admin/ingest-verify.js';

// Static routes (users, data-export and intake-sheet) keep precedence. This
// dispatcher preserves each existing ingest-* URL in one Vercel function.
//
// client-export rides here for the same reason rather than becoming
// api/admin/client-export.js: Vercel Hobby caps the project at 12 serverless
// functions and api/ holds 5 files today, so a new file would be 6 of 12 while
// this costs nothing. The map key is free-form — nothing here requires the
// ingest-* prefix.
const handlers = Object.freeze({
  'client-export': clientExport,
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
