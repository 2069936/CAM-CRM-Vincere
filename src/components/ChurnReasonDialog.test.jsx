// @vitest-environment jsdom
//
// The half of "record a reason" that is not a column: the moment it is asked.
//
// The desk manager's instruction has three parts and this file is about the
// third. A short list rather than free text is pinned in clientLifecycle.test.js
// (CHURN_REASONS). A column that never fabricates one is pinned in
// supabase/step_39_client_churn_reason.test.js. What is left is AT
// CLASSIFICATION — that the question is asked at the one moment somebody knows
// the answer, and that there is no way past it.
//
// That is a UI guarantee and nothing else can hold it. A dialog with a Skip
// button, or a confirm that fires with nothing chosen, satisfies every domain
// test in the tree and still produces exactly the unexplained rows the panel
// exists to stop accumulating. So: a real render, real clicks, and the
// no-way-past assertion stated by name.
//
// Synthetic throughout — there is no book in a dialog — so CI runs all of it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChurnReasonDialog from './ChurnReasonDialog';
import { CHURN_REASONS, CHURN_REASON_UNRECORDED } from '../domain/clientLifecycle';

afterEach(cleanup);

const open = (props = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = render(
    <ChurnReasonDialog
      clientName="Rosalind Vance"
      open
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onCancel, ...result };
};

const confirmButton = () => screen.getByRole('button', { name: 'Mark inactive' });
const pick = (code) => fireEvent.click(screen.getByRole('radio', { name: label(code) }));
const label = (code) => CHURN_REASONS.find((reason) => reason.code === code).label;

describe('the dialog that has to be answered', () => {
  it('asks about the client by name, and only when it is open', () => {
    const { rerender } = open();
    expect(screen.getByText(/Rosalind Vance/)).toBeTruthy();
    rerender(<ChurnReasonDialog clientName="Rosalind Vance" open={false} />);
    expect(screen.queryByRole('button', { name: 'Mark inactive' })).toBeNull();
  });

  it('offers every reason on the list and nothing else', () => {
    open();
    const offered = screen.getAllByRole('radio').map((input) => input.value);
    expect(offered).toEqual(CHURN_REASONS.map((reason) => reason.code));
    // The unrecorded bucket is observed, never chosen. Offering it here would
    // hand a CAM a way to file "I decline to say" — the reason-less row wearing
    // a badge, which is the state the panel is meant to watch fall.
    expect(offered).not.toContain(CHURN_REASON_UNRECORDED);
  });

  it('cannot be got past without one', () => {
    // THE assertion of this file. Not "the button is disabled" as a styling
    // detail — this is the only thing standing between the desk and a churn
    // count nobody can explain, and it is the one moment the answer is known.
    const { onConfirm } = open();
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    pick('cost');
    expect(confirmButton().disabled).toBe(false);
  });

  it('offers no skip: every way out but one writes nothing', () => {
    // A Skip button is the free-text problem in a different hat — it produces
    // the unexplained row at the exact moment somebody could have prevented it.
    // There are three controls and only ONE of them can classify a client. The
    // dismiss X is a second Cancel, not a third answer, and it is checked here
    // rather than assumed because it is the control a hurried CAM reaches for.
    const { onCancel, onConfirm } = open();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent.trim());
    expect(buttons).toEqual(['Cancel', 'Mark inactive', 'Close']);
    for (const text of buttons) {
      expect(text.toLowerCase()).not.toContain('skip');
      expect(text.toLowerCase()).not.toContain('later');
    }

    pick('cost');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('hands back the code and the note together', () => {
    const { onConfirm } = open();
    pick('unresponsive');
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  Stopped replying after the June drawdown.  ' },
    });
    fireEvent.click(confirmButton());
    // The code, not the label: the wording can be rewritten later without
    // rewriting the rows that were stored under it.
    expect(onConfirm).toHaveBeenCalledWith({
      reason: 'unresponsive',
      note: 'Stopped replying after the June drawdown.',
    });
  });

  it('lets the note be left empty, because the option is the structured half', () => {
    const { onConfirm } = open();
    pick('personal');
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'personal', note: '' });
  });

  it('writes nothing at all when the CAM changes their mind', () => {
    // Cancel is not "file them Inactive without a reason" — the classification
    // and the reason are one decision, so cancelling leaves the stage alone too.
    // The select goes on reading the stored stage because nothing was written.
    const { onCancel, onConfirm } = open();
    pick('cost');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not carry one client\'s answer over to the next', () => {
    // The dialog is mounted once per client card and reopened, so its state
    // outlives a cancel. A reason left selected from an abandoned classification
    // would be filed against a different client with one click — a wrong reason,
    // which is worse than none, because it counts.
    const { onCancel, onConfirm, rerender } = open();
    pick('cost');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Too expensive.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();

    rerender(
      <ChurnReasonDialog
        clientName="Someone Else"
        open
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getAllByRole('radio').every((input) => !input.checked)).toBe(true);
    expect(screen.getByRole('textbox').value).toBe('');
    expect(confirmButton().disabled).toBe(true);
  });
});
