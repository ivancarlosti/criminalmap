'use strict';

/**
 * Supported locales.
 *
 * Locale codes use the underscore form (pt_BR, en_US, es_MX) and match the
 * dictionary file names in public/locales/. The <html lang> attribute uses the
 * hyphenated form (pt-BR), mirroring the reference project.
 */

const DEFAULT_CODE = 'pt_BR';

const CATALOG = {
  pt_BR: {
    label: 'Português (Brasil)',
    defaultTitle: 'Quadro de Crimes',
    defaultSubtitle: 'Rede de Investigação Criminal',
  },
  en_US: {
    label: 'English (US)',
    defaultTitle: 'Crime Board',
    defaultSubtitle: 'Investigation Network Graph',
  },
  es_MX: {
    label: 'Español (México)',
    defaultTitle: 'Tablero de Crímenes',
    defaultSubtitle: 'Red de Investigación Criminal',
  },
};

/**
 * Return the locale catalog enriched with the code itself.
 *
 * @returns {Array<{code: string, label: string, defaultTitle: string, defaultSubtitle: string}>}
 */
function list() {
  return Object.keys(CATALOG).map((code) => ({ code, ...CATALOG[code] }));
}

/**
 * @returns {string[]} every supported locale code.
 */
function codes() {
  return Object.keys(CATALOG);
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function isSupported(code) {
  return Object.prototype.hasOwnProperty.call(CATALOG, code);
}

/**
 * Normalize an arbitrary value (e.g. from a cookie or a form) into a supported
 * locale code, falling back to $fallback (itself validated) or the default.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
function resolve(value, fallback = DEFAULT_CODE) {
  const candidate = typeof value === 'string' ? value.trim() : '';

  if (isSupported(candidate)) {
    return candidate;
  }

  return isSupported(fallback) ? fallback : DEFAULT_CODE;
}

/**
 * @param {string} code
 * @returns {string} the human readable locale name.
 */
function label(code) {
  return isSupported(code) ? CATALOG[code].label : code;
}

/**
 * @param {string} code
 * @returns {string} the value for the <html lang> attribute (pt_BR -> pt-BR).
 */
function htmlLang(code) {
  return String(code).replace('_', '-');
}

module.exports = {
  DEFAULT_CODE,
  codes,
  htmlLang,
  isSupported,
  label,
  list,
  resolve,
};
