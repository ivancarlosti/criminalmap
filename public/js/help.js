/* global window, document */
/**
 * Usage help popup.
 *
 * The "?" button in the header (right next to the theme toggle, same design)
 * opens a modal listing how the graph is used: clicking a box or a connection
 * opens its details, the middle mouse button resets the zoom and the scroll
 * wheel zooms in and out. The markup lives in views/layout.html, so the same
 * popup is available on every page; the strings are translated by i18n.js
 * through their data-i18n attributes.
 */
(function (global) {
  'use strict';

  const elements = {
    button: document.getElementById('help-toggle'),
    modal: document.getElementById('help-modal'),
    close: document.getElementById('help-modal-close'),
  };

  let lastFocused = null;

  /** @returns {boolean} true when this page rendered the popup. */
  function available() {
    return Boolean(elements.button && elements.modal && elements.close);
  }

  function open() {
    if (!available() || !elements.modal.hidden) {
      return;
    }

    lastFocused = document.activeElement;
    elements.modal.hidden = false;
    document.body.classList.add('modal-open');
    elements.close.focus();
  }

  function close() {
    if (!available() || elements.modal.hidden) {
      return;
    }

    elements.modal.hidden = true;
    document.body.classList.remove('modal-open');

    // Hand the focus back to the button that opened the popup.
    const target = lastFocused && document.contains(lastFocused) ? lastFocused : elements.button;
    lastFocused = null;

    if (target) {
      target.focus();
    }
  }

  function init() {
    if (!available()) {
      return;
    }

    elements.button.addEventListener('click', open);
    elements.close.addEventListener('click', close);

    // Clicking the dimmed overlay (but not the card) closes the popup.
    elements.modal.addEventListener('click', (event) => {
      if (event.target === elements.modal) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.modal.hidden) {
        close();
      }
    });
  }

  global.Help = { available, close, init, open };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
