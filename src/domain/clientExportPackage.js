import { strToU8, zipSync } from 'fflate';

/* ------------------------------------------------------------------------- *
 * The parts of a CAM-scoped export, as ONE file.
 *
 * WHY THIS EXISTS. /api/admin/client-export cannot return more than 4 MiB in one
 * response — the ceiling is the platform's and the long measurement behind it is
 * in server/export/clientExport.js — so a pull bigger than that is planned into
 * parts by src/domain/clientExportPlan.js and fetched one request at a time. The
 * parts were then written straight to disk as they arrived, which made the whole
 * desk with trade history a four-file download somebody had to reassemble by
 * hand, and "two weeks of every client" a thing nobody did twice.
 *
 * The split is not the problem; the download is. Every part still costs its own
 * request and still respects the ceiling, so nothing about the server changes.
 * They are simply held until the last one lands and handed over as one archive.
 *
 * ZIP AND NOT CONCATENATION, because the parts are not fragments of one document
 * — each is a complete, independently readable envelope with its own range,
 * caveats and truncation report, and stitching their `tables` together here
 * would be this browser inventing a payload the server never measured or
 * audited. Inside the archive they stay exactly the files they would have been.
 *
 * THE CASE THIS WAS BUILT FOR, read off the dialog on the real desk: 16.10 MB,
 * 925 sessions, 10,904 rows, 89 of 145 clients, planned as "4 parts of up to
 * 4 MB" (40/49/49/40 clients). Nothing was refused and nothing failed — all four
 * parts arrived. The complaint was the four files, not the four requests.
 *
 * WHAT IT COSTS, measured on export-shaped JSON at the size the planner targets:
 * four parts totalling 17.8 MiB deflate to 1.02 MiB in 277 ms at level 6. Read
 * that 17.5x as an upper bound and not as a promise — the synthetic rows repeat
 * more than the book's do, and the ratio measured on REAL payloads is the ~9x
 * recorded at GZIP_RATIO in clientExportPlan.js. At 9x the run above is a 1.8 MB
 * download. Either figure puts the archive below any ONE of the parts it
 * replaces, and the wait below a single one of the four requests that produced
 * them. zipSync blocks the main thread for those milliseconds, which is why this
 * does not reach for fflate's worker-backed async path: a quarter of a second
 * does not need one, and a Worker would buy complexity in exchange for nothing
 * measurable.
 *
 * WHAT IT DOES NOT DO, because the number on the button is unchanged and someone
 * will read that as a bug: it does not make a bigger pull possible. A part is
 * still one request, and a request is still bounded by MAX_CLIENTS (60) and
 * MAX_TOTAL_ROWS (25,000) in server/export/clientExport.js. Neither is a byte
 * limit, so neither is touched by compressing anything: the whole desk over a
 * long range is ~50,000 rows and 145 clients and still cannot be read in one
 * request. Those two ceilings hold the function's memory, this project's
 * Supabase quota, and the per-CAM RLS story around them; this file deliberately
 * leaves them alone.
 *
 * A ONE-PART EXPORT IS NOT ZIPPED. It fits in one response, it always arrived as
 * one file, and wrapping it would mean every CAM pulling one client now has an
 * archive to open first. The zip exists to undo a split, so where there is no
 * split there is no zip.
 *
 * AN INCOMPLETE RUN STILL PRODUCES A FILE, AND SAYS SO TWICE. When a part fails
 * the walk stops, and the parts already fetched are real data somebody paid four
 * round trips for. Throwing them away to avoid a misleading file is the wrong
 * trade when the file can simply not be misleading: the archive is named
 * INCOMPLETE, it carries how many parts of how many it holds in that name, and
 * manifest.json inside says it again in full. This is the same rule the payload
 * itself follows — a truncated export that does not say it was truncated is
 * worse than an error.
 * ------------------------------------------------------------------------- */

/** Deflate level. 6 is fflate's default and what server/apiLib/autoExportDownload.js zips at. */
const ZIP_LEVEL = 6;

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stampFor(payload) {
  const from = payload?.range?.from || '';
  const to = payload?.range?.to || '';
  return from && to ? `${from}_${to}` : 'unknown-range';
}

/**
 * How one part is named — the name it carries inside the archive, and the name
 * it carries on its own when the export was never split.
 *
 * The part number is in the FILENAME as well as in the envelope, because a
 * folder of alike-named files is the one place `scope.batch` cannot be read
 * without opening them. That is still true inside a zip, where a reader sees the
 * listing long before they see any JSON.
 */
export function exportPartFileName(payload) {
  const count = payload?.scope?.includedClientCount ?? 0;
  const label = count === 1
    ? (slug(payload?.scope?.includedClients?.[0]?.name) || 'client')
    : `${count}-clients`;
  const batch = payload?.scope?.batch;
  const part = batch && batch.index && batch.of ? `-part${batch.index}of${batch.of}` : '';
  return `cam-crm-export-${label}-${stampFor(payload)}${part}.json`;
}

/**
 * What the archive is called.
 *
 * The client count is summed across the parts rather than taken from one of
 * them, because the split is BY client: no single part knows how many the export
 * covers, and naming the archive after part one would understate it.
 */
export function clientExportPackageName({ payloads = [], expectedParts = payloads.length } = {}) {
  const clients = payloads.reduce((sum, payload) => sum + (payload?.scope?.includedClientCount || 0), 0);
  const stamp = stampFor(payloads[0]);
  const base = `cam-crm-export-${clients}-client${clients === 1 ? '' : 's'}-${stamp}`;
  // Shouted, and in the filename rather than only inside it: this is the one
  // property of the download that must survive being read at a glance in a
  // Downloads folder six weeks later.
  return payloads.length < expectedParts
    ? `${base}-INCOMPLETE-${payloads.length}of${expectedParts}.zip`
    : `${base}.zip`;
}

/**
 * The index of the archive, built ONLY from fields the parts beside it already
 * carry.
 *
 * This package leaves the CRM, so what goes in it is a disclosure decision and
 * not a convenience one. Nothing here is read from the CRM's state: every value
 * is copied out of a payload that is already in the same archive, which means
 * the manifest can tell a reader what they have without telling them anything
 * they could not have learnt by opening the files.
 *
 * It earns its place on the incomplete run. The dialog can say "3 of 5 parts"
 * while it is open; the folder cannot, and the folder is what gets opened later.
 */
export function clientExportManifest({ payloads = [], expectedParts = payloads.length } = {}) {
  const complete = payloads.length >= expectedParts && payloads.length > 0;
  return {
    complete,
    parts: { received: payloads.length, expected: expectedParts },
    range: payloads[0]?.range
      ? { from: payloads[0].range.from ?? null, to: payloads[0].range.to ?? null }
      : null,
    exportedAt: payloads[0]?.exportedAt ?? null,
    files: payloads.map((payload, index) => ({
      name: exportPartFileName(payload),
      part: payload?.scope?.batch
        ? { index: payload.scope.batch.index, of: payload.scope.batch.of }
        : { index: index + 1, of: expectedParts },
      includedClientCount: payload?.scope?.includedClientCount ?? null,
      totalRows: payload?.totalRows ?? null,
      truncated: Boolean(payload?.truncated),
    })),
    note: complete
      ? 'Every part of this export is in this archive. Each file is a complete envelope; read them together.'
      : `INCOMPLETE. ${payloads.length} of ${expectedParts} parts are here. Rows belonging to the missing parts are NOT in this archive and must not be read as absent data.`,
  };
}

/**
 * What to save for a finished (or abandoned) export run.
 *
 * Returns null when there is nothing to save, so a caller that caught a failure
 * before the first part landed writes no file at all.
 *
 * @param payloads      the envelopes that actually arrived, in part order.
 * @param expectedParts how many the dialog planned. A run that planned one part
 *                      and got it is a plain .json; anything else is an archive,
 *                      INCLUDING a five-part run that only managed one — that
 *                      single file is not a complete export and must not be
 *                      handed over looking like one.
 */
export function buildClientExportPackage({ payloads = [], expectedParts = payloads.length } = {}) {
  if (!payloads.length) return null;

  const complete = payloads.length >= expectedParts;
  if (expectedParts <= 1 && complete) {
    const payload = payloads[0];
    return {
      fileName: exportPartFileName(payload),
      body: JSON.stringify(payload, null, 2),
      type: 'application/json',
      complete: true,
      entryNames: [],
    };
  }

  const entries = {};
  const entryNames = [];
  const seen = new Set();
  for (const [index, payload] of payloads.entries()) {
    let name = exportPartFileName(payload);
    // The server echoes `batch` back, so two parts share a name only if it came
    // back missing. Disambiguated rather than dropped: a zip silently holding
    // four files for five parts is the failure this whole module is about.
    if (seen.has(name)) name = name.replace(/\.json$/, `-${index + 1}.json`);
    seen.add(name);
    entryNames.push(name);
    entries[name] = strToU8(JSON.stringify(payload, null, 2));
  }
  const manifest = clientExportManifest({ payloads, expectedParts });
  entries['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

  return {
    fileName: clientExportPackageName({ payloads, expectedParts }),
    body: zipSync(entries, { level: ZIP_LEVEL }),
    type: 'application/zip',
    complete,
    entryNames,
  };
}
