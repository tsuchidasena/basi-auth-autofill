import globals from "globals";

/**
 * Flat config. Two environments live in this repo:
 *   src/   — extension code: browser + chrome.* APIs, ES modules, no bundler
 *   test/  — pure-logic tests run by `node --test`
 */
export default [
  {
    ignores: ["node_modules/", "native/bin/", "logs/", "icons/"],
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // The bugs that actually bite in this codebase: typos in rarely-hit
      // error paths, and forgotten awaits around the crypto / storage calls.
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-implicit-globals": "error",
      "require-atomic-updates": "error",
      "no-return-await": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["test/**/*.js", "tools/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
];
