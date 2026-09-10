import {
  ACCOUNT_FOCUS_DESCRIPTIONS,
  ACCOUNT_FOCUS_LIST,
  compareAccountFocus,
  describeAccountFocus,
  normalizeAccountFocus,
  toggleAccountFocus,
} from '../domain/clientAccountFocus';

/* ------------------------------------------------------------------------- *
 * What this client runs, next to what has actually shown up.
 *
 * The sidebar badge is derived from the registered accounts, so it says nothing
 * until the first export lands, and it says "Cash" without saying whether that
 * is straight cash or retirement money. A CAM onboarding a client knows both on
 * day one and had nowhere to put it but the Notes box.
 *
 * The comparison line underneath is the reason this is worth more than a label.
 * "Registered accounts also include Prop, which was not expected" is a setup
 * mistake found in week one instead of in an audit. On a client with no
 * accounts yet it simply says so, because that is the normal state of a new
 * client and not a fault to warn about.
 * ------------------------------------------------------------------------- */
export default function ClientAccountFocusPicker({
  accountFocus,
  accountRegistry,
  onChange,
  disabled = false,
}) {
  const current = normalizeAccountFocus(accountFocus);
  const comparison = compareAccountFocus(current, accountRegistry);
  const note = describeAccountFocus(comparison);
  return (
    <div className="client-tag-picker">
      <div className="client-tag-picker-label">Account types this client runs</div>
      <div className="client-tag-options">
        {ACCOUNT_FOCUS_LIST.map((focus) => {
          const checked = current.includes(focus);
          return (
            <label
              key={focus}
              className={`client-tag-option${checked ? ' checked' : ''}`}
              title={ACCOUNT_FOCUS_DESCRIPTIONS[focus]}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange?.(toggleAccountFocus(current, focus))}
              />
              <span className="client-tag-name">{focus}</span>
              <span className="client-tag-why">{ACCOUNT_FOCUS_DESCRIPTIONS[focus]}</span>
            </label>
          );
        })}
      </div>
      {note ? (
        <p className={comparison.unexpected.length ? 'revenue-caveat' : 'client-tag-why'}>{note}</p>
      ) : null}
    </div>
  );
}
