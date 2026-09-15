/* global window, document, fetch, CustomEvent */
(function (global) {
  'use strict';

  const config = global.APP_CONFIG || {};
  const STORAGE_KEY = 'locale';
  const SUPPORTED = Array.isArray(config.supportedLocales) && config.supportedLocales.length > 0
    ? config.supportedLocales
    : ['pt_BR'];
  const DEFAULT_LOCALE = SUPPORTED.indexOf(config.defaultLocale) >= 0 ? config.defaultLocale : SUPPORTED[0];

  const dictionaryCache = new Map();
  const localeListeners = [];

  let currentLocale = DEFAULT_LOCALE;
  let dictionary = {};
  let initPromise = null;

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
   * Persist the choice so the server renders the same locale next time.
   *
   * @param {string} locale
   */
  function remember(locale) {
    try {
      global.localStorage.setItem(STORAGE_KEY, locale);
    } catch (error) {
      // Storage may be unavailable; the cookie below still applies.
    }

    document.cookie = `${STORAGE_KEY}=${encodeURIComponent(locale)};path=/;max-age=31536000;SameSite=Lax`;
  }

  /**
   * Apply translations to every element carrying a data-i18n* attribute, then
   * sync the <html lang> attribute.
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

    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        el.setAttribute('title', translate(key));
      }
    });

    document.documentElement.lang = currentLocale.replace('_', '-');
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { locale: currentLocale } }));
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

    const response = await fetch(`/locales/${locale}.json`);

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
    const target = SUPPORTED.indexOf(locale) >= 0 ? locale : DEFAULT_LOCALE;

    try {
      dictionary = await loadDictionary(target);
      currentLocale = target;
      remember(target);

      const select = document.getElementById('lang-select');
      if (select && select.value !== target) {
        select.value = target;
      }

      applyTranslations();

      localeListeners.forEach((listener) => {
        try {
          listener(target);
        } catch (err) {
          console.error('i18n: locale change listener failed.', err);
        }
      });
    } catch (err) {
      // Keep the previous dictionary so the UI never becomes blank.
      console.error(`i18n: could not switch to locale "${target}".`, err);
    }

    return dictionary;
  }

  /** @returns {string} the active locale code. */
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

  /**
   * The locale to start with: stored preference > server rendered locale.
   *
   * @returns {string}
   */
  function preferredLocale() {
    let stored = null;

    try {
      stored = global.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      stored = null;
    }

    if (stored && SUPPORTED.indexOf(stored) >= 0) {
      return stored;
    }

    return SUPPORTED.indexOf(config.currentLocale) >= 0 ? config.currentLocale : DEFAULT_LOCALE;
  }

  async function initialize() {
    const select = document.getElementById('lang-select');

    if (select) {
      select.value = preferredLocale();
      select.addEventListener('change', () => {
        setLocale(select.value);
      });
    }

    await setLocale(preferredLocale());
    return dictionary;
  }

  /** @returns {Promise<Object>} resolves once the first dictionary is applied. */
  function ready() {
    if (!initPromise) {
      initPromise = initialize();
    }

    return initPromise;
  }

  global.I18n = {
    applyTranslations,
    getLocale,
    init: ready,
    onLocaleChange,
    ready,
    setLocale,
    supportedLocales: SUPPORTED,
    translate,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})(window);
