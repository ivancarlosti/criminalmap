'use strict';

/**
 * Seed data and reusable node/edge upsert helpers.
 *
 * The insert helpers are shared by both the seed process (src/db.js) and the
 * POST /api/parse endpoint (server.js).
 */

const { parseText } = require('./parser');

const EXAMPLE_TEXT = `[Flávio Bolsonaro] -> [Fabrício Queiroz] : Rachadinha (Desvio de salários) | Fontes: https://noticia1.com/rachadinha, https://noticia2.com/relatorio-coaf
[Flávio Bolsonaro] -> [Fabrício Queiroz] : Lavagem de Dinheiro (Loja de Chocolates) | Fontes: https://noticia3.com/chocolates
[Fabrício Queiroz] -> [Milícia de Rio das Pedras] : Ligação com milicianos | Fontes: https://noticia4.com/milicia
[Victor (O Chefe)] -> [Marcos (O Capanga)] : Emprega e dá ordens para | Fontes: https://inquerito.gov/pag12
[Victor (O Chefe)] -> [Sr. Silva (Contador)] : Usa para lavar dinheiro | Fontes: 
[Inspetor Carlos] -> [Victor (O Chefe)] : Recebe propina de | Fontes: https://audio-vazado.com/carlos
[Ana (Testemunha)] -> [Jornalista Investigativo] : Forneceu provas em segredo | Fontes: 
[Jornalista Investigativo] -> [Importadora Global] : Publicou dossiê sobre | Fontes: https://jornal.com/dossie-global
[Importadora Global] -> [Sr. Silva (Contador)] : Fachada gerenciada por | Fontes: `;

/**
 * Insert a node by label (upsert) and return its id.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} label
 * @param {string} [type]
 * @returns {Promise<number>}
 */
async function upsertNode(pool, label, type = 'person') {
  await pool.query(
    'INSERT INTO nodes (label, type) VALUES (?, ?) ON DUPLICATE KEY UPDATE label = VALUES(label)',
    [label, type]
  );

  const [rows] = await pool.query('SELECT id FROM nodes WHERE label = ? LIMIT 1', [label]);
  return rows[0].id;
}

/**
 * Insert a single edge row. Sources are stored as a JSON array.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} fromNodeId
 * @param {number} toNodeId
 * @param {string} topicDescription
 * @param {string[]} sources
 */
async function insertEdge(pool, fromNodeId, toNodeId, topicDescription, sources) {
  await pool.query(
    'INSERT INTO edges (from_node, to_node, topic_description, sources_json) VALUES (?, ?, ?, ?)',
    [fromNodeId, toNodeId, topicDescription, JSON.stringify(sources)]
  );
}

/**
 * Upsert every node and insert every relation as a NEW edge row.
 *
 * Deliberately allows duplicate edges between the same two nodes.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {Array<{from: string, to: string, topic: string, sources: string[]}>} relations
 * @returns {Promise<{nodeCount: number, edgeCount: number}>}
 */
async function insertRelations(pool, relations) {
  const labelToId = new Map();

  async function getNodeId(label) {
    if (labelToId.has(label)) {
      return labelToId.get(label);
    }

    const id = await upsertNode(pool, label);
    labelToId.set(label, id);
    return id;
  }

  let edgeCount = 0;
  for (const relation of relations) {
    const fromNodeId = await getNodeId(relation.from);
    const toNodeId = await getNodeId(relation.to);

    await insertEdge(pool, fromNodeId, toNodeId, relation.topic, relation.sources);
    edgeCount += 1;
  }

  return { nodeCount: labelToId.size, edgeCount };
}

/**
 * Seed the database using the built-in example text.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{nodeCount: number, edgeCount: number}>}
 */
async function seedDatabase(pool) {
  const relations = parseText(EXAMPLE_TEXT);
  return insertRelations(pool, relations);
}

module.exports = {
  EXAMPLE_TEXT,
  seedDatabase,
  insertRelations,
  upsertNode,
  insertEdge,
};
