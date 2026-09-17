/* global window, document, I18n */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'admin_settings_active_tab';
  const DEFAULT_TAB = 'appearance';

  /**
   * @param {string} key
   * @returns {string}
   */
  function message(key) {
    return global.I18n ? global.I18n.translate(key) : key;
  }

  function initTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
    const panels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));
    const scoped = Array.prototype.slice.call(document.querySelectorAll('[data-tab-scope]'));

    if (tabs.length === 0) {
      return;
    }

    // Restore the last active tab, falling back to the first one.
    let active = DEFAULT_TAB;

    try {
      const stored = global.sessionStorage.getItem(STORAGE_KEY);
      if (stored && tabs.some((button) => button.dataset.tab === stored)) {
        active = stored;
      }
    } catch (error) {
      active = DEFAULT_TAB;
    }

    function activate(name) {
      tabs.forEach((button) => {
        const isActive = button.dataset.tab === name;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      panels.forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.tab !== name);
      });

      // Blocks with data-tab-scope are only visible on the listed tabs (e.g. the
      // settings save button, which has no meaning inside Maintenance).
      scoped.forEach((block) => {
        const names = block.dataset.tabScope.split(/\s+/);
        block.classList.toggle('hidden', names.indexOf(name) === -1);
      });

      try {
        global.sessionStorage.setItem(STORAGE_KEY, name);
      } catch (error) {
        // Ignore storage failures.
      }
    }

    tabs.forEach((button) => {
      button.addEventListener('click', () => activate(button.dataset.tab));
    });

    activate(active);
  }

  function initConfirms() {
    document.querySelectorAll('form[data-confirm]').forEach((form) => {
      form.addEventListener('submit', (event) => {
        if (!global.confirm(message(form.dataset.confirm))) {
          event.preventDefault();
        }
      });
    });
  }

  function init() {
    initTabs();
    initConfirms();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
