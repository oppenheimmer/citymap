import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteConfig from './svelte.config.js';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/fixtures/**', '.city-data/**', '.benchmarks/**', '.kilo/**', 'src/proto/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }] } },
  { languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker }, parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { files: ['**/*.svelte'], languageOptions: { parserOptions: { parser: ts.parser, svelteConfig } } },
];
