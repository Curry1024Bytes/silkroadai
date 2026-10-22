# Vendored new-api web code

This directory contains the **model plaza / pricing** feature of
[QuantumNous/new-api](https://github.com/QuantumNous/new-api), vendored from
tag `v1.0.0-rc.44` (`web/src/features/pricing` plus the shared components,
hooks and libs it depends on). Upstream copyright headers are preserved.

new-api is licensed under the **GNU Affero General Public License v3.0**.
Including this code makes the Silk Road AI portal a derivative work, so the
portal as a whole is distributed under AGPL-3.0 (see `/LICENSE`). The original
sub2apipay code remains available under its MIT terms (`/LICENSE.sub2apipay-MIT`).

## Local modifications (2026-10-22)

- `@/` import alias rewritten to `@newapi/` (portal keeps its own `@/`).
- App-shell modules replaced by shims (marked `silkroadai portal shim` at the top):
  `lib/api.ts` (fetch via portal proxy `/api/portal/models/*`), `lib/router-shim.ts`
  (replaces `@tanstack/react-router`), `hooks/use-status.ts`, `stores/system-config-store.ts`,
  `lib/plaza-runtime.ts`, `components/layout`, `components/page-transition.tsx`,
  `components/ai-elements/code-block.tsx` (no shiki), `context/*`, `lib/use-chart-theme.ts`,
  `i18n/config.ts` (zh + en only, keys pruned to what this feature uses).
- `lib/lobe-icon.tsx`: static icon registry instead of a template dynamic import.
- `features/pricing/components/model-details.tsx`: route-level `ModelDetails` page removed
  (drawer only).
- `features/pricing/components/model-details-api.tsx`: "Supported parameters" and
  "Rate limits" sections removed — upstream renders them from seeded mock data
  (`lib/mock-stats.ts`), which must not be shown to customers as real.
- `features/pricing/components/model-details-apps.tsx` removed (mock-only, unmounted upstream).
- Deleted app-shell hooks: `use-top-nav-links`, `use-notifications`, `use-system-config`.
- `styles/plaza.css`: theme tokens scoped under `.newapi-plaza`.

Everything else is byte-identical to upstream.
