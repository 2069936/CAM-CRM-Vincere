// @vitest-environment jsdom
//
// The two buttons the CAM actually presses, and the order they are in.

import { createRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportSheetActions from './ReportSheetActions';

const TITLE = 'Wren Larch - 2026-08-24 daily report';

function mount({ download = vi.fn(async () => ({ fileName: `${TITLE}.pdf` })), print = vi.fn() } = {}) {
  const ref = createRef();
  const sheet = document.createElement('div');
  sheet.className = 'report-sheet';
  sheet.innerHTML = '<h1>Wren Larch</h1>';
  ref.current = sheet;
  const view = render(
    <div className="report-actions no-print">
      <ReportSheetActions title={TITLE} sheetRef={ref} download={download} print={print} />
    </div>,
  );
  return { view, download, print, sheet };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('which action the report offers first', () => {
  it('offers Download, and offers it before Print', () => {
    // THE CHANGE THE CAM ASKED FOR. There used to be one button and it opened
    // the OS print dialog; eleven clients a day meant eleven dialogs and eleven
    // files in whichever folder the dialog last pointed at.
    mount();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent.trim())).toEqual(['Download PDF', 'Print']);
  });

  it('weights them the way the rest of the app weights an action against a fallback', () => {
    mount();
    expect(screen.getByRole('button', { name: /Download PDF/ }).className).toContain('secondary-button');
    expect(screen.getByRole('button', { name: /^Print$/ }).className).toContain('ghost-button');
  });

  it('keeps Print, because it is the only path that survives the function being down', () => {
    // Not sentiment. Download needs the network and the deployment; print needs
    // the tab that is already open, and this desk ships eleven reports at every
    // close. Keeping it also means the `@media print` blocks that shape every
    // client's PDF still have a human exercising them.
    const { print } = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Print$/ }));
    expect(print).toHaveBeenCalledWith(TITLE);
  });
});

describe('downloading', () => {
  it('hands the renderer the live sheet and the name the desk files by', async () => {
    const { download, sheet } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    await waitFor(() => expect(download).toHaveBeenCalledWith({ sheet, title: TITLE }));
  });

  it('says it is working and cannot be pressed twice', async () => {
    // A second click mid-render would start a second chromium for the same
    // report, and the CAM has eleven of these to get through.
    let release;
    const download = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    mount({ download });
    const button = screen.getByRole('button', { name: /Download PDF/ });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: /Building PDF/ }).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Building PDF/ }));
    expect(download).toHaveBeenCalledTimes(1);
    release({ fileName: 'x.pdf' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Download PDF/ }).disabled).toBe(false));
  });

  it('shows the failure on the sheet instead of failing silently', async () => {
    // A download that quietly did nothing would be read as a download that
    // worked, and the client would simply never receive the report.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const download = vi.fn(async () => { throw new Error('Could not build the PDF. Use Print to save this one.'); });
    mount({ download });
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    const alert = await screen.findByRole('status');
    expect(alert.textContent).toMatch(/Use Print to save this one/);
    expect(alert.className).toContain('error');
    // And the button comes back, so the CAM can try again.
    expect(screen.getByRole('button', { name: /Download PDF/ }).disabled).toBe(false);
  });

  it('clears a stale failure when the next attempt starts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const download = vi.fn(async () => {
      if (fail) throw new Error('Could not build the PDF. Use Print to save this one.');
      return { fileName: 'x.pdf' };
    });
    mount({ download });
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    await screen.findByRole('status');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
