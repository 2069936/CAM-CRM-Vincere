import { useState } from "react";
import { changeOwnPassword } from "../lib/supabaseClient";

// Self-service password change for the signed-in user (any role). Self-contained
// state so it can be dropped into any sidebar/profile area without touching the
// parent component's state.
export default function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setPassword("");
    setConfirm("");
    setStatus("");
    setBusy(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus("");
    if (password.length < 8) {
      setStatus("Min 8 characters.");
      return;
    }
    if (password !== confirm) {
      setStatus("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await changeOwnPassword(password);
      setStatus("Password updated.");
      setPassword("");
      setConfirm("");
    } catch (error) {
      setStatus(error.message || "Could not update password.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="change-pw-toggle" onClick={() => setOpen(true)}>
        Change password
      </button>
    );
  }

  return (
    <form className="change-pw-form" onSubmit={handleSubmit}>
      <input
        type="password"
        placeholder="New password"
        value={password}
        autoComplete="new-password"
        onChange={(event) => setPassword(event.target.value)}
      />
      <input
        type="password"
        placeholder="Confirm"
        value={confirm}
        autoComplete="new-password"
        onChange={(event) => setConfirm(event.target.value)}
      />
      <div className="change-pw-actions">
        <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save"}</button>
        <button type="button" onClick={() => { setOpen(false); reset(); }}>Cancel</button>
      </div>
      {status && <small className="change-pw-status">{status}</small>}
    </form>
  );
}
