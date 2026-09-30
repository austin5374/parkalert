// Lint config. ESLint is a dev-only dependency: the app itself still runs on
// plain Node with nothing installed.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'e2e/results/', 'e2e/gallery/', '.lab-data*/', '.shots*.mjs'] },
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
    // Playwright specs: Node for the runner, the browser (and the app's own
    // globals) for code passed to page.evaluate.
    files: ['e2e/**/*.js', 'playwright.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node, ...globals.browser,
        dash: 'readonly', pages: 'readonly', openRide: 'readonly', openParkInfo: 'readonly', openPause: 'readonly',
        refresh: 'readonly', switchView: 'readonly',
      },
    },
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  {
    // Classic scripts, not modules: no build step, loaded straight from
    // index.html, time.js first so app.js can use its functions.
    files: ['public/app.js', 'public/time.js', 'public/scene.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['public/app.js'],
    languageOptions: { globals: { localDay: 'readonly', nextLocalHour: 'readonly', fmtDuration: 'readonly', matchesSearch: 'readonly', extractTripCode: 'readonly', sceneSvg: 'readonly', sceneMood: 'readonly' } },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker, localClock: 'readonly' } },
  },
];
