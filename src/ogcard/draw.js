'use strict';

/**
 * Raster primitives used by the OpenGraph card renderer.
 *
 * Everything works directly on the RGB buffer created by ./png.js. Curves and
 * diagonals are anti-aliased with coverage computed from a signed distance
 * field, which keeps the code compact while still producing the crisp edges a
 * card needs (the alternative would be a per-pixel sampler plus a lot more
 * bookkeeping for very little visual gain at this scale).
 */

/** @param {number} value @param {number} min @param {number} max @returns {number} */
function clamp(value, min, max) {
  if (value < min) {
    return min;
  }

  return value > max ? max : value;
}

/**
 * Parse a "#rrggbb" (or "#rgb") colour into an RGB triplet.
 *
 * @param {string} hex
 * @returns {number[]}
 */
function parseHex(hex) {
  const value = String(hex).replace('#', '').trim();
  const full = value.length === 3
    ? value.split('').map((char) => `${char}${char}`).join('')
    : value;

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Blend one pixel over the canvas.
 *
 * @param {{width: number, height: number, data: Buffer}} canvas
 * @param {number} x
 * @param {number} y
 * @param {number[]} color RGB triplet
 * @param {number} alpha 0..1
 */
function blendPixel(canvas, x, y, color, alpha) {
  const px = Math.round(x);
  const py = Math.round(y);

  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height || alpha <= 0) {
    return;
  }

  const offset = (py * canvas.width + px) * 3;
  const amount = clamp(alpha, 0, 1);

  if (amount >= 1) {
    canvas.data[offset] = color[0];
    canvas.data[offset + 1] = color[1];
    canvas.data[offset + 2] = color[2];
    return;
  }

  canvas.data[offset] = Math.round(canvas.data[offset] + (color[0] - canvas.data[offset]) * amount);
  canvas.data[offset + 1] = Math.round(canvas.data[offset + 1] + (color[1] - canvas.data[offset + 1]) * amount);
  canvas.data[offset + 2] = Math.round(canvas.data[offset + 2] + (color[2] - canvas.data[offset + 2]) * amount);
}

/**
 * Axis aligned rectangle.
 *
 * @param {Object} canvas
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number[]} color
 * @param {number} [alpha]
 */
function fillRect(canvas, x, y, width, height, color, alpha = 1) {
  const left = Math.round(x);
  const top = Math.round(y);
  const right = Math.round(x + width);
  const bottom = Math.round(y + height);

  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      blendPixel(canvas, px, py, color, alpha);
    }
  }
}

/**
 * Signed distance from a point to a rounded rectangle.
 *
 * @param {number} px
 * @param {number} py
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} halfWidth
 * @param {number} halfHeight
 * @param {number} radius
 * @returns {number} negative inside, positive outside
 */
function roundedRectDistance(px, py, centerX, centerY, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - centerX) - (halfWidth - radius);
  const dy = Math.abs(py - centerY) - (halfHeight - radius);
  const outsideX = Math.max(dx, 0);
  const outsideY = Math.max(dy, 0);

  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Filled rounded rectangle (post-it style boxes, panels).
 *
 * @param {Object} canvas
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {number[]} color
 * @param {number} [alpha]
 */
function fillRoundedRect(canvas, x, y, width, height, radius, color, alpha = 1) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = x + halfWidth;
  const centerY = y + halfHeight;
  const corner = Math.min(radius, halfWidth, halfHeight);
  const left = Math.floor(x - 1);
  const top = Math.floor(y - 1);
  const right = Math.ceil(x + width + 1);
  const bottom = Math.ceil(y + height + 1);

  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const distance = roundedRectDistance(px + 0.5, py + 0.5, centerX, centerY, halfWidth, halfHeight, corner);
      const coverage = clamp(0.5 - distance, 0, 1);

      if (coverage > 0) {
        blendPixel(canvas, px, py, color, alpha * coverage);
      }
    }
  }
}

/**
 * Rounded rectangle outline (the border of a post-it or of the graph panel).
 *
 * @param {Object} canvas
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {number[]} color
 * @param {number} [thickness]
 * @param {number} [alpha]
 */
function strokeRoundedRect(canvas, x, y, width, height, radius, color, thickness = 2, alpha = 1) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = x + halfWidth;
  const centerY = y + halfHeight;
  const corner = Math.min(radius, halfWidth, halfHeight);
  const half = thickness / 2;
  const left = Math.floor(x - thickness - 1);
  const top = Math.floor(y - thickness - 1);
  const right = Math.ceil(x + width + thickness + 1);
  const bottom = Math.ceil(y + height + thickness + 1);

  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const distance = roundedRectDistance(px + 0.5, py + 0.5, centerX, centerY, halfWidth, halfHeight, corner);
      const coverage = clamp(half + 0.5 - Math.abs(distance), 0, 1);

      if (coverage > 0) {
        blendPixel(canvas, px, py, color, alpha * coverage);
      }
    }
  }
}

/**
 * Anti-aliased line segment with a given thickness (used for the stroke font
 * and for the edges of the graph sketch).
 *
 * @param {Object} canvas
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number[]} color
 * @param {number} [thickness]
 * @param {number} [alpha]
 */
function line(canvas, x0, y0, x1, y1, color, thickness = 2, alpha = 1) {
  const half = thickness / 2;
  const reach = half + 1;
  const left = Math.floor(Math.min(x0, x1) - reach);
  const top = Math.floor(Math.min(y0, y1) - reach);
  const right = Math.ceil(Math.max(x0, x1) + reach);
  const bottom = Math.ceil(Math.max(y0, y1) + reach);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;

  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const sampleX = px + 0.5;
      const sampleY = py + 0.5;
      let t = 0;

      if (lengthSquared > 0) {
        t = clamp(((sampleX - x0) * dx + (sampleY - y0) * dy) / lengthSquared, 0, 1);
      }

      const distance = Math.hypot(sampleX - (x0 + t * dx), sampleY - (y0 + t * dy));
      const coverage = clamp(half + 0.5 - distance, 0, 1);

      if (coverage > 0) {
        blendPixel(canvas, px, py, color, alpha * coverage);
      }
    }
  }
}

/**
 * Anti-aliased filled circle.
 *
 * @param {Object} canvas
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} radius
 * @param {number[]} color
 * @param {number} [alpha]
 */
function circle(canvas, centerX, centerY, radius, color, alpha = 1) {
  const left = Math.floor(centerX - radius - 1);
  const top = Math.floor(centerY - radius - 1);
  const right = Math.ceil(centerX + radius + 1);
  const bottom = Math.ceil(centerY + radius + 1);

  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const distance = Math.hypot(px + 0.5 - centerX, py + 0.5 - centerY);
      const coverage = clamp(radius + 0.5 - distance, 0, 1);

      if (coverage > 0) {
        blendPixel(canvas, px, py, color, alpha * coverage);
      }
    }
  }
}

/**
 * Soft radial glow, used for the warm "case file" light of the background.
 *
 * @param {Object} canvas
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} radius
 * @param {number[]} color
 * @param {number} [alpha]
 */
function radialGlow(canvas, centerX, centerY, radius, color, alpha = 0.1) {
  const left = Math.max(0, Math.floor(centerX - radius));
  const top = Math.max(0, Math.floor(centerY - radius));
  const right = Math.min(canvas.width - 1, Math.ceil(centerX + radius));
  const bottom = Math.min(canvas.height - 1, Math.ceil(centerY + radius));

  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const distance = Math.hypot(px + 0.5 - centerX, py + 0.5 - centerY);

      if (distance >= radius) {
        continue;
      }

      const falloff = 1 - distance / radius;
      blendPixel(canvas, px, py, color, alpha * falloff * falloff);
    }
  }
}

/**
 * Subtle 45 degree stripes, mirroring the repeating gradient of the UI.
 *
 * @param {Object} canvas
 * @param {number[]} color
 * @param {number} [alpha]
 * @param {number} [period] distance between stripes in pixels
 */
function diagonalStripes(canvas, color, alpha = 0.02, period = 14) {
  for (let py = 0; py < canvas.height; py += 1) {
    for (let px = 0; px < canvas.width; px += 1) {
      if ((px + py) % period === 0) {
        blendPixel(canvas, px, py, color, alpha);
      }
    }
  }
}

module.exports = {
  circle,
  diagonalStripes,
  fillRect,
  fillRoundedRect,
  line,
  parseHex,
  radialGlow,
  strokeRoundedRect,
};
