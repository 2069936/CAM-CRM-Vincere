import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_FOCUS,
  ACCOUNT_FOCUS_LIST,
  compareAccountFocus,
  describeAccountFocus,
  focusForAccountType,
  focusFromAccounts,
  normalizeAccountFocus,
  toggleAccountFocus,
} from './clientAccountFocus';

/* A client is onboarded knowing exactly what they will trade, and that
 * knowledge had nowhere to go: it was being typed into Notes as the words
 * "Retirement Account", where nothing can count it and nobody will find it.
 * The derived badge only exists once an export has landed, which is the wrong
 * day, and it says Cash without saying whether that is straight or retirement. */

describe('what the CAM was told at onboarding', () => {
  it('is the three kinds a client can run', () => {
    expect(ACCOUNT_FOCUS_LIST).toEqual(['Cash straight', 'Cash retirement', 'Prop']);
  });

  it('takes more than one, because a client can run retirement money and a prop eval', () => {
    let focus = toggleAccountFocus([], ACCOUNT_FOCUS.CASH_RETIREMENT);
    focus = toggleAccountFocus(focus, ACCOUNT_FOCUS.PROP);
    expect(focus).toEqual(['Cash retirement', 'Prop']);
  });

  it('drops anything outside the set and keeps the declared order', () => {
    expect(normalizeAccountFocus(['Prop', 'whatever', 'cash straight'])).toEqual(['Cash straight', 'Prop']);
    expect(normalizeAccountFocus(null)).toEqual([]);
  });
});

describe('what the accounts actually say', () => {
  it('maps each account type to the kind it belongs to', () => {
    expect(focusForAccountType('Cash - IRA')).toBe('Cash retirement');
    expect(focusForAccountType('Cash - Straight')).toBe('Cash straight');
    expect(focusForAccountType('Funded')).toBe('Prop');
    expect(focusForAccountType('Evaluation - Standard')).toBe('Prop');
  });

  it('says nothing for the types that say nothing', () => {
    // 'Cash' is the legacy value from before the IRA/Straight split and it
    // genuinely does not say which one it is.
    expect(focusForAccountType('Cash')).toBeNull();
    expect(focusForAccountType('Unassigned')).toBeNull();
    expect(focusForAccountType('Inactive / Ignore')).toBeNull();
    expect(focusForAccountType(undefined)).toBeNull();
  });

  it('reads the registry without counting the same kind twice', () => {
    expect(focusFromAccounts({
      A: { accountType: 'Cash - IRA' },
      B: { accountType: 'Cash - IRA' },
      C: { accountType: 'Funded' },
    })).toEqual(['Cash retirement', 'Prop']);
  });
});

describe('declared against actual', () => {
  it('does not call a brand new client a disagreement', () => {
    // THE CASE THIS WAS BUILT FOR. A client starting next week, declared
    // retirement, with no accounts yet. That is the normal state, not a fault.
    const comparison = compareAccountFocus(['Cash retirement'], {});
    expect(comparison.missing).toEqual(['Cash retirement']);
    expect(comparison.agrees).toBe(false);
    expect(describeAccountFocus(comparison)).toBe('No accounts registered yet.');
  });

  it('names an account type nobody said was coming', () => {
    // The half worth reading: declared retirement, and a prop account showed up.
    const comparison = compareAccountFocus(['Cash retirement'], {
      A: { accountType: 'Cash - IRA' },
      B: { accountType: 'Funded' },
    });
    expect(comparison.unexpected).toEqual(['Prop']);
    expect(describeAccountFocus(comparison)).toContain('was not expected');
  });

  it('says so when they line up', () => {
    const comparison = compareAccountFocus(['Cash retirement'], { A: { accountType: 'Cash - IRA' } });
    expect(comparison.agrees).toBe(true);
    expect(describeAccountFocus(comparison)).toBe('Registered accounts match.');
  });

  it('names a declared kind that has not shown up while others have', () => {
    const comparison = compareAccountFocus(['Cash retirement', 'Prop'], { A: { accountType: 'Funded' } });
    expect(comparison.missing).toEqual(['Cash retirement']);
    expect(describeAccountFocus(comparison)).toContain('No Cash retirement account');
  });

  it('stays quiet when nobody declared anything', () => {
    // Not a disagreement. A question nobody answered.
    const comparison = compareAccountFocus([], { A: { accountType: 'Funded' } });
    expect(comparison.agrees).toBe(false);
    expect(describeAccountFocus(comparison)).toBeNull();
  });

  it('survives a client with no registry at all', () => {
    expect(() => compareAccountFocus(['Prop'], null)).not.toThrow();
    expect(compareAccountFocus(['Prop'], null).actual).toEqual([]);
  });
});
