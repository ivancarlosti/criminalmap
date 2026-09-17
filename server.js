'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const { initDatabase } = require('./src/db');
const { formatRelations, parseTextWithDetails } = require('./src/parser');
const { EXAMPLE_TEXT, exampleMapDescription, exampleMapTitle } = require('./src/seed');
const locales = require('./src/locales');
const maps = require('./src/maps');
const render = require('./src/render');
const settings = require('./src/settings');
const auth = require('./src/auth');
const ogcard = require('./src/ogcard');

const PORT = Number(process.env.PORT) || 8080;
const DOMAIN = process.env.DOMAIN || null;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOCALE_COOKIE = 'locale';

const app = express();

// Support reverse-proxy setups (e.g., nginx / docker-compose) by trusting the
// X-Forwarded-* headers set by the first proxy hop.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve the frontend static assets from the public/ directory. HTML pages are
// rendered from views/ so that settings can be injected server-side.
app.use(express.static(PUBLIC_DIR));

// Expose req.admin (null for anonymous visitors) to every route.
app.use(auth.attachSession);

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

/**
 * Best known public base URL, without a trailing slash.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function baseUrl(req) {
  const configured = settings.publicBaseUrl();

  if (configured !== '') {
    return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  }

  return `${req.protocol}://${req.get('host')}`;
}

/**
 * Build an absolute URL for a path.
 *
 * @param {import('express').Request} req
 * @param {string} pathname
 * @returns {string}
 */
function absoluteUrl(req, pathname) {
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${baseUrl(req)}${suffix}`;
}

/**
 * Public short URL of a saved map.
 *
 * @param {import('express').Request} req
 * @param {string} shortId
 * @returns {string}
 */
function mapUrl(req, shortId) {
  return absoluteUrl(req, `/${settings.mapPathPrefix()}/${shortId}`);
}

/**
 * Public path of the current OpenGraph card of a map, or '' when the feature is
 * disabled. The file name is derived from the map row alone, so rendering a page
 * never has to touch the database again for the image.
 *
 * @param {Object} map
 * @returns {string}
 */
function mapCardPath(map) {
  if (!map || !settings.getBool('og_card_enabled', true)) {
    return '';
  }

  return ogcard.publicPath(ogcard.fileNameFor(map));
}

/**
 * pageData() options for the generated card of a map.
 *
 * @param {import('express').Request} req
 * @param {Object} map
 * @returns {Object} empty when the map has no card (feature off / no map)
 */
function cardImageOptions(req, map) {
  const cardPath = mapCardPath(map);

  if (cardPath === '') {
    return {};
  }

  return {
    ogImage: absoluteUrl(req, cardPath),
    ogImageSize: { width: ogcard.CARD_WIDTH, height: ogcard.CARD_HEIGHT },
  };
}

/**
 * Regenerate the OpenGraph card of a map after it changed. src/ogcard logs its
 * own failures and never throws, so saving a map can never fail because of the
 * image.
 *
 * @param {Object} map
 * @returns {Promise<void>}
 */
async function refreshCard(map) {
  if (!map || !settings.getBool('og_card_enabled', true)) {
    return;
  }

  await ogcard.refresh(map);
}

/**
 * Locale for the current request: "locale" cookie > configured default.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function currentLocale(req) {
  const cookies = String(req.headers.cookie || '');
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  let value = '';

  if (match) {
    try {
      value = decodeURIComponent(match[1]);
    } catch {
      value = match[1];
    }
  }

  return locales.resolve(value, settings.defaultLocale());
}

/**
 * Only allow same-origin relative redirect targets.
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeNext(value) {
  const target = typeof value === 'string' ? value.trim() : '';

  if (target.startsWith('/') && !target.startsWith('//')) {
    return target;
  }

  return '';
}

/**
 * Restrict return targets to known pages (the home page, the admin pages and a
 * saved map page).
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeReturn(value) {
  const target = safeNext(value);

  if (['/', '/admin/maps', '/admin/settings'].includes(target)) {
    return target;
  }

  return new RegExp(`^/${settings.mapPathPrefix()}/[A-Za-z0-9]{3,32}$`).test(target) ? target : '';
}

/**
 * Read the effective value of a form field (checkboxes post twice: hidden "0"
 * followed by "1" when checked).
 *
 * @param {unknown} value
 * @returns {string}
 */
function fieldValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[value.length - 1]) : '';
  }

  return value === null || value === undefined ? '' : String(value);
}

/**
 * @param {Object} body
 * @param {string} key
 * @returns {boolean}
 */
function checkboxValue(body, key) {
  return ['1', 'true', 'on', 'yes'].includes(fieldValue(body[key]).trim().toLowerCase());
}

/**
 * @param {string|undefined} url
 * @returns {string}
 */
function faviconLinks(url) {
  const value = String(url || '').trim();

  return value === '' ? '' : `<link rel="icon" href="${render.escapeHtml(value)}">`;
}

/**
 * @param {string} imageUrl
 * @param {string} title
 * @param {{width: number, height: number}} [size] known dimensions of the image
 * @returns {string} OpenGraph/Twitter image meta tags, or an empty string.
 */
function imageMeta(imageUrl, title, size) {
  const value = String(imageUrl || '').trim();

  if (value === '') {
    return '';
  }

  const escaped = render.escapeHtml(value);
  const tags = [
    `<meta property="og:image" content="${escaped}">`,
    `<meta property="og:image:alt" content="${render.escapeHtml(title)}">`,
  ];

  if (size && size.width > 0 && size.height > 0) {
    // Only emitted for the cards this application generates: the dimensions of
    // an external og_image_url are unknown, and wrong values make some crawlers
    // render the wrong crop.
    tags.push(
      '<meta property="og:image:type" content="image/png">',
      `<meta property="og:image:width" content="${Math.round(size.width)}">`,
      `<meta property="og:image:height" content="${Math.round(size.height)}">`
    );
  }

  tags.push(`<meta name="twitter:image" content="${escaped}">`);
  tags.push(`<meta name="twitter:image:alt" content="${render.escapeHtml(title)}">`);

  return tags.join('\n  ');
}

/**
 * @param {string} handle
 * @returns {string} a twitter:site meta tag, or an empty string.
 */
function twitterSiteMeta(handle) {
  const value = String(handle || '').trim();

  if (value === '') {
    return '';
  }

  const at = value.startsWith('@') ? value : `@${value}`;
  return `<meta name="twitter:site" content="${render.escapeHtml(at)}">`;
}

/**
 * Collect everything the layout needs for one request.
 *
 * @param {import('express').Request} req
 * @param {Object} [options]
 * @returns {Object}
 */
function pageData(req, options = {}) {
  const locale = currentLocale(req);
  const siteTitle = settings.siteTitle(locale);
  const siteSubtitle = settings.siteSubtitle(locale);
  const themeColors = settings.themeColors();
  const defaultTheme = settings.defaultTheme();
  const isAdmin = auth.isAdmin(req);
  const title = options.title || siteTitle;
  const description = options.description !== undefined ? options.description : siteSubtitle;
  const logoUrl = settings.get('site_logo_url', '');
  const image = options.ogImage !== undefined ? options.ogImage : settings.get('og_image_url', '');

  return {
    LANG: locales.htmlLang(locale),
    TITLE: title,
    DESCRIPTION: description,
    ROBOTS_META: options.robotsMeta || '',
    CANONICAL: absoluteUrl(req, options.canonicalPath || req.path),
    OG_TYPE: options.ogType || 'website',
    SITE_TITLE: siteTitle,
    SITE_SUBTITLE: siteSubtitle,
    SITE_LOGO_URL: logoUrl,
    SHOW_BRAND_TEXT: logoUrl === '',
    OG_IMAGE_META: imageMeta(image, title, options.ogImageSize),
    TWITTER_CARD: image !== '' ? 'summary_large_image' : 'summary',
    TWITTER_SITE_META: twitterSiteMeta(settings.get('twitter_site', '')),
    TWITTER_IMAGE_META: '',
    THEME_COLOR: defaultTheme === 'light' ? themeColors.light : themeColors.dark,
    THEME_TOGGLE_TITLE: '',
    FAVICON_LINKS: faviconLinks(settings.get('favicon_url', '')),
    APP_CONFIG_JSON: JSON.stringify({
      defaultLocale: settings.defaultLocale(),
      currentLocale: locale,
      supportedLocales: locales.codes(),
      defaultTheme,
      themeColors,
      mapPathPrefix: settings.mapPathPrefix(),
      isAdmin,
    }),
    SUPPORTED_LOCALES: locales.list().map((entry) => ({
      code: entry.code,
      label: entry.label,
      selected: entry.code === locale ? 'selected' : '',
    })),
    IS_ADMIN: isAdmin,
    NOT_ADMIN: !isAdmin,
    SHOW_LOGIN_LINK: !isAdmin && auth.isAccount(),
    SHOW_HOME_LINK: options.showHomeLink === true,
    CSRF_TOKEN: auth.csrfToken(req),
    PAGE_SCRIPTS: options.pageScripts || '',
    CUSTOM_HEAD: settings.get('custom_head', ''),
    CUSTOM_CSS: settings.get('custom_css', '') === ''
      ? ''
      : `<style>\n${settings.get('custom_css', '')}\n</style>`,
    CUSTOM_JS: settings.get('custom_js', '') === ''
      ? ''
      : `<script>\n${settings.get('custom_js', '')}\n</script>`,
  };
}

const NOINDEX_META = '<meta name="robots" content="noindex, nofollow">';
const APP_SCRIPT = '<script src="/js/app.js" defer></script>';
const ADMIN_SCRIPT = '<script src="/js/admin.js" defer></script>';

/**
 * XML-safe escaping for sitemap URLs.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Web standards
// ---------------------------------------------------------------------------

// GET /robots.txt -> dynamically served from the admin settings.
app.get('/robots.txt', (req, res) => {
  if (!settings.getBool('robots_enabled', true)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  return res.type('text/plain').send(settings.get('robots_content', '') || '');
});

// GET /sitemap.xml -> home page plus every public saved map.
app.get('/sitemap.xml', asyncHandler(async (req, res) => {
  if (!settings.getBool('sitemap_enabled', false)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const entries = [{ loc: absoluteUrl(req, '/'), priority: '1.0', lastmod: null }];
  const all = await maps.listMaps();

  all.filter((map) => map.is_public).forEach((map) => {
    entries.push({
      loc: mapUrl(req, map.short_id),
      priority: '0.7',
      lastmod: map.updated_at ? new Date(map.updated_at).toISOString() : null,
    });
  });

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((entry) => [
      '  <url>',
      `    <loc>${escapeXml(entry.loc)}</loc>`,
      entry.lastmod ? `    <lastmod>${entry.lastmod}</lastmod>` : '',
      `    <priority>${entry.priority}</priority>`,
      '  </url>',
    ].filter(Boolean).join('\n')),
    '</urlset>',
  ].join('\n');

  return res.type('application/xml').send(body);
}));

// GET /site.webmanifest -> minimal PWA manifest built from the settings.
app.get('/site.webmanifest', (req, res) => {
  const locale = settings.defaultLocale();
  const manifest = {
    name: settings.siteTitle(locale),
    short_name: settings.siteTitle(locale).slice(0, 12),
    description: settings.siteSubtitle(locale),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: settings.themeColors().dark,
    theme_color: settings.themeColors().dark,
    icons: [],
  };
  const favicon = String(settings.get('favicon_url', '') || '').trim();

  if (favicon !== '') {
    manifest.icons.push({ src: favicon, sizes: 'any', type: 'image/png' });
  }

  return res
    .type('application/manifest+json')
    .send(JSON.stringify(manifest, null, 2));
});



// ---------------------------------------------------------------------------
// Public JSON API
// ---------------------------------------------------------------------------

// GET /media/maps/<shortId>-<version>.png -> generated OpenGraph card.
//
// Cards are stored on the WEBIMAGES_DIR volume. When the requested name is the
// current version of the map, the file is generated if it is missing, so a
// deployment with an empty volume heals itself on the first hit. An older
// version answers 302 to the current one, which keeps the immutable cache
// header honest for crawlers that still hold the previous URL.
app.get(`${ogcard.MEDIA_BASE}/:file`, asyncHandler(async (req, res) => {
  if (!settings.getBool('og_card_enabled', true)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const parsed = ogcard.parseFileName(req.params.file);

  if (!parsed) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const map = await maps.findMapByShortId(parsed.shortId);

  if (!map || (!map.is_public && !auth.isAdmin(req))) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const current = ogcard.fileNameFor(map);

  if (current !== req.params.file) {
    return res.redirect(302, ogcard.publicPath(current));
  }

  const card = await ogcard.generate(map, { force: !ogcard.exists(current) });

  res.setHeader('Cache-Control', card.stored ? 'public, max-age=31536000, immutable' : 'no-store');

  if (card.stored) {
    return res.type('image/png').sendFile(card.path);
  }

  // Read-only volume: serve the freshly rendered image without storing it.
  return res.type('image/png').send(card.buffer);
}));

// GET /api/settings -> public settings used by the frontend bootstrap.
app.get('/api/settings', (req, res) => {
  res.json({
    settings: settings.publicSettings(),
    locales: locales.list().map((entry) => ({ code: entry.code, label: entry.label })),
    mapPathPrefix: settings.mapPathPrefix(),
    isAdmin: auth.isAdmin(req),
  });
});

// POST /api/maps/:shortId/parse -> append the parsed relations to a saved map,
// or replace every relation of the map when the body sends "mode": "replace"
// (that is what the map editor uses: its textarea holds the relations already
// saved in the map, so lines can be added or removed before saving).
app.post('/api/maps/:shortId/parse', auth.requireAdmin, asyncHandler(async (req, res) => {
  const map = await maps.findMapByShortId(req.params.shortId);

  if (!map) {
    return res.status(404).json({ error: 'Map not found.' });
  }

  const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  const mode = req.body && req.body.mode === 'replace' ? 'replace' : 'append';

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

  // Replacing discards what is stored, so a single invalid line aborts the
  // whole request instead of silently dropping relations.
  if (mode === 'replace' && invalidLines.length > 0) {
    return res.status(400).json({
      error: 'Every line must be a valid relation when replacing the map relations.',
      invalidLines,
    });
  }

  if (mode === 'replace') {
    await maps.clearMapGraph(map.id);
  }

  await maps.insertMapRelations(map.id, relations);

  const payload = await maps.fetchMapGraph(map.id);
  const updated = await maps.findMapById(map.id);

  // The card shows the entity/connection counts, so every save regenerates it.
  await refreshCard(updated);

  return res.json({
    map: {
      short_id: map.short_id,
      title: map.title,
      description: map.description,
      updated_at: updated ? updated.updated_at : map.updated_at,
      url: mapUrl(req, map.short_id),
    },
    nodes: payload.nodes,
    edges: payload.edges,
  });
}));

// DELETE /api/maps/:shortId/graph -> empty a saved map (the map itself stays).
app.delete('/api/maps/:shortId/graph', auth.requireAdmin, asyncHandler(async (req, res) => {
  const map = await maps.findMapByShortId(req.params.shortId);

  if (!map) {
    return res.status(404).json({ error: 'Map not found.' });
  }

  const removed = await maps.clearMapGraph(map.id);

  // An emptied map still gets a card (title, description, "no entities").
  await refreshCard(await maps.findMapById(map.id));

  return res.json({ success: true, removed });
}));

// GET /api/maps -> saved maps (administrators only).
app.get('/api/maps', auth.requireAdmin, asyncHandler(async (req, res) => {
  const all = await maps.listMaps();
  res.json({
    maps: all.map((map) => ({ ...map, url: mapUrl(req, map.short_id) })),
  });
}));

// GET /api/maps/:shortId -> graph of a saved map (public when published).
app.get('/api/maps/:shortId', asyncHandler(async (req, res) => {
  const map = await maps.findMapByShortId(req.params.shortId);

  if (!map || (!map.is_public && !auth.isAdmin(req))) {
    return res.status(404).json({ error: 'Map not found.' });
  }

  const payload = await maps.fetchMapGraph(map.id);

  return res.json({
    map: {
      short_id: map.short_id,
      title: map.title,
      description: map.description,
      updated_at: map.updated_at,
      url: mapUrl(req, map.short_id),
    },
    nodes: payload.nodes,
    edges: payload.edges,
  });
}));

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// GET /auth/login -> login form (with a short lived CSRF token).
app.get('/auth/login', (req, res) => {
  if (!auth.isAccount()) {
    return res.status(404).type('text/plain').send('Not found');
  }

  if (auth.isAdmin(req)) {
    return res.redirect(safeNext(req.query.next) || '/admin/settings');
  }

  const data = pageData(req, {
    title: `${settings.siteTitle(currentLocale(req))} — Login`,
    robotsMeta: NOINDEX_META,
  });

  data.CSRF_TOKEN = auth.issueLoginCsrf(req, res);
  data.NEXT_URL = safeNext(req.query.next);
  data.AUTH_NOT_CONFIGURED = !auth.credentialsConfigured();
  data.ERROR_MESSAGE = '';

  return res.send(render.renderPage('login.html', data));
});

// POST /auth/login -> verify the env credentials and start a session.
app.post('/auth/login', (req, res) => {
  if (!auth.isAccount()) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const email = fieldValue(req.body.email).trim();
  const password = fieldValue(req.body.password);
  const nextUrl = safeNext(req.body.next) || '/admin/settings';

  const renderLogin = (errorKey) => {
    const data = pageData(req, {
      title: `${settings.siteTitle(currentLocale(req))} — Login`,
      robotsMeta: NOINDEX_META,
    });

    data.CSRF_TOKEN = auth.issueLoginCsrf(req, res);
    data.NEXT_URL = safeNext(req.body.next);
    data.AUTH_NOT_CONFIGURED = !auth.credentialsConfigured();
    data.ERROR_MESSAGE = errorKey;
    data.EMAIL = email;

    return res.status(400).send(render.renderPage('login.html', data));
  };

  if (!auth.credentialsConfigured()) {
    return renderLogin('authNotConfigured');
  }

  if (!auth.verifyLoginCsrf(req)) {
    return renderLogin('authSessionExpired');
  }

  if (!auth.verifyCredentials(email, password)) {
    return renderLogin('authInvalidCredentials');
  }

  auth.clearLoginCsrf(req, res);
  auth.issueSession(req, res, email);

  return res.redirect(nextUrl);
});

// POST /auth/logout -> drop the session cookie.
app.post('/auth/logout', (req, res) => {
  if (!auth.isAdmin(req)) {
    auth.clearSession(req, res);
    return res.redirect('/');
  }

  return auth.requireCsrf(req, res, () => {
    auth.clearSession(req, res);
    return res.redirect('/');
  });
});


// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------

/**
 * Build the data for the admin settings page.
 *
 * @param {import('express').Request} req
 * @param {Object} [state]
 * @returns {Object}
 */
function adminSettingsData(req, state = {}) {
  const source = state.form || null;
  const read = (key, fallback) => (
    source && Object.prototype.hasOwnProperty.call(source, key) ? fieldValue(source[key]) : fallback
  );
  const defaultLocale = locales.resolve(read('default_locale', settings.defaultLocale()));
  const defaultTheme = read('default_theme', settings.defaultTheme()) === 'light' ? 'light' : 'dark';
  // Where the generated OpenGraph cards are stored, and whether they can be
  // stored at all: a bind mount owned by root is the usual reason for "no".
  const cardStatus = ogcard.status();

  return {
    ...pageData(req, {
      title: `${settings.siteTitle(currentLocale(req))} — Admin`,
      robotsMeta: NOINDEX_META,
      pageScripts: ADMIN_SCRIPT,
      showHomeLink: true,
    }),
    SAVED_OK: state.saved === true,
    SEEDED_OK: state.seeded === true,
    VALIDATION_ERROR: state.error || '',
    LOCALES: locales.list().map((entry) => ({
      code: entry.code,
      label: entry.label,
      title_value: read(`site_title_${entry.code}`, settings.siteTitle(entry.code)),
      subtitle_value: read(`site_subtitle_${entry.code}`, settings.siteSubtitle(entry.code)),
      selected_default: entry.code === defaultLocale ? 'selected' : '',
    })),
    SITE_LOGO_URL: read('site_logo_url', settings.get('site_logo_url', '')),
    FAVICON_URL: read('favicon_url', settings.get('favicon_url', '')),
    DEFAULT_THEME_DARK: defaultTheme === 'dark',
    DEFAULT_THEME_LIGHT: defaultTheme === 'light',
    THEME_COLOR_LIGHT: read('theme_color_light', settings.themeColors().light),
    THEME_COLOR_DARK: read('theme_color_dark', settings.themeColors().dark),
    MAP_PATH_PREFIX: read('map_path_prefix', settings.mapPathPrefix()),
    MAP_SHORT_ID_LENGTH: read('map_short_id_length', String(settings.shortIdLength())),
    SHORT_ID_UPPERCASE: source ? checkboxValue(source, 'map_short_id_uppercase') : settings.shortIdUppercase(),
    SHORT_ID_NUMBERS: source ? checkboxValue(source, 'map_short_id_numbers') : settings.shortIdNumbers(),
    ROBOTS_ENABLED: source ? checkboxValue(source, 'robots_enabled') : settings.getBool('robots_enabled', true),
    ROBOTS_CONTENT: read('robots_content', settings.get('robots_content', '')),
    SITEMAP_ENABLED: source ? checkboxValue(source, 'sitemap_enabled') : settings.getBool('sitemap_enabled', false),
    SITE_URL_RAW: read('site_url', settings.siteUrl()),
    TWITTER_SITE: read('twitter_site', settings.get('twitter_site', '')),
    OG_IMAGE_URL: read('og_image_url', settings.get('og_image_url', '')),
    OG_CARD_ENABLED: source ? checkboxValue(source, 'og_card_enabled') : settings.getBool('og_card_enabled', true),
    OG_CARD_FOLDER: cardStatus.folder,
    OG_CARD_WRITABLE: cardStatus.writable,
    OG_CARD_READONLY: !cardStatus.writable,
    // String so that "0 regenerated" still renders the banner.
    CARDS_OK: state.cards === null || state.cards === undefined ? '' : String(state.cards),
    CUSTOM_HEAD: read('custom_head', settings.get('custom_head', '')),
    CUSTOM_CSS: read('custom_css', settings.get('custom_css', '')),
    CUSTOM_JS: read('custom_js', settings.get('custom_js', '')),
    ADMIN_EMAIL: req.admin ? req.admin.email : '',
  };
}

/**
 * Validate the settings form, returning i18n keys for the first error.
 *
 * @param {Object} body
 * @returns {string[]}
 */
function validateSettings(body) {
  const errors = [];
  const prefix = fieldValue(body.map_path_prefix).trim().toLowerCase();

  if (prefix.length > 16 || (prefix !== '' && !/^[a-z0-9_-]+$/.test(prefix))) {
    errors.push('errorSettingsInvalidPrefix');
  }

  const length = Number.parseInt(fieldValue(body.map_short_id_length), 10);

  if (!Number.isInteger(length) || length < 3 || length > 32) {
    errors.push('errorSettingsInvalidLength');
  }

  const siteUrl = fieldValue(body.site_url).trim();

  if (siteUrl !== '' && !/^https?:\/\/\S+$/i.test(siteUrl)) {
    errors.push('errorSettingsInvalidSiteUrl');
  }

  return errors;
}

/**
 * Persist every settings form field.
 *
 * @param {Object} body
 */
async function persistSettings(body) {
  const entries = [
    ['default_locale', locales.resolve(fieldValue(body.default_locale), settings.defaultLocale())],
    ['default_theme', fieldValue(body.default_theme) === 'light' ? 'light' : 'dark'],
    ['theme_color_light', fieldValue(body.theme_color_light).trim()],
    ['theme_color_dark', fieldValue(body.theme_color_dark).trim()],
    ['map_path_prefix', fieldValue(body.map_path_prefix).trim().toLowerCase()],
    ['map_short_id_length', String(Number.parseInt(fieldValue(body.map_short_id_length), 10) || 6)],
    ['map_short_id_uppercase', checkboxValue(body, 'map_short_id_uppercase') ? '1' : '0'],
    ['map_short_id_numbers', checkboxValue(body, 'map_short_id_numbers') ? '1' : '0'],
    ['site_logo_url', fieldValue(body.site_logo_url).trim()],
    ['favicon_url', fieldValue(body.favicon_url).trim()],
    ['site_url', fieldValue(body.site_url).trim()],
    ['twitter_site', fieldValue(body.twitter_site).trim()],
    ['og_image_url', fieldValue(body.og_image_url).trim()],
    ['og_card_enabled', checkboxValue(body, 'og_card_enabled') ? '1' : '0'],
    ['robots_enabled', checkboxValue(body, 'robots_enabled') ? '1' : '0'],
    ['robots_content', fieldValue(body.robots_content)],
    ['sitemap_enabled', checkboxValue(body, 'sitemap_enabled') ? '1' : '0'],
    ['custom_head', fieldValue(body.custom_head)],
    ['custom_css', fieldValue(body.custom_css)],
    ['custom_js', fieldValue(body.custom_js)],
  ];

  locales.codes().forEach((code) => {
    entries.push([`site_title_${code}`, fieldValue(body[`site_title_${code}`]).trim()]);
    entries.push([`site_subtitle_${code}`, fieldValue(body[`site_subtitle_${code}`]).trim()]);
  });

  await settings.putMany(entries);
}


/**
 * Build the data for the saved maps admin page.
 *
 * @param {import('express').Request} req
 * @param {Object} [state]
 * @returns {Promise<Object>}
 */
async function adminMapsData(req, state = {}) {
  const all = await maps.listMaps();
  const csrf = auth.csrfToken(req);
  const prefix = settings.mapPathPrefix();

  return {
    ...pageData(req, {
      title: `${settings.siteTitle(currentLocale(req))} — Maps`,
      robotsMeta: NOINDEX_META,
      pageScripts: ADMIN_SCRIPT,
      showHomeLink: true,
    }),
    DELETED_OK: state.deleted === true,
    UPDATED_OK: state.updated === true,
    VALIDATION_ERROR: state.error || '',
    MAPS_EMPTY: all.length === 0,
    MAPS: all.map((map) => ({
      id: map.id,
      short_id: map.short_id,
      title: map.title,
      description: map.description,
      is_public: map.is_public,
      is_private: !map.is_public,
      node_count: map.node_count,
      edge_count: map.edge_count,
      url: `/${prefix}/${map.short_id}`,
      csrf,
    })),
  };
}

// GET /admin -> the settings page is the admin landing page.
app.get('/admin', auth.requireAdmin, (req, res) => {
  res.redirect('/admin/settings');
});

// GET /admin/settings -> tabbed settings form.
app.get('/admin/settings', auth.requireAdmin, (req, res) => {
  const generated = Number.parseInt(req.query.cards, 10);

  res.send(render.renderPage('admin/settings.html', adminSettingsData(req, {
    saved: req.query.saved === '1',
    seeded: req.query.seeded === '1',
    cards: Number.isInteger(generated) ? generated : null,
  })));
});

// POST /admin/settings -> persist the settings form.
app.post('/admin/settings', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const errors = validateSettings(req.body);

  if (errors.length > 0) {
    return res.status(400).send(render.renderPage(
      'admin/settings.html',
      adminSettingsData(req, { error: errors[0], form: req.body })
    ));
  }

  await persistSettings(req.body);

  return res.redirect('/admin/settings?saved=1');
}));

// GET /admin/maps -> list and manage saved maps.
app.get('/admin/maps', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.send(render.renderPage('admin/maps.html', await adminMapsData(req, {
    deleted: req.query.deleted === '1',
    updated: req.query.updated === '1',
  })));
}));

// POST /admin/maps -> create an empty map and open it for editing.
app.post('/admin/maps', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const title = fieldValue(req.body.title).trim();
  const description = fieldValue(req.body.description);

  if (title === '') {
    return res.status(400).send(render.renderPage('index.html', await homeData(req, {
      create: true,
      title,
      description,
      error: 'errorMapTitleRequired',
    })));
  }

  const map = await maps.createMap({
    title,
    description,
    isPublic: checkboxValue(req.body, 'is_public'),
  });

  await refreshCard(map);

  return res.redirect(`/${settings.mapPathPrefix()}/${map.short_id}`);
}));

// POST /admin/maps/:id/update -> rename / re-describe / toggle visibility.
app.post('/admin/maps/:id/update', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const map = await maps.findMapById(req.params.id);

  if (!map) {
    return res.status(404).type('text/plain').send('Map not found');
  }

  const updated = await maps.updateMapMeta(map.id, {
    title: fieldValue(req.body.title),
    description: fieldValue(req.body.description),
    isPublic: checkboxValue(req.body, 'is_public'),
  });

  // Title, description and visibility are all painted on the card.
  await refreshCard(updated);

  const returnTo = safeReturn(req.body.return_to) || '/admin/maps';
  const separator = returnTo.includes('?') ? '&' : '?';

  return res.redirect(`${returnTo}${separator}updated=1`);
}));

// POST /admin/maps/:id/delete -> remove a saved map.
app.post('/admin/maps/:id/delete', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const map = await maps.findMapById(req.params.id);

  await maps.deleteMap(req.params.id);

  if (map) {
    // The card of a deleted map must not linger on the volume.
    ogcard.removeCards(map.short_id);
  }

  return res.redirect('/admin/maps?deleted=1');
}));

// POST /admin/maintenance/demo-map -> publish the example data as a new map.
app.post('/admin/maintenance/demo-map', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const locale = settings.defaultLocale();
  const { relations } = parseTextWithDetails(EXAMPLE_TEXT);
  const map = await maps.createMap({
    title: exampleMapTitle(locale),
    description: exampleMapDescription(locale),
    isPublic: true,
  });

  await maps.insertMapRelations(map.id, relations);

  await refreshCard(await maps.findMapById(map.id));

  return res.redirect('/admin/settings?seeded=1');
}));

// POST /admin/maintenance/og-cards -> regenerate every OpenGraph card.
//
// Useful after changing the site title, the domain or the default theme, since
// all of those are painted on the cards.
app.post('/admin/maintenance/og-cards', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const all = await maps.listMaps();
  let generated = 0;

  for (const row of all) {
    const map = await maps.findMapById(row.id);

    if (map && await ogcard.refresh(map)) {
      generated += 1;
    }
  }

  return res.redirect(`/admin/settings?cards=${generated}`);
}));


// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Format a timestamp as an ISO (YYYY-MM-DD) date.
 *
 * @param {unknown} value
 * @returns {string}
 */
function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : '';
}

/**
 * Build the data for the home page: every visible map, a randomly picked map
 * (or the one requested through ?map=) and the preview of that map.
 *
 * @param {import('express').Request} req
 * @param {{create?: boolean, title?: string, description?: string, error?: string}} [state]
 * @returns {Promise<Object>}
 */
async function homeData(req, state = {}) {
  const isAdmin = auth.isAdmin(req);
  const prefix = settings.mapPathPrefix();
  const all = await maps.listMaps({ publicOnly: !isAdmin });
  const requested = typeof req.query.map === 'string' ? req.query.map.trim() : '';
  const requestedMap = all.find((entry) => entry.short_id === requested) || null;
  const selected = requestedMap
    || (all.length > 0 ? all[Math.floor(Math.random() * all.length)] : null);

  return {
    ...pageData(req, { pageScripts: APP_SCRIPT, ...cardImageOptions(req, selected) }),
    MAPS: all.map((map) => {
      const isSelected = selected !== null && map.short_id === selected.short_id;

      return {
        id: map.id,
        short_id: map.short_id,
        title: map.title,
        description: map.description,
        is_public: map.is_public,
        is_private: !map.is_public,
        node_count: map.node_count,
        edge_count: map.edge_count,
        select_url: `/?map=${encodeURIComponent(map.short_id)}`,
        url: `/${prefix}/${map.short_id}`,
        selected_class: isSelected ? 'selected' : '',
        current_attr: isSelected ? 'aria-current="true"' : '',
        open_label_key: isAdmin ? 'mapOpenEdit' : 'mapOpenFullscreen',
      };
    }),
    MAPS_LISTED: all.length > 0,
    MAPS_EMPTY: all.length === 0,
    SELECTED_MAP: selected !== null,
    MAP_PREVIEW_EMPTY: selected === null,
    SELECTED_MAP_TITLE: selected ? selected.title : '',
    SELECTED_MAP_DESCRIPTION: selected ? selected.description : '',
    SELECTED_MAP_URL: selected ? `/${prefix}/${selected.short_id}` : '',
    SELECTED_MAP_COUNTS: selected ? `${selected.node_count} / ${selected.edge_count}` : '',
    SELECTED_MAP_UPDATED: selected ? isoDate(selected.updated_at) : '',
    MAP_GRAPH_SOURCE: selected ? `/api/maps/${encodeURIComponent(selected.short_id)}` : '',
    CREATE_PANEL: isAdmin && (state.create === true || req.query.create === '1'),
    NEW_MAP_TITLE: state.title || '',
    NEW_MAP_DESCRIPTION: state.description || '',
    VALIDATION_ERROR: state.error || '',
  };
}

// GET / -> map picker with a randomly selected preview.
app.get('/', asyncHandler(async (req, res) => {
  res.send(render.renderPage('index.html', await homeData(req)));
}));

// GET /{map_path_prefix}/{shortId} -> saved map (editable for administrators).
app.get(
  '/:prefix([a-z0-9_-]{1,16})/:shortId([A-Za-z0-9]{3,32})',
  asyncHandler(async (req, res, next) => {
    if (req.params.prefix !== settings.mapPathPrefix()) {
      return next();
    }

    const map = await maps.findMapByShortId(req.params.shortId);

    if (!map || (!map.is_public && !auth.isAdmin(req))) {
      return next();
    }

    const locale = currentLocale(req);
    const prefix = settings.mapPathPrefix();
    const data = pageData(req, {
      title: `${map.title} — ${settings.siteTitle(locale)}`,
      description: map.description || settings.siteSubtitle(locale),
      canonicalPath: `/${prefix}/${map.short_id}`,
      ogType: 'article',
      showHomeLink: true,
      pageScripts: APP_SCRIPT,
      ...cardImageOptions(req, map),
    });

    data.MAP_ID = map.id;
    data.MAP_TITLE = map.title;
    data.MAP_DESCRIPTION = map.description;
    data.MAP_SHORT_ID = map.short_id;
    data.MAP_UPDATED = isoDate(map.updated_at);
    data.MAP_ABSOLUTE_URL = mapUrl(req, map.short_id);
    data.CAN_EDIT_MAP = auth.isAdmin(req);
    data.CHECKED_PUBLIC = map.is_public ? 'checked' : '';
    data.DETAILS_ACTION = `/admin/maps/${map.id}/update`;
    data.RETURN_TO = `/${prefix}/${map.short_id}`;
    data.PARSE_ENDPOINT = `/api/maps/${map.short_id}/parse`;
    data.CLEAR_ENDPOINT = `/api/maps/${map.short_id}/graph`;
    // The editor textarea holds the relations already saved in the map, so they
    // can be copied, edited (added/removed) and saved again as the full set.
    data.RELATIONS_TEXT = data.CAN_EDIT_MAP ? formatRelations(await maps.fetchMapGraph(map.id)) : '';
    // Preview of the generated card (administrators only).
    data.OG_CARD_URL = data.CAN_EDIT_MAP ? mapCardPath(map) : '';
    data.UPDATED_OK = req.query.updated === '1';

    return res.send(render.renderPage('map.html', data));
  })
);

// Fallback: a plain 404 page.
app.use((req, res) => {
  res.status(404).type('html').send(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
     <meta name="viewport" content="width=device-width, initial-scale=1.0">
     <title>404 — Not found</title></head>
     <body style="font-family:system-ui,sans-serif;padding:2rem">
     <h1>404</h1><p>The page you requested does not exist.</p>
     <p><a href="/">Back to the maps</a></p></body></html>`
  );
});

// JSON error middleware.
app.use((error, req, res, _next) => {
  console.error('Request error:', error);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({ error: 'Internal server error.' });
});

/**
 * Publish the staged example relations (or the legacy working graph) as the
 * first saved map when the database does not have any map yet.
 *
 * @returns {Promise<void>}
 */
async function ensureInitialMap() {
  const existing = await maps.listMaps();

  if (existing.length > 0) {
    return;
  }

  const locale = settings.defaultLocale();
  const map = await maps.createMapFromScratch({
    title: exampleMapTitle(locale),
    description: exampleMapDescription(locale),
    isPublic: true,
  });

  if (map) {
    console.log(
      `Initial map published: ${settings.mapPathPrefix()}/${map.short_id} (${map.title})`
    );
  }

  await refreshCard(map);
}

/**
 * Bootstrap: initialize the database (connect, migrate, stage the example
 * data), publish the first map if needed, load the settings cache and then
 * start listening.
 */
async function main() {
  try {
    await initDatabase();
    await settings.load();

    // Make sure the OpenGraph card volume is usable before anything tries to
    // write to it (a read-only mount is reported and the app keeps running).
    ogcard.ensureDirectory();
    await ensureInitialMap();

    if (!auth.credentialsConfigured()) {
      console.warn(
        '[auth] No admin credentials configured. Set ADMIN_LOGIN and ADMIN_PASSWORD to enable the admin panel.'
      );
    }

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

