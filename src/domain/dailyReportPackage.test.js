import { describe, it, expect } from 'vitest';
import {
  buildDailyReportPackage,
  clientsWithCloseOn,
  describePackage,
  packageFileName,
} from './dailyReportPackage';

const DATE = '2026-09-01';

const book = () => [
  { id: 'a', name: 'Joel Onafowokan', dailyImports: [{ id: 'i1', date: DATE }] },
  { id: 'b', name: 'Todd Grehl', dailyImports: [{ id: 'i2', date: DATE }] },
  { id: 'c', name: 'Diana Dolan', dailyImports: [{ id: 'i3', date: '2026-08-31' }] },
];

const ok = () => ({
  renderSheet: async () => '<div class="report-sheet">x</div>',
  renderPdf: async () => new Uint8Array([1, 2, 3]),
});

describe('who is in the package', () => {
  it('takes the clients with a close on that date and nobody else', () => {
    expect(clientsWithCloseOn(book(), DATE).map((entry) => entry.client.name))
      .toEqual(['Joel Onafowokan', 'Todd Grehl']);
  });

  it('is empty without a date rather than guessing at today', () => {
    expect(clientsWithCloseOn(book(), '')).toEqual([]);
    expect(clientsWithCloseOn(book(), null)).toEqual([]);
  });

  it('survives a book with nothing in it', () => {
    expect(clientsWithCloseOn(null, DATE)).toEqual([]);
    expect(clientsWithCloseOn([{ id: 'a', name: 'No imports' }], DATE)).toEqual([]);
  });
});

describe('building the package', () => {
  it('names each file exactly as the single download would', async () => {
    // A file pulled out of this zip has to be the one a CAM would have
    // downloaded by hand, or the desk ends up with two naming schemes.
    const result = await buildDailyReportPackage({ clients: book(), date: DATE, ...ok() });
    expect(result.files.map((file) => file.name)).toEqual([
      'Joel Onafowokan - 2026-09-01 daily report.pdf',
      'Todd Grehl - 2026-09-01 daily report.pdf',
    ]);
  });

  it('keeps the nine when two fail, and names the two', async () => {
    // THE CASE THAT MATTERS. The PDF is built by a function that cold starts and
    // launches Chromium, so on a real book the interesting outcome is partial.
    // A CAM with nine PDFs and two names can send nine messages tonight.
    const result = await buildDailyReportPackage({
      clients: book(),
      date: DATE,
      renderSheet: async () => '<div/>',
      renderPdf: async ({ title }) => {
        if (title.startsWith('Todd')) throw Object.assign(new Error('nope'), { code: 'unavailable' });
        return new Uint8Array([1]);
      },
    });

    expect(result.files).toHaveLength(1);
    expect(result.failed).toEqual([{ clientName: 'Todd Grehl', reason: 'unavailable' }]);
  });

  it('counts a client that could not produce a sheet as failed, not as built', async () => {
    const result = await buildDailyReportPackage({
      clients: book(),
      date: DATE,
      renderSheet: async ({ client }) => (client.name === 'Todd Grehl' ? null : '<div/>'),
      renderPdf: async () => new Uint8Array([1]),
    });
    expect(result.files).toHaveLength(1);
    expect(result.failed[0]).toEqual({ clientName: 'Todd Grehl', reason: 'no_report' });
  });

  it('refuses an empty PDF instead of writing a zero byte file into the zip', async () => {
    // A file named "<Client> - <date> daily report.pdf" that opens to nothing is
    // worse than a missing one: it gets sent.
    const result = await buildDailyReportPackage({
      clients: book(),
      date: DATE,
      renderSheet: async () => '<div/>',
      renderPdf: async () => null,
    });
    expect(result.files).toHaveLength(0);
    expect(result.failed.map((entry) => entry.reason)).toEqual(['empty_pdf', 'empty_pdf']);
  });

  it('counts the clients with no close apart from the ones that refused', async () => {
    const result = await buildDailyReportPackage({ clients: book(), date: DATE, ...ok() });
    expect(result).toMatchObject({ total: 2, skipped: 1, failed: [] });
  });

  it('renders one at a time, because eleven Chromium launches is how a working endpoint starts timing out', async () => {
    let inFlight = 0;
    let peak = 0;
    await buildDailyReportPackage({
      clients: book(),
      date: DATE,
      renderSheet: async () => '<div/>',
      renderPdf: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return new Uint8Array([1]);
      },
    });
    expect(peak).toBe(1);
  });

  it('reports progress so a run of eleven is not a frozen button', async () => {
    const seen = [];
    await buildDailyReportPackage({
      clients: book(),
      date: DATE,
      ...ok(),
      onProgress: (event) => seen.push(event),
    });
    expect(seen).toEqual([
      { done: 1, total: 2, clientName: 'Joel Onafowokan' },
      { done: 2, total: 2, clientName: 'Todd Grehl' },
    ]);
  });

  it('stops on an abort and rethrows, because a cancelled batch is not a result', async () => {
    const controller = new AbortController();
    const attempted = [];
    await expect(buildDailyReportPackage({
      clients: book(),
      date: DATE,
      signal: controller.signal,
      renderSheet: async ({ client }) => {
        attempted.push(client.name);
        controller.abort();
        return '<div/>';
      },
      renderPdf: async () => new Uint8Array([1]),
    })).rejects.toBeDefined();
    expect(attempted).toEqual(['Joel Onafowokan']);
  });
});

describe('what the CAM is told', () => {
  it('names the clients that failed rather than counting them', () => {
    // "9 of 11" sends someone hunting for the two.
    expect(describePackage({
      files: [{}, {}],
      failed: [{ clientName: 'Todd Grehl' }, { clientName: 'Diana Dolan' }],
    })).toBe('2 reports. Could not build: Todd Grehl, Diana Dolan.');
  });

  it('mentions the clients with no close only when there are some', () => {
    expect(describePackage({ files: [{}], skipped: 0 })).toBe('1 report.');
    expect(describePackage({ files: [{}, {}], skipped: 1 }))
      .toBe('2 reports. 1 client had no close today.');
  });

  it('dates the zip, because these land in a Downloads folder', () => {
    expect(packageFileName(DATE)).toBe('Vincere daily reports 2026-09-01.zip');
  });
});
