import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { handleApiError, requireMethod, sendJson } from '../_lib/http.js';

/* global process */

const GOOGLE_SHEET_CSV_URL = process.env.GOOGLE_SHEET_CSV_URL || '';

export function createHandler({
  createClients = createApiClients,
  fetchImpl = fetch,
  sheetUrl = GOOGLE_SHEET_CSV_URL,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);

      const { admin, auth } = createClients();
      await requireAppUser(req, { admin, authClient: auth, roles: ['Manager'] });

      if (!sheetUrl) {
        return sendJson(res, 501, {
          error: 'GOOGLE_SHEET_CSV_URL is not configured.',
          nextStep: 'Set GOOGLE_SHEET_CSV_URL to a published Google Sheet CSV export URL.',
        });
      }

      const response = await fetchImpl(sheetUrl);
      if (!response.ok) throw new Error(`Google Sheet fetch failed: ${response.status}`);

      return sendJson(res, 200, {
        source: 'google_sheet_csv',
        csv: await response.text(),
      });
    } catch (error) {
      return handleApiError(res, error, { fallbackMessage: 'Intake sheet fetch failed.' });
    }
  }
}

export default createHandler();
