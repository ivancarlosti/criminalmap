'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const { initDatabase, getPool } = require('./src/db');
const { parseTextWithDetails } = require('./src/parser');
const { seedDatabase, insertRelations } = require('./src/seed');

const PORT = Number(process.env.PORT) || 8080;
const DOMAIN = process.env.DOMAIN || null;

const app = express();

// Support reverse-proxy setups (e.g., nginx / docker-compose) by trusting the
// X-Forwarded-* headers set by the first proxy hop.
app.set('trust proxy', 1);

app.use(express.json());

// Serve the frontend static files from the public/ directory.
app.use(express.static(path.join(__dirname, 'public')));

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
 * Read the full graph (nodes + edges) from the database.
 *
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
async function fetchGraph() {
  const pool = getPool();

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
 * Wrap an async route handler so rejections reach the error middleware.
 *
 * @param {Function} handler
 * @returns {Function}
 */
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// GET /api/graph -> full graph payload.
app.get('/api/graph', asyncHandler(async (req, res) => {
  res.json(await fetchGraph());
}));

// GET /api/nodes -> nodes subset.
app.get('/api/nodes', asyncHandler(async (req, res) => {
  const { nodes } = await fetchGraph();
  res.json({ nodes });
}));

// GET /api/edges -> edges subset.
app.get('/api/edges', asyncHandler(async (req, res) => {
  const { edges } = await fetchGraph();
  res.json({ edges });
}));

// POST /api/parse -> parse text, upsert nodes, insert edges, return full graph.
app.post('/api/parse', asyncHandler(async (req, res) => {
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';

  if (text.trim() === '') {
    return res.status(400).json({
      error: 'The "text" field is required and must not be empty.',
    });
  }

  const { relations, invalidLines } = parseTextWithDetails(text);

  if (relations.length === 0) {
    return res.status(400).json({
      error: 'No valid relation lines were found in the provided text.',
      invalidLines,
    });
  }

  await insertRelations(getPool(), relations);
  res.json(await fetchGraph());
}));

// DELETE /api/graph -> remove all edges then all nodes.
app.delete('/api/graph', asyncHandler(async (req, res) => {
  const pool = getPool();
  await pool.query('DELETE FROM edges');
  await pool.query('DELETE FROM nodes');
  res.json({ success: true });
}));

// POST /api/seed -> wipe the graph and re-run the seed data.
app.post('/api/seed', asyncHandler(async (req, res) => {
  const pool = getPool();
  await pool.query('DELETE FROM edges');
  await pool.query('DELETE FROM nodes');
  await seedDatabase(pool);
  res.json(await fetchGraph());
}));

// JSON error middleware.
app.use((error, req, res, _next) => {
  console.error('Request error:', error);
  res.status(500).json({ error: 'Internal server error.' });
});

/**
 * Bootstrap: initialize the database (connect, migrate, seed) and then listen.
 */
async function main() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`Criminalmap API listening on http://localhost:${PORT}`);

      if (DOMAIN) {
        console.log(`Configured domain: ${DOMAIN}`);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
