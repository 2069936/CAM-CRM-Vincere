import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildBenchmarkSeries, parseBenchmarkCsv } from '../domain/algorithmBenchmark';
import {
  NO_SERIES,
  readSavedBenchmarks,
  readSavedImportNow,
  readSessionImport,
  setSessionImport,
} from '../domain/benchmarkSessionCache';
import { listPeriods, resolvePeriod } from '../domain/deskPeriod';
import { buildDeskPeriodReport, formatDeskPeriodReport } from '../domain/deskPeriodReport';
import DeskPeriodReportSheet from './DeskPeriodReportSheet';

/**
 * The period report's one piece of state: which period is on screen.
 *
 * Everything else is derived. This wrapper exists so both shells — the
 * manager's sidebar destination and the CAM's — add one element each instead of
 * carrying a period selector, a memo and a clipboard handler apiece, which is
 * how two surfaces end up disagreeing about what "this week" means.
 *
 * THE DEFAULT PERIOD IS THE BOOK'S, NEVER THE WALL CLOCK'S. It is the ISO week
 * containing the book's latest close. On 2026-08-20 over a book whose newest
 * close is 2026-07-30, a wall-clock "this week" is an empty period, and an
 * empty period prints zeros that read as a flat desk. `deskMoney.monthFor` and
 * the ranking anchor both carry the same note for the same reason.
 *
 * THE PERIOD IS RESOLVED OVER THE DESK'S BOOK, NOT THE READER'S. A week is a
 * week: two CAMs opening "Week of 2026-07-27" must be looking at the same seven
 * days, and the roster, the results, the stack and the benchmark below are
 * measured over the desk's clients whoever is reading. Coverage is then the
 * reader's own closes inside those bounds, which is what `buildCoverage`
 * computes and what the header prints.
 *
 * THE CAM SCOPE IS PARTIAL AND IS LABELLED. A CAM is handed their own clients
 * for coverage, money and the account changes, and the DESK's clients — through
 * `deskClients` — for the roster, the results, the movement and the stack,
 * because a ranking computed over one CAM's eight clients under the same column
 * header would be a different measurement wearing the same label, and on this
 * book almost every row of it would fall under the evidence gate and print a
 * refusal. Two CAMs comparing their own copies would reach opposite conclusions
 * about the same algorithm. One pooled measurement, labelled as pooled, is the
 * honest answer. `buildDeskPeriodReport` checks that it was actually handed the
 * desk list before it prints the desk-wide sentence.
 */

/**
 * WHY `benchmarkSeries` DEFAULTS TO A SHARED CONSTANT.
 *
 * `benchmarkSeries = []` as a default PARAMETER allocates a new array on every
 * render, and neither call site passes the prop, so `series` changed identity
 * every render and the `report` memo below rebuilt the whole report each time:
 * three `buildStrategyRanking` passes, two `buildComboPerformance` passes and a
 * `buildDeskMoneyForRange` per close, around 60 ms on the real book. Clicking
 * "Copy summary" cost two full rebuilds on its own, because `copied` flips
 * twice. The files themselves live in `benchmarkSessionCache.js`, outside this
 * component, so navigating away and back does not lose a 36-file import.
 */
export default function DeskPeriodReportView({
  clients = [],
  scopedClients = null,
  scope = 'desk',
  camName = '',
  camProfileId = null,
  benchmarkSeries = NO_SERIES,
  // The stored per-close money, as indexCloseSummaries returns it. deskMoney
  // reads it for the closes a session did not load row by row, and this report
  // is a deskMoney reader like the manager's tiles: without it the two printed
  // different figures under identical labels over the same month.
  summaries = null,
  builtBy = '',
}) {
  const book = scopedClients || clients;
  const [selection, setSelection] = useState({ kind: 'week', key: '', from: '', to: '' });
  const [benchmarkRisk, setBenchmarkRisk] = useState('Low');
  const [copied, setCopied] = useState(false);
  const [imported, setImported] = useState(readSessionImport);
  const [saved, setSaved] = useState(readSavedImportNow);

  // The saved import, read once per session and shared by every mount of this
  // view. Step 44 stores each month's own days precisely so this can feed the
  // report: without them the table held monthly aggregates the report could not
  // use, the section was empty on every open, and the manager re-imported the
  // files each visit.
  useEffect(() => {
    let alive = true;
    readSavedBenchmarks().then((result) => { if (alive) setSaved(result); });
    return () => { alive = false; };
  }, []);

  const onImportBenchmark = useCallback(async (files) => {
    const list = [...(files || [])];
    if (!list.length) return;
    const parsed = await Promise.all(list.map(async (file) => (
      parseBenchmarkCsv(await file.text(), file.name)
    )));
    const accepted = parsed.filter((file) => file.ok);
    setImported(setSessionImport({
      series: buildBenchmarkSeries(accepted),
      accepted: accepted.length,
      files: accepted.map((file) => file.fileName),
      parsedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      // A refused file is named with the reason it was refused. A file silently
      // dropped is a figure silently missing from every row below.
      rejected: parsed.filter((file) => !file.ok)
        .map((file) => ({ fileName: file.fileName, reason: file.reason })),
    }));
  }, []);

  const periods = useMemo(
    () => listPeriods(clients, selection.kind),
    [clients, selection.kind],
  );

  const period = useMemo(
    () => resolvePeriod(clients, {
      kind: selection.kind,
      // With nothing chosen for this kind yet, take the newest period the book
      // holds a close in rather than a key from another kind.
      key: selection.key || periods[0]?.key || '',
      from: selection.from || periods[0]?.from || '',
      to: selection.to || periods[0]?.to || '',
    }),
    [clients, selection, periods],
  );

  // Files read in this visit win over the saved import, which wins over
  // anything a caller passed. Memoised so the identity is stable across
  // renders: it is a dependency of the report below.
  const series = useMemo(() => {
    if (imported.series.length) return imported.series;
    if (saved?.series?.length) return saved.series;
    return benchmarkSeries;
  }, [imported.series, saved, benchmarkSeries]);

  const benchmarkSource = useMemo(() => ({
    fromFiles: imported.series.length > 0,
    accepted: imported.accepted,
    files: imported.files,
    parsedAt: imported.parsedAt,
    rejected: imported.rejected,
    savedRows: saved?.rows || 0,
    savedSeries: saved?.series?.length || 0,
    savedImportedAt: saved?.importedAt || null,
    savedError: saved?.error || null,
    loading: saved === null,
  }), [imported, saved]);

  const report = useMemo(
    () => buildDeskPeriodReport(book, {
      period,
      // The desk's clients, for the sections the page prints as desk wide.
      deskClients: clients,
      scope: {
        kind: scope,
        camName,
        camProfileId,
        deskClientCount: clients.length,
      },
      benchmarkSeries: series,
      benchmarkRisk,
      summaries,
      builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      builtBy,
    }),
    [book, clients, period, scope, camName, camProfileId, series, benchmarkRisk, summaries, builtBy],
  );

  return (
    <DeskPeriodReportSheet
      report={report}
      periods={periods}
      kind={selection.kind}
      onPeriodChange={(next) => setSelection({
        kind: next.kind,
        key: next.key || '',
        from: next.from || '',
        to: next.to || '',
      })}
      benchmarkRisk={benchmarkRisk}
      onBenchmarkRiskChange={setBenchmarkRisk}
      onImportBenchmark={onImportBenchmark}
      benchmarkImport={imported}
      benchmarkSource={benchmarkSource}
      onCopySummary={() => {
        navigator.clipboard.writeText(formatDeskPeriodReport(report)).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      copied={copied}
    />
  );
}
