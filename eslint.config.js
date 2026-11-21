import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the whole workspace (task E0-02).
 * Type-aware rules are intentionally left to `tsc --noEmit`: lint stays fast and
 * deterministic in CI, while strictness is enforced by the type checker.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'drizzle/**',
      'eslint.config.js',
      'commitlint.config.js',
      // Generated, not authored: the Electron shell ships a pre-built copy of the SPA and the
      // admin panel (desktop/runtime), and Capacitor copies the SPA into the Android project.
      'desktop/runtime/**',
      'desktop/dist-content/**',
      'apps/mobile/android/**',
      'apps/mobile/www/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', crypto: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['error', 'warn', 'info'] }],
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Plain-Node scripts (smoke runs, build helpers, the Electron main process) and the PostCSS/
    // Tailwind configs run on Node, not in a browser: flat config has no `env`, so the Node and
    // WHATWG globals they lean on are declared here instead.
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // The Electron main process and its build helpers are CommonJS by necessity (Electron loads
      // them before any bundler exists), so `require()` is the correct form there.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // The service worker is plain JS on purpose (no build step, no bundler): declare the worker
    // globals it runs against instead of pulling a browser/types package into the app (E9-15).
    files: ['apps/web/public/**/*.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        addEventListener: 'readonly',
      },
    },
  },
  prettier,
);
