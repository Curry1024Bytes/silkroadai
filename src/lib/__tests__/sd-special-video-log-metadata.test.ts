import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createMany, findMany, identity, timings } = vi.hoisted(() => ({
    createMany: vi.fn(),
    findMany: vi.fn(),
    identity: vi.fn(),
    timings: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        sdVideoTaskMetadata: { findMany },
        $transaction: (
            callback: (tx: { sdVideoTaskMetadata: { createMany: typeof createMany } }) => Promise<unknown>,
        ) => callback({ sdVideoTaskMetadata: { createMany } }),
    },
}));
vi.mock('@/lib/reqlog/identity', () => ({ resolveLogIdentity: identity }));
vi.mock('@/lib/sd-special-video-delivery', () => ({ readSdSpecialTaskTimings: timings }));
vi.mock('@/lib/customer-video-tasks', () => ({ readCustomerVideoTasks: async () => new Map() }));

import { enrichSdSpecialVideoLogs, recordSdSpecialVideoMetadata } from '@/lib/sd-special-video-log-metadata';
import { parseVideoTaskBilling } from '@/lib/newapi/log-display';

const taskId = `task_${'x'.repeat(32)}`;
const owner = { userId: '00000000-0000-4000-8000-000000000001', newapiUserId: 100 };
const request = { model: 'sd-2-mini', resolution: '480p', aspect_ratio: '16:9', prompt: 'private prompt' };
const snapshot = {
    task_id: taskId,
    public_model: 'sd-2-mini',
    resolution: '480p',
    has_video: false,
    aspect_ratio: '16:9',
};
function row(model = 'sd-2-mini-480-novideo') {
    const video = parseVideoTaskBilling(
        {
            model_name: model,
            type: 2,
            quota: 250000,
            other: JSON.stringify({
                is_task: true,
                billing_mode: 'tiered_expr',
                task_id: taskId,
                usage_facts: { seconds: 4 },
                matched_tier: 'base',
                group_ratio: 1,
                expr_b64: btoa('tier("base", u("seconds") * 0.125)'),
            }),
        },
        { quotaPerUsd: 500000, quotaPerCny: 500000 },
    )!;
    return { model, costCny: 0.5, quota: 250000, video: { ...video, elapsedSec: null as number | null } };
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    identity.mockResolvedValue({ user_id: owner.userId });
    createMany.mockResolvedValue({ count: 1 });
    findMany.mockResolvedValue([]);
    timings.mockResolvedValue(new Map());
});
afterEach(() => vi.restoreAllMocks());

describe('SD video submission metadata', () => {
    it.each([undefined, [{ type: 'image', url: 'private image' }], [{ type: 'audio', url: 'private audio' }]])(
        'saves only the owned minimal snapshot, without treating non-video references as video: %j',
        async (references) => {
            await recordSdSpecialVideoMetadata('Bearer test', { ...request, references }, { id: taskId });
            expect(identity).toHaveBeenCalledExactlyOnceWith('Bearer test');
            expect(createMany).toHaveBeenCalledExactlyOnceWith({
                data: [
                    {
                        ...snapshot,
                        user_id: owner.userId,
                        request_summary: { resolution: '480p', ratio: '16:9', hasVideo: false },
                    },
                ],
                skipDuplicates: true,
            });
            expect(JSON.stringify(createMany.mock.calls)).not.toMatch(/private|Bearer|quota|price/);
        },
    );

    it('accepts nested task responses and saves explicit video reference state', async () => {
        await recordSdSpecialVideoMetadata(
            'Bearer test',
            { ...request, references: [{ type: 'video' }] },
            { data: { id: taskId } },
        );
        expect(createMany.mock.calls[0][0].data[0].has_video).toBe(true);
    });

    it('leaves omitted or unknown aspect ratios unknown instead of assuming 16:9', async () => {
        for (const aspect_ratio of [undefined, 'auto', 'not-a-ratio']) {
            await recordSdSpecialVideoMetadata('Bearer test', { ...request, aspect_ratio }, { id: taskId });
            expect(createMany.mock.lastCall![0].data[0].aspect_ratio).toBeNull();
        }
    });

    it.each([null, [], { id: 'task_short' }, { data: null }, { id: '<script>' }])(
        'ignores invalid task responses: %j',
        async (response) => {
            await recordSdSpecialVideoMetadata('Bearer test', request, response);
            expect(identity).not.toHaveBeenCalled();
            expect(createMany).not.toHaveBeenCalled();
        },
    );

    it('does not store non-SD requests, missing resolutions, or unowned tasks', async () => {
        await recordSdSpecialVideoMetadata(null, { ...request, model: 'other-video' }, { id: taskId });
        await recordSdSpecialVideoMetadata(null, { ...request, resolution: undefined }, { id: taskId });
        expect(identity).not.toHaveBeenCalled();
        identity.mockResolvedValue({ user_id: null });
        await recordSdSpecialVideoMetadata(null, request, { id: taskId });
        expect(createMany).not.toHaveBeenCalled();
    });

    it('never turns an accepted submission into an error or logs credentials when saving fails', async () => {
        createMany.mockRejectedValue(new Error('private database URL'));
        await expect(recordSdSpecialVideoMetadata('Bearer test', request, { id: taskId })).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledExactlyOnceWith('[sd-video-metadata] task metadata could not be saved');
    });
});

describe('SD customer log enrichment', () => {
    it('batches owner-scoped reads and adds specs and canonical elapsed time without changing billing', async () => {
        findMany.mockResolvedValue([snapshot]);
        timings.mockResolvedValue(new Map([[taskId, { model: 'sd-2-mini', elapsedSec: 207 }]]));
        const original = row();
        const [result] = await enrichSdSpecialVideoLogs([original, original], owner);
        expect(findMany).toHaveBeenCalledExactlyOnceWith({
            where: { user_id: owner.userId, task_id: { in: [taskId] } },
            select: {
                task_id: true,
                public_model: true,
                resolution: true,
                has_video: true,
                aspect_ratio: true,
                request_summary: true,
            },
        });
        expect(timings).toHaveBeenCalledExactlyOnceWith(100, [taskId]);
        expect(result).toMatchObject({
            model: 'sd-2-mini',
            costCny: 0.5,
            quota: 250000,
            video: { seconds: 4, unitCnyPerSecond: 0.125, ratio: '16:9', elapsedSec: 207, videoInput: 'none' },
        });
        expect(original.model).toBe('sd-2-mini-480-novideo');
        expect(original.video.ratio).toBeNull();
    });

    it('historical rows get task duration without inventing a missing aspect ratio', async () => {
        timings.mockResolvedValue(new Map([[taskId, { model: 'sd-2-mini', elapsedSec: 207 }]]));
        const [result] = await enrichSdSpecialVideoLogs([row()], owner);
        expect(result.video).toMatchObject({ ratio: null, elapsedSec: 207 });
    });

    it.each([true, false])(
        '1080p shared SKU uses saved reference state instead of guessing from its name: %s',
        async (hasVideo) => {
            findMany.mockResolvedValue([
                { ...snapshot, public_model: 'sd-2.5', resolution: '1080p', has_video: hasVideo },
            ]);
            const [result] = await enrichSdSpecialVideoLogs([row('sd-2.5-1080P')], owner);
            expect(result.model).toBe('sd-2.5');
            expect(result.video).toMatchObject({ resolution: '1080p', videoInput: hasVideo ? 'video' : 'none' });
        },
    );

    it('does not use metadata or timings belonging to another model', async () => {
        findMany.mockResolvedValue([{ ...snapshot, public_model: 'sd-2.5', aspect_ratio: '9:16' }]);
        timings.mockResolvedValue(new Map([[taskId, { model: 'sd-2.5', elapsedSec: 207 }]]));
        expect((await enrichSdSpecialVideoLogs([row()], owner))[0].video).toMatchObject({
            ratio: null,
            elapsedSec: null,
        });
    });

    it('preserves existing logged specifications instead of overwriting billing facts', async () => {
        findMany.mockResolvedValue([snapshot]);
        const original = row();
        original.video = { ...original.video, resolution: '720p', ratio: '9:16', videoInput: 'video' };
        expect((await enrichSdSpecialVideoLogs([original], owner))[0].video).toMatchObject({
            resolution: '720p',
            ratio: '9:16',
            videoInput: 'video',
        });
    });

    it('degrades independently when either metadata store is unavailable', async () => {
        findMany.mockRejectedValueOnce(new Error('not migrated'));
        timings.mockResolvedValueOnce(new Map([[taskId, { model: 'sd-2-mini', elapsedSec: 207 }]]));
        expect((await enrichSdSpecialVideoLogs([row()], owner))[0].video.elapsedSec).toBe(207);
        findMany.mockResolvedValueOnce([snapshot]);
        timings.mockRejectedValueOnce(new Error('reader unavailable'));
        expect((await enrichSdSpecialVideoLogs([row()], owner))[0].video).toMatchObject({
            elapsedSec: null,
            ratio: '16:9',
        });
    });

    it('normalizes model names even without video details, without querying unrelated tasks', async () => {
        const rows = [
            { model: 'sd-2-mini-720', video: null },
            { model: 'ordinary-model', video: null },
        ];
        expect(await enrichSdSpecialVideoLogs(rows, owner)).toEqual([{ model: 'sd-2-mini', video: null }, rows[1]]);
        expect(findMany).not.toHaveBeenCalled();
        expect(timings).not.toHaveBeenCalled();
    });
});
