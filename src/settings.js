'use strict';

/**
 * Application settings store.
 *
 * Settings live in the `settings` key/value table and are edited from the
 * admin panel. The whole table is loaded into memory once at boot (and reloaded
 * after every write), so `get()` is synchronous and cheap enough to call from
 * every request. This mirrors the reference project's cached Setting model.
 */

const { getPool } = require('./db');
const locales = require('./locales');

/**
 * Built-in defaults. Locale-aware defaults (site_title_*, site_subtitle_*) are
 * appended from the locale catalog below.
 */
const DEFAULT_SETTINGS = {
  default_locale: locales.DEFAULT_CODE,
  default_theme: 'dark',
  theme_color_light: '#f5efe2',
  theme_color_dark: '#0e0e10',
  map_path_prefix: 'm',
  map_short_id_length: '6',
  map_short_id_uppercase: '0',
  map_short_id_numbers: '0',
  site_logo_url: '',
  favicon_url: '',
  site_url: '',
  twitter_site: '',
  og_image_url: '',
  og_card_enabled: '1',
  robots_enabled: '1',
  sitemap_enabled: '0',
  robots_content: 'User-agent: *\nDisallow: /admin\nDisallow: /auth',
  custom_head: '',
  custom_css: '',
  custom_js: '',
};

locales.list().forEach((locale) => {
  DEFAULT_SETTINGS[`site_title_${locale.code}`] = locale.defaultTitle;
  DEFAULT_SETTINGS[`site_subtitle_${locale.code}`] = locale.defaultSubtitle;
});

/** Keys exposed to unauthenticated clients through GET /api/settings. */
const PUBLIC_KEYS = [
  'default_locale',
  'default_theme',
  'theme_color_light',
  'theme_color_dark',
  'map_path_prefix',
  'robots_enabled',
  'sitemap_enabled',
  'site_logo_url',
  'favicon_url',
];

const PREFIX_REGEX = /^[a-z0-9_-]+$/;
const TRUTHY = ['1', 'true', 'on', 'yes'];

let cache = null;

/**
 * Read every setting row from the database and merge it over the defaults.
 *
 * @returns {Promise<Object<string, string|null>>}
 */
async function load() {
  const [rows] = await getPool().query('SELECT `key`, `value` FROM settings');
  const stored = {};

  rows.forEach((row) => {
    stored[row.key] = row.value;
  });

  cache = { ...DEFAULT_SETTINGS, ...stored };
  return cache;
}

/**
 * Read the in-memory settings, falling back to the built-in defaults.
 *
 * @returns {Object<string, string|null>}
 */
function all() {
  return cache || { ...DEFAULT_SETTINGS };
}

/**
 * Read a single setting. Empty/missing values fall back to the default.
 *
 * @param {string} key
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
function get(key, fallback = null) {
  const value = all()[key];
  const resolved = typeof value === 'string' ? value.trim() : value;

  if (resolved !== null && resolved !== undefined && resolved !== '') {
    return resolved;
  }

  if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
    return DEFAULT_SETTINGS[key];
  }

  return fallback;
}

/**
 * Read a boolean-ish setting ("1", "true", "on", ...).
 *
 * @param {string} key
 * @param {boolean} [fallback]
 * @returns {boolean}
 */
function getBool(key, fallback = false) {
  const value = all()[key];

  if (value === null || value === undefined || value === '') {
    return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)
      ? TRUTHY.includes(String(DEFAULT_SETTINGS[key]).toLowerCase())
      : fallback;
  }

  return TRUTHY.includes(String(value).toLowerCase());
}


/**
 * Persist a single setting and refresh the cache.
 *
 * @param {string} key
 * @param {string|null} value
 */
async function put(key, value) {
  await putMany([[key, value]]);
}

/**
 * Persist several settings at once using a single upsert statement.
 *
 * @param {Array<[string, string|null]>} entries
 */
async function putMany(entries) {
  const clean = entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string');

  if (clean.length === 0) {
    return;
  }

  const placeholders = clean.map(() => '(?, ?)').join(', ');
  const params = [];

  clean.forEach(([key, value]) => {
    const normalized = value === null || value === undefined ? '' : String(value);
    params.push(key, normalized === '' ? null : normalized);
  });

  await getPool().query(
    `INSERT INTO settings (\`key\`, \`value\`) VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
    params
  );

  await load();
}

/**
 * Invalidate the cache so the next read hits the database.
 */
function flush() {
  cache = null;
}

/** @returns {string} the validated map path prefix (default "m"). */
function mapPathPrefix() {
  const raw = String(get('map_path_prefix', 'm') || '').trim().toLowerCase();
  return PREFIX_REGEX.test(raw) ? raw : 'm';
}

/** @returns {number} the configured short ID length, clamped to 3–32. */
function shortIdLength() {
  const length = Number.parseInt(get('map_short_id_length', '6'), 10);
  return Number.isInteger(length) && length >= 3 && length <= 32 ? length : 6;
}

/** @returns {boolean} whether A–Z may appear in new short IDs. */
function shortIdUppercase() {
  return getBool('map_short_id_uppercase', false);
}

/** @returns {boolean} whether 0–9 may appear in new short IDs. */
function shortIdNumbers() {
  return getBool('map_short_id_numbers', false);
}

/** @returns {string} the default locale, validated against the catalog. */
function defaultLocale() {
  return locales.resolve(get('default_locale', locales.DEFAULT_CODE));
}

/** @returns {string} the default theme ("dark" or "light"). */
function defaultTheme() {
  return get('default_theme', 'dark') === 'light' ? 'light' : 'dark';
}

/** @returns {{light: string, dark: string}} */
function themeColors() {
  return {
    light: get('theme_color_light', '#f5efe2'),
    dark: get('theme_color_dark', '#0e0e10'),
  };
}

/**
 * Localized site title.
 *
 * @param {string} code
 * @returns {string}
 */
function siteTitle(code) {
  const locale = locales.resolve(code);
  return get(`site_title_${locale}`, '') || locales.label(locale);
}

/**
 * Localized site subtitle.
 *
 * @param {string} code
 * @returns {string}
 */
function siteSubtitle(code) {
  const locale = locales.resolve(code);
  return get(`site_subtitle_${locale}`, '');
}

/** @returns {string} the canonical site URL without a trailing slash. */
function siteUrl() {
  return String(get('site_url', '') || '').trim().replace(/\/+$/, '');
}

/** @returns {string} the public domain configured through the environment. */
function envDomain() {
  return String(process.env.DOMAIN || '').trim().replace(/\/+$/, '');
}

/** @returns {string} the best known public base URL (may be empty). */
function publicBaseUrl() {
  return siteUrl() || envDomain();
}

/**
 * The subset of settings safe to expose to anonymous clients.
 *
 * @returns {Object<string, string|boolean|number>}
 */
function publicSettings() {
  const result = {};

  PUBLIC_KEYS.forEach((key) => {
    result[key] = get(key);
  });

  result.default_locale = defaultLocale();
  result.default_theme = defaultTheme();
  result.map_path_prefix = mapPathPrefix();
  result.map_short_id_length = shortIdLength();
  result.robots_enabled = getBool('robots_enabled', true);
  result.sitemap_enabled = getBool('sitemap_enabled', false);

  return result;
}

module.exports = {
  DEFAULT_SETTINGS,
  PUBLIC_KEYS,
  all,
  defaultLocale,
  defaultTheme,
  envDomain,
  flush,
  get,
  getBool,
  load,
  mapPathPrefix,
  publicBaseUrl,
  publicSettings,
  put,
  putMany,
  shortIdLength,
  shortIdNumbers,
  shortIdUppercase,
  siteSubtitle,
  siteTitle,
  siteUrl,
  themeColors,
};
