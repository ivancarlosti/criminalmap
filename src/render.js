'use strict';

/**
 * Minimal server-side template renderer for the HTML views in views/.
 *
 * Supported syntax (sections nest at any depth):
 *   {{KEY}}                    escaped interpolation
 *   {{{KEY}}}                  raw (unescaped) interpolation
 *   {{#if KEY}}…{{/if}}        rendered only when KEY is truthy
 *   {{#each KEY}}…{{/each}}    repeated for every item; keys used inside resolve
 *                              against the item first, then against the root
 *
 * Nesting is the reason this is a small recursive parser instead of regex
 * replacement: a {{#if}} inside another {{#if}} used to close on the first
 * {{/if}} it found, which leaked the tag into the rendered page.
 *
 * Interpolated values are inserted as text and never parsed again, so content
 * coming from the database or from the settings (map titles, custom head/CSS/JS)
 * can not inject template syntax. Unbalanced or unknown tags raise an error:
 * a broken template must be loud instead of being visible to visitors.
 */

const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');
const templateCache = new Map();
const nodeCache = new Map();
const SECTION_TYPES = ['if', 'each'];

// {{{raw}}} | {{#section key}} | {{/section}} | {{key}}
const TOKEN_REGEX = /\{\{\{\s*(\w+)\s*\}\}\}|\{\{\s*#\s*(\w+)\s+(\w+)\s*\}\}|\{\{\s*\/\s*(\w+)\s*\}\}|\{\{\s*(\w+)\s*\}\}/g;

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
 * Split a template into text, interpolation and section tokens.
 *
 * @param {string} source
 * @param {string} label template name used in error messages
 * @returns {Array<Object>}
 */
function tokenize(source, label) {
  const tokens = [];
  let cursor = 0;
  let match = TOKEN_REGEX.exec(source);

  while (match !== null) {
    if (match.index > cursor) {
      tokens.push({ type: 'text', value: source.slice(cursor, match.index) });
    }

    if (match[1] !== undefined) {
      tokens.push({ type: 'raw', name: match[1] });
    } else if (match[2] !== undefined) {
      if (!SECTION_TYPES.includes(match[2])) {
        throw new Error(`${label}: unknown section {{#${match[2]} ${match[3]}}}`);
      }

      tokens.push({ type: 'open', section: match[2], name: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'close', section: match[4] });
    } else {
      tokens.push({ type: 'value', name: match[5] });
    }

    cursor = TOKEN_REGEX.lastIndex;
    match = TOKEN_REGEX.exec(source);
  }

  if (cursor < source.length) {
    tokens.push({ type: 'text', value: source.slice(cursor) });
  }

  return tokens;
}

/**
 * Build the node tree of a template: sections become nodes with children, so
 * nesting is handled by recursion instead of by counting regex matches.
 *
 * @param {Array<Object>} tokens
 * @param {string} label
 * @returns {Array<Object>}
 */
function parse(tokens, label) {
  let cursor = 0;

  /**
   * @param {string|null} stopSection section this call must close, null at the top level
   * @returns {Array<Object>}
   */
  function parseNodes(stopSection) {
    const nodes = [];

    while (cursor < tokens.length) {
      const token = tokens[cursor];

      if (token.type === 'close') {
        if (token.section !== stopSection) {
          throw new Error(
            stopSection === null
              ? `${label}: unexpected {{/${token.section}}} without a matching section`
              : `${label}: expected {{/${stopSection}}} but found {{/${token.section}}}`
          );
        }

        cursor += 1;
        return nodes;
      }

      if (token.type === 'open') {
        cursor += 1;
        nodes.push({ type: token.section, name: token.name, children: parseNodes(token.section) });
        continue;
      }

      nodes.push(token);
      cursor += 1;
    }

    if (stopSection !== null) {
      throw new Error(`${label}: missing {{/${stopSection}}}`);
    }

    return nodes;
  }

  return parseNodes(null);
}

/**
 * Read a key from the innermost scope object that owns it: the iterator item
 * first, then the root data (the lookup order of the previous renderer).
 *
 * @param {Array<Object>} scope
 * @param {string} name
 * @returns {unknown}
 */
function resolve(scope, name) {
  for (let index = 0; index < scope.length; index += 1) {
    const target = scope[index];

    if (target !== null && target !== undefined && Object.prototype.hasOwnProperty.call(Object(target), name)) {
      return target[name];
    }
  }

  return undefined;
}

/**
 * Evaluate a node list against a scope chain.
 *
 * @param {Array<Object>} nodes
 * @param {Array<Object>} scope
 * @returns {string}
 */
function renderNodes(nodes, scope) {
  let output = '';

  nodes.forEach((node) => {
    if (node.type === 'text') {
      output += node.value;
      return;
    }

    if (node.type === 'value') {
      output += escapeHtml(resolve(scope, node.name));
      return;
    }

    if (node.type === 'raw') {
      const raw = resolve(scope, node.name);
      output += raw === null || raw === undefined ? '' : String(raw);
      return;
    }

    const value = resolve(scope, node.name);

    if (node.type === 'if') {
      if (value) {
        output += renderNodes(node.children, scope);
      }

      return;
    }

    // {{#each}}: each item becomes the innermost scope of its own rendering.
    if (!Array.isArray(value)) {
      return;
    }

    value.forEach((item) => {
      output += renderNodes(node.children, [item].concat(scope));
    });
  });

  return output;
}

/**
 * Render a template string with the given data.
 *
 * @param {string} source
 * @param {Object} [data]
 * @param {string} [label] template name used in error messages
 * @returns {string}
 */
function renderString(source, data = {}, label = '<template>') {
  return renderNodes(parse(tokenize(source, label), label), [data]);
}

/**
 * Render a template file.
 *
 * @param {string} relativePath
 * @param {Object} [data]
 * @returns {string}
 */
function renderTemplate(relativePath, data = {}) {
  const key = relativePath.replace(/^\/+/, '');

  // The parsed tree is cached per template: templates never change at runtime.
  if (!nodeCache.has(key)) {
    nodeCache.set(key, parse(tokenize(template(key), key), key));
  }

  return renderNodes(nodeCache.get(key), [data]);
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
