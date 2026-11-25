import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewApiUsageLog } from '@/lib/newapi/client';

const { queryLogs } = vi.hoisted(() => ({ queryLogs: vi.fn() }));
vi.mock('@/lib/newapi/client', () => ({ queryLogs }));

import { customerLogPages, queryCustomerLogs } from '@/lib/newapi/customer-log-query';
import { sdSpecialLogModelNames } from '@/lib/sd-special-video';

function log(id: number, model_name: string): NewApiUsageLog {
    return {
        id,
        model_name,
        user_id: 100,
        username: 'customer',
        type: 2,
        created_at: id,
        token_name: 'key',
        quota: 250000,
        prompt_tokens: 0,
        completion_tokens: 0,
        use_time: 1,
        is_stream: false,
        channel: 13,
        token_id: 1,
        group: 'SD特惠',
        request_id: `R${id}`,
        content: '',
        other: '',
    };
}

beforeEach(() => vi.resetAllMocks());

describe('customer SD log model filters', () => {
    it('merges exact SKU pages globally without mixing Flash or dropping older resolutions', async () => {
        const fixtures = [
            log(15, 'sd-2.5-480P-novideo'),
            log(14, 'sd-2.5-480P-novideo'),
            log(13, 'sd-2.5-480P-novideo'),
            log(12, 'sd-2.5-720P'),
            log(11, 'sd-2.5'),
            log(10, 'sd-2.5-1080P'),
            log(9, 'sd-2.5-480P'),
            log(8, 'sd-2.5-720P-novideo'),
            log(16, 'sd-2.5-flash-480P'),
            log(17, 'sd-2-mini-480'),
        ];
        queryLogs.mockImplementation(async ({ model_name, page, page_size }) => {
            const mine = fixtures.filter((row) => row.model_name === model_name);
            return { items: mine.slice((page - 1) * page_size, page * page_size), total: mine.length };
        });
        const args = { username: 'customer', user_id: 100, model_name: 'sd-2.5', page_size: 2, token_name: 'key' };
        const pages = [];
        for await (const page of customerLogPages(args)) pages.push(page);
        expect(pages.map((page) => page.items.map((row) => row.id))).toEqual([
            [15, 14],
            [13, 12],
            [11, 10],
            [9, 8],
        ]);
        expect(pages.every((page) => page.total === 8)).toBe(true);
        expect(new Set(queryLogs.mock.calls.map(([args]) => args.model_name))).toEqual(
            new Set(sdSpecialLogModelNames('sd-2.5')),
        );
        for (const [call] of queryLogs.mock.calls)
            expect(call).toMatchObject({ username: 'customer', user_id: 100, token_name: 'key' });
        queryLogs.mockClear();
        expect(await queryCustomerLogs({ ...args, page: 2 })).toMatchObject({
            items: [{ id: 13 }, { id: 12 }],
            total: 8,
        });
        expect(await queryCustomerLogs({ ...args, page: 6 })).toEqual({ items: [], total: 8 });
    });

    it('passes ordinary and exact legacy model queries through unchanged', async () => {
        for (const model_name of [undefined, 'gpt-5.5', 'sd-2-mini-480-novideo']) {
            queryLogs.mockClear().mockResolvedValue({ items: [], total: 0 });
            const args = { username: 'customer', model_name, page: 3, page_size: 100 };
            expect(await queryCustomerLogs(args)).toEqual({ items: [], total: 0 });
            expect(queryLogs).toHaveBeenCalledExactlyOnceWith(args);
        }
    });

    it('fails closed when an upstream ignores the exact model filter', async () => {
        queryLogs.mockResolvedValue({ items: [log(1, 'sd-2.5-flash-480P')], total: 1 });
        await expect(queryCustomerLogs({ model_name: 'sd-2.5' })).rejects.toThrow('Model log filter was not respected');
    });

    it('propagates an alias fetch failure instead of returning a partial page', async () => {
        queryLogs.mockRejectedValue(new Error('unavailable'));
        await expect(queryCustomerLogs({ model_name: 'sd-2-mini' })).rejects.toThrow('unavailable');
    });

    it('does not prefetch later pages when the consumer stops after one page', async () => {
        queryLogs.mockImplementation(async ({ model_name }) => ({
            items: model_name === 'sd-2-mini-480' ? [log(3, model_name), log(2, model_name)] : [],
            total: 2,
        }));
        await queryCustomerLogs({ model_name: 'sd-2-mini', page_size: 2 });
        expect(queryLogs).toHaveBeenCalledTimes(sdSpecialLogModelNames('sd-2-mini')!.length);
    });

    it('keeps ordinary export paging until the first short page', async () => {
        queryLogs
            .mockResolvedValueOnce({ items: [log(2, 'gpt'), log(1, 'gpt')], total: 2 })
            .mockResolvedValueOnce({ items: [], total: 2 });
        const pages = [];
        for await (const page of customerLogPages({ username: 'customer', page_size: 2 })) pages.push(page);
        expect(pages).toHaveLength(2);
        expect(queryLogs.mock.calls.map(([args]) => args.page)).toEqual([1, 2]);
    });
});
