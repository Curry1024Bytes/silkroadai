/**
 * PR-U1 — register-helper unit tests with Prisma mock.
 *
 * Covers polymorphic invite resolution + 防控 #1 self-invite + 防控 #2 IP throttle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── prisma mock ──
const mockResellerInviteCodeFindUnique = vi.fn();
const mockUserCount = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        resellerInviteCode: {
            findUnique: (...args: unknown[]) => mockResellerInviteCodeFindUnique(...args),
        },
        user: {
            count: (...args: unknown[]) => mockUserCount(...args),
        },
    },
}));

// ── analytics mock ──
const mockRecord = vi.fn();
vi.mock('@/lib/analytics/recorder', () => ({
    record: (...args: unknown[]) => mockRecord(...args),
}));

import { resolveInviteCode, checkIpThrottleAndFlag } from '@/lib/reseller/register-helper';

const baseNow = new Date('2026-05-11T12:00:00.000Z');

describe('resolveInviteCode', () => {
    const originalEnv = process.env.INVITE_CODES;
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        if (originalEnv === undefined) delete process.env.INVITE_CODES;
        else process.env.INVITE_CODES = originalEnv;
    });

    it('empty input → kind="none"', async () => {
        const r = await resolveInviteCode({ typedCode: '', registeringEmail: 'a@b.io', now: baseNow });
        expect(r.kind).toBe('none');
        expect(mockResellerInviteCodeFindUnique).not.toHaveBeenCalled();
    });

    it('reseller code hit → kind="reseller" + populates attribution fields', async () => {
        mockResellerInviteCodeFindUnique.mockResolvedValue({
            id: 'code-uuid',
            reseller_id: 'reseller-uuid',
            is_active: true,
            reseller: {
                status: 'active',
                user: { email: 'reseller@example.com' },
            },
        });
        const r = await resolveInviteCode({
            typedCode: 'frank-wx',
            registeringEmail: 'newcust@gmail.com',
            now: baseNow,
        });
        expect(r.kind).toBe('reseller');
        if (r.kind === 'reseller') {
            expect(r.inviter_code_id).toBe('code-uuid');
            expect(r.inviter_reseller_id).toBe('reseller-uuid');
            expect(r.attribution_expires_at.getUTCFullYear()).toBe(2028);
        }
    });

    it('self-invite (registering email == reseller owner email) → kind="self_invite_rejected"', async () => {
        mockResellerInviteCodeFindUnique.mockResolvedValue({
            id: 'code-uuid',
            reseller_id: 'reseller-uuid',
            is_active: true,
            reseller: {
                status: 'active',
                user: { email: 'frank@example.com' },
            },
        });
        const r = await resolveInviteCode({
            typedCode: 'frank-wx',
            registeringEmail: 'FRANK@example.com', // case-insensitive match
            now: baseNow,
        });
        expect(r.kind).toBe('self_invite_rejected');
    });

    it('inactive reseller code → falls through to env then invalid', async () => {
        mockResellerInviteCodeFindUnique.mockResolvedValue({
            id: 'code-uuid',
            reseller_id: 'reseller-uuid',
            is_active: false,
            reseller: { status: 'active', user: { email: 'frank@example.com' } },
        });
        const r = await resolveInviteCode({
            typedCode: 'frank-wx',
            registeringEmail: 'cust@gmail.com',
            now: baseNow,
        });
        expect(r.kind).toBe('invalid');
    });

    it('suspended reseller → falls through to invalid', async () => {
        mockResellerInviteCodeFindUnique.mockResolvedValue({
            id: 'code-uuid',
            reseller_id: 'reseller-uuid',
            is_active: true,
            reseller: { status: 'suspended', user: { email: 'frank@example.com' } },
        });
        const r = await resolveInviteCode({
            typedCode: 'frank-wx',
            registeringEmail: 'cust@gmail.com',
            now: baseNow,
        });
        expect(r.kind).toBe('invalid');
    });

    it('falls back to env allow-list when reseller miss', async () => {
        mockResellerInviteCodeFindUnique.mockResolvedValue(null);
        process.env.INVITE_CODES = 'LAUNCH-A,beta-1';
        const r = await resolveInviteCode({
            typedCode: 'launch-a',
            registeringEmail: 'cust@gmail.com',
            now: baseNow,
        });
        expect(r.kind).toBe('env_invite_code');
        if (r.kind === 'env_invite_code') expect(r.invite_code).toBe('launch-a');
    });

    it('neither reseller nor env matches → kind="invalid"', async () => {
        mockResellerInviteCodeFindUnique.mockResolvedValue(null);
        delete process.env.INVITE_CODES;
        const r = await resolveInviteCode({
            typedCode: 'made-up',
            registeringEmail: 'cust@gmail.com',
            now: baseNow,
        });
        expect(r.kind).toBe('invalid');
    });
});

describe('checkIpThrottleAndFlag', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('skips when signup_ip is null', async () => {
        const r = await checkIpThrottleAndFlag({
            signup_ip: null,
            inviter_code_id: 'code-uuid',
            inviter_reseller_id: 'reseller-uuid',
            new_user_id: 'u',
            now: baseNow,
        });
        expect(r.flagged).toBe(false);
        expect(mockUserCount).not.toHaveBeenCalled();
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('skips when inviter_code_id is null (non-reseller path)', async () => {
        const r = await checkIpThrottleAndFlag({
            signup_ip: '1.2.3.4',
            inviter_code_id: null,
            inviter_reseller_id: null,
            new_user_id: 'u',
            now: baseNow,
        });
        expect(r.flagged).toBe(false);
        expect(mockUserCount).not.toHaveBeenCalled();
    });

    it('count ≤ threshold → not flagged, no analytics', async () => {
        mockUserCount.mockResolvedValue(2); // 2 = exactly at threshold; brief: >2 trips
        const r = await checkIpThrottleAndFlag({
            signup_ip: '1.2.3.4',
            inviter_code_id: 'code-uuid',
            inviter_reseller_id: 'reseller-uuid',
            new_user_id: 'u',
            now: baseNow,
        });
        expect(r.flagged).toBe(false);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('count > threshold → flagged + writes analytics event', async () => {
        mockUserCount.mockResolvedValue(3); // the 3rd registration in window
        const r = await checkIpThrottleAndFlag({
            signup_ip: '1.2.3.4',
            inviter_code_id: 'code-uuid',
            inviter_reseller_id: 'reseller-uuid',
            new_user_id: 'new-user-uuid',
            now: baseNow,
        });
        expect(r.flagged).toBe(true);
        expect(r.count).toBe(3);
        expect(mockRecord).toHaveBeenCalledOnce();
        const arg = mockRecord.mock.calls[0][0];
        expect(arg.eventType).toBe('reseller_signup_ip_throttle_flagged');
        expect(arg.userId).toBe('new-user-uuid');
        expect(arg.properties.signup_ip).toBe('1.2.3.4');
    });
});
