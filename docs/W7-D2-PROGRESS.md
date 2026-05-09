# W7 D2 — Pricing Migration Progress

**Date**: 2026-05-06
**Branch**: `feat/w7-d2-pricing-migration` (off `main` at `54c3ea0`)
**Status**: 3 of 7 phases complete + 2 prep artifacts ready; **Phases 2/4/6 gated on operator-orchestrated maintenance window**.

---

## Phases done in this PR

### Phase 1.5 — orphan + admin-test-log cleanup ✅ (executed on prod new-api db)

Deleted directly on the prod `new-api-db` Postgres (no portal-side change):

| target                                                                     | rows deleted |
| -------------------------------------------------------------------------- | ------------ |
| `users` (id 8-12 — orphaned customer-style accounts from W2-W3 dev rounds) | 5            |
| `tokens` (owned by id 8-12)                                                | 9            |
| `quota_data` (owned by id 8-12)                                            | 10           |
| `logs` attributed to id 8-12                                               | 18           |
| `logs` for already-deleted users `c-8220a1ed` / `c-dbc1a63c`               | 5            |
| `logs` for `admin` (test traffic from various dev rounds)                  | 25           |

Result: **4 users remain** (admin + 3 portal users — Frankqy + 2 dev). 0 customer-attributable logs in the 30-day window. The apply script's "active models" triage now reflects only real customer behavior (currently zero).

Original W7 D1 audit confirmed **0 real-customer hits on default-fallback ratios**, so no remediation needed for over-billing.

### Phase 3 — `_bootstrap/apply-w7-pricing.ts` ✅ (built + dry-run validated, NOT applied)

Single-file script that does the bulk model_ratio + completion_ratio + models update across the 3 channels. Reads operator-supplied constants at the top:

- `SUB2API_CLAUDE_WHITELIST` — 6 SKUs, retail prices baked in
- `SUB2API_OPENAI_WHITELIST` — 8 SKUs, retail prices baked in (5 with `✱ defaulted` flag — operator must verify before `--apply`)
- `SF_WHOLESALE_CNY` — 22 SF models with audited wholesale data
- `PROMO_DISCOUNT = 0.5` (sub2api channels only; SF cost-plus untouched)
- `SF_DIVISOR = 5.83` (mr formula `wholesale_¥/5.83` ≈ 20% markup at ¥7/USD fixed)

**Dry-run summary**:

```
sub2api Claude (id=2)     32 → 6  (26 removed)
sub2api-openai (id=3)    157 → 8 (149 removed)
siliconflow    (id=1)    190 → 22 (168 removed, 0 follow-up after admin-log cleanup)
```

**Cannot run `--apply` yet** because the ratios assume QPU=1M, but Phase 2 hasn't bumped QuotaPerUnit yet. Brief's order is correct: Phase 2 (db backup + QPU + balance migration × 2.0571) → Phase 3 (this script `--apply`) → Phase 4 (portal constants) → Phase 5 (verify).

### Phase 7 — `_bootstrap/exit-w7-promo.ts` + `docs/W7-PROMO-EXIT-RUNBOOK.md` ✅ (built, manual trigger 2026-06-09)

Multiplies sub2api channel `model_ratio` values by 2 (promo → retail). Idempotent: dry-run currently shows "SKIP — channel has no model_ratio set" because Phase 3 hasn't been applied yet; will populate after Phase 3 `--apply`.

Runbook covers: pre-flight, backup, dry-run, apply, verify, portal /pricing rebuild, rollback. Operator triggers manually on 2026-06-09 evening.

---

## Phases gated on operator (NOT in this PR)

### Phase 2 — DB migration (15 min, **destructive**)

Maintenance-window operations on prod new-api db:

1. `pg_dump newapi > /tmp/newapi-pre-w7-pricing.sql.gz` (rollback insurance)
2. Update QuotaPerUnit via admin UI: 500K → 1M
3. SQL `UPDATE users SET quota = ROUND(quota * 2.0571);` (and tokens, redemption_codes, etc. — see brief B6 for the corrected multiplier)

**Atomic with Phase 4** — must complete in same window. Recommend the brief's maintenance-mode strategy (Caddy temp 503 + static page → run Phase 2 → run Phase 4 → Phase 3 → verify → unmaintenance).

### Phase 4 — portal `QUOTA_PER_USD` + `RMB_USD_RATE` sync (30 min)

```ts
// src/lib/newapi/client.ts
export const QUOTA_PER_USD = parseInt(process.env.NEWAPI_QUOTA_PER_USD || '1000000', 10); // was 500000
export const USD_TO_CNY_RATE = parseFloat(process.env.USD_TO_CNY_RATE || '7'); // was 7.2
```

Run full vitest, expect quota-cache + balance + recharge math tests to need fixture updates (existing tests assume QPU=500K). Belongs in a separate PR (or this PR's follow-up commit) so it can deploy in lockstep with Phase 2.

### Phase 5 — verification (30 min, after Phases 2-4)

- `curl /api/pricing` → diff against expected promo ratios from Phase 3 dry-run
- Re-run `_bootstrap/build-pricing-audit.py` → produce `W7-D2-PRICING-AUDIT.xlsx` (post-fix)
- Real e2e: 3 channel-specific calls from a portal sk- key, verify RechargeLog precision

### Phase 6 — landing page + `/pricing` (4h)

- Caddy: `silkroadai.io` apex currently serves `/var/www/silkroadai/index.html` (static, sub2api-era residue, 40 KB). Brief says "全替不留 A/B" — back up to `/var/www/silkroadai.bak.20260506-w7d2/`, repoint apex to portal `localhost:3002` Next route.
- Tailwind v4 `@theme` tokens (B4 in operator inputs).
- 13 flagship SKUs for /pricing per operator B1.
- ISR `revalidate=60` server-component fetch from `/api/pricing`.

---

## What's in this PR

| file                                | type | purpose                                                  |
| ----------------------------------- | ---- | -------------------------------------------------------- |
| `_bootstrap/apply-w7-pricing.ts`    | NEW  | Phase 3 bulk apply (dry-run-validated)                   |
| `_bootstrap/exit-w7-promo.ts`       | NEW  | Phase 7 promo exit (2026-06-09 manual trigger)           |
| `_bootstrap/build-pricing-audit.py` | NEW  | W7 D1 audit script (was untracked, prerequisite reading) |
| `docs/W7-D1-PRICING-AUDIT.md`       | NEW  | W7 D1 decision brief (operator's pricing strategy)       |
| `docs/W7-PROMO-EXIT-RUNBOOK.md`     | NEW  | Phase 7 operator playbook                                |
| `docs/W7-D2-PROGRESS.md`            | NEW  | This file                                                |

## What's NOT in this PR

- Portal `QUOTA_PER_USD` / `RMB_USD_RATE` constant changes (Phase 4 — separate PR or follow-up commit)
- Landing-page Next routes (Phase 6 — separate PR)
- `/pricing` page (Phase 6 — separate PR)
- Tailwind v4 `@theme` tokens in `globals.css` (Phase 6 dependency)

## Operator next-step decision tree

**If you want to proceed with the maintenance-window cutover**:

1. Schedule a 30-min window (recommend low-traffic time, e.g. 23:00-23:30 UTC+8)
2. Notify Frankqy (站内 + WeChat) ~24h ahead
3. Run Phases 2 → 3 (`--apply`) → 4 → portal rebuild → 5 verify in that window
4. Phase 6 (landing + /pricing) can land in a follow-up PR after Phase 5 GREEN

**If you want operator-confirmed retail prices for the OpenAI 5.x SKUs first**:

- Edit `SUB2API_OPENAI_WHITELIST` in `_bootstrap/apply-w7-pricing.ts` for the 5 SKUs marked `✱ defaulted`
- Re-run dry-run to verify
- Then proceed with the maintenance window

**If Phase 1.5 cleanup needs to be reverted**:

- The orphan accounts had no real customer linkage; deletion is permanent. If needed, reactivate by re-running portal `provisionNewCustomer` against the 3 portal users (regenerates new newapi user rows).
