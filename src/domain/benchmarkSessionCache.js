/**
 * The My Futures Book series the period report is looking at, for this browser
 * session rather than for one mount of one component.
 *
 * WHY THIS IS NOT COMPONENT STATE. It was, and the cost was that a manager who
 * dragged 36 CSVs into the sheet lost every one of them the moment they clicked
 * Auto Collection and came back. The benchmark is the part of the report the
 * desk asked for by name; as shipped it was a re-upload chore on every visit.
 *
 * TWO SOURCES, AND THE ORDER BETWEEN THEM IS FIXED. Files read in this visit win
 * over the saved import, because somebody who has just dropped a file in means
 * to look at it. The saved import is `algorithm_benchmarks`, read once per
 * session: step 44 stores each month's own days precisely so the report can use
 * it, because the two questions this report asks a benchmark — which days inside
 * THIS WEEK did it trade, and what does the curve do day by day — are questions
 * a monthly aggregate cannot answer.
 *
 * A saved import that fails to load is reported as a failure, never as "no
 * benchmark has been imported": those are different claims and only one of them
 * sends somebody back to the vendor's website.
 *
 * This module holds no React and no DOM, so a test can reset it between cases.
 */

import { benchmarkSeriesFromStoredRows } from './algorithmBenchmark';
import { loadAlgorithmBenchmarks } from './supabaseStore';

/** A stable empty array, so a memo keyed on "no series" does not churn. */
export const NO_SERIES = [];

const EMPTY_IMPORT = {
  series: NO_SERIES, accepted: 0, rejected: [], files: [], parsedAt: null,
};

let sessionImport = EMPTY_IMPORT;
let savedImport = null;
let savedImportPromise = null;

export function readSessionImport() {
  return sessionImport;
}

export function setSessionImport(next) {
  sessionImport = next;
  return sessionImport;
}

export function readSavedImportNow() {
  return savedImport;
}

/**
 * The saved import, read at most once per session and shared by every mount.
 *
 * Resolves rather than rejects: the caller renders the failure on the sheet.
 */
export function readSavedBenchmarks() {
  if (savedImport) return Promise.resolve(savedImport);
  if (!savedImportPromise) {
    savedImportPromise = (async () => {
      try {
        const rows = await loadAlgorithmBenchmarks();
        const series = benchmarkSeriesFromStoredRows(rows);
        savedImport = {
          series,
          rows: rows.length,
          // The newest `imported_at` across the rows: when the desk last pulled
          // these files, which is not when this page read them.
          importedAt: series.reduce(
            (latest, entry) => (
              entry.importedAt && entry.importedAt > latest ? entry.importedAt : latest
            ),
            '',
          ) || null,
          error: null,
        };
      } catch (error) {
        savedImport = {
          series: NO_SERIES,
          rows: 0,
          importedAt: null,
          error: error?.message || String(error),
        };
      }
      return savedImport;
    })();
  }
  return savedImportPromise;
}

/** Clears both caches, so one test's import cannot reach the next. */
export function resetBenchmarkSessionCache() {
  sessionImport = EMPTY_IMPORT;
  savedImport = null;
  savedImportPromise = null;
}
