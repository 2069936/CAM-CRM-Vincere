// @vitest-environment jsdom
//
// Whose words reach the PDF.
//
// ReportNoteSection.test.jsx asserts WHAT prints, on static markup. This asserts
// WHOSE, which needs a real render and a prop change, because the failure is
// client-side state: a paragraph written about one client showing on another
// client's report is the kind of mistake that gets sent before anyone notices.
//
// This is the first interactive test in the repo. Every other component test is
// renderToStaticMarkup, which cannot see a state transition at all, so this file
// opts into jsdom on its own line rather than changing the default and slowing
// the other 1,850 down.
//
// ReportNoteSection.jsx:93 resets during render, keyed on
// `${clientId}:${dailyImportId}:${reportType}`. Both halves are pinned below: a
// key on the client alone bleeds across days, a key on the close alone bleeds
// across clients, and both look perfectly reasonable until the wrong text is in
// somebody's inbox.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ReportNoteSection from './ReportNoteSection';

afterEach(cleanup);

const noteFor = (text) => ({
  text, authorName: 'Pedro', updatedAt: '2026-08-11T21:00:00.000Z', clearedAt: '',
});

/** Answers per (client, close), the way the real store does. */
function storeWith(byKey) {
  return {
    load: async ({ clientId, dailyImportId }) => ({
      note: byKey[`${clientId}:${dailyImportId}`] || null,
      reportId: 'r1',
      rows: 1,
    }),
    save: async () => ({}),
  };
}

const box = () => screen.getByRole('textbox');

describe('the note follows the client and the close, not the screen', () => {
  const store = storeWith({
    'clientA:day1': noteFor('Written about client A on day one.'),
    'clientB:day1': noteFor('Written about client B on day one.'),
    'clientA:day2': noteFor('Written about client A on day two.'),
  });

  it('swaps the text when the client changes on the same day', async () => {
    const { rerender } = render(
      <ReportNoteSection clientId="clientA" dailyImportId="day1" store={store} />,
    );
    await waitFor(() => expect(box().value).toContain('client A on day one'));

    rerender(<ReportNoteSection clientId="clientB" dailyImportId="day1" store={store} />);
    // Synchronously after the prop change, before the new load resolves. The
    // previous client's paragraph must already be gone: the reset is in render
    // for exactly this, and an effect would leave it on screen for a frame.
    expect(box().value).toBe('');
    await waitFor(() => expect(box().value).toContain('client B on day one'));
  });

  it('swaps the text when the close changes for the same client', async () => {
    const { rerender } = render(
      <ReportNoteSection clientId="clientA" dailyImportId="day1" store={store} />,
    );
    await waitFor(() => expect(box().value).toContain('client A on day one'));

    rerender(<ReportNoteSection clientId="clientA" dailyImportId="day2" store={store} />);
    expect(box().value).toBe('');
    await waitFor(() => expect(box().value).toContain('client A on day two'));
  });

  it('shows an empty box for a close nobody has written on', async () => {
    const { rerender } = render(
      <ReportNoteSection clientId="clientA" dailyImportId="day1" store={store} />,
    );
    await waitFor(() => expect(box().value).toContain('client A on day one'));

    // day3 is absent from the store. "Nothing written here" must never render as
    // whatever happened to be on screen a moment ago.
    rerender(<ReportNoteSection clientId="clientA" dailyImportId="day3" store={store} />);
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('does not let a slow load overwrite what is already being typed', async () => {
    // The other half of the same problem. A round trip that lands after the CAM
    // has started typing would eat the sentence, so ReportNoteSection guards it
    // with touchedRef (ReportNoteSection.jsx:112).
    //
    // THE ASSERTION HAS TO WAIT FOR THE LOAD TO LAND. A first draft of this test
    // asserted the typed text right after release(), which passes before the
    // promise callback has even run, so it went on passing with the guard
    // deleted. Waiting for "Loading note…" to disappear is what proves the
    // overwrite had its chance and did not take it.
    let release;
    const slow = {
      load: () => new Promise((resolve) => {
        release = () => resolve({ note: noteFor('from the server'), reportId: 'r1', rows: 1 });
      }),
      save: async () => ({}),
    };
    render(<ReportNoteSection clientId="clientA" dailyImportId="day1" store={slow} />);
    expect(screen.getByText('Loading note…')).toBeTruthy();

    fireEvent.change(box(), { target: { value: 'typed while it was still loading' } });
    release();

    await waitFor(() => expect(screen.queryByText('Loading note…')).toBeNull());
    expect(box().value).toBe('typed while it was still loading');
  });
});
