/* WHY A CLOSE WAS REJECTED, IN ONE LINE A MANAGER CAN READ.
 *
 * normalizeAutoImportSnapshot refuses a snapshot with an
 * AutoImportValidationError whose `errors` array says exactly which rule each
 * row broke. Until step 69 that array reached nobody: the ingest route stored
 * only the code, invalid_auto_import_snapshot, and on 2026-10-08, 09, 13 and
 * 14 thirteen closes were refused with nothing anyone could read about why.
 *
 * This turns the array into the text stored on the batch (step 69,
 * ingest_batches.error_detail) and shown under the code in the failed closes
 * panel. Pure, so the route, the replay and the tests all agree on it.
 *
 * WHAT A MESSAGE CAN CARRY, read from autoExportContract.js and autoImport.js:
 * a field path (`accounts[3].netLiquidation`), fixed rule text, and in one
 * rule an account name (`... does not reference an account (APEX 1)`). No
 * message carries a value: not a balance, not a price, not free text. Two
 * pieces are the client's own text, and both are kept only in a shape that
 * cannot be anything else:
 *
 *   * the account name, which is already in the CRM. Kept, cut to 64
 *     characters.
 *   * a strategy parameter's NAME, the last segment of
 *     `strategies[i].parameters.<name>`. A path, so kept when it looks like
 *     one (an identifier), and replaced by <parameter> when it does not.
 *
 * Anything else is matched against the rule shapes the validator writes today
 * and, when it matches none, stored as "unrecognized rule" after its path (a
 * path of the snapshot's own keys, up to 160 characters, or no path). A
 * message added to the validator tomorrow that quotes a value therefore
 * arrives here withheld rather than stored; the test beside this file runs
 * the real validator over a broken snapshot and fails if one of its messages
 * falls through. */

// The two codes the validator refuses a snapshot with, and the only two step
// 69 writes a reason for.
export const VALIDATION_REASON_CODES = Object.freeze(['invalid_auto_import_snapshot', 'unsupported_schema_version']);
export const REASON_RULE_LIMIT = 12;
// The cap step 69 stores. The summary is built inside it, so the database
// never has to cut the "(+N more)" tail off.
export const REASON_MAX_CHARS = 2000;
const ACCOUNT_NAME_MAX = 64;
// A path the summary does not recognize the rule of is kept up to this long.
const PATH_MAX = 160;

// `[3]`, `[0, 1, 2]` and `[0, 1, 2] and 5 more`: the row, not the rule.
const ROW_INDEXES = /\[\d+(?:, \d+)*\](?: and \d+ more)?/g;
const SEGMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\[\*\])?`;
const PATH = String.raw`${SEGMENT}(?:\.${SEGMENT})*`;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// The keys a path can start with: the snapshot's own. A leading word that is
// not one of them is not a path, it is the start of a sentence.
const ROOTS = new Set([
  'snapshot', 'schemaVersion', 'captureId', 'capturedAt', 'tradingDate', 'timeZone', 'source',
  'accounts', 'strategies', 'orders', 'executions',
]);
const isFieldPath = (path) => ROOTS.has(path.split(/[.[]/)[0]);

// Every rule text the validator writes after a path, and nothing else.
const RULE_TAILS = new Set([
  'is required',
  'must be 1',
  'must be an object',
  'must be an array',
  'must be an ISO date',
  'must be America/New_York',
  'must be an ISO-8601 timestamp with an offset',
  'must be an ISO-8601 timestamp with an offset or null',
  'must be a string or null',
  'must be a number or null',
  'must be a boolean or null',
  'must be a boolean or null when present',
  'must be a scalar or null',
  'must match capturedAt in America/New_York',
]);

const PARAMETER_RULE = new RegExp(String.raw`^(${PATH}\.parameters)\.(.+) must be a scalar or null$`);
const REFERENCE_RULE = new RegExp(String.raw`^(${PATH}\.accountName) does not reference an account \((.*)\)$`);
const DUPLICATE_RULE = new RegExp(String.raw`^(${PATH}) duplicates (${PATH})$`);
const PATH_RULE = new RegExp(String.raw`^(${PATH}) (.+)$`);
const LEADING_PATH = new RegExp(String.raw`^(${PATH})(?=\s|$)`);

// Control characters (C0, DEL, C1) to spaces, then every run of space to one.
function oneLine(value) {
  let text = '';
  for (const char of String(value ?? '')) {
    const code = char.codePointAt(0);
    text += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function accountName(name) {
  const text = name.trim();
  if (!text) return 'blank';
  return text.length > ACCOUNT_NAME_MAX ? `${text.slice(0, ACCOUNT_NAME_MAX)}…` : text;
}

/** One message, as the rule it states: rows collapsed, nothing but a path, an account name and fixed text. */
export function validationRule(message) {
  const text = oneLine(message).replace(ROW_INDEXES, '[*]');
  if (!text) return '';
  if (text === 'snapshot must be an object') return text;

  const parameter = PARAMETER_RULE.exec(text);
  if (parameter && isFieldPath(parameter[1])) {
    const name = IDENTIFIER.test(parameter[2]) ? parameter[2] : '<parameter>';
    return `${parameter[1]}.${name} must be a scalar or null`;
  }
  const reference = REFERENCE_RULE.exec(text);
  if (reference && isFieldPath(reference[1])) return `${reference[1]} does not reference an account (${accountName(reference[2])})`;
  const duplicate = DUPLICATE_RULE.exec(text);
  if (duplicate && isFieldPath(duplicate[1]) && isFieldPath(duplicate[2])) return `${duplicate[1]} duplicates ${duplicate[2]}`;
  const rule = PATH_RULE.exec(text);
  if (rule && isFieldPath(rule[1]) && RULE_TAILS.has(rule[2])) return `${rule[1]} ${rule[2]}`;

  const path = LEADING_PATH.exec(text);
  const kept = path && isFieldPath(path[1]) && path[1].length <= PATH_MAX;
  return kept ? `${path[1]} unrecognized rule` : 'unrecognized rule';
}

// Rules joined, and the count of the ones left out.
function render(shown, hidden) {
  const tail = hidden ? `(+${hidden} more)` : '';
  return [shown.join('; '), tail].filter(Boolean).join(' ');
}

/**
 * The errors array of an AutoImportValidationError as one short text:
 * the unique rules in the order they were first broken, the first twelve,
 * joined with "; ", and "(+N more)" when there were more.
 *
 * @param {unknown} errors
 * @returns {string} '' when there is nothing to say.
 */
export function validationReasonSummary(errors) {
  if (!Array.isArray(errors)) return '';
  const rules = [...new Set(errors.map(validationRule).filter(Boolean))];
  const shown = [];
  for (const rule of rules) {
    if (shown.length === REASON_RULE_LIMIT) break;
    if (render([...shown, rule], rules.length - shown.length - 1).length > REASON_MAX_CHARS) break;
    shown.push(rule);
  }
  return render(shown, rules.length - shown.length);
}
