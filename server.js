'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const { initDatabase, getPool } = require('./src/db');
const { parseTextWithDetails } = require('./src/parser');
const { seedDatabase, insertRelations } = require('./src/seed');
const graph = require('./src/graph');
const locales = require('./src/locales');
const maps = require('./src/maps');
const render = require('./src/render');
const settings = require('./src/settings');
const auth = require('./src/auth');

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
 * Restrict return targets to known pages.
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeReturn(value) {
  const target = safeNext(value);
  return ['/', '/admin/maps', '/admin/settings'].includes(target) ? target : '';
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
 * @returns {string} OpenGraph/Twitter image meta tags, or an empty string.
 */
function imageMeta(imageUrl, title) {
  const value = String(imageUrl || '').trim();

  if (value === '') {
    return '';
  }

  const escaped = render.escapeHtml(value);
  return [
    `<meta property="og:image" content="${escaped}">`,
    `<meta property="og:image:alt" content="${render.escapeHtml(title)}">`,
    `<meta name="twitter:image" content="${escaped}">`,
  ].join('\n  ');
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
    OG_IMAGE_META: imageMeta(image, title),
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
      publicEditor: settings.getBool('show_public_editor', true),
    }),
    SUPPORTED_LOCALES: locales.list().map((entry) => ({
      code: entry.code,
      label: entry.label,
      selected: entry.code === locale ? 'selected' : '',
    })),
    IS_ADMIN: isAdmin,
    NOT_ADMIN: !isAdmin,
    SHOW_LOGIN_LINK: !isAdmin && auth.isAccount(),
    SHOW_EDITOR_LINK: options.showEditorLink === true,
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

/**
 * The editor is open to everybody unless the admin disables it.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function canEdit(req) {
  return settings.getBool('show_public_editor', true) || auth.isAdmin(req);
}

/**
 * Guard the graph-writing API endpoints.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function requireEditor(req, res, next) {
  if (canEdit(req)) {
    return next();
  }

  return res.status(403).json({
    error: 'Editing is restricted to administrators. Sign in to continue.',
  });
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

// GET /api/settings -> public settings used by the frontend bootstrap.
app.get('/api/settings', (req, res) => {
  res.json({
    settings: settings.publicSettings(),
    locales: locales.list().map((entry) => ({ code: entry.code, label: entry.label })),
    mapPathPrefix: settings.mapPathPrefix(),
    isAdmin: auth.isAdmin(req),
  });
});

// GET /api/graph -> full working graph payload.
app.get('/api/graph', asyncHandler(async (req, res) => {
  res.json(await graph.fetchGraph());
}));

// GET /api/nodes -> nodes subset.
app.get('/api/nodes', asyncHandler(async (req, res) => {
  const { nodes } = await graph.fetchGraph();
  res.json({ nodes });
}));

// GET /api/edges -> edges subset.
app.get('/api/edges', asyncHandler(async (req, res) => {
  const { edges } = await graph.fetchGraph();
  res.json({ edges });
}));

// POST /api/parse -> parse text, upsert nodes, insert edges, return the graph.
app.post('/api/parse', requireEditor, asyncHandler(async (req, res) => {
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
  return res.json(await graph.fetchGraph());
}));

// DELETE /api/graph -> remove every edge and node from the working graph.
app.delete('/api/graph', requireEditor, asyncHandler(async (req, res) => {
  const removed = await graph.clearGraph();
  res.json({ success: true, removed });
}));

// POST /api/seed -> wipe the working graph and re-run the seed data.
app.post('/api/seed', requireEditor, asyncHandler(async (req, res) => {
  const pool = getPool();
  await graph.clearGraph(pool);
  await seedDatabase(pool);
  res.json(await graph.fetchGraph());
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

  return {
    ...pageData(req, {
      title: `${settings.siteTitle(currentLocale(req))} — Admin`,
      robotsMeta: NOINDEX_META,
      pageScripts: ADMIN_SCRIPT,
    }),
    SAVED_OK: state.saved === true,
    CLEARED_OK: state.cleared === true,
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
    SHOW_PUBLIC_EDITOR: source
      ? checkboxValue(source, 'show_public_editor')
      : settings.getBool('show_public_editor', true),
    ROBOTS_ENABLED: source ? checkboxValue(source, 'robots_enabled') : settings.getBool('robots_enabled', true),
    ROBOTS_CONTENT: read('robots_content', settings.get('robots_content', '')),
    SITEMAP_ENABLED: source ? checkboxValue(source, 'sitemap_enabled') : settings.getBool('sitemap_enabled', false),
    SITE_URL_RAW: read('site_url', settings.siteUrl()),
    TWITTER_SITE: read('twitter_site', settings.get('twitter_site', '')),
    OG_IMAGE_URL: read('og_image_url', settings.get('og_image_url', '')),
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
    ['show_public_editor', checkboxValue(body, 'show_public_editor') ? '1' : '0'],
    ['site_logo_url', fieldValue(body.site_logo_url).trim()],
    ['favicon_url', fieldValue(body.favicon_url).trim()],
    ['site_url', fieldValue(body.site_url).trim()],
    ['twitter_site', fieldValue(body.twitter_site).trim()],
    ['og_image_url', fieldValue(body.og_image_url).trim()],
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
    }),
    SAVED_OK: state.saved === true,
    DELETED_OK: state.deleted === true,
    UPDATED_OK: state.updated === true,
    LOADED_OK: state.loaded === true,
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
  res.send(render.renderPage('admin/settings.html', adminSettingsData(req, {
    saved: req.query.saved === '1',
    cleared: req.query.cleared === '1',
    seeded: req.query.seeded === '1',
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
    saved: req.query.saved === '1',
    deleted: req.query.deleted === '1',
    updated: req.query.updated === '1',
    loaded: req.query.loaded === '1',
  })));
}));

// POST /admin/maps -> snapshot the working graph into a new saved map.
app.post('/admin/maps', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const title = fieldValue(req.body.title).trim();
  const returnTo = safeReturn(req.body.return_to) || '/admin/maps';

  if (title === '') {
    if (returnTo === '/admin/maps') {
      return res.status(400).send(render.renderPage(
        'admin/maps.html',
        await adminMapsData(req, { error: 'errorMapTitleRequired' })
      ));
    }

    return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=1`);
  }

  const map = await maps.createMapFromScratch({
    title,
    description: fieldValue(req.body.description),
    isPublic: checkboxValue(req.body, 'is_public'),
  });

  const separator = returnTo.includes('?') ? '&' : '?';

  return res.redirect(`${returnTo}${separator}saved=${encodeURIComponent(map.short_id)}`);
}));

// POST /admin/maps/:id/update -> rename / re-describe / toggle visibility.
app.post('/admin/maps/:id/update', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const map = await maps.findMapById(req.params.id);

  if (!map) {
    return res.status(404).type('text/plain').send('Map not found');
  }

  await maps.updateMapMeta(map.id, {
    title: fieldValue(req.body.title),
    description: fieldValue(req.body.description),
    isPublic: checkboxValue(req.body, 'is_public'),
  });

  return res.redirect('/admin/maps?updated=1');
}));

// POST /admin/maps/:id/replace -> replace a map snapshot with the working graph.
app.post('/admin/maps/:id/replace', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const map = await maps.findMapById(req.params.id);

  if (!map) {
    return res.status(404).type('text/plain').send('Map not found');
  }

  await maps.replaceMapGraphFromScratch(map.id);

  return res.redirect('/admin/maps?updated=1');
}));

// POST /admin/maps/:id/load -> copy a map snapshot into the working graph.
app.post('/admin/maps/:id/load', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const map = await maps.findMapById(req.params.id);

  if (!map) {
    return res.status(404).type('text/plain').send('Map not found');
  }

  await maps.replaceScratchFromMap(map.id);

  return res.redirect('/?loaded=1');
}));

// POST /admin/maps/:id/delete -> remove a saved map.
app.post('/admin/maps/:id/delete', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  await maps.deleteMap(req.params.id);

  return res.redirect('/admin/maps?deleted=1');
}));

// POST /admin/maintenance/clear -> empty the working graph.
app.post('/admin/maintenance/clear', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  await graph.clearGraph();

  return res.redirect('/admin/settings?cleared=1');
}));

// POST /admin/maintenance/seed -> restore the built-in example graph.
app.post('/admin/maintenance/seed', auth.requireAdmin, auth.requireCsrf, asyncHandler(async (req, res) => {
  const pool = getPool();
  await graph.clearGraph(pool);
  await seedDatabase(pool);

  return res.redirect('/admin/settings?seeded=1');
}));


// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// GET / -> the working graph editor (or a read-only view for visitors).
app.get('/', asyncHandler(async (req, res) => {
  const data = pageData(req, { pageScripts: APP_SCRIPT });
  const editable = canEdit(req);
  const savedId = typeof req.query.saved === 'string' ? req.query.saved.trim() : '';

  data.EDITOR_PANEL = editable;
  data.READ_ONLY_NOTICE = !editable;
  data.SAVED_MAP_URL = '';

  if (savedId !== '') {
    const map = await maps.findMapByShortId(savedId);

    if (map) {
      data.SAVED_MAP_URL = mapUrl(req, map.short_id);
    }
  }

  res.send(render.renderPage('index.html', data));
}));

// GET /{map_path_prefix}/{shortId} -> public read-only view of a saved map.
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
    const data = pageData(req, {
      title: `${map.title} — ${settings.siteTitle(locale)}`,
      description: map.description || settings.siteSubtitle(locale),
      canonicalPath: `/${settings.mapPathPrefix()}/${map.short_id}`,
      ogType: 'article',
      showEditorLink: true,
      pageScripts: APP_SCRIPT,
    });

    data.MAP_TITLE = map.title;
    data.MAP_DESCRIPTION = map.description;
    data.MAP_SHORT_ID = map.short_id;
    data.MAP_UPDATED = map.updated_at ? new Date(map.updated_at).toISOString().slice(0, 10) : '';

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
     <p><a href="/">Back to the map</a></p></body></html>`
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
 * Bootstrap: initialize the database (connect, migrate, seed), load the
 * settings cache and then start listening.
 */
async function main() {
  try {
    await initDatabase();
    await settings.load();

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

