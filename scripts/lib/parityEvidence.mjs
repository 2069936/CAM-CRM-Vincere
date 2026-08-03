const SECTION_NAMES = ['accounts', 'strategies', 'orders', 'executions'];
const CHECK_NAMES = [
  'sameMinuteCapture',
  'postResetRealizedGrossVerified',
  'twoStrategyAlgorithmsVerified',
  'currentSessionExecutionsConfirmed',
];
const ENVIRONMENT_NAMES = [
  'windowsVersion',
  'ninjaTraderVersion',
  'connectionProvider',
  'localTimeZone',
];
const COMPARISON_STATUSES = new Set([
  'exact',
  'normalized-match',
  'missing-api',
  'missing-grid',
  'value-mismatch',
]);
const MISSING_API_ACTIONS = new Set([
  'derive-in-crm',
  'preserve-null-optional',
  'version-guarded-reflection',
]);

function requireNonemptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function decisionKey(value) {
  return `${value.section}\u0000${value.field}\u0000${value.status}`;
}

function validateDecision(decision, missing) {
  const label = `${missing.section}.${missing.field} (${missing.status})`;
  requireNonemptyString(decision.rationale, `${label} rationale`);
  const action = requireNonemptyString(decision.action, `${label} production action`);
  if (missing.status === 'missing-grid') {
    if (action !== 'accept-supported-api') {
      throw new Error(`${label} has an invalid production action: ${action}.`);
    }
  } else if (!MISSING_API_ACTIONS.has(action)
    || (decision.required === true && action === 'preserve-null-optional')) {
    throw new Error(`${label} has an invalid production action: ${action}.`);
  }
  return {
    section: missing.section,
    field: missing.field,
    status: missing.status,
    required: decision.required === true,
    action,
    rationale: decision.rationale.trim(),
  };
}

export function buildParityEvidence(report, review, comparisonSha256) {
  if (!report || typeof report !== 'object') throw new Error('comparison report is required.');
  if (!review || typeof review !== 'object') throw new Error('parity review is required.');
  if (typeof comparisonSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(comparisonSha256)) {
    throw new Error('comparisonSha256 must be a SHA-256 hash.');
  }

  const inputTypes = Array.isArray(report.inputTypes) ? report.inputTypes : [];
  if (inputTypes.length !== SECTION_NAMES.length
    || SECTION_NAMES.some((section) => inputTypes.filter((value) => value === section).length !== 1)) {
    throw new Error('The comparison must contain exactly one input for all four sections.');
  }

  const reviewer = requireNonemptyString(review.reviewer, 'reviewer');
  const reviewedAt = requireNonemptyString(review.reviewedAt, 'reviewedAt');
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error('reviewedAt must be an ISO timestamp.');

  const environment = {};
  for (const name of ENVIRONMENT_NAMES) {
    environment[name] = requireNonemptyString(review.environment?.[name], `environment.${name}`);
  }
  const checks = {};
  for (const name of CHECK_NAMES) {
    if (review.checks?.[name] !== true) throw new Error(`checks.${name} must be true.`);
    checks[name] = true;
  }

  const missingFields = [];
  const sections = {};
  for (const sectionName of SECTION_NAMES) {
    const section = report.sections?.[sectionName];
    if (!section || !Number.isInteger(section.apiRowCount) || section.apiRowCount < 1
      || !Number.isInteger(section.gridRowCount) || section.gridRowCount < 1) {
      throw new Error(`${sectionName} must contain API and grid rows.`);
    }
    const statusCounts = {};
    for (const row of section.rows || []) {
      if (row.rowStatus !== 'matched') {
        throw new Error(`${row.rowStatus || 'invalid-row-status'} remains unresolved in ${sectionName}.`);
      }
      for (const field of row.fields || []) {
        if (!COMPARISON_STATUSES.has(field.status)) {
          throw new Error(`Unknown comparison status ${field.status || '(empty)'} in ${sectionName}.`);
        }
        statusCounts[field.status] = (statusCounts[field.status] || 0) + 1;
        if (field.status === 'value-mismatch') {
          throw new Error(`value-mismatch remains unresolved for ${sectionName}.${field.field}.`);
        }
        if (field.status === 'missing-api' || field.status === 'missing-grid') {
          missingFields.push({ section: sectionName, field: field.field, status: field.status });
        }
      }
    }
    sections[sectionName] = {
      passed: true,
      apiRowCount: section.apiRowCount,
      gridRowCount: section.gridRowCount,
      statusCounts,
    };
  }

  const uniqueMissing = [...new Map(missingFields.map((item) => [decisionKey(item), item])).values()];
  const reviewDecisions = Array.isArray(review.decisions) ? review.decisions : [];
  const decisions = uniqueMissing.map((missing) => {
    const matches = reviewDecisions.filter((decision) => decisionKey(decision) === decisionKey(missing));
    if (matches.length !== 1) {
      throw new Error(`${missing.section}.${missing.field} (${missing.status}) requires exactly one decision.`);
    }
    return validateDecision(matches[0], missing);
  });
  if (reviewDecisions.length !== decisions.length) {
    throw new Error('The review contains decisions that do not match unresolved comparison fields.');
  }

  return {
    schemaVersion: 1,
    captureMethod: 'supported-api',
    comparisonSha256: comparisonSha256.toLowerCase(),
    allFourSectionsPassed: true,
    reviewer,
    reviewedAt: new Date(reviewedAt).toISOString(),
    environment,
    checks,
    sections,
    decisions,
  };
}
