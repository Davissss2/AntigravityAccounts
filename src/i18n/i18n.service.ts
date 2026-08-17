/**
 * I18n Service — Internationalization Engine
 *
 * Provides a scalable localization system that:
 * - Loads locale files dynamically
 * - Supports nested key access (dot notation)
 * - Supports parameter interpolation {{param}}
 * - Falls back gracefully to the key itself if translation missing
 * - Allows adding new locales at runtime
 *
 * Architecture:
 * - Locale files are plain JSON objects stored in /i18n/locales/
 * - Adding a new language = adding a new JSON file + registering it
 * - No if/else or switch statements in UI code — just call i18n.t('key')
 */

import { Logger } from '../core/utils/logger';

declare const require: any;

/** Describes a registered locale */
export interface LocaleInfo {
  /** ISO language code (e.g., 'en', 'ar', 'fr') */
  code: string;
  /** Human-readable name (e.g., 'English', 'العربية') */
  name: string;
  /** Text direction */
  dir: 'ltr' | 'rtl';
}

/** Flat or nested translation dictionary */
interface TranslationDict {
  [key: string]: string | TranslationDict;
}

export class I18nService {
  private static instance: I18nService;

  /** Currently active locale code */
  private currentLocale: string = 'en';

  /** Registry: code → { info, translations } */
  private locales: Map<string, { info: LocaleInfo; translations: TranslationDict }> = new Map();

  /** Flattened cache for fast lookups: code → { 'a.b.c': 'value' } */
  private flatCache: Map<string, Record<string, string>> = new Map();

  private constructor() {
    // Register built-in locales
    this.registerBuiltInLocales();
  }

  static getInstance(): I18nService {
    if (!I18nService.instance) {
      I18nService.instance = new I18nService();
    }
    return I18nService.instance;
  }

  /**
   * Set the active locale.
   * Falls back to 'en' if the requested locale is not registered.
   */
  setLocale(code: string): void {
    const lower = (code || '').toLowerCase();
    if (this.locales.has(code)) {
      this.currentLocale = code;
    } else if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') {
      this.currentLocale = 'zh-CN';
    } else if (lower === 'pt' || lower === 'pt-br') {
      this.currentLocale = 'pt-BR';
    } else if (lower === 'es') {
      this.currentLocale = 'es';
    } else if (lower === 'ar') {
      this.currentLocale = 'ar';
    } else if (lower === 'fr') {
      this.currentLocale = 'fr';
    } else if (lower === 'de') {
      this.currentLocale = 'de';
    } else if (lower === 'ja') {
      this.currentLocale = 'ja';
    } else if (lower === 'ru') {
      this.currentLocale = 'ru';
    } else if (lower === 'ko') {
      this.currentLocale = 'ko';
    } else {
      Logger.getInstance().warn(`Locale '${code}' not found, falling back to 'en'`);
      this.currentLocale = 'en';
    }
  }

  /**
   * Get the current locale code.
   */
  getLocale(): string {
    return this.currentLocale;
  }

  /**
   * Get the current locale info (name, direction, etc.)
   */
  getLocaleInfo(): LocaleInfo {
    return this.locales.get(this.currentLocale)!.info;
  }

  /**
   * Get all registered locales.
   */
  getAvailableLocales(): LocaleInfo[] {
    return Array.from(this.locales.values()).map((entry) => entry.info);
  }

  /**
   * Translate a key with optional parameter interpolation.
   *
   * @param key - Dot-notation key (e.g., 'accounts.addButton.label')
   * @param params - Optional parameters for interpolation (e.g., { count: 5 })
   * @returns Translated string, or the key itself if not found
   *
   * @example
   * i18n.t('accounts.balance', { amount: '1850' })
   * // If translation is "Credits: {{amount}}" → returns "Credits: 1850"
   */
  t(key: string, params?: Record<string, string | number>): string {
    const flat = this.getFlatTranslations(this.currentLocale);
    let value = flat[key];

    if (value === undefined) {
      // Fallback to English
      if (this.currentLocale !== 'en') {
        const enFlat = this.getFlatTranslations('en');
        value = enFlat[key];
      }

      if (value === undefined) {
        Logger.getInstance().warn(`Missing translation key: '${key}' for locale '${this.currentLocale}'`);
        return key;
      }
    }

    // Interpolate parameters: {{paramName}}
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        value = value.replace(new RegExp(`\\{\\{${paramKey}\\}\\}`, 'g'), String(paramValue));
      }
    }

    return value;
  }

  /**
   * Register a new locale at runtime.
   * This is the extension point for adding new languages.
   *
   * @param info - Locale metadata
   * @param translations - Translation dictionary (can be nested)
   */
  registerLocale(info: LocaleInfo, translations: TranslationDict): void {
    this.locales.set(info.code, { info, translations });
    this.flatCache.delete(info.code); // Invalidate cache
    Logger.getInstance().info(`Locale registered: ${info.code} (${info.name})`);
  }

  /**
   * Check if a text direction is RTL for the current locale.
   */
  isRtl(): boolean {
    return this.getLocaleInfo().dir === 'rtl';
  }

  // ── Private Methods ──

  /**
   * Get flattened translations for a locale, using cache.
   */
  private getFlatTranslations(code: string): Record<string, string> {
    if (this.flatCache.has(code)) {
      return this.flatCache.get(code)!;
    }

    const entry = this.locales.get(code);
    if (!entry) {
      return {};
    }

    const flat = this.flattenObject(entry.translations);
    this.flatCache.set(code, flat);
    return flat;
  }

  /**
   * Flatten a nested object to dot-notation keys.
   * { a: { b: 'hello' } } → { 'a.b': 'hello' }
   */
  private flattenObject(
    obj: TranslationDict,
    prefix: string = ''
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof value === 'string') {
        result[fullKey] = value;
      } else {
        Object.assign(result, this.flattenObject(value, fullKey));
      }
    }

    return result;
  }

  /**
   * Register built-in locales.
   */
  private registerBuiltInLocales(): void {
    // English
    this.registerLocale(
      { code: 'en', name: 'English', dir: 'ltr' },
      require('./locales/en.json')
    );

    // Arabic
    this.registerLocale(
      { code: 'ar', name: 'العربية', dir: 'rtl' },
      require('./locales/ar.json')
    );

    // Spanish
    this.registerLocale(
      { code: 'es', name: 'Español', dir: 'ltr' },
      require('./locales/es.json')
    );

    // Chinese (Simplified)
    this.registerLocale(
      { code: 'zh-CN', name: '中文 (简体)', dir: 'ltr' },
      require('./locales/zh-CN.json')
    );

    // Portuguese (Brazil)
    this.registerLocale(
      { code: 'pt-BR', name: 'Português (Brasil)', dir: 'ltr' },
      require('./locales/pt-BR.json')
    );

    // French
    this.registerLocale(
      { code: 'fr', name: 'Français', dir: 'ltr' },
      require('./locales/fr.json')
    );

    // German
    this.registerLocale(
      { code: 'de', name: 'Deutsch', dir: 'ltr' },
      require('./locales/de.json')
    );

    // Japanese
    this.registerLocale(
      { code: 'ja', name: '日本語', dir: 'ltr' },
      require('./locales/ja.json')
    );

    // Russian
    this.registerLocale(
      { code: 'ru', name: 'Русский', dir: 'ltr' },
      require('./locales/ru.json')
    );

    // Korean
    this.registerLocale(
      { code: 'ko', name: '한국어', dir: 'ltr' },
      require('./locales/ko.json')
    );
  }
}
