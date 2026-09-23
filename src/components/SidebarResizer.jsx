import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_WIDTH_VARIABLE,
  clampSidebarWidth,
  parseStoredSidebarWidth,
  widthFromKey,
  widthFromPointer,
} from '../domain/sidebarWidth';

/* ------------------------------------------------------------------------- *
 * The drag handle on the sidebar's right edge.
 *
 * The width lives in a CSS variable on <html>, not in React state that the rows
 * re-render from: a drag is a stream of pointer moves and a sidebar full of
 * client rows cannot re-render on each one. React holds the number only to
 * label the handle and to save it; the layout follows the variable.
 *
 * Storage can throw (private window, blocked site data), so every read and
 * write is guarded and a failure just means the width is not remembered.
 * ------------------------------------------------------------------------- */

function readStored() {
  try {
    return parseStoredSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function writeStored(width) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* Not remembering the width is not worth an error on the screen. */
  }
}

function applyWidth(width) {
  document.documentElement.style.setProperty(SIDEBAR_WIDTH_VARIABLE, `${width}px`);
}

export default function SidebarResizer({ label = 'Sidebar width' }) {
  // Read once, during the first render, so the sidebar is never painted at the
  // default width and then jumped to the stored one.
  const [width, setWidth] = useState(readStored);
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef(null);
  const latest = useRef(width);

  const commit = useCallback((next) => {
    const value = clampSidebarWidth(next);
    latest.current = value;
    applyWidth(value);
    setWidth(value);
    writeStored(value);
  }, []);

  useEffect(() => {
    // Only the CSS variable, never state: the stored width is already the
    // state's initial value.
    applyWidth(latest.current);
  }, []);

  useEffect(() => {
    if (!dragging) return undefined;
    const shell = handleRef.current?.closest('.app-shell, .manager-shell');
    const shellLeft = shell ? shell.getBoundingClientRect().left : 0;

    function onMove(event) {
      // The pointer owns the width during a drag, so nothing else may select
      // text or scroll under it.
      event.preventDefault();
      const value = widthFromPointer(event.clientX, shellLeft);
      latest.current = value;
      applyWidth(value);
    }
    function onUp() {
      setDragging(false);
      // One write at the end, not one per pointer move.
      setWidth(latest.current);
      writeStored(latest.current);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.classList.add('sidebar-resizing');
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('sidebar-resizing');
    };
  }, [dragging]);

  return (
    <div
      ref={handleRef}
      className={`sidebar-resizer${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title="Drag to resize. Double click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDoubleClick={() => commit(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(event) => {
        const next = widthFromKey(event.key, latest.current, { shift: event.shiftKey });
        if (next === null) return;
        event.preventDefault();
        commit(next);
      }}
    >
      <span className="sidebar-resizer-grip" aria-hidden="true" />
    </div>
  );
}
