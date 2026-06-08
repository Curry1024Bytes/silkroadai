/**
 * P6b §0 security guardrail (static-grep, like server-only-guards.test.ts).
 *
 * Confirmed escalation risk: platform-level admin APIs were gated role≥admin, and
 * SystemConfig (payment config) is global (no tenant_id) — a partner admin
 * (role=admin, tenant set) could edit PLATFORM settings. §0 locks every
 * platform-level management route to superadmin; resolveAdmin(req,'superadmin')
 * returns null for a role=admin user → 401/403 (proven by auth-helpers.test).
 *
 * This test fails if a platform route regresses to 'admin'/verifyAdminToken, or if
 * a tenant-scoped route loses its admin+tenantScope gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ADMIN_API = path.join(process.cwd(), 'src/app/api/admin');
const read = (rel: string) => fs.readFileSync(path.join(ADMIN_API, rel), 'utf-8');

// Platform-level management — MUST gate superadmin (partner admin gets 403).
const SUPERADMIN_ROUTES = [
    'config/route.ts',
    'config/env-defaults/route.ts',
    'subscriptions/route.ts',
    'billing-shadow/route.ts',
    'channels/route.ts',
    'channels/[id]/route.ts',
    'channel-groups/route.ts',
    'channel-groups/[id]/route.ts',
    'models/route.ts',
    'models/[id]/route.ts',
    'models/import/route.ts',
    'pricing/route.ts',
    'pricing/[modelId]/resync/route.ts',
    'pricing/batch-cost/route.ts',
    'provider-instances/route.ts',
    'provider-instances/[id]/route.ts',
    'subscription-plans/route.ts',
    'subscription-plans/[id]/route.ts',
    // Write / money-moving / cross-tenant-unsafe ops (operator decision: partner backend
    // is read-only). refund + user-balance move/expose money; orders cancel/retry are order
    // writes with NO tenant scope (cross-tenant IDOR if left at admin); litellm/* are W1 leftovers.
    'refund/route.ts',
    'user-balance/route.ts',
    'orders/[id]/cancel/route.ts',
    'orders/[id]/retry/route.ts',
    'litellm/groups/route.ts',
    'litellm/search-users/route.ts',
];

// Tenant-scoped reads — stay role≥admin so a partner admin sees THEIR tenant.
// (orders list + orders/[id] GET detail are tenantScope'd; the cancel/retry WRITES under
// orders/[id]/ are locked to superadmin above.)
const TENANT_ADMIN_ROUTES = ['dashboard/route.ts', 'orders/route.ts', 'orders/[id]/route.ts'];

describe('P6b §0 — platform routes locked to superadmin', () => {
    it.each(SUPERADMIN_ROUTES)('%s gates at superadmin (not admin / not verifyAdminToken)', (rel) => {
        const src = read(rel);
        expect(src).toContain("resolveAdmin(request, 'superadmin')");
        expect(src).not.toContain("resolveAdmin(request, 'admin')");
        expect(src).not.toContain('verifyAdminToken(');
    });
});

describe('P6b §0 — tenant-scoped routes stay admin + tenantScope (partner sees own tenant)', () => {
    it.each(TENANT_ADMIN_ROUTES)('%s gates at admin + uses tenantScope', (rel) => {
        const src = read(rel);
        expect(src).toContain("resolveAdmin(request, 'admin')");
        expect(src).toContain('tenantScope');
        expect(src).not.toContain('verifyAdminToken(');
    });
});
