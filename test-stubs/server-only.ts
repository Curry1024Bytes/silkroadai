/**
 * Vitest stub for the `server-only` directive.
 *
 * In production, Next.js / Turbopack resolves `import 'server-only'` to
 * `next/dist/compiled/server-only`, which throws if reached from a
 * client bundle (preventing server-only modules from being shipped to
 * the browser). Vitest runs in plain Node and has no such resolver, so
 * this file is aliased in via `vitest.config.ts` purely to make the
 * import resolvable. It deliberately exports nothing — the marker's
 * runtime behavior is build-time-only.
 */
export {};
