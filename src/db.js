'use strict';

/**
 * Database bootstrap module.
 *
 * Responsibilities:
 *   - Connect to MariaDB with retries (tolerates slow docker-compose startup).
 *   - Ensure the target database exists with utf8mb4 settings.
 *   - Apply the schema from db/schema.sql (auto-migration).
 *   - Stage the example relations in the `nodes` table when it is empty; the
 *     first saved map is published from there by ensureInitialMap() (server.js).
 *   - Export the shared connection pool.
 */

const fs = require('fs');
const path = require('path');

const mysql = require('mysql2/promise');

const { seedDatabase } = require('./seed');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'criminalmap';

const MAX_CONNECT_ATTEMPTS = 10;
const RETRY_DELAY_MS = 3000;

let pool = null;

/**
 * Build a mysql2 connection pool bound to a specific database.
 *
 * @param {string} database
 * @returns {import('mysql2/promise').Pool}
 */
function createPool(database) {
  return mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
  });
}

/**
 * Open a raw bootstrap connection (not bound to a database) with retries.
 *
 * @returns {Promise<import('mysql2/promise').Connection>}
 */
async function connectWithRetry() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const connection = await mysql.createConnection({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        multipleStatements: true,
        charset: 'utf8mb4',
      });

      console.log('Database connected');
      return connection;
    } catch (error) {
      lastError = error;
      console.error(
        `Database connection attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed: ${error.message}`
      );

      if (attempt < MAX_CONNECT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `Could not connect to the database after ${MAX_CONNECT_ATTEMPTS} attempts. Last error: ${lastError.message}`
  );
}

/**
 * Ensure the database exists, apply the schema, create the pool, and stage the
 * example data when the `nodes` table is still empty. The staged relations are
 * published as the first saved map right after the server settings are loaded.
 */
async function initDatabase() {
  const connection = await connectWithRetry();

  try {
    const escapedDbName = connection.escapeId(DB_NAME);

    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${escapedDbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE ${escapedDbName}`);

    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await connection.query(schemaSql);

    console.log('Tables ready');
  } finally {
    await connection.end();
  }

  pool = createPool(DB_NAME);

  const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM nodes');
  const nodeCount = countRows[0].total;

  if (nodeCount === 0) {
    console.log('Seeding example data...');
    await seedDatabase(pool);
    console.log('Seed data inserted');
  }
}

/**
 * Return the shared pool. Throws if initDatabase() has not completed yet.
 *
 * @returns {import('mysql2/promise').Pool}
 */
function getPool() {
  if (!pool) {
    throw new Error('Database pool is not initialized. Call initDatabase() first.');
  }

  return pool;
}

module.exports = { initDatabase, getPool };
