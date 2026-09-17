'use strict';

/**
 * OpenGraph card storage and lifecycle.
 *
 * Cards live outside the application tree so they can be kept on a Docker
 * volume (see docker/docker-compose.yml): WEBIMAGES_DIR/maps/<shortId>-<version>.png.
 * The version derives from the map's updated_at plus a hash of everything else
 * that shows up on the card (title, description, visibility and the site
 * branding), so:
 *
 *   - the URL of a card changes exactly when the card changes, which is what
 *     social networks need to re-scrape it;
 *   - the file name can be served with an immutable cache header;
 *   - only the current version is kept on disk.
 *
 * Cards are regenerated at every write to a map (created, updated, relations
 * saved, emptied, deleted) and generated on demand when a request arrives for a
 * card that is not on disk (old deployment, empty volume, restored backup).
 */

const fs = require('fs');
const path = require('path');

const settings = require('../settings');
const maps = require('../maps');
const {
  CARD_HEIGHT,
  CARD_WIDTH,
  hashString,
  renderMapCard,
} = require('./card');
const MEDIA_BASE = '/media/maps';
const FILE_REGEX = /^([A-Za-z0-9]{3,32})-(\d{10,16})-([a-f0-9]{8})\.png$/;
const LOCALES_DIR = path.join(__dirname, '..', '..', 'public', 'locales');
const FALLBACK_LABELS = {
  entities: 'ENTIDADES',
  connections: 'CONEXOES',
  network: 'REDE',
  empty: 'SEM ENTIDADES',
  updated: 'ATUALIZADO',
};

const directory = process.env.WEBIMAGES_DIR && String(process.env.WEBIMAGES_DIR).trim() !== ''
  ? path.resolve(String(process.env.WEBIMAGES_DIR).trim())
  : path.join(__dirname, '..', '..', 'webimages');
const mapsDirectory = path.join(directory, 'maps');

const labelCache = new Map();
const inFlight = new Map();

let directoryReady = null;
let writable = null;
let warned = false;

/**
 * Create the storage directory and remember whether it can be written to.
 *
 * A read-only volume must not stop the application: cards are then rendered on
 * demand and streamed without being stored. The check runs again on every call,
 * so fixing the volume permissions is enough — the next write succeeds without
 * restarting the container.
 *
 * @returns {boolean} true when the directory exists and is writable.
 */
function ensureDirectory() {
  if (directoryReady === true) {
    return true;
  }

  try {
    fs.mkdirSync(mapsDirectory, { recursive: true });
    fs.accessSync(mapsDirectory, fs.constants.W_OK);

    if (directoryReady === false) {
      console.log(`[ogcard] ${mapsDirectory} is writable again: cards are being stored.`);
    }

    directoryReady = true;
    writable = true;
    warned = false;
    return true;
  } catch (error) {
    if (!warned) {
      warned = true;
      // The container id lets the operator fix the ownership of the bind mount
      // straight away, without editing docker-compose or restarting anything.
      const container = process.env.HOSTNAME || '<container>';

      console.warn(
        `[ogcard] ${mapsDirectory} is not writable (${error.code || error.message}) — cards are `
        + 'rendered on demand but not stored.\n'
        + '         Fix it once (no docker-compose change needed):\n'
        + `           docker exec --user root ${container} chown -R 1000:1000 ${directory}\n`
        + `         or on the host:  sudo chown -R 1000:1000 <folder mounted at ${directory}>\n`
        + '         The check is retried on every write, so no restart is needed afterwards.'
      );
    }

    directoryReady = false;
    writable = false;
    return false;
  }
}

/**
 * Storage status for the admin panel.
 *
 * @returns {{folder: string, writable: boolean}}
 */
function status() {
  return { folder: mapsDirectory, writable: ensureDirectory() };
}

/** @returns {string} the directory holding the generated cards. */
function mapsFolder() {
  return mapsDirectory;
}

/** @returns {boolean|null} null when writability was never checked. */
function isWritable() {
  return writable;
}

/**
 * Read the card words from the locale dictionary, falling back to the built-in
 * ones when a dictionary or a key is missing: missing translations are visible
 * elsewhere on purpose, but a card must never render empty text.
 *
 * @param {string} locale
 * @returns {{entities: string, connections: string, network: string, empty: string, updated: string}}
 */
function cardLabels(locale) {
  if (labelCache.has(locale)) {
    return labelCache.get(locale);
  }

  let dictionary = {};

  try {
    dictionary = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
  } catch (error) {
    dictionary = {};
  }

  const pick = (key, fallbackKey) => (
    typeof dictionary[key] === 'string' && dictionary[key] !== ''
      ? dictionary[key]
      : dictionary[fallbackKey] || FALLBACK_LABELS[fallbackKey] || ''
  );

  const labels = {
    entities: pick('ogCardEntities', 'entities'),
    connections: pick('ogCardConnections', 'connections'),
    network: pick('ogCardNetwork', 'network'),
    empty: pick('ogCardEmpty', 'empty'),
    updated: pick('mapMetaUpdated', 'updated'),
  };

  labelCache.set(locale, labels);
  return labels;
}

/** @returns {string} the host shown on the card (from site_url or DOMAIN). */
function brandingDomain() {
  const raw = String(settings.get('site_url', '') || process.env.DOMAIN || '').trim();

  if (raw === '') {
    return '';
  }

  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).host;
  } catch (error) {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

/**
 * Everything on the card that does not come from the map row itself.
 *
 * @returns {{siteTitle: string, domain: string, prefix: string, theme: string}}
 */
function cardBranding() {
  const locale = settings.defaultLocale();

  return {
    siteTitle: settings.siteTitle(locale),
    domain: brandingDomain(),
    prefix: `/${settings.mapPathPrefix().replace(/\/+$/, '')}`,
    theme: settings.defaultTheme(),
  };
}

/** @param {Object} branding @returns {string} the branding part of the version hash. */
function brandingKey(branding) {
  return [branding.siteTitle, branding.domain, branding.prefix, branding.theme].join('|');
}

/**
 * Version of a card: the map timestamp plus a hash of everything painted on it
 * (title, description, visibility, entity/connection counts and the branding),
 * so a change produces a new URL — which is what social networks need to
 * re-scrape it — while a plain reload reuses the stored file.
 *
 * The counts matter because updated_at has second precision: two edits inside
 * the same second would otherwise reuse the same URL.
 *
 * @param {Object} map
 * @param {string} [key] brandingKey(); resolved from the settings when omitted
 * @returns {string} "<epoch>-<hash8>"
 */
function cardVersion(map, key) {
  const updated = map && map.updated_at ? new Date(map.updated_at).getTime() : Date.now();
  const epoch = Number.isFinite(updated) ? Math.floor(updated / 1000) : 0;
  const fingerprint = [
    String((map && map.title) || ''),
    String((map && map.description) || ''),
    map && map.is_public ? '1' : '0',
    String((map && map.node_count) || 0),
    String((map && map.edge_count) || 0),
    key || brandingKey(cardBranding()),
  ].join('|');

  return `${epoch}-${hashString(fingerprint).toString(16).padStart(8, '0')}`;
}

/**
 * @param {Object} map
 * @param {string} [key]
 * @returns {string} the file name of the current card.
 */
function fileNameFor(map, key) {
  return `${map.short_id}-${cardVersion(map, key)}.png`;
}

/** @param {string} fileName @returns {string} absolute path inside the volume. */
function filePath(fileName) {
  return path.join(mapsDirectory, path.basename(fileName));
}

/**
 * @param {string} value
 * @returns {{shortId: string, version: string}|null} the parsed file name.
 */
function parseFileName(value) {
  const match = FILE_REGEX.exec(String(value || ''));
  return match ? { shortId: match[1], version: `${match[2]}-${match[3]}` } : null;
}

/** @param {string} fileName @returns {boolean} whether the card is already stored. */
function exists(fileName) {
  return fs.existsSync(filePath(fileName));
}

/**
 * Write a card atomically (temporary file + rename) so a request can never read
 * a half written image.
 *
 * @param {string} fileName
 * @param {Buffer} buffer
 * @returns {boolean} true when it was stored.
 */
function store(fileName, buffer) {
  if (!ensureDirectory()) {
    return false;
  }

  const target = filePath(fileName);
  const temporary = `${target}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, target);
    return true;
  } catch (error) {
    console.warn(`[ogcard] could not store ${target}:`, error.message);

    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      // The temporary file was never created; nothing to clean up.
    }

    return false;
  }
}

/**
 * @param {string} shortId
 * @param {string} [keep] file name to keep
 * @returns {number} how many stale files were removed.
 */
function removeStaleFiles(shortId, keep) {
  if (!ensureDirectory()) {
    return 0;
  }

  let removed = 0;

  try {
    fs.readdirSync(mapsDirectory).forEach((entry) => {
      if (entry === keep || !entry.startsWith(`${shortId}-`) || !FILE_REGEX.test(entry)) {
        return;
      }

      try {
        fs.unlinkSync(path.join(mapsDirectory, entry));
        removed += 1;
      } catch (error) {
        // Another request may have removed it already.
      }
    });
  } catch (error) {
    return removed;
  }

  return removed;
}

/** @param {string} shortId @returns {number} how many card files were removed. */
function removeCards(shortId) {
  return removeStaleFiles(shortId);
}

/**
 * Render the card of a map and store it when the volume allows it.
 *
 * Concurrent requests for the same card share one render (the promise is kept
 * while it runs), which keeps a crawler burst from drawing the same image many
 * times in parallel.
 *
 * @param {Object} map map row (needs id, short_id, title, description, updated_at)
 * @param {{force?: boolean, branding?: Object, labels?: Object}} [options]
 * @returns {Promise<{fileName: string, path: string, buffer: Buffer|null, stored: boolean}>}
 */
async function generate(map, options = {}) {
  const branding = options.branding || cardBranding();
  const labels = options.labels || cardLabels(settings.defaultLocale());
  const fileName = fileNameFor(map, brandingKey(branding));
  const path_ = filePath(fileName);

  if (options.force !== true && exists(fileName)) {
    return { fileName, path: path_, buffer: null, stored: true };
  }

  if (inFlight.has(fileName)) {
    return inFlight.get(fileName);
  }

  const task = (async () => {
    const graph = await maps.fetchMapGraph(map.id);
    const buffer = renderMapCard({ map, graph, labels, branding });
    const stored = store(fileName, buffer);

    if (stored) {
      removeStaleFiles(map.short_id, fileName);
    }

    return { fileName, path: path_, buffer, stored };
  })();

  inFlight.set(fileName, task);

  try {
    return await task;
  } finally {
    inFlight.delete(fileName);
  }
}

/**
 * Regenerate the card of a map, logging (instead of throwing) on failure so a
 * map can always be saved even when the volume is broken.
 *
 * @param {Object} map
 * @returns {Promise<Object|null>}
 */
async function refresh(map) {
  if (!map) {
    return null;
  }

  try {
    return await generate(map, { force: true });
  } catch (error) {
    console.warn(`[ogcard] could not regenerate the card of ${map.short_id}:`, error.message);
    return null;
  }
}

/**
 * @param {number|string} mapId
 * @returns {Promise<Object|null>} the regenerated card, or null.
 */
async function refreshById(mapId) {
  const map = await maps.findMapById(mapId);
  return map ? refresh(map) : null;
}

/**
 * @param {string} fileName
 * @returns {string} the public path of a card (prefix with the site URL for meta tags).
 */
function publicPath(fileName) {
  return `${MEDIA_BASE}/${fileName}`;
}

module.exports = {
  CARD_HEIGHT,
  CARD_WIDTH,
  MEDIA_BASE,
  cardBranding,
  cardLabels,
  cardVersion,
  ensureDirectory,
  exists,
  fileNameFor,
  filePath,
  generate,
  isWritable,
  mapsFolder,
  parseFileName,
  publicPath,
  refresh,
  refreshById,
  removeCards,
  renderMapCard,
  status,
  store,
};
