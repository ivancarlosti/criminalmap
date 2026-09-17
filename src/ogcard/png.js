'use strict';

/**
 * Minimal 8-bit RGB canvas and PNG encoder.
 *
 * The OpenGraph cards are rendered by this project itself (see src/ogcard/), so
 * that no image dependency is required: pixels are painted into a plain Buffer
 * and written as a PNG using Node's own zlib for the compression step. The
 * output is a standard 8-bit truecolour PNG (colour type 2) with one IDAT chunk
 * and the "none" filter per scanline — more than enough for the flat colours of
 * a card, and it keeps the encoder small enough to audit.
 */

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGB = 2;
const BIT_DEPTH = 8;

// CRC-32 (IEEE 802.3) lookup table, built once on load.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let value = n;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[n] = value;
  }

  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number} the CRC-32 checksum of the buffer (unsigned).
 */
function crc32(buffer) {
  let crc = -1;

  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ -1) >>> 0;
}

/**
 * Build one PNG chunk: length + type + data + CRC.
 *
 * @param {string} type four ASCII characters (IHDR, IDAT, IEND, …)
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'latin1');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/**
 * Create an RGB canvas filled with a solid colour.
 *
 * @param {number} width
 * @param {number} height
 * @param {number[]} [background] RGB triplet, black by default
 * @returns {{width: number, height: number, data: Buffer}}
 */
function createCanvas(width, height, background = [0, 0, 0]) {
  const data = Buffer.alloc(width * height * 3);
  const red = background[0] || 0;
  const green = background[1] || 0;
  const blue = background[2] || 0;

  for (let offset = 0; offset < data.length; offset += 3) {
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
  }

  return { width, height, data };
}

/**
 * Encode a canvas as a PNG buffer.
 *
 * @param {{width: number, height: number, data: Buffer}} canvas
 * @returns {Buffer}
 */
function encodePng(canvas) {
  const { width, height, data } = canvas;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);

    // Filter type 0 ("none") followed by the scanline itself.
    raw[target] = 0;
    data.copy(raw, target + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGB;
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { createCanvas, encodePng };
