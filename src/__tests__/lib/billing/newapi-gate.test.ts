import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockUserFindUnique = vi.fn();
const mockAddQuota = vi.fn();

vi.mock('@/lib/db', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) } } }));
vi.mock('@/lib/newapi/client', () => ({ addQuota: (...a: unknown[]) => mockAddQuota(...a) }));

import { syncNewapiGate, GATE_OPEN_QUOTA } from '@/lib/billing/newapi-gate';

const D = (n: number | string) => new Prisma.Decimal(n);
const portalUser = (balance: number | string | null, over: Record<string, unknown> = {}) => ({
    billing_mode: 'portal',
    newapi_user_id: 555,
    account: balance == null ? null : { balance_cny: D(balance) },
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockAddQuota.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('syncNewapiGate — scope guard (IRON RULE: never touch newapi customers)', () => {
    it('BILLING_SOURCE unset → no-op, not even a DB read', async () => {
        mockUserFindUnique.mockResolvedValue(portalUser(100));
        await syncNewapiGate('u1');
        expect(mockUserFindUnique).not.toHaveBeenCalled();
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('BILLING_SOURCE=portal but user billing_mode=newapi → NEVER touches its quota', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUserFindUnique.mockResolvedValue(portalUser(100, { billing_mode: 'newapi' }));
        await syncNewapiGate('u1');
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('portal user with no newapi_user_id → no-op (cannot route)', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUserFindUnique.mockResolvedValue(portalUser(100, { newapi_user_id: null }));
        await syncNewapiGate('u1');
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('user not found → no-op', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUserFindUnique.mockResolvedValue(null);
        await syncNewapiGate('u1');
        expect(mockAddQuota).not.toHaveBeenCalled();
    });
});

describe('syncNewapiGate — open/close (portal mode + BILLING_SOURCE=portal)', () => {
    beforeEach(() => vi.stubEnv('BILLING_SOURCE', 'portal'));

    it('balance > 0 → override quota to GATE_OPEN_QUOTA (open the door)', async () => {
        mockUserFindUnique.mockResolvedValue(portalUser('12.5'));
        await syncNewapiGate('u1');
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 555, quotaDelta: GATE_OPEN_QUOTA, mode: 'override' });
    });

    it('balance = 0 → override quota to 0 (close the door → insufficient_user_quota)', async () => {
        mockUserFindUnique.mockResolvedValue(portalUser('0'));
        await syncNewapiGate('u1');
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 555, quotaDelta: 0, mode: 'override' });
    });

    it('balance < 0 (overdraft window) → override quota to 0 (close)', async () => {
        mockUserFindUnique.mockResolvedValue(portalUser('-3.2'));
        await syncNewapiGate('u1');
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 555, quotaDelta: 0, mode: 'override' });
    });

    it('no Account row yet → treated as balance 0 → override quota to 0 (closed until first credit)', async () => {
        mockUserFindUnique.mockResolvedValue(portalUser(null));
        await syncNewapiGate('u1');
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 555, quotaDelta: 0, mode: 'override' });
    });
});
