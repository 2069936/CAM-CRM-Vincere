import { ACCOUNT_TYPES } from './reconcile';

/* ------------------------------------------------------------------------- *
 * What kind of accounts this client runs, said before there are any.
 *
 * Accounts already carry their own type, and the client's badge in the sidebar
 * is derived from them: Cash, Prop, Cash + Prop. That works from the day the
 * first export lands and not one day earlier, which is the wrong day. A client
 * is onboarded knowing exactly what they will trade, and that knowledge had
 * nowhere to go: it was being typed into Notes as the words "Retirement
 * Account", where nothing can count it and nobody will find it.
 *
 * IT IS ALSO FINER THAN THE BADGE. The derived label says Cash. It does not say
 * whether that is straight cash or retirement money, and the difference decides
 * which rules the account trades under.
 *
 * DECLARED IS NOT DERIVED, AND BOTH ARE KEPT. This is what the CAM was told at
 * onboarding. The accounts are what actually showed up. They usually agree, and
 * the day they do not is worth seeing rather than resolving silently in favour
 * of either one: a client set up for retirement whose first account registers
 * as straight cash is a mistake somebody should catch in week one, not in an
 * audit.
 *
 * Fixed set and multi-select, like the tags beside it. A client can genuinely
 * run retirement money and a prop evaluation at the same time.
 * ------------------------------------------------------------------------- */

export const ACCOUNT_FOCUS = Object.freeze({
  CASH_STRAIGHT: 'Cash straight',
  CASH_RETIREMENT: 'Cash retirement',
  PROP: 'Prop',
});

export const ACCOUNT_FOCUS_LIST = Object.freeze([
  ACCOUNT_FOCUS.CASH_STRAIGHT,
  ACCOUNT_FOCUS.CASH_RETIREMENT,
  ACCOUNT_FOCUS.PROP,
]);

export const ACCOUNT_FOCUS_DESCRIPTIONS = Object.freeze({
  [ACCOUNT_FOCUS.CASH_STRAIGHT]: 'Ordinary cash accounts.',
  [ACCOUNT_FOCUS.CASH_RETIREMENT]: 'IRA or other retirement money. Different rules, same desk.',
  [ACCOUNT_FOCUS.PROP]: 'Prop firm evaluations and funded accounts.',
});

/** Which declared focus an account type belongs to, or null if it says nothing. */
export function focusForAccountType(accountType) {
  switch (accountType) {
    case ACCOUNT_TYPES.CASH_IRA:
      return ACCOUNT_FOCUS.CASH_RETIREMENT;
    case ACCOUNT_TYPES.CASH_STRAIGHT:
      return ACCOUNT_FOCUS.CASH_STRAIGHT;
    case ACCOUNT_TYPES.FUNDED:
    case ACCOUNT_TYPES.EVALUATION_BULLET:
    case ACCOUNT_TYPES.EVALUATION_STANDARD:
      return ACCOUNT_FOCUS.PROP;
    // 'Cash' is the legacy value written before the IRA/Straight split, and it
    // genuinely does not say which. Unassigned and Inactive say nothing either.
    default:
      return null;
  }
}

export function normalizeAccountFocus(value) {
  const incoming = Array.isArray(value) ? value : [];
  const wanted = new Set(
    incoming.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean),
  );
  return ACCOUNT_FOCUS_LIST.filter((focus) => wanted.has(focus.toLowerCase()));
}

export function toggleAccountFocus(current, focus) {
  const list = normalizeAccountFocus(current);
  const [only] = normalizeAccountFocus([focus]);
  if (!only) return list;
  return list.includes(only)
    ? list.filter((entry) => entry !== only)
    : normalizeAccountFocus([...list, only]);
}

/** What the registered accounts actually say, ignoring the ones that say nothing. */
export function focusFromAccounts(accountRegistry) {
  const found = new Set();
  for (const meta of Object.values(accountRegistry || {})) {
    const focus = focusForAccountType(meta?.accountType);
    if (focus) found.add(focus);
  }
  return ACCOUNT_FOCUS_LIST.filter((focus) => found.has(focus));
}

/**
 * Declared against actual.
 *
 * `missing` is declared and not yet seen, which on a new client is simply the
 * normal state and not a problem. `unexpected` is an account type nobody said
 * was coming, which is the half worth reading.
 */
export function compareAccountFocus(declared, accountRegistry) {
  const said = normalizeAccountFocus(declared);
  const actual = focusFromAccounts(accountRegistry);
  return {
    declared: said,
    actual,
    missing: said.filter((focus) => !actual.includes(focus)),
    unexpected: actual.filter((focus) => !said.includes(focus)),
    // Nothing declared is not a disagreement, it is a question nobody answered.
    agrees: said.length > 0 && actual.length > 0
      && said.every((f) => actual.includes(f)) && actual.every((f) => said.includes(f)),
  };
}

/** One sentence, or null when there is nothing worth saying. */
export function describeAccountFocus(comparison) {
  if (!comparison?.declared?.length) return null;
  if (!comparison.actual.length) return 'No accounts registered yet.';
  if (comparison.unexpected.length) {
    return `Registered accounts also include ${comparison.unexpected.join(', ')}, which was not expected.`;
  }
  if (comparison.missing.length) {
    return `No ${comparison.missing.join(' or ')} account has been registered yet.`;
  }
  return 'Registered accounts match.';
}
