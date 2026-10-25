/**
 * LIVE smoke for the rc.41+ access-token flows — MUTATES the target new-api
 * (creates a throwaway customer, resets its password, mints PATs). Excluded
 * from CI by the `.smoke.` name. Run it against a rehearsal instance or
 * right after the production cutover:
 *
 *   NEWAPI_BASE_URL=http://127.0.0.1:14000 NEWAPI_ADMIN_TOKEN=… NEWAPI_ADMIN_USER_ID=1 \
 *   NEWAPI_LIVE_ALLOW_MUTATIONS=true NEWAPI_LIVE_CUSTOMER_GROUP=… \
 *   NEWAPI_LIVE_ROOT_USERNAME=root NEWAPI_LIVE_ROOT_PASSWORD=… \
 *   pnpm vitest run src/lib/newapi/__tests__/rc44-access-token.live.smoke.test.ts
 *
 * Skipped unless NEWAPI_LIVE_ALLOW_MUTATIONS=true, NEWAPI_LIVE_ROOT_PASSWORD, and
 * NEWAPI_LIVE_CUSTOMER_GROUP are explicitly supplied for an isolated rehearsal target.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
    getUser,
    isLegacyNewApiAccessToken,
    listTokensForCustomer,
    loginNewApiUser,
    provisionNewCustomer,
    reissueCustomerAccessTokenViaAdminReset,
    resolveAccessTokenMode,
} from '../client';

const ROOT_PW = process.env.NEWAPI_LIVE_ROOT_PASSWORD;
const ALLOW_MUTATIONS = process.env.NEWAPI_LIVE_ALLOW_MUTATIONS === 'true';
const LIVE_GROUP = process.env.NEWAPI_LIVE_CUSTOMER_GROUP;
const ROOT_USER = process.env.NEWAPI_LIVE_ROOT_USERNAME ?? 'root';

describe.skipIf(!ALLOW_MUTATIONS || !ROOT_PW || !LIVE_GROUP)('rc.41+ access tokens against a live new-api', () => {
    it('provisions a customer with a never-expiring PAT and re-issues it via admin password reset', async () => {
        const mode = await resolveAccessTokenMode();
        console.log(
            `  server mode: ${mode}; admin cred: ${isLegacyNewApiAccessToken(process.env.NEWAPI_ADMIN_TOKEN ?? '') ? 'legacy' : 'PAT'}`,
        );
        expect(mode).toBe('pat');

        const portalId = randomUUID();
        const t0 = Date.now();
        const p = await provisionNewCustomer({
            portal_user_id: portalId,
            newapi_group: LIVE_GROUP!,
            email: `rc44-live-${portalId.slice(0, 8)}@example.com`,
        });
        console.log(
            `  provision ${Date.now() - t0}ms uid=${p.newapi_user_id} ${p.newapi_username} access_token=${p.newapi_access_token.slice(0, 4)}… (${p.newapi_access_token.length}) sk len=${p.newapi_token_value.length}`,
        );
        expect(isLegacyNewApiAccessToken(p.newapi_access_token)).toBe(false);
        expect(p.newapi_access_token).toHaveLength(47);

        const first = { accessToken: p.newapi_access_token, userId: p.newapi_user_id };
        const list = await listTokensForCustomer(first, 1, 10);
        expect(list.items.some((t) => t.id === p.newapi_token_id)).toBe(true);
        const u = await getUser(p.newapi_user_id);
        expect(u.username).toBe(p.newapi_username);

        const admin = await loginNewApiUser({ username: ROOT_USER, password: ROOT_PW! });
        const t1 = Date.now();
        const r = await reissueCustomerAccessTokenViaAdminReset({
            admin: { session: admin.auth, userId: admin.user.id, password: ROOT_PW! },
            customer: { userId: p.newapi_user_id },
        });
        console.log(
            `  reissue ${Date.now() - t1}ms ${r.username} ${r.accessToken.slice(0, 4)}… (${r.accessToken.length})`,
        );
        expect(r.username).toBe(p.newapi_username);
        expect(isLegacyNewApiAccessToken(r.accessToken)).toBe(false);
        expect(r.accessToken).not.toBe(p.newapi_access_token);

        const second = { accessToken: r.accessToken, userId: p.newapi_user_id };
        expect((await listTokensForCustomer(second, 1, 10)).items.length).toBeGreaterThan(0);
        // The first PAT is NOT revoked by a password reset — both work (2 of the 20 slots).
        expect((await listTokensForCustomer(first, 1, 10)).items.length).toBeGreaterThan(0);
        console.log(`  LIVE_UID ${p.newapi_user_id}`);
    }, 60_000);
});
