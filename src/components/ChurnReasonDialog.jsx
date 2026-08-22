import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CHURN_REASONS } from '../domain/clientLifecycle';

/**
 * Asks why, at the moment a CAM marks a client Inactive.
 *
 * The desk manager's instruction: "When a CAM marks a client Inactive, the CRM
 * should capture why, as a short list of options rather than free text, so the
 * reasons can be counted later. Free text that nobody can aggregate is how this
 * question gets asked again in three months. A free-text note MAY accompany the
 * option; the option is what must be structured."
 *
 * So: a required option, an optional note, and no way past this dialog that
 * files the client as Inactive without one. Cancel does not write the stage
 * either — the classification and its reason are one decision and they are one
 * write. AT CLASSIFICATION is the load-bearing half of that sentence: asked
 * later, this is a survey nobody fills in, and the panel that counts the answers
 * has nothing to count.
 *
 * There is no "skip". A skip button is the free-text problem wearing a different
 * hat: it produces exactly the unexplained churn rows the panel exists to stop
 * accumulating, and it produces them at the one moment somebody knows the
 * answer. The rows that already carry no reason are a different thing — they are
 * history, they stay absent, and the panel reports them as "Not recorded".
 */
export default function ChurnReasonDialog({ clientName = '', open = false, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  function close() {
    setReason('');
    setNote('');
    onCancel?.();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="confirm-dialog churn-reason-dialog">
        <DialogHeader>
          <DialogTitle>Why is {clientName || 'this client'} going inactive?</DialogTitle>
          <DialogDescription>
            Recorded with the stage change so the desk can count churn reasons later.
            Cancel leaves the stage where it is.
          </DialogDescription>
        </DialogHeader>

        <div className="churn-reason-options">
          {CHURN_REASONS.map((option) => (
            <label key={option.code} className="churn-reason-option">
              <input
                type="radio"
                name="churn-reason"
                value={option.code}
                checked={reason === option.code}
                onChange={() => setReason(option.code)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>

        <label className="churn-reason-note">
          Note (optional)
          <textarea
            rows={2}
            value={note}
            placeholder="Anything the option does not cover"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <DialogFooter className="confirm-dialog-footer">
          <button className="ghost-button" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            data-action="confirm-churn-reason"
            disabled={!reason}
            onClick={() => {
              onConfirm?.({ reason, note: note.trim() });
              setReason('');
              setNote('');
            }}
          >
            Mark inactive
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
