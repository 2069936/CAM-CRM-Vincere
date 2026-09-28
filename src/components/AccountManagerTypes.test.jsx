import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AccountManager from './AccountManager';

/* THE SELECT MUST BE ABLE TO SHOW THE ROW'S OWN VALUE.
 *
 * ACCOUNT_TYPE_OPTIONS deliberately omits Simulation: a CAM classifying a new
 * account is answering "what is this client's money doing", and Simulation is
 * not an answer to that. While simulated accounts were drawn on no tab the
 * omission cost nothing. Once the Simulation tab renders them, a select whose
 * options do not contain the row's value displays some other type, and writes
 * that other type on the first change the CAM makes to the row.
 *
 * Same treatment, and the same reason, as the legacy 'Cash' value beside it.
 */
describe('the account type select', () => {
  const markupFor = (accountType) => renderToStaticMarkup(
    <AccountManager
      accounts={{ Sim101: { accountName: 'Sim101', alias: 'Sim101', accountType, status: 'Active' } }}
      snapshots={[]}
      onUpdateAccount={() => {}}
      onAddAccount={() => {}}
      onRemoveAccount={() => {}}
    />,
  );

  it('offers Simulation on an account that is one, and shows it selected', () => {
    const markup = markupFor('Simulation');
    expect(markup).toContain('>Simulation</option>');
    // Selected, not merely present: an option list containing the value but a
    // select showing something else is the same bug wearing a hat.
    expect(markup).toContain('<option selected="">Simulation</option>');
  });

  it('does not offer it on an account that is not one', () => {
    const markup = markupFor('Funded');
    expect(markup).toContain('<option selected="">Funded</option>');
    expect(markup).not.toContain('>Simulation</option>');
  });

  it('still offers the legacy Cash value on the rows that hold it', () => {
    // The case this pattern was written for, kept under test beside the new one.
    expect(markupFor('Cash')).toContain('<option selected="">Cash</option>');
    expect(markupFor('Funded')).not.toContain('>Cash</option>');
  });
});
