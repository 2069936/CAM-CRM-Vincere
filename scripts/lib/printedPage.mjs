/**
 * Reads a printed page back off the paper.
 *
 * The report has no PDF generator: printWithTitle (App.jsx:1721) is
 * window.print() on the live DOM, so every question about the printed layout —
 * how many sheets, where the break landed, how much of a sheet is blank — can
 * only be answered by printing and measuring. This module is the measuring end.
 *
 * It answers two things per page:
 *
 *   1. WHERE THE INK IS. The topmost and bottommost marks inside the printable
 *      band, so "used" and "blank" millimetres are what a reader would see, not
 *      what a box model predicts. White fills are ignored, because the report
 *      paints a page-sized white sheet background and counting it would make
 *      every page read as full. Ink outside the band is ignored too: the
 *      browser prints its own header and footer (date, title, page number, URL)
 *      into the margin and that is not the report.
 *   2. WHAT WORDS ARE ON IT. Enough to say which section landed on which sheet.
 *
 * It is deliberately small and handles exactly the two producers this repo sees:
 * Chrome's own printToPDF, which emits Type3 fonts with one-byte codes and a
 * ToUnicode map, and the macOS print dialog, which emits simple fonts and
 * literal strings — the eleven reports the desk sent on 2026-08-21 are the
 * second kind, and this module was calibrated against them (13 sides, 1,205mm
 * of blank space, agreeing with a by-hand read of the same files to ~1.5mm).
 */

import zlib from 'node:zlib';

const PT_PER_MM = 72 / 25.4;
/** 12mm, the margin @page asks for and the eleven shipped PDFs actually have. */
export const DEFAULT_MARGIN_PT = 12 * PT_PER_MM;

function objects(buf) {
  const text = buf.toString('latin1');
  const map = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) continue;
    const body = text.slice(start, end);
    const streamAt = /stream\r?\n/.exec(body);
    let stream = null;
    if (streamAt) {
      const from = start + streamAt.index + streamAt[0].length;
      stream = buf.subarray(from, text.indexOf('endstream', from));
    }
    map.set(Number(match[1]), {
      dict: streamAt ? body.slice(0, streamAt.index) : body,
      stream,
    });
  }
  return map;
}

function inflate(raw) {
  try { return zlib.inflateSync(raw); } catch { /* not zlib-wrapped */ }
  try { return zlib.inflateRawSync(raw); } catch { /* not raw deflate */ }
  return raw;
}

const refsIn = (text) => [...text.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));

const hexToString = (hex) => {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
};

/**
 * A ToUnicode CMap, plus how wide one character code is.
 *
 * The width is not cosmetic: Chrome's Type3 output uses one-byte codes and its
 * CID output two, and reading a one-byte stream four hex digits at a time
 * returns nothing at all rather than failing loudly.
 */
function parseCMap(text) {
  const map = new Map();
  const codespace = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(text);
  const nibbles = codespace ? codespace[1].length : 4;
  for (const block of text.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(m[1].toUpperCase(), hexToString(m[2]));
    }
  }
  for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const to = parseInt(m[3], 16);
      for (let code = lo; code <= hi; code += 1) {
        map.set(code.toString(16).toUpperCase().padStart(m[1].length, '0'), String.fromCharCode(to + (code - lo)));
      }
    }
  }
  return { map, nibbles };
}

const compose = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function unescapeLiteral(text) {
  return text.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => (/^[0-7]+$/.test(c)
    ? String.fromCharCode(parseInt(c, 8))
    : { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? c));
}

/** Walks one page's content stream and returns its ink spans and its words. */
function scan(content, fonts) {
  const tokens = content.match(/<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/[\]<>(){}]+|\((?:\\[\s\S]|[^\\()])*\)|[-+]?[\d.]+|[A-Za-z'"*]+/g) || [];
  let matrix = [1, 0, 0, 1, 0, 0];
  let text = [1, 0, 0, 1, 0, 0];
  let line = [1, 0, 0, 1, 0, 0];
  let size = 0;
  let cmap = null;
  let white = false;
  const saved = [];
  const ink = [];
  const words = [];
  let operands = [];
  const nth = (back) => Number(operands[operands.length + back]);
  const allOnes = (values) => values.length > 0 && values.every((v) => Math.abs(v - 1) < 1e-6);
  for (const token of tokens) {
    const isOperand = /^[-+]?[\d.]+$/.test(token)
      || token.startsWith('/') || token.startsWith('<') || token.startsWith('(')
      || token === '[' || token === ']';
    if (isOperand) { operands.push(token); continue; }
    switch (token) {
      case 'q': saved.push([matrix.slice(), white]); break;
      case 'Q': { const back = saved.pop(); if (back) { [matrix, white] = back; } break; }
      case 'cm': matrix = compose([nth(-6), nth(-5), nth(-4), nth(-3), nth(-2), nth(-1)], matrix); break;
      case 'sc': case 'scn': case 'rg': case 'g': case 'k': {
        const values = operands.filter((o) => /^[-+]?[\d.]+$/.test(o)).map(Number);
        // CMYK paints white at all zeroes; every other space paints it at all ones.
        white = token === 'k' ? values.every((v) => v === 0) : allOnes(values);
        break;
      }
      case 'BT': text = [1, 0, 0, 1, 0, 0]; line = text.slice(); break;
      case 'Tf': size = nth(-1); cmap = fonts.get(operands[operands.length - 2]) ?? null; break;
      case 'Tm': text = [nth(-6), nth(-5), nth(-4), nth(-3), nth(-2), nth(-1)]; line = text.slice(); break;
      case 'Td': case 'TD': line = compose([1, 0, 0, 1, nth(-2), nth(-1)], line); text = line.slice(); break;
      case 'Tj': case 'TJ': case "'": case '"': {
        const full = compose(text, matrix);
        const baseline = at(full, 0, 0)[1];
        const height = Math.abs(size * (full[3] || full[1] || 1)) || Math.abs(size);
        let piece = '';
        for (const operand of operands) {
          if (operand.startsWith('<')) {
            const hex = operand.slice(1, -1).replace(/\s/g, '').toUpperCase();
            const step = cmap ? cmap.nibbles : 2;
            if (cmap) {
              for (let i = 0; i + step <= hex.length; i += step) piece += cmap.map.get(hex.slice(i, i + step)) ?? '';
            }
          } else if (operand.startsWith('(')) {
            const literal = unescapeLiteral(operand.slice(1, -1));
            if (cmap && cmap.nibbles === 2) {
              for (const ch of literal) {
                piece += cmap.map.get(ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) ?? ch;
              }
            } else piece += literal;
          }
        }
        // Glyph box around the baseline: 0.85 above and 0.30 below is the ascent
        // and descent of the faces this report prints in, close enough that the
        // measured totals agree with the shipped PDFs to about 1.5mm.
        if (piece.trim()) {
          const span = [baseline - height * 0.85, baseline + height * 0.3];
          ink.push(span);
          // Kept with its position so the caller can drop the browser's own
          // page header and footer, which print into the margin and are not
          // part of the report.
          words.push([span[0], span[1], piece]);
        }
        break;
      }
      case 're': operands.push('__RE__', String(nth(-4)), String(nth(-3)), String(nth(-2)), String(nth(-1))); continue;
      case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'S': case 's': case 'b': case 'b*': {
        // A rectangle only counts as ink when it is painted, and only when it is
        // painted in something other than white. `re W n` is a clip, not a mark.
        if (white) break;
        for (let i = 0; i < operands.length; i += 1) {
          if (operands[i] !== '__RE__') continue;
          const [x, y, w, h] = operands.slice(i + 1, i + 5).map(Number);
          const a = at(matrix, x, y);
          const b = at(matrix, x + w, y + h);
          ink.push([Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
        }
        break;
      }
      default: break;
    }
    operands = [];
  }
  return { ink, words };
}

/** Every page of `buf`, with its ink extents inside the printable band. */
export function readPrintedPages(buf, marginPt = DEFAULT_MARGIN_PT) {
  const objs = objects(buf);
  const pageNumbers = [];
  let root = null;
  for (const [number, object] of objs) {
    if (/\/Type\s*\/Pages\b/.test(object.dict) && /\/Kids/.test(object.dict) && !/\/Parent/.test(object.dict)) root = object;
    if (/\/Type\s*\/Page[^s]/.test(object.dict)) pageNumbers.push(number);
  }
  let order = pageNumbers.slice().sort((a, b) => a - b);
  const kids = root && /\/Kids\s*\[([^\]]*)\]/.exec(root.dict);
  if (kids) {
    const listed = refsIn(kids[1]).filter((n) => pageNumbers.includes(n));
    if (listed.length === pageNumbers.length) order = listed;
  }

  return order.map((number) => {
    const page = objs.get(number);
    const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(page.dict);
    const height = box ? Number(box[4]) - Number(box[2]) : 792;
    const width = box ? Number(box[3]) - Number(box[1]) : 612;

    let resources = page.dict;
    const resourceRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
    if (resourceRef) resources = objs.get(Number(resourceRef[1]))?.dict || resources;

    const fonts = new Map();
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] || '';
    for (const entry of fontBlock.matchAll(/\/([^\s/]+)\s+(\d+)\s+0\s+R/g)) {
      const font = objs.get(Number(entry[2]));
      if (!font) continue;
      let toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font.dict);
      if (!toUnicode) {
        for (const child of refsIn(font.dict)) {
          const descendant = objs.get(child);
          if (descendant && /\/ToUnicode\s+(\d+)\s+0\s+R/.test(descendant.dict)) {
            toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(descendant.dict);
            break;
          }
        }
      }
      const cmap = toUnicode && objs.get(Number(toUnicode[1]));
      if (cmap?.stream) fonts.set(`/${entry[1]}`, parseCMap(inflate(cmap.stream).toString('latin1')));
    }

    let content = '';
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(page.dict);
    for (const ref of array ? refsIn(array[1]) : (single ? [Number(single[1])] : [])) {
      const stream = objs.get(ref)?.stream;
      if (stream) content += `${inflate(stream).toString('latin1')}\n`;
    }

    const { ink, words } = scan(content, fonts);
    const bandTop = height - marginPt;
    const bandBottom = marginPt;
    const within = ([low, high]) => Math.min(high, bandTop) > Math.max(low, bandBottom) + 0.01;
    const inside = ink
      .map(([low, high]) => [Math.max(low, bandBottom), Math.min(high, bandTop)])
      .filter(([low, high]) => high > low + 0.01);
    return {
      width,
      height,
      bandTop,
      bandBottom,
      topPt: inside.length ? Math.max(...inside.map((span) => span[1])) : null,
      bottomPt: inside.length ? Math.min(...inside.map((span) => span[0])) : null,
      text: words.filter(([low, high]) => within([low, high])).map(([, , piece]) => piece).join('').replace(/\s+/g, ' ').trim(),
    };
  });
}

/** Used and blank millimetres for one page, measured down from the band top. */
export function pageSpace(page) {
  const band = (page.bandTop - page.bandBottom) / PT_PER_MM;
  if (page.bottomPt === null) return { band, used: 0, blank: band, lead: band };
  const used = (page.bandTop - page.bottomPt) / PT_PER_MM;
  return { band, used, blank: band - used, lead: (page.bandTop - page.topPt) / PT_PER_MM };
}
