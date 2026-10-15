import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AccountManager from './AccountManager';

/* THE SELECT MUST BE ABLE TO SHOW THE ROW'S OWN VALUE, AND OFFER SIMULATION.
 *
 * Simulation used to be offered only on rows already holding it. NinjaTrader
 * names a simulation account a client creates Sim<whatever they typed>, and
 * those arrived Unassigned with no way for a CAM to type them as anything but
 * real money. It is now offered on every row and in the add form.
 *
 * The legacy 'Cash' value is still offered only on the rows that hold it, so the
 * select shows the row's real value instead of snapping to another type.
 */
describe('the account type select', () => {
  const markupFor = (accountType) => renderToStaticMarkup(
    <AccountManager
      accounts={{ SimAlex2: { accountName: 'SimAlex2', alias: 'SimAlex2', accountType, status: 'Active' } }}
      snapshots={[]}
      onUpdateAccount={() => {}}
      onAddAccount={() => {}}
      onRemoveAccount={() => {}}
    />,
  );

  it('offers Simulation on an account that is one, and shows it selected', () => {
    const markup = markupFor('Simulation');
    // Selected, not merely present: an option list containing the value but a
    // select showing something else is the same bug wearing a hat.
    expect(markup).toContain('<option selected="">Simulation</option>');
  });

  it('offers Simulation on an unclassified account and on a real money one', () => {
    for (const type of ['Unassigned', 'Cash - Straight', 'Funded']) {
      const markup = markupFor(type);
      expect(markup).toContain(`<option selected="">${type}</option>`);
      expect(markup).toMatch(/<option>Simulation<\/option>[\s\S]*<option>Simulation<\/option>/);
    }
  });

  it('offers Simulation exactly once per select, also on a row that holds it', () => {
    const markup = markupFor('Simulation');
    // Two selects render: the add form and the row. Each lists it once.
    expect(markup.match(/>Simulation<\/option>/g)).toHaveLength(2);
  });

  it('still offers the legacy Cash value on the rows that hold it', () => {
    expect(markupFor('Cash')).toContain('<option selected="">Cash</option>');
    expect(markupFor('Funded')).not.toContain('>Cash</option>');
  });
});
