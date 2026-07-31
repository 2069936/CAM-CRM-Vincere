import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { handleApiError, requireMethod, sendJson } from '../_lib/http.js';

const EXPORT_TABLES = [
  'cam_profiles',
  'app_users',
  'clients',
  'client_assignments',
  'trading_accounts',
  'daily_imports',
  'account_snapshots',
  'strategy_snapshots',
  'orders',
  'executions',
  'operational_flags',
  'tasks',
  'activity_logs',
  'price_checks',
  'payout_events',
  'reports',
  'audit_logs',
  'sop_templates',
  'sop_sections',
  'sop_items',
  'daily_sop_checklists',
];

async function fetchAll(admin, table) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await admin
      .from(table)
      .select('*')
      .range(from, to);
    if (error) {
      if (error.code === 'PGRST205' || /Could not find the table/i.test(error.message || '')) {
        return { rows: [], skipped: true, reason: error.message };
      }
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { rows, skipped: false };
}

async function createAuditLog(admin, userId, action, afterData = {}) {
  const { error } = await admin
    .from('audit_logs')
    .insert({
      user_id: userId,
      entity_type: 'data_export',
      action,
      after_data: afterData,
    });
  if (error) console.error('[CRM] Failed to write export audit log:', error);
}

export function createHandler({ createClients = createApiClients } = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);

      const { admin, auth } = createClients();
      const manager = await requireAppUser(req, { admin, authClient: auth, roles: ['Manager'] });
      const tables = {};
      const skippedTables = [];
      for (const table of EXPORT_TABLES) {
        const result = await fetchAll(admin, table);
        if (result.skipped) {
          skippedTables.push({ table, reason: result.reason });
        } else {
          tables[table] = result.rows;
        }
      }

      await createAuditLog(admin, manager.id, 'data_export.create', {
        tableCount: Object.keys(tables).length,
        tables: Object.keys(tables),
        skippedTables,
      });

      return sendJson(res, 200, {
        exportedAt: new Date().toISOString(),
        source: 'cam-crm-supabase',
        version: 1,
        excludedTables: ['client_credentials', 'client_prop_firms'],
        skippedTables,
        tables,
      });
    } catch (error) {
      return handleApiError(res, error, { fallbackMessage: 'Data export failed.' });
    }
  }
}

export default createHandler();
