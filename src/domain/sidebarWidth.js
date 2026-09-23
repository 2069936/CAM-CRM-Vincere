/* ------------------------------------------------------------------------- *
 * How wide the sidebar is, decided by the person reading it.
 *
 * 280px was a guess, and the row it has to hold is not one thing: a name, a
 * kind chip that can say "Cash + Prop", a Covering pill, a last-contact dot, a
 * task count and a VPS address. At 280px the name column is 201.5px and the
 * widest real chip set is about 163px, so the name gets ~38px and reads
 * "Johnny V...". Every CAM works a different book and a different screen, and
 * the one who needs to see "Cash + Prop" in full is not the one who needs
 * thirty characters of name.
 *
 * So it is a preference, kept per browser. Pure functions here, so the clamp
 * and the parsing are testable without a DOM: the component is only the drag.
 * ------------------------------------------------------------------------- */

export const SIDEBAR_WIDTH_DEFAULT = 280;
export const SIDEBAR_WIDTH_MIN = 240;
// Half a 1280px laptop is the point past which the sidebar stops being a
// sidebar. Wider screens are not the constraint; the content beside it is.
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'cam.sidebarWidth';
export const SIDEBAR_WIDTH_VARIABLE = '--sidebar-width';

export function clampSidebarWidth(value) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  if (width < SIDEBAR_WIDTH_MIN) return SIDEBAR_WIDTH_MIN;
  if (width > SIDEBAR_WIDTH_MAX) return SIDEBAR_WIDTH_MAX;
  return width;
}

/* A stored value can be anything: a string from an older build, null from a
 * cleared profile, "NaN" from a bug we have not written yet. Anything that is
 * not a usable number is the default, never a throw and never a 0px sidebar. */
export function parseStoredSidebarWidth(raw) {
  if (raw === null || raw === undefined || raw === '') return SIDEBAR_WIDTH_DEFAULT;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return SIDEBAR_WIDTH_DEFAULT;
  return clampSidebarWidth(parsed);
}

/* The handle sits on the sidebar's right edge, so the width the drag wants is
 * simply the pointer's distance from the shell's left edge. Kept separate from
 * the event so the arithmetic can be tested with numbers. */
export function widthFromPointer(clientX, shellLeft) {
  return clampSidebarWidth(clientX - shellLeft);
}

export const SIDEBAR_WIDTH_STEP = 16;
export const SIDEBAR_WIDTH_STEP_COARSE = 64;

export function widthFromKey(key, current, { shift = false } = {}) {
  const step = shift ? SIDEBAR_WIDTH_STEP_COARSE : SIDEBAR_WIDTH_STEP;
  if (key === 'ArrowLeft') return clampSidebarWidth(current - step);
  if (key === 'ArrowRight') return clampSidebarWidth(current + step);
  if (key === 'Home') return SIDEBAR_WIDTH_MIN;
  if (key === 'End') return SIDEBAR_WIDTH_MAX;
  // Enter and Space on a separator mean nothing, so they reset rather than
  // doing nothing: the way back from a width that went wrong.
  if (key === 'Enter' || key === ' ') return SIDEBAR_WIDTH_DEFAULT;
  return null;
}
