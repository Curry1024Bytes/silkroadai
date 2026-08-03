import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
    ...nextVitals,
    ...nextTs,
    // Override default ignores of eslint-config-next.
    globalIgnores([
        // Default ignores of eslint-config-next:
        '.next/**',
        'out/**',
        'build/**',
        'next-env.d.ts',
        // Codex skills are standalone tooling with their own runtime/style.
        '.codex/**',
        // Git submodules:
        'vendor/**',
    ]),
    {
        rules: {
            // React Compiler is not enabled in next.config.ts. Keep compiler
            // compatibility diagnostics visible without failing the CI lint
            // gate for otherwise valid React 19 code. Promote these back to
            // errors when reactCompiler is deliberately enabled.
            'react-hooks/immutability': 'warn',
            'react-hooks/preserve-manual-memoization': 'warn',
            'react-hooks/purity': 'warn',
            'react-hooks/set-state-in-effect': 'warn',
            'react-hooks/static-components': 'warn',
        },
    },
]);

export default eslintConfig;
