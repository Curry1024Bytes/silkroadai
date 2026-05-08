/**
 * Static asset module declarations.
 *
 * Next.js's auto-generated `next-env.d.ts` references
 * `next/image-types/global` which already declares `*.svg` (and other
 * static-asset modules). That works locally because `pnpm dev` /
 * `pnpm build` writes `.next/dev/types/routes.d.ts` first, which keeps
 * the `next-env.d.ts` `import "./.next/dev/types/routes.d.ts"` chain
 * intact.
 *
 * In CI, no `.next/` directory exists when `pnpm typecheck` runs (we
 * skip dev + build in the typecheck job to keep it fast), so `tsc`
 * loses the chain and the `*.svg` ambient declarations don't get
 * picked up — every `import logo from '@/assets/brand/*.svg'` then
 * fails with `TS2307 Cannot find module …`.
 *
 * Declaring the modules ourselves makes the typecheck self-contained
 * and works in both runtimes (Next dev/build inlines the SVG as
 * `StaticImageData`; vitest under Vite returns the URL string — both
 * shapes are usable at runtime via the `assetUrl()` helper in
 * `src/components/brand/Logo.tsx`).
 */

declare module '*.svg' {
  const content: string;
  export default content;
}
