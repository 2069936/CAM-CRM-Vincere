import { useCallback, useMemo, useState } from 'react';
import { buildBenchmarkSeries, parseBenchmarkCsv } from '../domain/algorithmBenchmark';
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
 * THE CAM SCOPE IS PARTIAL AND IS LABELLED. A CAM is handed their own clients
 * for coverage, money and the account changes, and the DESK's clients for the
 * roster, the results, the movement and the stack — because a ranking computed
 * over one CAM's eight clients under the same column header would be a
 * different measurement wearing the same label, and on this book almost every
 * row of it would fall under the evidence gate and print a refusal. Two CAMs
 * comparing their own copies would reach opposite conclusions about the same
 * algorithm. One pooled measurement, labelled as pooled, is the honest answer.
 */
export default function DeskPeriodReportView({
  clients = [],
  scopedClients = null,
  scope = 'desk',
  camName = '',
  camProfileId = null,
  benchmarkSeries = [],
  builtBy = '',
}) {
  const book = scopedClients || clients;
  const [selection, setSelection] = useState({ kind: 'week', key: '', from: '', to: '' });
  const [benchmarkRisk, setBenchmarkRisk] = useState('Low');
  const [copied, setCopied] = useState(false);
  // The benchmark files, read in the browser and held for this visit only.
  //
  // NOT loaded from `algorithm_benchmarks`: that table stores MONTHLY
  // aggregates, and this report's benchmark block states days with a trade
  // inside a week and draws a day-by-day curve, neither of which a month can
  // answer. Reading the CSVs here is the same parse the Data Tools import runs,
  // through the same function, so the two cannot disagree about a file.
  const [imported, setImported] = useState({ series: [], accepted: 0, rejected: [] });

  const onImportBenchmark = useCallback(async (files) => {
    const list = [...(files || [])];
    if (!list.length) return;
    const parsed = await Promise.all(list.map(async (file) => (
      parseBenchmarkCsv(await file.text(), file.name)
    )));
    const accepted = parsed.filter((file) => file.ok);
    setImported({
      series: buildBenchmarkSeries(accepted),
      accepted: accepted.length,
      // A refused file is named with the reason it was refused. A file silently
      // dropped is a figure silently missing from every row below.
      rejected: parsed.filter((file) => !file.ok)
        .map((file) => ({ fileName: file.fileName, reason: file.reason })),
    });
  }, []);

  const periods = useMemo(
    () => listPeriods(book, selection.kind),
    [book, selection.kind],
  );

  const period = useMemo(
    () => resolvePeriod(book, {
      kind: selection.kind,
      // With nothing chosen for this kind yet, take the newest period the book
      // holds a close in rather than a key from another kind.
      key: selection.key || periods[0]?.key || '',
      from: selection.from || periods[0]?.from || '',
      to: selection.to || periods[0]?.to || '',
    }),
    [book, selection, periods],
  );

  const series = imported.series.length ? imported.series : benchmarkSeries;

  const report = useMemo(
    () => buildDeskPeriodReport(book, {
      period,
      scope: {
        kind: scope,
        camName,
        camProfileId,
        deskClientCount: clients.length,
      },
      benchmarkSeries: series,
      benchmarkRisk,
      builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      builtBy,
    }),
    [book, clients.length, period, scope, camName, camProfileId, series, benchmarkRisk, builtBy],
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
