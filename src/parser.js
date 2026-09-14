'use strict';

/**
 * Text parser for investigation network graph relations.
 *
 * Expected line syntax:
 *   [Node A] -> [Node B] : Topic/Description | Fontes: url1, url2, url3
 *
 * The "Fontes:" (sources) part is optional. When present but empty, the parsed
 * relation gets an empty sources array.
 */

const RELATION_REGEX = /^\s*\[([^\]]+)\]\s*->\s*\[([^\]]+)\]\s*:\s*([^|]*?)\s*(?:\|\s*Fontes\s*:\s*(.*))?\s*$/i;

/**
 * Parse a block of text and return a detailed result containing both the
 * successfully parsed relations and any invalid lines (for API reporting).
 *
 * @param {string} text
 * @returns {{ relations: Array<{from: string, to: string, topic: string, sources: string[]}>, invalidLines: Array<{line: number, text: string}> }}
 */
function parseTextWithDetails(text) {
  const relations = [];
  const invalidLines = [];

  if (typeof text !== 'string') {
    return { relations, invalidLines };
  }

  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    // Skip blank lines.
    if (rawLine.trim() === '') {
      return;
    }

    const match = rawLine.match(RELATION_REGEX);

    if (!match) {
      invalidLines.push({ line: index + 1, text: rawLine });
      return;
    }

    const from = match[1].trim();
    const to = match[2].trim();
    const topic = match[3].trim();
    const sourcesRaw = match[4] !== undefined ? match[4] : '';

    // Split the sources by comma, trim each entry, and drop empty entries.
    const sources = sourcesRaw
      .split(',')
      .map((source) => source.trim())
      .filter((source) => source.length > 0);

    relations.push({ from, to, topic, sources });
  });

  return { relations, invalidLines };
}

/**
 * Parse a block of text and return only the successfully parsed relations.
 *
 * @param {string} text
 * @returns {Array<{from: string, to: string, topic: string, sources: string[]}>}
 */
function parseText(text) {
  return parseTextWithDetails(text).relations;
}

module.exports = { RELATION_REGEX, parseText, parseTextWithDetails };
