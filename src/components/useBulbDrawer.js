import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ONE DRAWER UNDER A ROW OF BULBS: WHICH ONE IS OPEN, AND HOW IT CLOSES.
 *
 * The CAM Overview's compact bulbs (FleetStatusLights) and the Manager's desk
 * bulbs (DeskClientLights) open one client's drawer under the grid. Both close
 * it the same three ways, and all three hand the keyboard back where it was:
 *
 *   THE BULB AGAIN, THE CLOSE BUTTON, OR ESCAPE. Whichever it is, focus goes
 *   back to the bulb that opened the drawer. Without it, Escape or Close from
 *   inside the drawer dropped focus on the page's body when the drawer left
 *   the DOM, and a keyboard user started again from the top of the overview.
 *
 *   ESCAPE ONLY, AND NOT WHILE TYPING. The listener is on the document, so it
 *   hears every key on the page: any other key is ignored, and so is an Escape
 *   meant for something else, pressed while focus is in an input, a textarea,
 *   a select or a dialog (a search box clearing itself, a modal closing).
 *   Listened for only while the drawer is on screen.
 *
 * @returns {{open: string|null, toggle: Function, close: Function, reset: Function}}
 *   `toggle(key, event)` opens that key's drawer, or closes it when it is the
 *   open one; `event.currentTarget` is remembered as the bulb to return to.
 *   `close()` shuts it and returns focus. `reset()` shuts it and leaves focus
 *   alone (a view switch, where focus is already on the switch).
 */
export default function useBulbDrawer() {
  const [open, setOpen] = useState(null);
  const opener = useRef(null);

  const close = useCallback(() => {
    const node = opener.current;
    opener.current = null;
    setOpen(null);
    if (node && node.isConnected && typeof node.focus === 'function') node.focus();
  }, []);

  const reset = useCallback(() => {
    opener.current = null;
    setOpen(null);
  }, []);

  function toggle(key, event = null) {
    if (open === key) {
      close();
      return;
    }
    opener.current = event?.currentTarget || null;
    setOpen(key);
  }

  return { open, toggle, close, reset };
}

/* Where an Escape belongs to something else: a field being typed in, or a
 * dialog over the page. */
const ESCAPE_OWNERS = 'input, textarea, select, dialog, [role="dialog"], [role="alertdialog"]';

/**
 * Whether a keydown on the document should close the drawer: Escape, and only
 * when focus is not inside a field or a dialog.
 */
export function escapeClosesDrawer(event) {
  if (!event || event.key !== 'Escape') return false;
  const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
  const focus = target || (typeof document !== 'undefined' ? document.activeElement : null);
  if (focus && typeof focus.closest === 'function' && focus.closest(ESCAPE_OWNERS)) return false;
  return true;
}

/** Escape closes the drawer, while `active` (the drawer is on screen). */
export function useEscapeToClose(active, close) {
  useEffect(() => {
    if (!active) return undefined;
    function onKey(event) {
      if (escapeClosesDrawer(event)) close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, close]);
}
