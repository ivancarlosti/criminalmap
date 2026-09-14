/* global window, document, fetch */
(function (global) {
  'use strict';

  const DEFAULT_LOCALE = 'pt-BR';
  const dictionaryCache = new Map();
  const localeListeners = [];

  let currentLocale = DEFAULT_LOCALE;
  let dictionary = {};

  /**
   * Translate a dictionary key, optionally interpolating {placeholder} vars.
   *
   * @param {string} key
   * @param {Object} [vars]
   * @returns {string}
   */
  function translate(key, vars) {
    let template = dictionary[key];

    if (typeof template !== 'string') {
      return key;
    }

    if (vars && typeof vars === 'object') {
      template = template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(vars, name)
          ? String(vars[name])
          : match
      ));
    }

    return template;
  }

  /**
   * Apply translations to every element carrying a data-i18n key or a
   * data-i18n-placeholder key, then sync the <html lang> attribute.
   */
  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = translate(key);
      }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        el.setAttribute('placeholder', translate(key));
      }
    });

    document.documentElement.lang = currentLocale;
  }

  /**
   * Fetch a locale JSON file, caching it so it is only downloaded once.
   *
   * @param {string} locale
   * @returns {Promise<Object>}
   */
  async function loadDictionary(locale) {
    if (dictionaryCache.has(locale)) {
      return dictionaryCache.get(locale);
    }

    const response = await fetch(`locales/${locale}.json`);

    if (!response.ok) {
      throw new Error(`Failed to load locale "${locale}" (HTTP ${response.status})`);
    }

    const data = await response.json();
    dictionaryCache.set(locale, data);
    return data;
  }

  /**
   * Switch the active locale, re-apply translations and notify listeners.
   *
   * @param {string} locale
   * @returns {Promise<Object>}
   */
  async function setLocale(locale) {
    try {
      dictionary = await loadDictionary(locale);
      currentLocale = locale;
      applyTranslations();

      localeListeners.forEach((listener) => {
        try {
          listener(locale);
        } catch (err) {
          console.error('i18n: locale change listener failed.', err);
        }
      });
    } catch (err) {
      // Keep the previous dictionary so the UI never becomes blank.
      console.error(`i18n: could not switch to locale "${locale}".`, err);
    }

    return dictionary;
  }

  function getLocale() {
    return currentLocale;
  }

  /**
   * Register a callback invoked after every successful locale switch.
   *
   * @param {Function} listener
   */
  function onLocaleChange(listener) {
    if (typeof listener === 'function') {
      localeListeners.push(listener);
    }
  }

  async function init() {
    await setLocale(DEFAULT_LOCALE);
    return dictionary;
  }

  global.I18n = {
    translate,
    applyTranslations,
    setLocale,
    getLocale,
    onLocaleChange,
    init,
  };
})(window);
