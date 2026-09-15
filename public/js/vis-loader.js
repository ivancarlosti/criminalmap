/* global window, document, CustomEvent */
/**
 * vis-network loader with a CDN fallback.
 *
 * views/layout.html loads the library from a CDN with `defer`; this script runs
 * right after it, so `window.vis` is either already defined or the first source
 * failed. In that case the next source is tried, and the outcome is announced so
 * app.js can show a readable message instead of leaving an empty graph area
 * (common on filtered/slow mobile connections).
 */
(function (global) {
  'use strict';

  const SOURCES = [
    'https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js',
    'https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js',
  ];

  /**
   * @param {string} name
   * @param {Object} [detail]
   */
  function announce(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  /**
   * Inject the next source, in order, until the library is available.
   *
   * @param {number} index
   */
  function load(index) {
    if (index >= SOURCES.length) {
      global.__visLoadFailed = true;
      announce('vis:error', { sources: SOURCES.slice() });
      return;
    }

    const script = document.createElement('script');

    script.src = SOURCES[index];
    script.async = false;
    script.onload = () => {
      if (global.vis) {
        announce('vis:ready', { source: SOURCES[index] });
        return;
      }

      load(index + 1);
    };
    script.onerror = () => load(index + 1);

    document.head.appendChild(script);
  }

  // The static <script defer> in layout.html may have failed before this file
  // runs, so the check happens here (not on load) on purpose.
  if (global.vis) {
    announce('vis:ready', { source: SOURCES[0] });
  } else if (!global.__visLoaderStarted) {
    global.__visLoaderStarted = true;
    load(0);
  }

  global.VisLoader = { sources: SOURCES.slice(), load };
})(window);
