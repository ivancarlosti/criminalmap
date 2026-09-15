'use strict';

/**
 * Saved map repository.
 *
 * Maps are the editable unit of the application: a map lives in the `maps` /
 * `map_nodes` / `map_edges` tables and is created, edited (relations added or
 * cleared, title/description/visibility changed) and deleted by administrators.
 * Visitors can only read the maps that are marked as public.
 *
 * `createMapFromScratch()` is only used by the bootstrap migration that
 * publishes the legacy working graph (`nodes` / `edges`) as the first map.
 */

const { getPool } = require('./db');
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
 * List saved maps with their node/edge counts.
 *
 * @param {Object} [options]
 * @param {boolean} [options.publicOnly] - only published maps (visitor facing)
 * @param {import('mysql2/promise').Pool} [options.pool]
 * @returns {Promise<Array>}
 */
async function listMaps(options = {}) {
  const { publicOnly = false, pool = getPool() } = options;
  const [rows] = await pool.query(
    `SELECT m.id, m.short_id, m.title, m.description, m.is_public, m.created_at, m.updated_at,
            (SELECT COUNT(*) FROM map_nodes n WHERE n.map_id = m.id) AS node_count,
            (SELECT COUNT(*) FROM map_edges e WHERE e.map_id = m.id) AS edge_count
       FROM maps m
      ${publicOnly ? 'WHERE m.is_public = 1' : ''}
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
 * Create an empty saved map.
 *
 * @param {{title: string, description?: string, isPublic?: boolean}} input
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<Object|null>}
 */
async function createMap(input, pool = getPool()) {
  const title = normalizeTitle(input.title) || 'Untitled map';
  const description = normalizeDescription(input.description);
  const isPublic = input.isPublic === false ? 0 : 1;
  const shortId = await uniqueForPool(pool);

  const [result] = await pool.query(
    'INSERT INTO maps (short_id, title, description, is_public) VALUES (?, ?, ?, ?)',
    [shortId, title, description, isPublic]
  );

  return findMapById(Number(result.insertId), pool);
}

/**
 * Publish the legacy working graph (`nodes` / `edges`) as a new saved map.
 *
 * Used by the bootstrap migration (see ensureInitialMap() in server.js) and by
 * the "restore example map" maintenance action.
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
 * Upsert a map node by label and return its id.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} mapId
 * @param {string} label
 * @param {string} [type]
 * @returns {Promise<number>}
 */
async function upsertMapNode(pool, mapId, label, type = 'person') {
  await pool.query(
    'INSERT INTO map_nodes (map_id, label, type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE label = VALUES(label)',
    [mapId, label, type]
  );

  const [rows] = await pool.query(
    'SELECT id FROM map_nodes WHERE map_id = ? AND label = ? LIMIT 1',
    [mapId, label]
  );

  return rows[0].id;
}

/**
 * Add parsed relations to a saved map: nodes are upserted by label and every
 * relation becomes a NEW edge row (duplicate edges are allowed on purpose).
 *
 * @param {number} mapId
 * @param {Array<{from: string, to: string, topic: string, sources: string[]}>} relations
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<{nodeCount: number, edgeCount: number}>}
 */
async function insertMapRelations(mapId, relations, pool = getPool()) {
  const labelToId = new Map();

  async function getNodeId(label) {
    if (labelToId.has(label)) {
      return labelToId.get(label);
    }

    const id = await upsertMapNode(pool, mapId, label);
    labelToId.set(label, id);
    return id;
  }

  let edgeCount = 0;

  for (const relation of relations) {
    const fromNodeId = await getNodeId(relation.from);
    const toNodeId = await getNodeId(relation.to);

    await pool.query(
      'INSERT INTO map_edges (map_id, from_node, to_node, topic_description, sources_json) VALUES (?, ?, ?, ?, ?)',
      [mapId, fromNodeId, toNodeId, relation.topic, JSON.stringify(relation.sources || [])]
    );

    edgeCount += 1;
  }

  await pool.query('UPDATE maps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mapId]);

  return { nodeCount: labelToId.size, edgeCount };
}

/**
 * Remove every node and edge stored in a saved map (the map itself is kept).
 *
 * @param {number} mapId
 * @param {import('mysql2/promise').Pool} [pool]
 * @returns {Promise<{nodes: number, edges: number}>}
 */
async function clearMapGraph(mapId, pool = getPool()) {
  const [edgeResult] = await pool.query('DELETE FROM map_edges WHERE map_id = ?', [mapId]);
  const [nodeResult] = await pool.query('DELETE FROM map_nodes WHERE map_id = ?', [mapId]);

  await pool.query('UPDATE maps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mapId]);

  return {
    nodes: Number(nodeResult.affectedRows) || 0,
    edges: Number(edgeResult.affectedRows) || 0,
  };
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
    'UPDATE maps SET title = ?, description = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
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
  clearMapGraph,
  createMap,
  createMapFromScratch,
  deleteMap,
  fetchMapGraph,
  findMapById,
  findMapByShortId,
  insertMapRelations,
  listMaps,
  normalizeDescription,
  normalizeTitle,
  parseSourcesJson,
  uniqueForPool,
  updateMapMeta,
};

