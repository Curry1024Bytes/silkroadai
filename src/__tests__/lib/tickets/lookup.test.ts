import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({ queryLogs: (...a: unknown[]) => mockQueryLogs(...a) }));

import { locateRequest, pickLogRow } from '@/lib/tickets/lookup';
import type { NewApiUsageLog } from '@/lib/newapi/client';

const row = (over: Partial<NewApiUsageLog>): NewApiUsageLog =>
    ({
        id: 1,
        user_id: 40,
        created_at: 1_750_000_000,
        type: 2,
        content: '',
        username: 'c-9b4d578d',
        token_name: 'default',
        model_name: 'gpt-5.4',
        quota: 85000,
        prompt_tokens: 100,
        completion_tokens: 50,
        use_time: 2,
        is_stream: false,
        channel: 3,
        token_id: 77,
        group: 'default',
        other: '',
        request_id: 'RID1234567890',
        ...over,
    }) as NewApiUsageLog;

describe('pickLogRow', () => {
    it('ignores rows of other users even when request_id matches', () => {
        expect(pickLogRow([row({ user_id: 41 })], 40, 'RID1234567890')).toBeNull();
    });
    it('prefers the success row over the failover error row', () => {
        const picked = pickLogRow([row({ id: 1, type: 5 }), row({ id: 2, type: 2 })], 40, 'RID1234567890');
        expect(picked?.id).toBe(2);
    });
    it('falls back to the error row when the call never succeeded', () => {
        expect(pickLogRow([row({ type: 5 })], 40, 'RID1234567890')?.type).toBe(5);
    });
});

describe('locateRequest', () => {
    beforeEach(() => vi.clearAllMocks());
    const user = { newapi_user_id: 40, newapi_username: 'c-9b4d578d' };

    it('returns null without calling new-api for an unprovisioned user', async () => {
        expect(await locateRequest({ newapi_user_id: null, newapi_username: null }, 'RID1234567890')).toBeNull();
        expect(mockQueryLogs).not.toHaveBeenCalled();
    });
    it('maps a located row to model / token / cost', async () => {
        mockQueryLogs.mockResolvedValue({ items: [row({})], total: 1 });
        const r = await locateRequest(user, 'RID1234567890');
        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({ request_id: 'RID1234567890', user_id: 40, username: 'c-9b4d578d' }),
        );
        expect(r).toMatchObject({ model: 'gpt-5.4', newapiTokenId: 77, quota: 85000, failed: false });
        expect(r?.costCny).toBeGreaterThan(0);
    });
    it('swallows new-api failures (never blocks ticket creation)', async () => {
        mockQueryLogs.mockRejectedValue(new Error('502'));
        expect(await locateRequest(user, 'RID1234567890')).toBeNull();
    });
});
