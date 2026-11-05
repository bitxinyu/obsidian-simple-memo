import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['Simple Memo', 'Thino', 'Markdown'] }],
    },
  },
  globalIgnores(['node_modules/**', 'main.js', 'dist/**', 'artifacts/**', 'scripts/**', 'tests/**', '*.mjs']),
]);
