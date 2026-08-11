/**
 * @neotavern/i18n — localization: i18next setup, en/ru resources, error-code
 * localizer and pseudo-locale for tests.
 */
export * from './resources/en.js';
export { ru } from './resources/ru.js';
export * from './createI18n.js';
export * from './localizeError.js';
export { pseudoLocale } from './pseudo.js';
