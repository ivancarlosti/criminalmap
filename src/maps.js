'use strict';

/**
 * Saved map repository.
 *
 * A saved map is a snapshot of the scratch graph (src/graph.js) stored in the
 * `maps` / `map_nodes` / `map_edges` tables. Only administrators create,
 * replace or delete maps; everybody can read a public map through its short URL.
 */

const { getPool } = require('./db');
const { parseSourcesJson } = require('./graph');
const { uniqueForPool } = require('./shortid');

const TITLE_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Normalize a user supplied title.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTitle(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_LENGTH);
}

/**
 * Normalize a user supplied description (newlines are preserved).
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDescription(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, DESCRIPTION_MAX_LENGTH);
}

/**
 * List every saved map with its node/edge counts.
 *
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Array>}
 */
async function listMaps(pool = getPool()) {
  const [rows] = await pool.query(
    `SELECT m.id, m.short_id, m.title, m.description, m.is_public, m.created_at, m.updated_at,
            (SELECT COUNT(*) FROM map_nodes n WHERE n.map_id = m.id) AS node_count,
            (SELECT COUNT(*) FROM map_edges e WHERE e.map_id = m.id) AS edge_count
       FROM maps m
      ORDER BY m.updated_at DESC, m.id DESC`
  );

  return rows.map((row) => ({
    id: row.id,
    short_id: row.short_id,
    title: row.title,
    description: row.description || '',
    is_public: Number(row.is_public) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    node_count: Number(row.node_count) || 0,
    edge_count: Number(row.edge_count) || 0,
  }));
}

/**
 * Find a saved map by primary key.
 *
 * @param {number|string} id
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Object|null>}
 */
async function findMapById(id, pool = getPool()) {
  const mapId = Number.parseInt(id, 10);

  if (!Number.isInteger(mapId) || mapId <= 0) {
    return null;
  }

  const [rows] = await pool.query(
    'SELECT id, short_id, title, description, is_public, created_at, updated_at FROM maps WHERE id = ? LIMIT 1',
    [mapId]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  return {
    id: row.id,
    short_id: row.short_id,
    title: row.title,
    description: row.description || '',
    is_public: Number(row.is_public) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Find a saved map by its short ID.
 *
 * @param {string} shortId
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Object|null>}
 */
async function findMapByShortId(shortId, pool = getPool()) {
  const value = String(shortId || '').trim();

  if (value === '') {
    return null;
  }

  const [rows] = await pool.query(
    'SELECT id, short_id, title, description, is_public, created_at, updated_at FROM maps WHERE short_id = ? LIMIT 1',
    [value]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  return {
    id: row.id,
    short_id: row.short_id,
    title: row.title,
    description: row.description || '',
    is_public: Number(row.is_public) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Read a saved map's graph (nodes + edges).
 *
 * @param {number} mapId
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
async function fetchMapGraph(mapId, pool = getPool()) {
  const [nodeRows] = await pool.query(
    'SELECT id, label, type FROM map_nodes WHERE map_id = ? ORDER BY id ASC',
    [mapId]
  );
  const [edgeRows] = await pool.query(
    `SELECT id, from_node, to_node, topic_description, sources_json
       FROM map_edges WHERE map_id = ? ORDER BY id ASC`,
    [mapId]
  );

  return {
    nodes: nodeRows.map((row) => ({ id: row.id, label: row.label, type: row.type })),
    edges: edgeRows.map((row) => ({
      id: row.id,
      from: row.from_node,
      to: row.to_node,
      topic_description: row.topic_description,
      sources: parseSourcesJson(row.sources_json),
    })),
  };
}

/**
 * Copy every scratch node into the given map.
 *
 * @param {number} mapId
 * @param {import('mysql2/promise').Pool} pool
 */
async function copyScratchNodesIntoMap(mapId, pool) {
  await pool.query(
    'INSERT INTO map_nodes (map_id, label, type) SELECT ?, label, type FROM nodes',
    [mapId]
  );
}

/**
 * Copy every scratch edge into the given map, resolving node IDs by label.
 *
 * @param {number} mapId
 * @param {import('mysql2/promise').Pool} pool
 */
async function copyScratchEdgesIntoMap(mapId, pool) {
  await pool.query(
    `INSERT INTO map_edges (map_id, from_node, to_node, topic_description, sources_json)
     SELECT ?, nf.id, nt.id, e.topic_description, e.sources_json
       FROM edges e
       JOIN nodes src_from ON src_from.id = e.from_node
       JOIN nodes src_to   ON src_to.id   = e.to_node
       JOIN map_nodes nf   ON nf.map_id = ? AND nf.label = src_from.label
       JOIN map_nodes nt   ON nt.map_id = ? AND nt.label = src_to.label`,
    [mapId, mapId, mapId]
  );
}

/**
 * Freeze the current scratch graph into a brand new saved map.
 *
 * @param {{title: string, description?: string, isPublic?: boolean}} input
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Object|null>}
 */
async function createMapFromScratch(input, pool = getPool()) {
  const title = normalizeTitle(input.title) || 'Untitled map';
  const description = normalizeDescription(input.description);
  const isPublic = input.isPublic === false ? 0 : 1;
  const shortId = await uniqueForPool(pool);

  const [result] = await pool.query(
    'INSERT INTO maps (short_id, title, description, is_public) VALUES (?, ?, ?, ?)',
    [shortId, title, description, isPublic]
  );

  const mapId = Number(result.insertId);

  await copyScratchNodesIntoMap(mapId, pool);
  await copyScratchEdgesIntoMap(mapId, pool);

  return findMapById(mapId, pool);
}

/**
 * Replace a saved map's snapshot with the current scratch graph.
 *
 * @param {number} mapId
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Object|null>}
 */
async function replaceMapGraphFromScratch(mapId, pool = getPool()) {
  await pool.query('DELETE FROM map_edges WHERE map_id = ?', [mapId]);
  await pool.query('DELETE FROM map_nodes WHERE map_id = ?', [mapId]);

  await copyScratchNodesIntoMap(mapId, pool);
  await copyScratchEdgesIntoMap(mapId, pool);
  await pool.query('UPDATE maps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mapId]);

  return findMapById(mapId, pool);
}

/**
 * Load a saved map's snapshot into the scratch graph ("open in editor").
 *
 * @param {number} mapId
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<void>}
 */
async function replaceScratchFromMap(mapId, pool = getPool()) {
  await pool.query('DELETE FROM edges');
  await pool.query('DELETE FROM nodes');

  await pool.query(
    'INSERT INTO nodes (label, type) SELECT label, type FROM map_nodes WHERE map_id = ?',
    [mapId]
  );

  await pool.query(
    `INSERT INTO edges (from_node, to_node, topic_description, sources_json)
     SELECT sf.id, st.id, e.topic_description, e.sources_json
       FROM map_edges e
       JOIN map_nodes mnf ON mnf.id = e.from_node
       JOIN map_nodes mnt ON mnt.id = e.to_node
       JOIN nodes sf      ON sf.label = mnf.label
       JOIN nodes st      ON st.label = mnt.label
      WHERE e.map_id = ?`,
    [mapId]
  );
}

/**
 * Update a saved map's metadata (title, description, visibility).
 *
 * @param {number} id
 * @param {{title: string, description?: string, isPublic?: boolean}} input
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Object|null>}
 */
async function updateMapMeta(id, input, pool = getPool()) {
  const title = normalizeTitle(input.title) || 'Untitled map';
  const description = normalizeDescription(input.description);
  const isPublic = input.isPublic === false ? 0 : 1;

  await pool.query(
    'UPDATE maps SET title = ?, description = ?, is_public = ? WHERE id = ?',
    [title, description, isPublic, id]
  );

  return findMapById(id, pool);
}

/**
 * Delete a saved map. Nodes and edges cascade with the foreign keys.
 *
 * @param {number} id
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<boolean>} true when a row was removed.
 */
async function deleteMap(id, pool = getPool()) {
  const [result] = await pool.query('DELETE FROM maps WHERE id = ?', [id]);
  return Number(result.affectedRows) > 0;
}

module.exports = {
  DESCRIPTION_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  copyScratchEdgesIntoMap,
  copyScratchNodesIntoMap,
  createMapFromScratch,
  deleteMap,
  fetchMapGraph,
  findMapById,
  findMapByShortId,
  listMaps,
  normalizeDescription,
  normalizeTitle,
  replaceMapGraphFromScratch,
  replaceScratchFromMap,
  uniqueForPool,
  updateMapMeta,
};

