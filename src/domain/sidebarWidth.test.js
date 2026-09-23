import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  parseStoredSidebarWidth,
  widthFromKey,
  widthFromPointer,
} from './sidebarWidth';

describe('sidebar width', () => {
  it('keeps the width inside the range a sidebar can usefully be', () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(4000)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(287.6)).toBe(288);
  });

  it('never returns a width that would collapse or hide the sidebar', () => {
    // A zero here is a sidebar nobody can get back, so every unusable input is
    // the default rather than a throw or a 0.
    for (const bad of [null, undefined, '', 'wide', NaN, Infinity, -1, 0, {}, []]) {
      const width = clampSidebarWidth(bad);
      expect(width).toBeGreaterThanOrEqual(SIDEBAR_WIDTH_MIN);
      expect(width).toBeLessThanOrEqual(SIDEBAR_WIDTH_MAX);
    }
  });

  it('reads whatever localStorage happens to hold', () => {
    expect(parseStoredSidebarWidth('340')).toBe(340);
    expect(parseStoredSidebarWidth(' 340 ')).toBe(340);
    expect(parseStoredSidebarWidth('9999')).toBe(SIDEBAR_WIDTH_MAX);
    for (const bad of [null, undefined, '', 'NaN', '0', '-20', 'null']) {
      expect(parseStoredSidebarWidth(bad)).toBe(SIDEBAR_WIDTH_DEFAULT);
    }
  });

  it('measures the drag from the shell edge, not the viewport', () => {
    // The shell is flush left today, but a drag must not jump the moment that
    // stops being true.
    expect(widthFromPointer(420, 0)).toBe(420);
    expect(widthFromPointer(420, 100)).toBe(320);
    expect(widthFromPointer(-50, 0)).toBe(SIDEBAR_WIDTH_MIN);
  });

  it('moves by keyboard, coarsely with shift, and resets on Enter', () => {
    expect(widthFromKey('ArrowRight', 300)).toBe(316);
    expect(widthFromKey('ArrowLeft', 300)).toBe(284);
    expect(widthFromKey('ArrowRight', 300, { shift: true })).toBe(364);
    expect(widthFromKey('Home', 400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(widthFromKey('End', 260)).toBe(SIDEBAR_WIDTH_MAX);
    expect(widthFromKey('Enter', 520)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(widthFromKey(' ', 520)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('ignores keys that are not a resize', () => {
    // null, not the current width: the handler uses it to decide whether to
    // call preventDefault, and swallowing Tab would trap focus on the handle.
    for (const key of ['Tab', 'a', 'Escape', 'ArrowUp', 'ArrowDown']) {
      expect(widthFromKey(key, 300)).toBeNull();
    }
  });

  it('cannot be walked out of range by repeated keypresses', () => {
    let width = SIDEBAR_WIDTH_DEFAULT;
    for (let i = 0; i < 100; i += 1) width = widthFromKey('ArrowLeft', width);
    expect(width).toBe(SIDEBAR_WIDTH_MIN);
    for (let i = 0; i < 100; i += 1) width = widthFromKey('ArrowRight', width);
    expect(width).toBe(SIDEBAR_WIDTH_MAX);
  });
});
