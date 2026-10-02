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
    // The agent-lane blocks' scripts were moved from the reference adopter, which doesn't
    // type-check its scripts, so each opts out with a described `@ts-nocheck` until it is
    // typed (ADR 0009: a move changes no line it doesn't have to).
    files: ['actions/agent-*/*.mjs'],
    rules: { '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description' }] },
  },
);
