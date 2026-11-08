import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            '.nx/**',
            '.angular/**',
            'coverage/**',
            'docs/vendor/**',
            '**/drizzle/meta/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-restricted-imports': [
                'error',
                { patterns: [{ group: ['**/api/**'], message: 'Logic and DAL must not import API.' }] },
            ],
        },
    },
    {
        files: ['**/*.mjs', '**/*.cjs'],
        languageOptions: {
            globals: {
                process: 'readonly',
                console: 'readonly',
                URL: 'readonly',
                Buffer: 'readonly',
                fetch: 'readonly',
            },
        },
    },
    {
        files: ['apps/service-desk/src/app.ts', 'apps/service-desk/src/main.ts', 'apps/service-desk/src/runtime.ts'],
        rules: { 'no-restricted-imports': 'off' },
    },
    { files: ['**/api/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['**/dal/**'] }] } },
    { files: ['libs/**/index.ts', '**/*.test.ts'], rules: { 'no-restricted-imports': 'off' } },
    {
        files: ['**/dal/**/*.ts'],
        rules: { 'no-restricted-imports': ['error', { patterns: ['**/api/**', '**/logic/**'] }] },
    },
    {
        files: ['**/logic/**/*.ts'],
        rules: { 'no-restricted-imports': ['error', { patterns: ['**/api/**', 'fastify'] }] },
    },
    prettier
);
