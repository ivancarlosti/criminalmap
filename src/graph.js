'use strict';

/**
 * Scratch graph access.
 *
 * The scratch graph is the working canvas rendered at "/" and stored in the
 * `nodes` / `edges` tables. Saved maps keep their own snapshot tables (see
 * src/maps.js) so publishing never mutates the working canvas.
 */

const { getPool } = require('./db');

/**
 * Convert a sources_json column value into a plain JavaScript array.
 * Handles both already-parsed JSON (mysql2 may auto-parse) and raw strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function parseSourcesJson(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Read the full scratch graph (nodes + edges).
 *
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
async function fetchGraph(pool = getPool()) {
  const [nodeRows] = await pool.query('SELECT id, label, type FROM nodes ORDER BY id ASC');
  const [edgeRows] = await pool.query(
    'SELECT id, from_node, to_node, topic_description, sources_json FROM edges ORDER BY id ASC'
  );

  const nodes = nodeRows.map((row) => ({
    id: row.id,
    label: row.label,
    type: row.type,
  }));

  const edges = edgeRows.map((row) => ({
    id: row.id,
    from: row.from_node,
    to: row.to_node,
    topic_description: row.topic_description,
    sources: parseSourcesJson(row.sources_json),
  }));

  return { nodes, edges };
}

/**
 * Remove every node and edge from the scratch graph.
 *
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<{nodes: number, edges: number}>}
 */
async function clearGraph(pool = getPool()) {
  const [edgeResult] = await pool.query('DELETE FROM edges');
  const [nodeResult] = await pool.query('DELETE FROM nodes');

  return {
    nodes: Number(nodeResult.affectedRows) || 0,
    edges: Number(edgeResult.affectedRows) || 0,
  };
}

module.exports = { clearGraph, fetchGraph, parseSourcesJson };
