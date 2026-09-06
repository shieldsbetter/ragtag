import eslintConfigPrettier from 'eslint-config-prettier/flat';
import js from '@eslint/js';
import globals from 'globals';

import { defineConfig } from 'eslint/config';

export default defineConfig([
    // Throwaway probes and the world's own state are not source.
    { ignores: ['**/*.cjs', 'ragtag/'] },
    {
        files: ['**/*.{js,mjs}'],
        plugins: { js },
        extends: ['js/recommended'],
        languageOptions: { globals: globals.node },
    },
    // The client runs in a page: no Node globals, and it is loaded as a plain script
    // rather than a module, so everything it defines is a global to itself.
    {
        files: ['public/**/*.js'],
        languageOptions: { globals: globals.browser, sourceType: 'script' },
    },
    eslintConfigPrettier,
    {
        rules: {
            eqeqeq: ['error', 'always'],
        },
    },
]);
