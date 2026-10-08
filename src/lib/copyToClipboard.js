/**
 * ONE LINE ONTO THE CLIPBOARD, TWO WAYS.
 *
 * navigator.clipboard.writeText is the way on https and on localhost. A page
 * served some other way has no clipboard API, and a browser can refuse the
 * write; either way the fall back is the old one, a textarea off screen and
 * execCommand('copy'). The caller learns only whether it worked, and says
 * "Copied" or "Could not copy" from that.
 *
 * Both collaborators are injectable so a test can hand a fake clipboard or no
 * clipboard at all; the defaults are read at call time, not at import time,
 * because jsdom has no navigator.clipboard and a test may install one.
 *
 * @param {string} text
 * @param {{clipboard?: {writeText: Function}|null, doc?: Document|null}} [options]
 * @returns {Promise<boolean>} true when the text reached the clipboard.
 */
export async function copyToClipboard(text, options = {}) {
  const value = String(text ?? '');
  const clipboard = 'clipboard' in options ? options.clipboard : globalThis.navigator?.clipboard;
  const doc = 'doc' in options ? options.doc : globalThis.document;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Refused: fall through to the textarea.
    }
  }
  if (!doc?.body || typeof doc.createElement !== 'function') return false;
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  try {
    area.select();
    return typeof doc.execCommand === 'function' && doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}
