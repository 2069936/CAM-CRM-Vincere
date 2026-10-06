// @vitest-environment jsdom
// The day's package builds each client's PDF by mounting ReportPanel into a
// parked host and reading the sheet back. Does the parked report stay off the
// CAM's screen, and does parking it leave the HTML that becomes the PDF alone?
//
// WHY THIS FILE EXISTS. The host was `position: fixed; left: -10000px`, which
// reads as off screen and was not. ReportPanel's root is `.report-overlay`,
// itself `position: fixed; inset: 0`, and a fixed box is placed against the
// viewport unless an ancestor has a transform, a filter or paint containment.
// The host had none, so for every client in the package the full report modal
// painted over the CAM Overview for a frame or two. A recording at 30 fps shows
// it flashing between overview frames.
//
// The two halves pull against each other, which is why they are asserted
// together. Hiding the overlay is easy; hiding it with a style that lands on the
// sheet would put that style into the outerHTML posted to /api/report/pdf, and a
// sheet that is `visibility: hidden` prints as a blank page.

import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportPanel, renderReportSheetHtml } from './App';
import { ACCOUNT_TYPES } from './domain/reconcile';

/* One client, built here so this runs on every clone. No `id` on the client:
 * ReportPanel only writes report history to Supabase when it has one. */
const REGISTRY = {
  EVAL1: {
    accountName: 'EVAL1',
    accountType: ACCOUNT_TYPES.EVALUATION_STANDARD,
    alias: 'Legends - 7045',
    status: 'Active',
    startBalance: 50000,
    targetProfit: 54100,
  },
  FUND1: {
    accountName: 'FUND1',
    accountType: ACCOUNT_TYPES.FUNDED,
    alias: 'TOF - 2928',
    status: 'Active',
    startBalance: 100000,
    targetProfit: 107300,
  },
};

const snapshot = (accountName, accountBalance) => ({
  accountName,
  accountBalance,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  trailingMaxDrawdown: 1850,
  strategies: [],
});

const EARLIER = {
  id: 'imp-1',
  date: '2026-07-01',
  status: 'Closed',
  accounts: REGISTRY,
  snapshots: [snapshot('EVAL1', 50000), snapshot('FUND1', 100000)],
  flags: [],
};
const LATEST = {
  id: 'imp-2',
  date: '2026-07-30',
  status: 'Closed',
  accounts: REGISTRY,
  snapshots: [snapshot('EVAL1', 52050), snapshot('FUND1', 103000)],
  flags: [],
};
const CLIENT = { name: 'Amanda', accountRegistry: REGISTRY, dailyImports: [EARLIER, LATEST] };
// Both charts on, so the inline SVGs are part of what is compared.
const CAM_PROFILE = {
  name: 'Desk',
  reportConfig: { showCumulativeChart: true, showDailyChart: true },
};

/**
 * Would this overlay reach the screen? Either it does not paint at all, or an
 * ancestor captures it the way a transform, a filter or paint containment
 * does, so it stays inside the parked host instead of escaping to the viewport.
 */
function overlayEscapesToScreen(overlay) {
  if (getComputedStyle(overlay).visibility === 'hidden') return false;
  for (let el = overlay.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    const contain = style.contain || el.style.contain || '';
    if (
      (style.transform && style.transform !== 'none') ||
      (style.filter && style.filter !== 'none') ||
      /\b(paint|layout|strict|content)\b/.test(contain)
    ) {
      return false;
    }
  }
  return true;
}

/** Catches the overlay the moment it is mounted, while the host still holds it. */
function watchForOverlay() {
  const seen = [];
  const observer = new MutationObserver(() => {
    for (const overlay of document.querySelectorAll('.report-overlay')) {
      if (seen.some((entry) => entry.overlay === overlay)) continue;
      seen.push({ overlay, escapes: overlayEscapesToScreen(overlay) });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { seen, stop: () => observer.disconnect() };
}

/** The same panel mounted in a plain container: the sheet as nothing parked it. */
async function unparkedSheetHtml() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await new Promise((resolve) => {
      root.render(
        <ReportPanel
          client={CLIENT}
          dailyImport={LATEST}
          camConfig={CAM_PROFILE.reportConfig}
          clientConfig={CLIENT.reportConfig}
          camName={CAM_PROFILE.name}
          onSaveConfig={() => {}}
          onClose={() => {}}
        />,
      );
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return host.querySelector('.report-sheet')?.outerHTML || null;
  } finally {
    root.unmount();
    host.remove();
  }
}

// The sheet prints a "Generated" time, so the clock is held still: two renders
// a second apart must not read as a difference parking made. Only Date is faked,
// so the frames the render waits on still arrive.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-30T21:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('renderReportSheetHtml: the parked report', () => {
  it('never paints over the page while it is parked', async () => {
    const watch = watchForOverlay();
    try {
      await renderReportSheetHtml({ client: CLIENT, dailyImport: LATEST, camProfile: CAM_PROFILE });
    } finally {
      watch.stop();
    }
    // It was mounted, so the check below is about a real overlay and not about
    // a render that produced nothing.
    expect(watch.seen).toHaveLength(1);
    expect(watch.seen[0].escapes).toBe(false);
  });

  it('serialises byte for byte the sheet an unparked mount produces', async () => {
    const parked = await renderReportSheetHtml({ client: CLIENT, dailyImport: LATEST, camProfile: CAM_PROFILE });
    const plain = await unparkedSheetHtml();
    expect(parked).toBeTruthy();
    expect(parked).toContain('<svg');
    expect(parked).toBe(plain);
    expect(parked).not.toMatch(/visibility|-10000px/);
  });

  it('takes its host back out of the document', async () => {
    await renderReportSheetHtml({ client: CLIENT, dailyImport: LATEST, camProfile: CAM_PROFILE });
    expect(document.body.children).toHaveLength(0);
  });

  // `visibility: hidden` is inherited, and a descendant that says `visible`
  // paints anyway. Nothing in the stylesheet does today; this keeps it so.
  it('has no stylesheet rule that would let part of the parked sheet paint through', () => {
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).not.toMatch(/visibility\s*:\s*visible/);
  });
});
