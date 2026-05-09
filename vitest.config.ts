import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        exclude: ['**/node_modules/**', '**/third-party/**', '**/vendor/**', '.claude/**'],
        setupFiles: ['dotenv/config'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            // `import 'server-only'` is provided by Next.js at build time
            // (resolves to next/dist/compiled/server-only). Vitest (plain
            // Node) has no such resolver, so without this alias every test
            // file that imports a guarded module fails with
            // `Cannot find package 'server-only'`. Stub it to a no-op file
            // that exports nothing — the marker's only purpose is to make
            // Webpack/Turbopack fail builds when client components reach
            // for it; at test time we just need the import to resolve.
            'server-only': path.resolve(__dirname, './test-stubs/server-only.ts'),
        },
    },
});
