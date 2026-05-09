#!/usr/bin/env tsx
/**
 * One-shot backfill — provision portal system tokens for existing users.
 *
 * Background: PR-T1 Phase 0 introduces a hidden new-api token per
 * portal user (`User.newapi_system_token_value`) for portal-managed
 * service calls (image gen + future). New registrations get one
 * eagerly via the register / OAuth callback hooks; existing users
 * (~19 active at PR-T1 time) need a retroactive sweep so their first
 * /api/portal/image/generate call doesn't pay the lazy-provision
 * latency.
 *
 * Mode:
 *   tsx _bootstrap/backfill-portal-system-tokens.ts            # dry-run
 *   tsx _bootstrap/backfill-portal-system-tokens.ts --apply    # live
 *
 * Idempotent — `getOrCreateSystemToken` itself short-circuits if the
 * column is already populated, so re-running is safe (each user's
 * already-provisioned row counts as `skipped` rather than a no-op
 * write).
 *
 * Pre-reqs:
 *   - SSH tunnel: ssh -fN -L 3000:localhost:3000 vps
 *   - Env loaded: DATABASE_URL, NEWAPI_BASE_URL, NEWAPI_ADMIN_TOKEN, NEWAPI_ADMIN_USER_ID
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const APPLY = process.argv.includes('--apply');

interface BackfillResult {
    total: number;
    alreadyProvisioned: number;
    provisioned: number;
    skippedNoLinkage: number;
    failed: number;
    failures: Array<{ userId: string; reason: string }>;
}

async function main(): Promise<void> {
    // Lazy imports so a missing env doesn't blow up before the dotenv
    // load above (server-only modules read env at module load).
    const { prisma } = await import('@/lib/db');
    const { getOrCreateSystemToken } = await import('@/lib/newapi/system-token');

    console.log(`PR-T1 portal-system-token backfill ${APPLY ? '(LIVE)' : '(DRY-RUN — pass --apply to write)'}`);

    // Cast to any to avoid Prisma client type narrowing issues if the
    // local generated client predates the Phase 0a migration. The query
    // itself is schema-correct against post-migration state.
    const users: Array<{
        id: string;
        email: string;
        status: string;
        newapi_user_id: number | null;
        newapi_system_token_value: string | null;
    }> = await prisma.user.findMany({
        where: { status: 'active' },
        select: {
            id: true,
            email: true,
            status: true,
            newapi_user_id: true,
            newapi_system_token_value: true,
        },
        orderBy: { created_at: 'asc' },
    });

    const result: BackfillResult = {
        total: users.length,
        alreadyProvisioned: 0,
        provisioned: 0,
        skippedNoLinkage: 0,
        failed: 0,
        failures: [],
    };

    console.log(`\nFound ${result.total} active users to inspect.`);

    for (const u of users) {
        if (u.newapi_system_token_value) {
            result.alreadyProvisioned++;
            continue;
        }
        if (u.newapi_user_id == null) {
            // Account never finished provisioning — skip (image-gen would
            // block on the same condition; backfill won't fix it).
            result.skippedNoLinkage++;
            continue;
        }

        if (!APPLY) {
            // Dry-run: just count what we'd provision.
            result.provisioned++;
            continue;
        }

        try {
            await getOrCreateSystemToken(u.id);
            result.provisioned++;
            // Brief pause to be polite to new-api (3 round-trips per
            // user in the live path: create + list + getKey).
            await new Promise((r) => setTimeout(r, 100));
        } catch (err) {
            result.failed++;
            const reason = err instanceof Error ? err.message : String(err);
            result.failures.push({ userId: u.id, reason });
            console.error(`[backfill] user ${u.id} (${u.email}) FAILED:`, reason);
        }
    }

    console.log('\n────────────────────────────────────────────────────────────────────');
    console.log(`total inspected:        ${result.total}`);
    console.log(`already provisioned:    ${result.alreadyProvisioned}`);
    console.log(`${APPLY ? 'newly provisioned' : 'WOULD provision'}:     ${result.provisioned}`);
    console.log(`skipped (no linkage):   ${result.skippedNoLinkage}`);
    console.log(`failed:                 ${result.failed}`);
    if (result.failures.length > 0) {
        console.log('\nFailures:');
        for (const f of result.failures) {
            console.log(`  - ${f.userId}: ${f.reason}`);
        }
    }

    if (!APPLY) {
        console.log('\nDry-run complete. Pass --apply to provision.');
    }

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
