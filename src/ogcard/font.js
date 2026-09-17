'use strict';

const { circle, line } = require('./draw');

/**
 * Single-stroke vector font used by the OpenGraph card renderer.
 *
 * Why a hand drawn stroke font instead of a TTF? The project ships no fonts and
 * the runtime image is alpine, which has no fontconfig and no system fonts at
 * all; shipping a font file would also mean adding a licence to the repository.
 * A stroke font is pure data: every glyph is a list of polylines on a small
 * integer grid, drawn with the anti-aliased line primitive of ./draw.js. It also
 * matches the app, whose interface is all uppercase and monospaced.
 *
 * Grid convention (per glyph):
 *   x: 0 (left) .. 6 (right)      y: 0 (cap height) .. 7 (baseline)
 *   negative y values are above the cap height (accent marks), values above 7
 *   fall below the baseline (commas, cedillas, the tail of the Q).
 *
 * Every glyph uses the same advance (ADVANCE units), which gives the monospaced
 * look of the UI. Text is uppercased and decomposed to NFD before drawing, so
 * "Caso Queiroz — Investigação" becomes "CASO QUEIROZ - INVESTIGACAO" with the
 * accents drawn as separate marks (see MARKS below).
 */

const UNITS_HEIGHT = 7;
const ADVANCE = 8;
const DEFAULT_THICKNESS_RATIO = 0.12;
const FALLBACK_GLYPH = '?';

/** @type {Record<string, string>} polylines ("x,y x,y …" separated by "|") */
const GLYPHS = {
  A: '0,7 3,0 6,7|1,5 5,5',
  B: '0,0 0,7|0,0 4,0 5,1 5,3 4,4 0,4|4,4 6,5 6,6 5,7 0,7',
  C: '6,1 4,0 2,0 0,2 0,5 2,7 4,7 6,6',
  D: '0,0 0,7|0,0 3,0 5,1 6,3 6,4 5,6 3,7 0,7',
  E: '6,0 0,0 0,7 6,7|0,4 4,4',
  F: '6,0 0,0 0,7|0,4 4,4',
  G: '6,1 4,0 2,0 0,2 0,5 2,7 4,7 6,5 6,4 3,4',
  H: '0,0 0,7|6,0 6,7|0,4 6,4',
  I: '3,0 3,7|1,0 5,0|1,7 5,7',
  J: '5,0 5,6 4,7 2,7 1,6 1,5',
  K: '0,0 0,7|6,0 0,5|2,4 6,7',
  L: '0,0 0,7 6,7',
  M: '0,7 0,0 3,4 6,0 6,7',
  N: '0,7 0,0 6,7 6,0',
  O: '0,2 2,0 4,0 6,2 6,5 4,7 2,7 0,5 0,2',
  P: '0,7 0,0|0,0 4,0 6,2 6,3 4,5 0,5',
  Q: '0,2 2,0 4,0 6,2 6,5 4,7 2,7 0,5 0,2|4,5 6,8',
  R: '0,7 0,0|0,0 4,0 6,2 6,3 4,5 0,5|3,5 6,7',
  S: '6,1 4,0 2,0 0,2 0,3 2,4 4,4 6,5 6,6 4,7 2,7 0,6',
  T: '0,0 6,0|3,0 3,7',
  U: '0,0 0,5 2,7 4,7 6,5 6,0',
  V: '0,0 3,7 6,0',
  W: '0,0 2,7 3,4 4,7 6,0',
  X: '0,0 6,7|6,0 0,7',
  Y: '0,0 3,4 6,0|3,4 3,7',
  Z: '0,0 6,0 0,7 6,7',
  '0': '0,2 2,0 4,0 6,2 6,5 4,7 2,7 0,5 0,2|1,6 5,1',
  '1': '1,1 3,0 3,7|1,7 5,7',
  '2': '0,1 2,0 4,0 6,2 6,3 0,7 6,7',
  '3': '0,1 2,0 4,0 5,1 5,3 3,4|3,4 5,5 5,6 3,7 1,7 0,6',
  '4': '5,7 5,0 0,5 6,5',
  '5': '6,0 1,0 0,4 2,3 4,3 6,5 6,6 4,7 2,7 0,6',
  '6': '5,1 3,0 2,1 1,3 1,6 2,7 4,7 5,6 5,5 4,4 2,4 1,5',
  '7': '0,0 6,0 2,7',
  '8': '2,0 0,1 0,3 2,4 4,4 6,3 6,1 4,0 2,0|2,4 0,5 0,6 2,7 4,7 6,6 6,5 4,4',
  '9': '1,6 3,7 4,6 5,4 5,1 4,0 2,0 1,1 1,2 2,3 4,3 5,2',
  ' ': '',
  '.': '3,6 3,7',
  ',': '3,6 3,7 2,8.5',
  ':': '3,3 3,4|3,6 3,7',
  ';': '3,3 3,4|3,6 3,7 2,8.5',
  '!': '3,0 3,5|3,7 3,8',
  '?': '0,1 2,0 4,0 5,1 5,2 3,4 3,5|3,7 3,8',
  "'": '3,0 3,2',
  '"': '2,0 2,2|4,0 4,2',
  '(': '4,0 2,2 2,5 4,7',
  ')': '2,0 4,2 4,5 2,7',
  '[': '4,0 2,0 2,7 4,7',
  ']': '2,0 4,0 4,7 2,7',
  '-': '1,4 5,4',
  '·': '3,3 3,4',
  '/': '6,0 0,7',
  '\\': '0,0 6,7',
  '+': '3,2 3,6|0,4 6,4',
  '=': '0,3 6,3|0,5 6,5',
  '&': '6,7 2,3 2,1 3,0 4,1 4,2 1,5 1,6 2,7 4,7 6,5',
  '%': '6,0 0,7|0,0 2,0 2,2 0,2 0,0|4,5 6,5 6,7 4,7 4,5',
  '*': '3,2 3,5|1,2.5 5,4.5|5,2.5 1,4.5',
  '_': '0,8.5 6,8.5',
  '<': '5,2 1,4 5,6',
  '>': '1,2 5,4 1,6',
  '|': '3,-1 3,8',
  '#': '2,0 1,7|5,0 4,7|0,2 6,2|0,5 6,5',
  '$': '3,-0.5 3,7.5|6,1 4,0 2,0 0,1 0,2 2,3 4,3 6,4 6,6 4,7 2,7 0,6',
};

/** Combining marks drawn above (or below) the base glyph. */
const MARKS = {
  acute: '2.2,-1.4 4,-2.8',
  grave: '4,-1.4 2.2,-2.8',
  circumflex: '2,-1.4 3,-2.8 4,-1.4',
  tilde: '1.4,-1.9 2.6,-2.8 3.4,-1.4 4.6,-2.2',
  diaeresis: '2,-1.6 2,-2.2|4,-1.6 4,-2.2',
  ring: '2,-1.5 4,-1.5 4,-2.5 2,-2.5 2,-1.5',
  cedilla: '3,7 2.6,8 3.4,8.4',
  slash: '5,-0.6 1,7.6',
};

/** Unicode combining characters mapped to the marks above. */
const COMBINING_MARKS = {
  '\u0301': 'acute', // ˊ
  '\u0300': 'grave', // ˋ
  '\u0302': 'circumflex', // ˆ
  '\u0303': 'tilde', // ˜
  '\u0308': 'diaeresis', // ¨
  '\u030a': 'ring', // ˚
  '\u0327': 'cedilla', // ¸
  '\u0338': 'slash', // ̸ (used by Ø)
};

/** Characters replaced before drawing (typographic punctuation, symbols). */
const SUBSTITUTIONS = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2026': '...',
  '\u00b7': '·',
  '\u00d8': 'O\u0338',
};

const SUBSTITUTION_REGEX = new RegExp(`[${Object.keys(SUBSTITUTIONS).join('')}]`, 'g');
const MARK_REGEX = new RegExp(`[${Object.keys(COMBINING_MARKS).join('')}]`);
const pathCache = new Map();

/**
 * Parse "x,y x,y …" into a list of points, with a small cache since the same
 * glyph specs are drawn over and over.
 *
 * @param {string} spec
 * @returns {number[][]}
 */
function parsePath(spec) {
  if (pathCache.has(spec)) {
    return pathCache.get(spec);
  }

  const points = spec
    .trim()
    .split(/\s+/)
    .filter((point) => point !== '')
    .map((point) => point.split(',').map(Number));

  pathCache.set(spec, points);
  return points;
}

/**
 * Turn arbitrary text into drawable units: uppercase, typographic punctuation
 * replaced, decomposed so accents become separate marks, and every unknown
 * character swapped for a question mark.
 *
 * @param {string} text
 * @returns {Array<{char: string, marks: string[]}>}
 */
function normalize(text) {
  const replaced = String(text === null || text === undefined ? '' : text)
    .toUpperCase()
    .replace(SUBSTITUTION_REGEX, (char) => SUBSTITUTIONS[char]);
  const units = [];

  Array.from(replaced.normalize('NFD')).forEach((char) => {
    if (MARK_REGEX.test(char)) {
      const previous = units[units.length - 1];

      if (previous && previous.marks.length < 2) {
        previous.marks.push(COMBINING_MARKS[char]);
      }

      return;
    }

    if (char === '\u00a0' || char === '\t') {
      units.push({ char: ' ', marks: [] });
      return;
    }

    units.push({ char: GLYPHS[char] === undefined ? FALLBACK_GLYPH : char, marks: [] });
  });

  return units;
}

/**
 * @param {number} size cap height in pixels
 * @param {number} [letterSpacing] extra pixels between characters
 * @returns {number} the distance between the left edges of two characters.
 */
function advance(size, letterSpacing = 0) {
  return (ADVANCE / UNITS_HEIGHT) * size + letterSpacing;
}

/**
 * @param {string} text
 * @param {number} size
 * @param {number} [letterSpacing]
 * @returns {number} the rendered width in pixels.
 */
function measureText(text, size, letterSpacing = 0) {
  return normalize(text).length * advance(size, letterSpacing);
}

/**
 * Draw one glyph spec (glyphs and accent marks share this code path).
 *
 * @param {Object} canvas
 * @param {string} spec
 * @param {number} originX
 * @param {number} baseline
 * @param {number} scale pixels per grid unit
 * @param {number[]} color
 * @param {number} thickness
 * @param {number} alpha
 */
function drawSpec(canvas, spec, originX, baseline, scale, color, thickness, alpha) {
  if (!spec) {
    return;
  }

  spec.split('|').forEach((path) => {
    const points = parsePath(path);
    const toScreenY = (gridY) => baseline - (UNITS_HEIGHT - gridY) * scale;

    if (points.length === 1) {
      circle(canvas, originX + points[0][0] * scale, toScreenY(points[0][1]), thickness / 2, color, alpha);
      return;
    }

    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];

      line(
        canvas,
        originX + from[0] * scale,
        toScreenY(from[1]),
        originX + to[0] * scale,
        toScreenY(to[1]),
        color,
        thickness,
        alpha
      );
    }
  });
}

/**
 * Draw text with the stroke font.
 *
 * @param {Object} canvas
 * @param {string} text
 * @param {number} x left edge
 * @param {number} baseline y of the baseline
 * @param {{size: number, color: number[], letterSpacing?: number, thickness?: number, alpha?: number}} options
 * @returns {number} the drawn width in pixels.
 */
function drawText(canvas, text, x, baseline, options) {
  const {
    size,
    color,
    letterSpacing = 0,
    thickness = Math.max(1.5, size * DEFAULT_THICKNESS_RATIO),
    alpha = 1,
  } = options;
  const scale = size / UNITS_HEIGHT;
  const step = advance(size, letterSpacing);
  let cursor = x;

  normalize(text).forEach((unit) => {
    drawSpec(canvas, GLYPHS[unit.char], cursor, baseline, scale, color, thickness, alpha);
    unit.marks.forEach((mark) => {
      drawSpec(canvas, MARKS[mark], cursor, baseline, scale, color, thickness, alpha);
    });
    cursor += step;
  });

  return cursor - x;
}

/**
 * Largest size (between minimum and preferred) at which the text still fits.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} preferred
 * @param {number} minimum
 * @param {number} [letterSpacing]
 * @returns {number}
 */
function fitTextSize(text, maxWidth, preferred, minimum, letterSpacing = 0) {
  let size = preferred;

  while (size > minimum && measureText(text, size, letterSpacing) > maxWidth) {
    size -= 2;
  }

  return Math.max(size, minimum);
}

/**
 * Greedily wrap text into at most maxLines lines, ellipsizing the last one when
 * the rest does not fit (mirrors what the UI does with long titles).
 *
 * @param {string} text
 * @param {number} size
 * @param {number} maxWidth
 * @param {number} maxLines
 * @param {number} [letterSpacing]
 * @returns {{lines: string[], truncated: boolean}}
 */
function wrapText(text, size, maxWidth, maxLines, letterSpacing = 0) {
  const step = advance(size, letterSpacing);
  const maxChars = Math.max(1, Math.floor(maxWidth / step));
  const words = String(text === null || text === undefined ? '' : text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current === '' ? word : `${current} ${word}`;

    if (normalize(candidate).length <= maxChars) {
      current = candidate;
      return;
    }

    if (current !== '') {
      lines.push(current);
      current = '';
    }

    // A single word longer than a whole line: cut it hard.
    let rest = word;

    while (normalize(rest).length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }

    current = rest;
  });

  if (current !== '') {
    lines.push(current);
  }

  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }

  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = normalize(last).length + 3 <= maxChars
    ? `${last}...`
    : `${last.slice(0, Math.max(0, maxChars - 3))}...`;

  return { lines: kept, truncated: true };
}

module.exports = {
  ADVANCE,
  UNITS_HEIGHT,
  drawText,
  fitTextSize,
  measureText,
  normalize,
  wrapText,
};
