// What a CAM ends up holding after pressing Download, which is the whole point
// of the change this file pins.
//
// The export is split into parts because ONE RESPONSE cannot carry more than
// 4 MiB (server/export/clientExport.js). That constraint is real and is not
// being relaxed here; what is being fixed is that it used to reach the desk as
// four files to reassemble by hand. So the properties worth pinning are:
//
//   1. ONE FILE. Several parts, one download.
//   2. A pull that was never split is NOT wrapped in an archive it does not need.
//   3. Every part is IN there, under a name that says which part it is.
//   4. A run that did not finish cannot come back looking like one that did.
//      This is the same rule the payload itself follows — a truncated export
//      that does not say it was truncated is worse than an error — and it is
//      the one a zip makes easy to get wrong, because the fragment is now a
//      single tidy file instead of an obviously short folder.
//   5. The archive discloses nothing the parts inside it did not already.
//
// Synthetic throughout, so CI runs all of it.

import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  buildClientExportPackage,
  clientExportManifest,
  clientExportPackageName,
  exportPartFileName,
} from './clientExportPackage';

function payload({ index = null, of = null, clients = ['Wren Larch', 'Ash Vale'], rows = 120 } = {}) {
  return {
    version: 2,
    exportedAt: '2026-07-31T12:00:00.000Z',
    range: { from: '2026-07-01', to: '2026-07-30', days: 30 },
    scope: {
      batch: index ? { index, of } : null,
      includedClients: clients.map((name, i) => ({ id: `id-${i}`, name })),
      includedClientCount: clients.length,
      requestedClientCount: clients.length,
    },
    totalRows: rows,
    rowCounts: { daily_imports: 12 },
    truncated: false,
    truncation: [],
    tables: { clients: clients.map((name) => ({ name })) },
  };
}

function entriesOf(file) {
  const unzipped = unzipSync(file.body);
  return Object.fromEntries(Object.entries(unzipped).map(([name, bytes]) => [name, strFromU8(bytes)]));
}

describe('a pull that fits in one response', () => {
  it('downloads as the plain JSON it always did', () => {
    const file = buildClientExportPackage({ payloads: [payload()], expectedParts: 1 });
    expect(file.type).toBe('application/json');
    expect(file.fileName).toBe('cam-crm-export-2-clients-2026-07-01_2026-07-30.json');
    expect(JSON.parse(file.body).version).toBe(2);
  });

  it('names a single-client pull after the client, not after a count', () => {
    const file = buildClientExportPackage({ payloads: [payload({ clients: ['Wren Larch'] })], expectedParts: 1 });
    expect(file.fileName).toBe('cam-crm-export-wren-larch-2026-07-01_2026-07-30.json');
  });

  it('is not wrapped in an archive, because there is no split to undo', () => {
    const file = buildClientExportPackage({ payloads: [payload()], expectedParts: 1 });
    expect(file.fileName.endsWith('.zip')).toBe(false);
  });

  it('writes nothing at all when not one part arrived', () => {
    expect(buildClientExportPackage({ payloads: [], expectedParts: 3 })).toBeNull();
  });
});

describe('a pull that had to be split', () => {
  const payloads = [
    payload({ index: 1, of: 3 }),
    payload({ index: 2, of: 3, clients: ['Bram Holt', 'Cove Ellis'] }),
    payload({ index: 3, of: 3, clients: ['Dell Ryne'] }),
  ];

  it('arrives as ONE zip rather than three downloads', () => {
    const file = buildClientExportPackage({ payloads, expectedParts: 3 });
    expect(file.type).toBe('application/zip');
    expect(file.fileName).toBe('cam-crm-export-5-clients-2026-07-01_2026-07-30.zip');
  });

  it('carries every part, under a name that says which part it is', () => {
    const entries = entriesOf(buildClientExportPackage({ payloads, expectedParts: 3 }));
    expect(Object.keys(entries).sort()).toEqual([
      'cam-crm-export-2-clients-2026-07-01_2026-07-30-part1of3.json',
      'cam-crm-export-2-clients-2026-07-01_2026-07-30-part2of3.json',
      // A part carrying one client is named after that client, exactly as a
      // one-part export of them would have been.
      'cam-crm-export-dell-ryne-2026-07-01_2026-07-30-part3of3.json',
      'manifest.json',
    ]);
  });

  it('hands back each part byte-for-byte, not a payload it invented by merging them', () => {
    // The archive holds the envelopes the server measured and audited. A single
    // stitched-together `tables` would be a payload nothing upstream ever saw.
    const entries = entriesOf(buildClientExportPackage({ payloads, expectedParts: 3 }));
    const part2 = JSON.parse(entries['cam-crm-export-2-clients-2026-07-01_2026-07-30-part2of3.json']);
    expect(part2).toEqual(payloads[1]);
  });

  it('is smaller than the parts it replaces, which is why one file is affordable', () => {
    const file = buildClientExportPackage({ payloads, expectedParts: 3 });
    const raw = payloads.reduce((sum, entry) => sum + JSON.stringify(entry, null, 2).length, 0);
    expect(file.body.length).toBeLessThan(raw);
  });

  it('still tells parts apart when the server echoed no batch back', () => {
    // Two parts sharing a name would leave a zip holding two files for three
    // parts, which is the silent truncation the whole export refuses.
    const anonymous = [payload(), payload(), payload()];
    const entries = entriesOf(buildClientExportPackage({ payloads: anonymous, expectedParts: 3 }));
    expect(Object.keys(entries).filter((name) => name !== 'manifest.json')).toHaveLength(3);
  });
});

describe('a run that stopped partway', () => {
  const partial = [payload({ index: 1, of: 5 }), payload({ index: 2, of: 5 })];

  it('shouts INCOMPLETE in the filename, with the count', () => {
    const file = buildClientExportPackage({ payloads: partial, expectedParts: 5 });
    expect(file.fileName).toBe('cam-crm-export-4-clients-2026-07-01_2026-07-30-INCOMPLETE-2of5.zip');
    expect(file.complete).toBe(false);
  });

  it('says it again inside, where the filename cannot be renamed away', () => {
    const entries = entriesOf(buildClientExportPackage({ payloads: partial, expectedParts: 5 }));
    const manifest = JSON.parse(entries['manifest.json']);
    expect(manifest.complete).toBe(false);
    expect(manifest.parts).toEqual({ received: 2, expected: 5 });
    expect(manifest.note).toMatch(/INCOMPLETE/);
    expect(manifest.note).toMatch(/must not be read as absent data/);
  });

  it('does NOT hand a lone surviving part over as an ordinary single-part export', () => {
    // The dangerous case: five parts planned, one arrived. Writing it as a bare
    // .json would make a fifth of the range indistinguishable from all of it.
    const file = buildClientExportPackage({ payloads: [payload({ index: 1, of: 5 })], expectedParts: 5 });
    expect(file.type).toBe('application/zip');
    expect(file.fileName).toMatch(/INCOMPLETE-1of5\.zip$/);
  });

  it('keeps the parts that did arrive rather than discarding a paid-for read', () => {
    const entries = entriesOf(buildClientExportPackage({ payloads: partial, expectedParts: 5 }));
    expect(Object.keys(entries)).toHaveLength(3);
  });
});

describe('what the manifest is allowed to know', () => {
  // This package leaves the CRM. Anything in it that is not already in the
  // parts beside it is a disclosure decision, so the manifest is pinned to
  // fields COPIED from those parts and nothing else.
  const payloads = [payload({ index: 1, of: 2 }), payload({ index: 2, of: 2 })];

  it('carries only what the payloads beside it already carry', () => {
    const manifest = clientExportManifest({ payloads, expectedParts: 2 });
    expect(Object.keys(manifest).sort()).toEqual([
      'complete', 'exportedAt', 'files', 'note', 'parts', 'range',
    ]);
    for (const entry of manifest.files) {
      expect(Object.keys(entry).sort()).toEqual([
        'includedClientCount', 'name', 'part', 'totalRows', 'truncated',
      ]);
    }
  });

  it('holds no client roster of its own', () => {
    const manifest = clientExportManifest({ payloads, expectedParts: 2 });
    expect(JSON.stringify(manifest)).not.toContain('Wren Larch');
  });

  it('reports a truncated part, because a short table is not a quiet month', () => {
    const short = { ...payload({ index: 2, of: 2 }), truncated: true };
    const manifest = clientExportManifest({ payloads: [payloads[0], short], expectedParts: 2 });
    expect(manifest.files.map((entry) => entry.truncated)).toEqual([false, true]);
  });
});

describe('naming, on its own', () => {
  it('falls back to a usable name when a client name slugs to nothing', () => {
    expect(exportPartFileName(payload({ clients: ['!!!'] })))
      .toBe('cam-crm-export-client-2026-07-01_2026-07-30.json');
  });

  it('counts clients across the parts, not inside one of them', () => {
    const name = clientExportPackageName({
      payloads: [payload({ index: 1, of: 2 }), payload({ index: 2, of: 2, clients: ['Solo'] })],
      expectedParts: 2,
    });
    expect(name).toBe('cam-crm-export-3-clients-2026-07-01_2026-07-30.zip');
  });
});
