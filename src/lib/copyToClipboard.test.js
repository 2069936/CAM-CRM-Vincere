// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './copyToClipboard';

/* ------------------------------------------------------------------------- *
 * ONE LINE ONTO THE CLIPBOARD, TWO WAYS.
 *
 * navigator.clipboard.writeText is the way on https and localhost; a page
 * opened some other way, or a browser that refuses, falls back to a textarea
 * and execCommand('copy'). The caller only learns whether it worked.
 * ------------------------------------------------------------------------- */

describe('copyToClipboard', () => {
  it('writes through navigator.clipboard when it is there', async () => {
    const writeText = vi.fn(async () => undefined);
    const doc = { body: { appendChild: vi.fn(), removeChild: vi.fn() }, createElement: vi.fn(), execCommand: vi.fn() };
    expect(await copyToClipboard('URGO: 3 accounts, -310 to -295, in line with the desk.', { clipboard: { writeText }, doc })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('URGO: 3 accounts, -310 to -295, in line with the desk.');
    expect(doc.createElement).not.toHaveBeenCalled();
  });

  it('falls back to a textarea and execCommand when there is no clipboard API', async () => {
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    let selected = '';
    const original = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = function select() { selected = this.value; };
    try {
      expect(await copyToClipboard('BulletBot: 4 accounts, long on 3, short on 1, -140 to +60, 1 differs from the desk.', { clipboard: undefined, doc: document })).toBe(true);
    } finally {
      HTMLTextAreaElement.prototype.select = original;
    }
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('BulletBot: 4 accounts, long on 3, short on 1, -140 to +60, 1 differs from the desk.');
    // The textarea does not stay on the page.
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });

  it('falls back too when writeText rejects, and answers false when nothing works', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    document.execCommand = vi.fn(() => false);
    expect(await copyToClipboard('x', { clipboard: { writeText }, doc: document })).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(await copyToClipboard('x', { clipboard: undefined, doc: null })).toBe(false);
  });
});
