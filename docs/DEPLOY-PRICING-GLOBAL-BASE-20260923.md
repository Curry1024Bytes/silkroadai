# Global base pricing deployment — 2026-09-23

## Scope

This release separates the official model price from `GroupRatio`: the official
input/output or per-request price is defined at `GroupRatio = 1`, while each
enabled tier derives its catalog price from the unchanged new-api group ratio.
It adds the global model pricing API/workbench, group-ratio-only publication and
recovery checks, and durable validation for global pricing jobs. Existing model
cost values remain reference costs and are not overwritten by the global price
workflow. Tiered models are previewed as a uniform tariff and the preview warns
that the length tiers will be removed.

## Release identity

- Previous production source: `c29e5e8`
- Deployed application source: `d8509a2`
- VPS branch: `prod`
- Build image: `silkroadai-portal-portal:release-d8509a2`
- Build image digest: `sha256:4050de372cd352011badb647b8560de99b3e90da96a075456c0ebc57f2ec40ab`
- Rollback tag: `silkroadai-portal-portal:rollback-global-pricing-20260923-172812`
- Rollback image digest: `sha256:6a0c9529797924b8cfb4ac9d7e5b18be1aa1e260b51472d17787f5d2da5f6eb9`
- Portal switch: 2026-09-23 17:34 CST

The release has no Prisma migration, environment variable, dependency,
Compose, Nginx, or Cloudflare change. Production remains at 80 applied
migrations.

## Backups

- Environment backup: `.env.bak.20260923-172812`, mode `0600`
- PostgreSQL backup: `/opt/backups/silkroadai-portal/portal-20260923-092812.sql.gz`, mode `0600`
- PostgreSQL backup passed `gzip -t`.

## Verification

- Portal and PostgreSQL are running; PostgreSQL is healthy; Portal restart count is `0`.
- Portal startup reported no pending migrations; database status is `80 applied / 0 unfinished`.
- Portal → new-api `/api/setup` returned `200` from the host and from inside the Portal container.
- Pricing coordinator `active_job=none`, non-terminal pricing jobs `0`, and `in_flight` writes `0`.
- Origin and public apex/www login returned `200`.
- Origin and public `/v1/models` with an invalid key returned `401`; API `/login` returned `404`.
- OpenAI and Gemini CORS preflights returned `204` with the expected allow headers.
- Google and GitHub OAuth start endpoints returned `302` to their provider domains.
- `nginx -t` passed and the Nginx service is active.

No production price was changed and no paid model call was made. Authenticated
global-pricing preview and real model inference remain operator-level follow-up
checks; anonymous access to the new admin route correctly returns `401`.
