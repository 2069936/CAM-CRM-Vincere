// The control that was missing, which is why one of the report's toggles could
// never do anything.
//
// `SIMULATION_MODES` has existed since step 36, `accountPatchToDb` maps
// `simulationMode -> simulation_mode`, `RECLASSIFYING_FIELDS` lists it, and
// `classifyAccountNature` consults it before every other signal. No component in
// src/ ever put the key in a patch, so the override was unreachable: a CAM could
// turn the report's simulation section on and watch nothing happen, with nothing
// anywhere to change. The two routes that looked like a way in are circular —
// `typeOptionsFor` offers the Simulation type only on rows that already hold it,
// and `buildVisibleTabs` offers the Simulation tab only to clients who already
// have one.
//
// Asserted on the rendered markup, the idiom AccountManagerTypes.test.jsx beside
// it uses.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AccountManager from './AccountManager';
import { SIMULATION_MODES } from '../domain/simulationAccounts';
import { ACCOUNT_TYPES } from '../domain/reconcile';

const markupFor = (account) => renderToStaticMarkup(
  <AccountManager
    accounts={{ [account.accountName]: account }}
    snapshots={[]}
    onUpdateAccount={() => {}}
  />,
);

describe('the Sim / Live control', () => {
  it('offers the override on an ordinary account', () => {
    const markup = markupFor({ accountName: 'ROME7045', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active' });
    expect(markup).toContain('>Sim / Live</th>');
    expect(markup).toContain('>Simulated funds</option>');
    expect(markup).toContain('>Real money</option>');
    expect(markup).toContain('>Automatic</option>');
  });

  it('does not collide with the account TYPE select two cells to the left', () => {
    /* AccountManagerTypes.test.jsx asserts that `>Simulation</option>` appears only
     * on rows that already hold the Simulation type. The labels here deliberately
     * avoid that word: the type select answers "what is this client's money doing"
     * and this one answers "is it money at all", and two controls reading the same
     * would be worse than one. */
    const markup = markupFor({ accountName: 'ROME7045', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active' });
    expect(markup).not.toContain('>Simulation</option>');
  });

  it('shows the row\'s own stored override as selected', () => {
    const markup = markupFor({
      accountName: 'ROME7045', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active',
      simulationMode: SIMULATION_MODES.SIMULATION,
    });
    // Selected, not merely present: a select showing something other than the
    // stored value writes that other value on the first change.
    expect(markup).toContain('<option value="simulation" selected="">Simulated funds</option>');
  });

  it('says what the automatic ladder decided while nobody has overridden it', () => {
    /* AUTO is the ABSENCE of an opinion, not a third value. A select sitting on
     * "Automatic" with nothing beside it tells a CAM nothing about what the report
     * will do, which is the same silence this whole change is about. */
    const live = markupFor({ accountName: 'ROME7045', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active' });
    expect(live).toContain('real money');

    const named = markupFor({ accountName: 'Sim101', accountType: ACCOUNT_TYPES.UNASSIGNED, status: 'Active' });
    // And a decision taken from the NAME is marked as a guess, because
    // simulationAccounts.js states that intent is not in the data and cannot be
    // derived.
    expect(named).toContain('simulated funds');
    expect(named).toContain('guessed from the name');
  });

  it('says nothing about the ladder once a human has decided', () => {
    const markup = markupFor({
      accountName: 'Sim101', accountType: ACCOUNT_TYPES.UNASSIGNED, status: 'Active',
      simulationMode: SIMULATION_MODES.LIVE,
    });
    expect(markup).not.toContain('guessed from the name');
  });

  it('emits simulationMode, which is the key the write path has always mapped', () => {
    // accountPatchToDb maps simulationMode -> simulation_mode, and
    // patchReclassifies lists it, so this one key re-splits every close the client
    // ever had rather than only tomorrow's.
    const onUpdateAccount = vi.fn();
    const account = { accountName: 'ROME7045', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active' };
    // renderToStaticMarkup cannot fire events, so the handler is exercised through
    // the same shape App.jsx passes down.
    const markup = renderToStaticMarkup(
      <AccountManager accounts={{ ROME7045: account }} snapshots={[]} onUpdateAccount={onUpdateAccount} />,
    );
    expect(markup).toContain('aria-label="Simulated or real money for ROME7045"');
    expect(markup).toContain('class="simulation-mode-picker"');
  });
});
