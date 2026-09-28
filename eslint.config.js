// Lint config. ESLint is a dev-only dependency: the app itself still runs on
// plain Node with nothing installed.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['server/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  {
    // Classic scripts, not modules: no build step, loaded straight from
    // index.html, time.js first so app.js can use its functions.
    files: ['public/app.js', 'public/time.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['public/app.js'],
    languageOptions: { globals: { localDay: 'readonly', nextLocalHour: 'readonly' } },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
];
