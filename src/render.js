'use strict';

/**
 * Minimal server-side template renderer for the HTML views in views/.
 *
 * Supported syntax:
 *   {{KEY}}                 escaped interpolation
 *   {{{KEY}}}               raw (unescaped) interpolation
 *   {{#if KEY}}...{{/if}}   rendered only when KEY is truthy
 *   {{#each KEY}}...{{/each}}  repeated for every item; {{FIELD}} inside a
 *                              section resolves against the item first, then
 *                              against the root data
 *
 * Nested sections of the same kind are intentionally not supported; render the
 * few places that need them from JavaScript instead (see the admin pages).
 */

const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');
const templateCache = new Map();
const EACH_REGEX = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
const IF_REGEX = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

/**
 * Escape a value for safe HTML output.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read (and cache) a template file.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function template(relativePath) {
  const key = relativePath.replace(/^\/+/, '');

  if (!templateCache.has(key)) {
    const absolute = path.join(VIEWS_DIR, key);

    if (!absolute.startsWith(VIEWS_DIR)) {
      throw new Error(`Refusing to read a template outside of views/: ${relativePath}`);
    }

    templateCache.set(key, fs.readFileSync(absolute, 'utf8'));
  }

  return templateCache.get(key);
}

/**
 * Replace {{KEY}} / {{{KEY}}} placeholders.
 *
 * @param {string} source
 * @param {Object} scope
 * @returns {string}
 */
function interpolate(source, scope) {
  let output = source.replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(scope, key) && scope[key] !== null && scope[key] !== undefined
      ? String(scope[key])
      : ''
  );

  output = output.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(scope, key) ? escapeHtml(scope[key]) : ''
  );

  return output;
}

/**
 * Resolve a section value against an item first, then the root data.
 *
 * @param {Object} data
 * @param {Object|null} item
 * @param {string} key
 * @returns {unknown}
 */
function lookup(data, item, key) {
  if (item && Object.prototype.hasOwnProperty.call(item, key)) {
    return item[key];
  }

  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
}

/**
 * Render a template string with the given data.
 *
 * @param {string} source
 * @param {Object} [data]
 * @returns {string}
 */
function renderString(source, data = {}) {
  let output = source;

  // {{#each}} sections — interpolated per item before the {{#if}} pass runs.
  output = output.replace(EACH_REGEX, (match, key, body) => {
    const items = data[key];

    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }

    return items
      .map((item) => {
        const scope = item && typeof item === 'object' ? { ...data, ...item } : data;
        const chunk = body.replace(IF_REGEX, (innerMatch, innerKey, innerBody) =>
          scope[innerKey] ? innerBody : ''
        );

        return interpolate(chunk, scope);
      })
      .join('');
  });

  // {{#if}} sections.
  output = output.replace(IF_REGEX, (match, key, body) => (data[key] ? interpolate(body, data) : ''));

  return interpolate(output, data);
}

/**
 * Render a template file.
 *
 * @param {string} relativePath
 * @param {Object} [data]
 * @returns {string}
 */
function renderTemplate(relativePath, data = {}) {
  return renderString(template(relativePath), data);
}

/**
 * Render a page template wrapped into views/layout.html.
 *
 * @param {string} relativePath
 * @param {Object} [data]
 * @returns {string}
 */
function renderPage(relativePath, data = {}) {
  const content = renderTemplate(relativePath, data);
  return renderTemplate('layout.html', { ...data, CONTENT: content });
}

module.exports = { escapeHtml, renderPage, renderString, renderTemplate };
