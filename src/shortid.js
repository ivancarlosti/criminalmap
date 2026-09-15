'use strict';

/**
 * Short ID generator for saved maps.
 *
 * IDs are random strings drawn from an alphabet that always contains lowercase
 * letters, optionally extended with uppercase letters and digits (both toggled
 * from the admin panel). Collisions are retried, and the generator grows the
 * ID by one character per level when the configured length keeps colliding.
 */

const crypto = require('crypto');

const settings = require('./settings');

const DEFAULT_LENGTH = 6;
const MIN_LENGTH = 3;
const MAX_LENGTH = 32;
const ATTEMPTS_PER_LEVEL = 100;
const EXTRA_LEVELS = 5;

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

/**
 * @returns {number} the configured ID length, clamped to a sane range.
 */
function length() {
  const configured = settings.shortIdLength();
  return configured >= MIN_LENGTH && configured <= MAX_LENGTH ? configured : DEFAULT_LENGTH;
}

/**
 * @returns {string} the alphabet built from the configured options.
 */
function alphabet() {
  let chars = LOWERCASE;

  if (settings.shortIdUppercase()) {
    chars += UPPERCASE;
  }

  if (settings.shortIdNumbers()) {
    chars += DIGITS;
  }

  return chars;
}

/**
 * Generate a single random ID.
 *
 * @param {number} [size]
 * @param {string} [chars]
 * @returns {string}
 */
function generate(size = length(), chars = alphabet()) {
  const max = chars.length - 1;
  let id = '';

  for (let index = 0; index < size; index += 1) {
    id += chars[crypto.randomInt(0, max + 1)];
  }

  return id;
}

/**
 * Generate an ID that does not exist yet in the maps table.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<string>}
 */
async function uniqueForPool(pool) {
  const baseLength = length();
  const chars = alphabet();

  for (let level = 0; level <= EXTRA_LEVELS; level += 1) {
    const currentLength = baseLength + level;

    for (let attempt = ATTEMPTS_PER_LEVEL; attempt > 0; attempt -= 1) {
      const candidate = generate(currentLength, chars);
      const [rows] = await pool.query('SELECT id FROM maps WHERE short_id = ? LIMIT 1', [candidate]);

      if (rows.length === 0) {
        return candidate;
      }
    }
  }

  throw new Error('Unable to generate a unique map short ID after retrying with longer lengths.');
}

module.exports = {
  ATTEMPTS_PER_LEVEL,
  DEFAULT_LENGTH,
  EXTRA_LEVELS,
  MAX_LENGTH,
  MIN_LENGTH,
  alphabet,
  generate,
  length,
  uniqueForPool,
};
