import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
  },
  {
    // The agent-lane blocks' scripts, the pipeline library and the lane resolver the tests use
    // were moved from the reference adopter, which doesn't type-check its scripts, so each
    // opts out with a described `@ts-nocheck` until it is typed (ADR 0009: a move changes no
    // line it doesn't have to).
    files: ['actions/agent-*/*.mjs', 'scripts/**/*.mjs', 'tests/unit/helpers/agent-lanes.mjs'],
    rules: { '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description' }] },
  },
  {
    // The pipeline library was linted by the reference adopter under a different profile:
    // Node's globals, the `_` prefix as the declared way to keep an unused binding, and
    // without ESLint 10's two newer recommended rules. Holding it to Kanon's profile would
    // change lines a move must not (ADR 0009); bringing it into line is separate work.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', URL: 'readonly' } },
    rules: {
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
);
