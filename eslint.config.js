/**
 * ESLint flat config. Requiere `npm install` (eslint).
 *   npm run lint
 */
'use strict';

const browserGlobals = {
  chrome: 'readonly', self: 'readonly', globalThis: 'readonly',
  document: 'readonly', window: 'readonly', location: 'readonly',
  getComputedStyle: 'readonly', MutationObserver: 'readonly',
  setTimeout: 'readonly', console: 'readonly', history: 'readonly',
  fetch: 'readonly', XMLHttpRequest: 'readonly', Date: 'readonly', Math: 'readonly',
};

const nodeGlobals = {
  module: 'writable', require: 'readonly', globalThis: 'readonly',
};

module.exports = [
  {
    files: [
      'browser/tokenizer.js', 'browser/content.js', 'browser/background.js',
      'browser/options.js', 'browser/usage-parser.js', 'browser/interceptor.js',
      'browser/pricing.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
    },
  },
  {
    files: ['browser/test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: nodeGlobals,
    },
    rules: { 'no-unused-vars': 'warn' },
  },
];
