import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ClientAccountFocusPicker from './ClientAccountFocusPicker';

const render = (props) => renderToStaticMarkup(<ClientAccountFocusPicker {...props} />);

describe('declaring what a client runs before they run it', () => {
  it('offers the three kinds with what each one means', () => {
    const html = render({ accountFocus: [], accountRegistry: {} });
    expect(html).toContain('Cash straight');
    expect(html).toContain('Cash retirement');
    expect(html).toContain('Prop');
    expect(html).toContain('IRA or other retirement money');
  });

  it('checks more than one, because a client can run both', () => {
    const html = render({ accountFocus: ['Cash retirement', 'Prop'], accountRegistry: {} });
    expect(html.match(/checked=""/g) || []).toHaveLength(2);
  });

  it('tells a brand new client apart from a disagreement', () => {
    // THE CASE THIS WAS BUILT FOR: a client starting next week, declared
    // retirement, no accounts yet. Normal, not a fault.
    const html = render({ accountFocus: ['Cash retirement'], accountRegistry: {} });
    expect(html).toContain('No accounts registered yet');
    expect(html).not.toContain('revenue-caveat');
  });

  it('flags an account type nobody said was coming', () => {
    const html = render({
      accountFocus: ['Cash retirement'],
      accountRegistry: { A: { accountType: 'Cash - IRA' }, B: { accountType: 'Funded' } },
    });
    expect(html).toContain('was not expected');
    expect(html).toContain('revenue-caveat');
  });

  it('says so quietly when they line up', () => {
    const html = render({
      accountFocus: ['Cash retirement'],
      accountRegistry: { A: { accountType: 'Cash - IRA' } },
    });
    expect(html).toContain('Registered accounts match');
    expect(html).not.toContain('revenue-caveat');
  });

  it('says nothing at all when nobody declared anything', () => {
    const html = render({ accountFocus: [], accountRegistry: { A: { accountType: 'Funded' } } });
    expect(html).not.toContain('Registered accounts');
    expect(html).not.toContain('No accounts registered yet');
  });

  it('renders with nothing passed in', () => {
    expect(() => renderToStaticMarkup(<ClientAccountFocusPicker />)).not.toThrow();
  });
});
