# Dynamic Model Cost and Customer Discounts Implementation Plan

> **For agentic workers:** Execute this plan task by task with focused verification. Preserve the existing uncommitted implementation as the starting point.

**Goal:** Finish and validate dynamic cost pricing and discount behavior for Portal-owned billing, then deploy the reviewed `dev` build for operator acceptance.

**Architecture:** Keep the existing catalog cost drafts, append-only revisions, signed preview, publication journal, and new-api price synchronization. Tighten Enterprise Portal ledger billing so it resolves supported model identity explicitly, validates calendar rules before charging, selects one discount source, and freezes the evaluated result on submission. Standard new-api API-key calls remain outside customer-by-model discounts because new-api's exposed ratio matrix has customer-group by billing-group granularity only.

**Tech Stack:** Next.js 16, TypeScript, Prisma 7, PostgreSQL, Vitest, pnpm, Docker.

**Spec:** `/Users/elon/.codex/worktrees/model-cost-workbench/silkroadai/docs/superpowers/specs/2026-11-04-动态模型成本与客户折扣需求规格.md`

## Global Constraints

- Do not modify new-api source or write production prices.
- Do not run paid generation or billing smoke tests in production.
- Do not collapse discount layers by multiplication; use the specified single-winner priority.
- Preserve historical cost, sale price, discount, and audit rows.
- Fail closed on ambiguous identity, invalid rules, or unverified price publication state.
- Deploy only after `dev` passes the required checks and can fast-forward to `prod`.

---

### Task 1: Audit and close Enterprise discount rule correctness gaps

**Files:**

- Modify: `src/lib/enterprise/billing.ts`
- Modify: `src/lib/seedance/cn-adapter.ts` only if strict identity resolution belongs with existing model parsing
- Test: `src/lib/enterprise/__tests__/billing.test.ts`
- Test: `src/app/api/admin/enterprise/__tests__/global-discount.test.ts`
- Modify: `src/app/api/admin/enterprise/global-discount/route.ts`

**Deliverable:** A malformed or ambiguous schedule and an unknown model identity cannot silently produce a discounted charge; same-priority overlapping windows are rejected; PATCH-like updates preserve omitted calendar fields while explicit empty windows clear them.

- [ ] Add tests that prove same-priority overlapping windows fail closed, malformed stored windows fail closed, unknown billing identities do not fall back to `cn/pro`, and omitted calendar fields are preserved on update.
- [ ] Run the focused billing and route tests and confirm each new assertion fails for the intended behavior.
- [ ] Implement strict validation and deterministic schedule selection using the Asia/Shanghai business timezone contract; keep existing known model aliases working.
- [ ] Re-run the focused tests and inspect the resulting discount snapshot and charge call arguments.

### Task 2: Complete rule editing and snapshot behavior

**Files:**

- Modify: `src/app/enterprise-admin/(panel)/admin-panel.tsx`
- Modify: `src/lib/enterprise/proxy.ts`
- Modify: `src/lib/enterprise/billing.ts`
- Test: `src/lib/enterprise/__tests__/proxy.test.ts`
- Test: `src/lib/enterprise/__tests__/billing.test.ts`

**Deliverable:** Existing schedules load into the editor, absolute local date/time values use explicit Asia/Shanghai conversion, and a submitted task freezes the pricing identity, evaluated time, discount source/rule, timezone, and calculated pricing basis used at settlement.

- [ ] Add tests for UTC conversion, saved schedule edit/clear round trips, submission snapshot persistence, and settlement using only that frozen snapshot.
- [ ] Run the focused UI-related and billing tests and confirm the new assertions expose the current gaps.
- [ ] Implement the edit/clear behavior and pricing snapshot fields with backwards-compatible null handling for legacy tasks.
- [ ] Re-run focused tests and verify ledger task idempotency remains unchanged.

### Task 3: Verify cost workbench and document charge boundaries

**Files:**

- Review: `src/lib/admin/pricing-cost-store.ts`, `src/lib/admin/pricing-publish.ts`, `src/lib/admin/pricing-publish-plan.ts`, and associated tests
- Review: `src/lib/billing/meter.ts`, `src/lib/newapi/user-tier-multiplier.ts`, and new-api read-only capability fixtures
- Modify: spec status/evidence only after code and deployment evidence are available

**Deliverable:** Dynamic catalog mappings, unit/currency constraints, revision/audit history, signed preview expiry, optimistic locking, recovery semantics, and exact biller ownership are covered by existing tests or added focused tests. The acceptance record states which API-key paths remain unsupported.

- [ ] Run relevant cost, preview, publication, discount, and billing tests; add only tests for uncovered required behavior.
- [ ] Verify no customer discount change leaks into new-api standard API-key charges or catalog display-only paths.
- [ ] Record new-api's actual production version only if verified read-only; otherwise explicitly limit the claim to checked local source/API contracts.

### Task 4: Validate, review, and deploy

**Files:**

- Update: spec stage and acceptance evidence, preserving the original requirements
- Create: `docs/DYNAMIC-MODEL-COST-DISCOUNTS-2026-11-04.md`
- Update: `deploy/部署与运维手册.md` only for a durable release record or changed build pin

- [ ] Run Prisma validation and isolated PostgreSQL migration up/rollback-compatibility checks, typecheck, lint, format check, complete CI tests, and production build.
- [ ] Review every modified diff and verify the new-api source was not modified and no production price write or paid smoke was made.
- [ ] Update the native linux/amd64 build source pin/workflow as required, pass CI, push `dev`, run the isolated amd64 build, verify its checksum, and fast-forward `dev` to `prod`.
- [ ] Follow the current deployment manual: preflight active pricing/task jobs, backup `.env` and PostgreSQL with mode 0600, retain and verify rollback image, apply additive migration, load only the verified image, and run no-charge health/public-route checks.
- [ ] Record the deployed SHA, image digest, migration status, checks, and remaining acceptance limits; leave the spec in `待验收` until operator acceptance.
