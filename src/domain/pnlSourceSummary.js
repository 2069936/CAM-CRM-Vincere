const PNL_SOURCES = ['realized', 'gross_fallback', 'gross_missing_realized', 'unavailable'];

export function summarizePnlSources(rows = []) {
  const summary = {
    realized: 0,
    gross_fallback: 0,
    gross_missing_realized: 0,
    unavailable: 0,
    unknown: 0,
  };
  for (const row of rows || []) {
    const source = PNL_SOURCES.includes(row?.pnlSource) ? row.pnlSource : 'unknown';
    summary[source] += 1;
  }
  return summary;
}
