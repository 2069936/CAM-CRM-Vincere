// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UploadArea from './UploadArea';

const SNAPSHOT = JSON.parse(readFileSync('test/fixtures/auto-export/snapshot-v1.json', 'utf8'));

// Scoped to the container under test. Querying the whole document picked up the
// input left behind by an earlier render and made these pass or fail depending
// on the order they ran in.
function drop(container, files) {
  const input = container.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

function file(name, text) {
  return new File([text], name, { type: name.endsWith('.json') ? 'application/json' : 'text/csv' });
}

// The AddOn writes one snapshot.json holding the whole close. Accepting it here
// matters because it is the desk's fallback: if the automatic upload is not
// working, a CAM can still install the AddOn, export by hand and file the day,
// instead of having no route at all.
describe('UploadArea', () => {
  afterEach(cleanup);

  it('accepts a snapshot from the AddOn as a complete close', async () => {
    const onParsed = vi.fn();
    const { container } = render(<UploadArea onParsed={onParsed} />);

    drop(container, [file('snapshot-2026-08-30-163000.json', JSON.stringify(SNAPSHOT))]);

    await waitFor(() => expect(onParsed).toHaveBeenCalled());
    const [grouped, parsedFiles] = onParsed.mock.calls[0];
    expect(Object.keys(grouped).sort()).toEqual(['accounts', 'executions', 'orders', 'strategies']);
    expect(grouped.accounts.length).toBe(SNAPSHOT.accounts.length);
    // Presented as the four exports it stands in for, so the completeness check
    // upstream sees a finished upload rather than one unknown file.
    expect(parsedFiles.map((f) => f.type).sort()).toEqual(['accounts', 'executions', 'orders', 'strategies']);
  });

  it('refuses a snapshot mixed with loose CSVs rather than double counting', async () => {
    const onParsed = vi.fn();
    const { container } = render(<UploadArea onParsed={onParsed} />);

    drop(container, [
      file('snapshot.json', JSON.stringify(SNAPSHOT)),
      file('NinjaTrader Grid 2026-08-30 PM1.csv', 'ConnectionStatus,Connection,Display name\nx,y,z\n'),
    ]);

    await waitFor(() => expect(container.querySelector('.notice.danger')?.textContent || '').toMatch(/not both at once/i));
    expect(onParsed).not.toHaveBeenCalled();
  });

  it('refuses more than one snapshot, since each is a whole day on its own', async () => {
    const onParsed = vi.fn();
    const { container } = render(<UploadArea onParsed={onParsed} />);

    drop(container, [file('a.json', JSON.stringify(SNAPSHOT)), file('b.json', JSON.stringify(SNAPSHOT))]);

    await waitFor(() => expect(container.querySelector('.notice.danger')?.textContent || '').toMatch(/one snapshot/i));
    expect(onParsed).not.toHaveBeenCalled();
  });

  it('says what is wrong with a malformed snapshot instead of failing silently', async () => {
    const onParsed = vi.fn();
    const { container } = render(<UploadArea onParsed={onParsed} />);

    drop(container, [file('broken.json', '{"accounts":[]}')]);

    await waitFor(() => expect(container.querySelector('.notice.danger')).not.toBeNull());
    expect(onParsed).not.toHaveBeenCalled();
  });

  it('still takes the four CSV exports', async () => {
    const onParsed = vi.fn();
    const { container } = render(<UploadArea onParsed={onParsed} />);

    drop(container, [file('accounts.csv', 'ConnectionStatus,Connection,Display name,Realized PnL,Cash value\nConnected,Live,ACC1,10,50000\n')]);

    await waitFor(() => expect(onParsed).toHaveBeenCalled());
    const [grouped] = onParsed.mock.calls[0];
    expect(grouped.accounts.length).toBe(1);
  });
});
