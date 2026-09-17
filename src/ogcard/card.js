'use strict';

/**
 * OpenGraph card composition (1200x630, the 1.91:1 ratio recommended by
 * Facebook/LinkedIn and required by X/Twitter for summary_large_image).
 *
 * The card is drawn with the primitives of ./draw.js and the stroke font of
 * ./font.js: a "case file" header with the site identity, the map title, its
 * description, the entity/connection counts, the short URL and — on the right —
 * a sketch of the network itself using the same post-it palette as the graph in
 * the browser (see public/js/app.js).
 */

const { createCanvas, encodePng } = require('./png');
const draw = require('./draw');
const font = require('./font');

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

// Kept in sync with the palette of public/js/app.js so a card always matches
// the graph rendered in the browser.
const POST_IT_PALETTE = [
  { background: '#FFF59D', border: '#C9B458' },
  { background: '#FFCC80', border: '#C9933D' },
  { background: '#F48FB1', border: '#B85C7E' },
  { background: '#90CAF9', border: '#4E8BB5' },
  { background: '#A5D6A7', border: '#5E8A61' },
  { background: '#CE93D8', border: '#8E5FA0' },
  { background: '#FFAB91', border: '#B86A50' },
  { background: '#80CBC4', border: '#468A83' },
];

// Mirrors the CSS custom properties of public/css/style.css.
const THEMES = {
  dark: {
    background: '#0e0e10',
    panel: '#101014',
    panelBorder: '#2a2a30',
    border: '#2a2a30',
    text: '#e8e2d5',
    muted: '#9a938a',
    accent: '#e6b84c',
    accentBright: '#f5cb6b',
    edge: '#e6b84c',
    glow: 0.1,
    stripes: 0.014,
  },
  light: {
    background: '#f5efe2',
    panel: '#fdfaf2',
    panelBorder: '#d9cdb6',
    border: '#d9cdb6',
    text: '#2b2419',
    muted: '#6f6656',
    accent: '#a8761f',
    accentBright: '#8c6216',
    edge: '#a8761f',
    glow: 0.14,
    stripes: 0.02,
  },
};

const LAYOUT = {
  padding: 64,
  headerBaseline: 86,
  dividerY: 112,
  textTop: 150,
  textWidth: 660,
  panelX: 790,
  panelY: 150,
  panelWidth: 344,
  panelHeight: 360,
  footerBaseline: 590,
  maxSketchNodes: 24,
};

/** Simple deterministic 32-bit string hash (djb2 variant), as in app.js. */
function hashString(value) {
  let hash = 5381;
  const text = String(value);

  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

/** @param {string} label @returns {{background: string, border: string}} */
function colorForLabel(label) {
  return POST_IT_PALETTE[hashString(label) % POST_IT_PALETTE.length];
}

/**
 * Deterministic sketch layout: nodes are sorted by degree and placed on up to
 * three concentric rings, so hubs sit in the middle and the result is stable
 * (and never overlapping) for a given graph.
 *
 * @param {Array<{id: number|string}>} nodes
 * @param {Array<{from: number|string, to: number|string}>} edges
 * @param {{x: number, y: number, width: number, height: number}} box
 * @returns {Map<number|string, {x: number, y: number}>}
 */
function layoutSketch(nodes, edges, box) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));

  edges.forEach((edge) => {
    if (degree.has(edge.from)) {
      degree.set(edge.from, degree.get(edge.from) + 1);
    }

    if (degree.has(edge.to)) {
      degree.set(edge.to, degree.get(edge.to) + 1);
    }
  });

  const ordered = nodes
    .slice()
    .sort((a, b) => (degree.get(b.id) - degree.get(a.id)) || (hashString(a.id) - hashString(b.id)));

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const positions = new Map();

  // Rings grow with the graph: a small network uses one or two rings so the
  // nodes fill the panel instead of leaving the middle rings empty.
  const total = ordered.length;
  const inner = total <= 4 ? total : (total <= 12 ? Math.ceil(total / 3) : 3);
  const middle = total <= 4 ? 0 : (total <= 12 ? total - inner : 8);
  const outer = total - inner - middle;
  const rings = [
    { count: inner, radius: 0 },
    { count: middle, radius: 0 },
    { count: outer, radius: 0 },
  ].filter((ring) => ring.count > 0);

  // Fewer rings means bigger radii, so a small graph still fills the panel.
  const radii = rings.length === 1 ? [0.55] : (rings.length === 2 ? [0.36, 0.8] : [0.33, 0.66, 0.95]);

  rings.forEach((ring, position) => {
    ring.radius = radii[position];
  });

  let index = 0;

  rings.forEach((ring) => {
    const slice = ordered.slice(index, index + ring.count);
    index += ring.count;

    slice.forEach((node, position) => {
      if (slice.length === 1) {
        positions.set(node.id, { x: centerX, y: centerY });
        return;
      }

      const angle = (position / slice.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * (box.width / 2) * ring.radius,
        y: centerY + Math.sin(angle) * (box.height / 2) * ring.radius,
      });
    });
  });

  return positions;
}

/**
 * Draw a right-aligned line of text inside the card padding.
 *
 * @param {Object} canvas
 * @param {string} text
 * @param {number} baseline
 * @param {{size: number, color: number[], letterSpacing?: number, alpha?: number}} options
 */
function drawRightAligned(canvas, text, baseline, options) {
  const spacing = options.letterSpacing || 0;
  const width = font.measureText(text, options.size, spacing);

  font.drawText(canvas, text, CARD_WIDTH - LAYOUT.padding - width, baseline, options);
}

/**
 * Card header: site identity on the left, domain on the right, then a separator.
 *
 * @param {Object} canvas
 * @param {{branding: Object, colors: Object, border: number[]}} context
 */
function drawHeader(canvas, context) {
  const { branding, colors, border } = context;
  const siteTitle = String(branding.siteTitle || '').trim();

  if (siteTitle !== '') {
    const size = font.fitTextSize(siteTitle, LAYOUT.textWidth, 26, 16, 3);
    font.drawText(canvas, siteTitle, LAYOUT.padding, LAYOUT.headerBaseline, {
      size,
      color: colors.accent,
      letterSpacing: 3,
    });
  }

  drawRightAligned(canvas, branding.domain || '', LAYOUT.headerBaseline, {
    size: 20,
    color: colors.muted,
    letterSpacing: 1,
  });

  draw.fillRect(canvas, LAYOUT.padding, LAYOUT.dividerY, CARD_WIDTH - LAYOUT.padding * 2, 1, border, 0.65);
}

/**
 * Card footer: the short URL of the map and the configured domain.
 *
 * @param {Object} canvas
 * @param {{map: Object, branding: Object, colors: Object}} context
 */
function drawFooter(canvas, context) {
  const { map, branding, colors } = context;
  const path = `${String(branding.prefix || '').replace(/\/+$/, '')}/${map.short_id || ''}`;

  font.drawText(canvas, path, LAYOUT.padding, LAYOUT.footerBaseline, {
    size: 20,
    color: colors.muted,
    letterSpacing: 1,
  });

  if (branding.updated) {
    drawRightAligned(canvas, branding.updated, LAYOUT.footerBaseline, {
      size: 20,
      color: colors.muted,
      letterSpacing: 1,
    });
  }
}

/**
 * Text block: map title (up to two lines, auto-sized), description, counts.
 *
 * @param {Object} canvas
 * @param {{map: Object, labels: Object, colors: Object}} context
 * @returns {number} the y where the block ended (for reference/debugging).
 */
function drawTextBlock(canvas, context) {
  const { map, labels, colors } = context;
  const x = LAYOUT.padding;
  const width = LAYOUT.textWidth;
  const title = String(map.title || '').trim();

  // Largest size at which the title wraps into at most two lines.
  let size = 64;
  let wrapped = { lines: [], truncated: true };

  while (size > 34) {
    wrapped = font.wrapText(title, size, width, 2);

    if (!wrapped.truncated && wrapped.lines.length <= 2) {
      break;
    }

    size -= 2;
  }

  let baseline = LAYOUT.textTop + size;

  wrapped.lines.forEach((line) => {
    font.drawText(canvas, line, x, baseline, { size, color: colors.text });
    baseline = baseline + Math.round(size * 1.05);
  });

  const lastBaseline = baseline - Math.round(size * 1.05);
  const ruleY = lastBaseline + 26;

  draw.fillRect(canvas, x, ruleY, Math.min(160, width), 4, colors.accent);

  const description = String(map.description || '').trim();
  let descriptionBaseline = ruleY + 46;

  if (description !== '') {
    font.wrapText(description, 26, width, 2).lines.forEach((line) => {
      font.drawText(canvas, line, x, descriptionBaseline, { size: 26, color: colors.muted });
      descriptionBaseline += 34;
    });
  }

  const entityCount = Array.isArray(context.graph.nodes) ? context.graph.nodes.length : 0;
  const edgeCount = Array.isArray(context.graph.edges) ? context.graph.edges.length : 0;
  const summary = entityCount === 0
    ? (labels.empty || '')
    : `${entityCount} ${labels.entities || ''}   ·   ${edgeCount} ${labels.connections || ''}`;

  font.drawText(canvas, summary, x, LAYOUT.footerBaseline - 70, {
    size: 24,
    color: colors.accentBright,
    letterSpacing: 2,
  });

  return ruleY;
}

/**
 * Network sketch panel: the same post-it boxes and gold connections the browser
 * renders, placed on deterministic rings so hubs end up in the centre.
 *
 * @param {Object} canvas
 * @param {{graph: Object, labels: Object, colors: Object, border: number[], panel: number[]}} context
 */
function drawSketch(canvas, context) {
  const { graph, labels, colors, border, panel } = context;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const box = {
    x: LAYOUT.panelX,
    y: LAYOUT.panelY,
    width: LAYOUT.panelWidth,
    height: LAYOUT.panelHeight,
  };

  draw.fillRoundedRect(canvas, box.x, box.y, box.width, box.height, 12, panel);
  draw.strokeRoundedRect(canvas, box.x, box.y, box.width, box.height, 12, border, 2);

  const drawn = nodes.slice(0, LAYOUT.maxSketchNodes);
  const area = {
    x: box.x + 30,
    y: box.y + 62,
    width: box.width - 60,
    height: box.height - 92,
  };

  // The sketch is laid out inside the padded area, so it fills the panel.
  const degreeOrdered = layoutSketch(nodes, edges, area);
  const overflow = Math.max(0, nodes.length - drawn.length);
  const caption = overflow > 0 ? `${labels.network || ''} +${overflow}` : (labels.network || '');

  font.drawText(canvas, caption, box.x + 20, box.y + 36, {
    size: 18,
    color: colors.muted,
    letterSpacing: 2,
  });

  if (nodes.length === 0) {
    const empty = font.wrapText(labels.empty || '', 18, area.width, 3).lines;

    empty.forEach((line, index) => {
      font.drawText(canvas, line, area.x, area.y + area.height / 2 + index * 26, {
        size: 18,
        color: colors.muted,
        letterSpacing: 1,
      });
    });

    return;
  }

  const nodeWidth = drawn.length > 16 ? 26 : (drawn.length > 8 ? 32 : 42);
  const nodeHeight = Math.round(nodeWidth * 0.72);
  const drawnIds = new Set(drawn.map((node) => node.id));

  edges.forEach((edge) => {
    const from = degreeOrdered.get(edge.from);
    const to = degreeOrdered.get(edge.to);

    if (!from || !to || !drawnIds.has(edge.from) || !drawnIds.has(edge.to)) {
      return;
    }

    draw.line(canvas, from.x, from.y, to.x, to.y, colors.edge, 2, 0.55);
  });

  drawn.forEach((node) => {
    const position = degreeOrdered.get(node.id);

    if (!position) {
      return;
    }

    const palette = colorForLabel(node.label);
    const x = position.x - nodeWidth / 2;
    const y = position.y - nodeHeight / 2;

    draw.fillRoundedRect(canvas, x, y, nodeWidth, nodeHeight, 4, draw.parseHex(palette.background));
    draw.strokeRoundedRect(canvas, x, y, nodeWidth, nodeHeight, 4, draw.parseHex(palette.border), 2);
  });
}

/**
 * Render the OpenGraph card of a saved map.
 *
 * @param {Object} input
 * @param {{short_id: string, title: string, description?: string}} input.map map row
 * @param {{nodes?: Array, edges?: Array}} [input.graph] graph payload from src/maps.js
 * @param {{entities?: string, connections?: string, network?: string, empty?: string}} [input.labels] localized card words
 * @param {{siteTitle?: string, domain?: string, prefix?: string, theme?: string, updated?: string}} [input.branding]
 * @returns {Buffer} PNG bytes (1200x630)
 */
function renderMapCard(input = {}) {
  const map = input.map || {};
  const graphInput = input.graph || {};
  const graph = {
    nodes: Array.isArray(graphInput.nodes) ? graphInput.nodes : [],
    edges: Array.isArray(graphInput.edges) ? graphInput.edges : [],
  };
  const labels = input.labels || {};
  const branding = input.branding || {};
  const theme = THEMES[branding.theme === 'light' ? 'light' : 'dark'];
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT, draw.parseHex(theme.background));
  const colors = {
    accent: draw.parseHex(theme.accent),
    accentBright: draw.parseHex(theme.accentBright),
    text: draw.parseHex(theme.text),
    muted: draw.parseHex(theme.muted),
    edge: draw.parseHex(theme.edge),
  };
  const border = draw.parseHex(theme.border);
  const panel = draw.parseHex(theme.panel);

  // Background: the diagonal texture and the warm glow the UI is built around.
  draw.diagonalStripes(canvas, draw.parseHex(theme.text), theme.stripes);
  draw.radialGlow(canvas, CARD_WIDTH / 2, -120, 900, colors.accent, theme.glow);
  draw.fillRect(canvas, 0, 0, CARD_WIDTH, 6, colors.accent);
  draw.strokeRoundedRect(canvas, 1, 1, CARD_WIDTH - 2, CARD_HEIGHT - 2, 2, border, 2);

  drawHeader(canvas, { branding, colors, border });
  drawTextBlock(canvas, { map, graph, labels, colors });
  drawSketch(canvas, { graph, labels, colors, border, panel });
  drawFooter(canvas, { map, branding, colors });

  return encodePng(canvas);
}

module.exports = {
  CARD_HEIGHT,
  CARD_WIDTH,
  LAYOUT,
  POST_IT_PALETTE,
  THEMES,
  colorForLabel,
  hashString,
  layoutSketch,
  renderMapCard,
};
