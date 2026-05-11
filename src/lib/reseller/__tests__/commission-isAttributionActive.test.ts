/**
 * PR-U1 — isAttributionActive pure-fn unit.
 *
 * (writeCommissionInTx is exercised via the executeRecharge integration
 *  test path; this file just covers the fast pure-fn guard.)
 */
import { describe, expect, it } from 'vitest';
import { isAttributionActive } from '@/lib/reseller/commission';

describe('isAttributionActive', () => {
    const now = new Date('2026-05-11T12:00:00.000Z');

    it('inactive when inviter_reseller_id is null', () => {
        expect(
            isAttributionActive({
                inviter_reseller_id: null,
                attribution_expires_at: new Date('2099-01-01'),
                now,
            }),
        ).toBe(false);
    });

    it('inactive when attribution_expires_at is null', () => {
        expect(
            isAttributionActive({
                inviter_reseller_id: 'reseller-uuid',
                attribution_expires_at: null,
                now,
            }),
        ).toBe(false);
    });

    it('inactive when expiry equals now (boundary — strictly after now)', () => {
        expect(
            isAttributionActive({
                inviter_reseller_id: 'reseller-uuid',
                attribution_expires_at: now,
                now,
            }),
        ).toBe(false);
    });

    it('active when expiry is in the future', () => {
        expect(
            isAttributionActive({
                inviter_reseller_id: 'reseller-uuid',
                attribution_expires_at: new Date(now.getTime() + 1_000),
                now,
            }),
        ).toBe(true);
    });

    it('inactive when expiry is in the past (24mo elapsed)', () => {
        expect(
            isAttributionActive({
                inviter_reseller_id: 'reseller-uuid',
                attribution_expires_at: new Date(now.getTime() - 1_000),
                now,
            }),
        ).toBe(false);
    });
});
