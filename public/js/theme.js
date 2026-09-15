/* global window, document, CustomEvent */
(function (global) {
  'use strict';

  const config = global.APP_CONFIG || {};
  const STORAGE_KEY = 'theme';
  const THEME_COLORS = config.themeColors || { light: '#f5efe2', dark: '#0e0e10' };

  /**
   * @returns {string} the theme currently applied to <html>.
   */
  function current() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  /**
   * Sync the toggle icon, its label and the theme-color meta tag.
   *
   * @param {string} theme
   */
  function sync(theme) {
    const toggleButton = document.getElementById('theme-toggle');
    const sun = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    const meta = document.getElementById('theme-color-meta');

    if (meta) {
      meta.setAttribute('content', theme === 'light' ? THEME_COLORS.light : THEME_COLORS.dark);
    }

    if (sun) {
      sun.classList.toggle('hidden', theme !== 'dark');
    }

    if (moon) {
      moon.classList.toggle('hidden', theme === 'dark');
    }

    if (toggleButton && global.I18n) {
      toggleButton.title = global.I18n.translate(theme === 'dark' ? 'themeToggleToLight' : 'themeToggleToDark');
    }
  }

  /**
   * Apply a theme, persist it and notify listeners.
   *
   * @param {string} theme
   */
  function apply(theme) {
    const value = theme === 'light' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', value);

    try {
      global.localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      // Storage may be unavailable (private mode); the theme still applies.
    }

    sync(value);
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: value } }));
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark');
  }

  function init() {
    sync(current());

    const toggleButton = document.getElementById('theme-toggle');

    if (toggleButton) {
      toggleButton.addEventListener('click', toggle);
    }

    // Refresh the toggle label once translations are available.
    document.addEventListener('i18n:changed', () => sync(current()));
  }

  global.Theme = { apply, current, init, sync, toggle };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
